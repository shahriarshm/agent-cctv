import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';

/**
 * What each provider needs on the command line, and how to find the public URL
 * in what it prints.
 *
 * Records rather than classes, because that is all the variation there is —
 * and because the matchers are the part most likely to change under us:
 * neither provider documents its output as an interface. When one of them
 * does, `--public-url` is the path that keeps working, which is also the only
 * path a *named* cloudflared tunnel can take: it prints no URL anywhere,
 * because its hostname lives in the operator's DNS rather than in the process.
 */
export const PROVIDERS = {
  cloudflare: {
    bin: 'cloudflared',
    install: 'brew install cloudflared',
    // --no-autoupdate is not politeness. An autoupdate restarts the binary and
    // drops the tunnel mid-session, which presents as a random disconnect
    // nobody can explain.
    argv: ({ target }) => ['tunnel', '--no-autoupdate', '--url', target],
    match: (chunk) => {
      const m = chunk.match(/https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i);
      return m ? m[0] : null;
    },
  },
  ngrok: {
    bin: 'ngrok',
    install: 'brew install ngrok   (then: ngrok config add-authtoken <token>)',
    // ngrok's default interface is a TUI that prints nothing parseable, so the
    // logging flags are forced rather than offered. The agent API on :4040 is
    // deliberately not used — it is a second port, and it moves when another
    // agent is already running, so "read the URL from :4040" silently reads
    // somebody else's tunnel.
    argv: ({ port }) => ['http', String(port), '--log', 'stdout', '--log-format', 'json'],
    match: (chunk) => {
      for (const line of chunk.split('\n')) {
        if (!line.includes('started tunnel')) continue;
        try {
          const rec = JSON.parse(line);
          if (typeof rec.url === 'string' && rec.url.startsWith('https://')) return rec.url;
        } catch {
          // Not JSON after all. Fall through to the regex rather than giving
          // up — the log format is not a contract, and a shape we half
          // recognise is still better than a timeout.
        }
        const m = line.match(/"url":"(https:\/\/[^"]+)"/);
        if (m) return m[1];
      }
      return null;
    },
  },
};

/** Best effort for --tunnel-cmd: the first https URL the command prints. */
export function matchCustom(chunk) {
  const m = chunk.match(/https:\/\/[^\s"'<>,)]+/);
  // Trailing punctuation belongs to the sentence around the URL, not the host.
  return m ? m[0].replace(/[.]+$/, '') : null;
}

const TTL_UNITS = { s: 1000, m: 60_000, h: 3_600_000 };

/** "30m" -> 1800000. A bare number is refused rather than guessed at. */
export function parseTtl(value) {
  const m = String(value ?? '')
    .trim()
    .match(/^(\d+)(s|m|h)$/i);
  const n = m ? Number(m[1]) : 0;
  if (!m || n <= 0) {
    throw new Error(`--tunnel-ttl must look like 45s, 30m or 2h — got ${JSON.stringify(value)}`);
  }
  return n * TTL_UNITS[m[2].toLowerCase()];
}

/**
 * Split a provider-argument string the way a shell would for the simple cases,
 * without invoking one. Provider binaries are spawned without a shell so that
 * nothing in --tunnel-args can start a second process; the cost of that is
 * that we owe the operator quote handling, because `--header "X-A: b"` is a
 * normal thing to want to pass.
 */
export function splitArgs(str) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(str ?? '')))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * Enough of the child's own words to diagnose a failure, bounded because a
 * chatty provider would otherwise grow this for the life of the process —
 * ngrok logs a line per request, and our SSE stream is a request that lasts
 * as long as somebody has the wall open.
 */
const TAIL_LINES = 40;

/**
 * A tunnel is a child process that prints a URL and then stays up.
 *
 * There is deliberately no respawn. A re-opened quick tunnel comes back on a
 * *different* hostname, so retrying cannot revive the link somebody was
 * already sent — it only produces a second link nobody has, while churning the
 * hostname the server is allowing. On exit we say so and stop; re-publishing
 * is a decision, and decisions belong to the operator.
 */
