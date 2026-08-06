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