export class Tunnel extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} [o.provider]  key of PROVIDERS
   * @param {string} [o.cmd]       a whole command line, run through a shell
   * @param {string} [o.args]      extra provider arguments, split without a shell
   * @param {number} o.port        the port the server actually bound
   * @param {string} [o.host]      the interface it bound, when it is a specific one
   * @param {string} [o.publicUrl] skip scraping and use this
   */
  constructor({ provider, cmd, args = '', port, host, publicUrl, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    super();
    this.provider = provider || null;
    this.cmd = cmd || null;
    this.args = args;
    this.port = port;
    // 0.0.0.0 and :: mean "every interface", and loopback is one of them — but
    // a bind to one specific private address is not reachable on 127.0.0.1,
    // and a tunnel pointed at the wrong address fails in a way that looks like
    // the tunnel's fault.
    this.target = `http://${!host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host}:${port}`;
    this.publicUrl = publicUrl || null;
    this.timeoutMs = timeoutMs || DEFAULT_TIMEOUT_MS;
    this.spawnBin = this.provider ? PROVIDERS[this.provider].bin : null;
    this.child = null;
    this.pid = null;
    this.url = null;
    this.host = null;
    this.stopped = false;
    this.tail = [];
  }

  get label() {
    return this.provider || 'tunnel';
  }

  /** Resolves once the public URL is known; rejects if it never is. */
  start() {
    const rec = this.provider ? PROVIDERS[this.provider] : null;
    const match = rec ? rec.match : matchCustom;

    if (this.cmd) {
      // A shell, on purpose: this string is operator-typed on their own
      // machine — the same trust boundary as their prompt — and hand-splitting
      // a shell command line is how quoting bugs are born. detached, because
      // the shell's *grandchild* is what actually holds the tunnel and it
      // survives child.kill(); stop() kills the group instead.
      this.child = spawn(this.cmd, { shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } else {
      // No shell for a provider binary: nothing in --tunnel-args should be
      // able to start a second process. Same process group, so a terminal
      // ctrl-c reaches the child too — belt, with shutdown()'s braces.
      this.child = spawn(
        this.spawnBin,
        [...rec.argv({ port: this.port, target: this.target }), ...splitArgs(this.args)],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
    }
    this.pid = this.child.pid;

    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(arg);
      };

      const timer = setTimeout(() => {
        done(
          reject,
          new Error(
            `${this.label}: no public URL after ${Math.round(this.timeoutMs / 1000)}s.\n` +
              `${this.output()}\n` +
              `  If this provider does not print one — a named cloudflared tunnel does not —\n` +
              `  pass --public-url with the hostname you own.`
          )
        );
      }, this.timeoutMs);
      timer.unref?.();

      const onChunk = (buf) => {
        const chunk = String(buf);
        for (const line of chunk.split('\n')) if (line.trim()) this.push(line.trim());
        if (settled || this.publicUrl) return;
        const url = match(chunk);
        if (url) done(resolve, this.publish(url));
      };

      // Both streams are read for the child's WHOLE life, not just until the
      // URL turns up. ngrok logs every request through the tunnel, and our SSE
      // stream never ends — stop reading and the 64 KB pipe fills, then the
      // child blocks on write and the tunnel silently stops forwarding.
      this.child.stdout.on('data', onChunk);
      this.child.stderr.on('data', onChunk);

      // ENOENT arrives here, asynchronously — not as a throw from spawn().
      // Unhandled, an EventEmitter 'error' takes the whole process down.
      this.child.on('error', (err) => {
        done(
          reject,
          new Error(
            err.code === 'ENOENT' && rec
              ? `${rec.bin} is not installed, or is not on PATH.\n  Install it with:  ${rec.install}`
              : `${this.label}: ${err.message}`
          )
        );
      });

      this.child.on('exit', (code, signal) => {
        const info = { code, signal, tail: this.output() };
        // Before the URL: the operator asked to publish and it did not happen,
        // so this is a rejection and the caller exits. After: there is a
        // working wall and possibly someone watching it, so it is an event.
        done(reject, new Error(`${this.label} exited (code ${code}) before publishing.\n${info.tail}`));
        if (!this.stopped) this.emit('exit', info);
      });

      // A URL we were given rather than told. Nothing to wait for, but the
      // child still has to survive being spawned, so resolve on the next tick
      // rather than synchronously — an immediate ENOENT should still reject.
      if (this.publicUrl) setImmediate(() => done(resolve, this.publish(this.publicUrl)));
    });
  }

  publish(url) {
    this.url = url;
    this.host = new URL(url).hostname.toLowerCase();
    return { url: this.url, host: this.host };
  }

  push(line) {
    this.tail.push(line);
    if (this.tail.length > TAIL_LINES) this.tail.shift();
  }

  output() {
    return this.tail.map((l) => `  ${l}`).join('\n');
  }

  stop() {
    if (!this.child || this.stopped) return;
    this.stopped = true;
    try {
      // A detached child is its own group leader, so the negative pid reaches
      // the shell AND whatever it started. Without this the grandchild keeps
      // forwarding after we are gone.
      if (this.cmd) process.kill(-this.pid, 'SIGTERM');
      else this.child.kill('SIGTERM');
    } catch {
      // Already gone. Nothing to do, and nothing worth telling anyone about.
    }
  }
}
