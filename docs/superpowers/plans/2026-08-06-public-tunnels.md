# Public Tunnels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `agent-cctv --tunnel cloudflare` publishes the dashboard on a public https URL through a tunnel binary the operator already has, with a mandatory token, a typed confirmation, an optional self-closing TTL, and a badge in the header while it is up.

**Architecture:** A new `src/tunnel.js` owns provider records (argv + URL matcher) and a `Tunnel` EventEmitter that spawns the binary, drains its output for life, and scrapes the public URL. `bin/cctv.js` binds the server first, then starts the tunnel against the real bound port, then hands the hostname to `server.setTunnel()` — a single mutable slot consulted by the Host/Origin checks and by the `Secure` cookie predicate. The SPA learns about it over the existing SSE stream.

**Tech Stack:** Node ≥18, ESM, `node:child_process`, `node:test`. No new dependencies — that is non-negotiable in this repo.

## Global Constraints

- **Zero runtime dependencies.** Nothing new in `package.json`. We spawn a binary the operator installed; we never link a provider SDK.
- **Pure observer.** Nothing here writes to `~/.claude` or `~/.codex`.
- **`textContent` only** in `public/*.js`. `test/spa-guard.test.js` fails on `innerHTML` from anything but its icon allowlist.
- **`test/helpers/env.js` must be the first import** in any test that touches `src/` — `src/paths.js` reads env at module load.
- **No test may spawn `cloudflared` or `ngrok`.** Provider records are data; process machinery is exercised through `--tunnel-cmd` with `node` as the child.
- **Host-header tests use raw `node:http`**, never `fetch` — `fetch` silently rewrites `Host`.
- Commits are `feat:` / `fix:` / `docs:` / `refactor:`, lowercase subject, body explains the reasoning not the diff.
- Comments explain *why* and what breaks without it. A comment restating the code is worse than none.
- Full suite: `npm test`. One file: `node --test test/tunnel.test.js`.

**Branch:** `feat/public-tunnels`, merged at the end with a summarizing merge commit.

---

### Task 1: Make `parseArgs` able to carry a tunnel's arguments

`bin/cctv.js:32-48` has two bugs that would silently eat `--tunnel-args` before any tunnel code runs. Fix them first, with tests, so nothing later is debugged through them.

**Files:**
- Modify: `bin/cctv.js:30-48`
- Test: `test/args.test.js` (new)

Why a new test file rather than appending to `test/cli.test.js`: importing
`bin/cctv.js` pulls `src/paths.js` into the test process, and it reads its
environment at module load. `test/cli.test.js` never imports `src/` today — it
only spawns subprocesses — so it has no `helpers/env.js` import to protect it,
and adding one there would change how every existing case in it runs.

**Interfaces:**
- Produces: `parseArgs` handling `--flag=a=b` (whole value) and `--flag '-x y'` (dash-leading value) for members of a new `VALUE_FLAGS` set; `yes` recognised as boolean.

- [ ] **Step 1: Export `parseArgs` so it can be tested directly**

`bin/cctv.js` runs its command dispatch at module top level, so importing it from a test would start a server. Move nothing: instead add a focused test that drives the real CLI, plus a unit-testable copy is *not* acceptable (it would drift). Export the function and guard the dispatch:

In `bin/cctv.js`, change the bare `export function parseArgs` (add `export`) and wrap the final dispatch block:

```js
export function parseArgs(argv) { /* unchanged body for now */ }
```

and at the bottom, replace `const args = parseArgs(process.argv.slice(2));` … dispatch with:

```js
// Importing this file from a test must not start a server. `import.meta.main`
// is Node 24+; comparing argv[1] to this module's path is the ≥18 spelling.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
```

wrapping the existing dispatch in `async function main() { … }`. Add at the top of the file:

```js
import path from 'node:path';
import { fileURLToPath } from 'node:url';
```

- [ ] **Step 2: Write the failing tests**

Create `test/args.test.js`:

```js
import './helpers/env.js'; // must come first — bin/cctv.js imports src/paths.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs } from '../bin/cctv.js';

test('a flag value containing = survives parsing whole', () => {
  // --tunnel-args=--log=stdout used to arrive as '--log': the old
  // split('=') destructured [k, v] and dropped everything after the second.
  const { flags } = parseArgs(['--tunnel-args=--log=stdout']);
  assert.equal(flags['tunnel-args'], '--log=stdout');
});

test('a value beginning with a dash is still a value, for flags that take one', () => {
  // `--tunnel-args '--region us'` is the normal way to pass provider flags.
  const { flags } = parseArgs(['--tunnel-args', '--region us']);
  assert.equal(flags['tunnel-args'], '--region us');
});

test('--yes is a boolean and does not swallow the subcommand', () => {
  const { flags, _ } = parseArgs(['--yes', 'start']);
  assert.equal(flags.yes, true);
  assert.deepEqual(_, ['start']);
});

test('a value flag left empty is still reported as valueless', () => {
  // cmdStart turns `=== true` into "--tunnel requires a value".
  assert.equal(parseArgs(['--tunnel']).flags.tunnel, true);
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `node --test test/args.test.js`
Expected: FAIL — first test gets `'--log'`, second gets `true`.

- [ ] **Step 4: Fix `parseArgs`**

Replace the flag branch in `bin/cctv.js`:

```js
// Flags that always take the next token as their value, even when it begins
// with a dash. Without this list, `--tunnel-args '--region us'` loses its
// value to the "next token looks like a flag" guard below and --region
// becomes a flag of its own — which reads as agent-cctv not supporting a
// provider flag rather than as a parser bug.
const VALUE_FLAGS = new Set(['port', 'host', 'public-url', 'tunnel', 'tunnel-args', 'tunnel-cmd', 'tunnel-ttl']);

export function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      // Split on the FIRST = only: --tunnel-args=--log=stdout is one value
      // with an = in it, not a key, a value, and a discarded remainder.
      const body = a.slice(2);
      const eq = body.indexOf('=');
      const k = eq < 0 ? body : body.slice(0, eq);
      const v = eq < 0 ? undefined : body.slice(eq + 1);
      if (BOOLEAN_FLAGS.has(k)) args.flags[k] = v ?? true;
      else if (v !== undefined) args.flags[k] = v;
      else if (VALUE_FLAGS.has(k)) args.flags[k] = argv[i + 1] !== undefined ? argv[++i] : true;
      else args.flags[k] = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : true;
    } else if (a.startsWith('-') && a.length > 1) {
      args.flags[a.slice(1)] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}
```

Add `'yes'` to `BOOLEAN_FLAGS`.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, including the pre-existing `--host`/`--port`/`--public-url` refusal cases.

- [ ] **Step 6: Commit**

```bash
git add bin/cctv.js test/args.test.js
git commit -m "fix: let a flag value contain = or begin with a dash"
```

---

### Task 2: Provider records, TTL parsing, and URL matching

The pure half of `src/tunnel.js` — data and string functions, no processes.

**Files:**
- Create: `src/tunnel.js`
- Test: `test/tunnel.test.js`

**Interfaces:**
- Produces: `PROVIDERS` (`{cloudflare, ngrok}`, each `{bin, install, argv({port, target}), match(line)}`), `parseTtl(str) -> ms`, `splitArgs(str) -> string[]`, `matchCustom(line) -> url|null`.

- [ ] **Step 1: Write the failing tests**

Create `test/tunnel.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PROVIDERS, parseTtl, splitArgs, matchCustom } from '../src/tunnel.js';

test('parseTtl accepts a suffixed duration and rejects an ambiguous one', () => {
  assert.equal(parseTtl('45s'), 45_000);
  assert.equal(parseTtl('30m'), 30 * 60_000);
  assert.equal(parseTtl('2h'), 2 * 3600_000);
  // A bare number is 30 of what? A safety timer that guesses is worse than
  // one that refuses.
  for (const bad of ['30', 'soon', '-5m', '', '0m']) {
    assert.throws(() => parseTtl(bad), /tunnel-ttl/, `${JSON.stringify(bad)} should be refused`);
  }
});

test('splitArgs respects quotes so a provider flag can carry a space', () => {
  assert.deepEqual(splitArgs('--region us'), ['--region', 'us']);
  assert.deepEqual(splitArgs('--header "X-A: b" --x'), ['--header', 'X-A: b', '--x']);
  assert.deepEqual(splitArgs("run 'my tunnel'"), ['run', 'my tunnel']);
  assert.deepEqual(splitArgs('   '), []);
});

test('cloudflared is invoked with autoupdate off and pointed at our port', () => {
  const argv = PROVIDERS.cloudflare.argv({ port: 4599, target: 'http://127.0.0.1:4599' });
  assert.deepEqual(argv, ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:4599']);
});

test('ngrok is forced out of its TTY interface and into parseable logging', () => {
  const argv = PROVIDERS.ngrok.argv({ port: 4599, target: 'http://127.0.0.1:4599' });
  assert.deepEqual(argv, ['http', '4599', '--log', 'stdout', '--log-format', 'json']);
});

test('the cloudflared banner yields its URL', () => {
  const banner = [
    '2026-08-06T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...',
    '+--------------------------------------------------------------------------+',
    '|  Your quick Tunnel has been created! Visit it at (it may take some time   |',
    '|  to be reachable):                                                        |',
    '|  https://modern-stack-42d9.trycloudflare.com                              |',
    '+--------------------------------------------------------------------------+',
  ].join('\n');
  assert.equal(PROVIDERS.cloudflare.match(banner), 'https://modern-stack-42d9.trycloudflare.com');
  assert.equal(PROVIDERS.cloudflare.match('INF Connection registered connIndex=0'), null);
});

test('the ngrok started-tunnel line yields its URL', () => {
  const line =
    '{"addr":"http://localhost:4599","lvl":"info","msg":"started tunnel",' +
    '"name":"command_line","obj":"tunnels","t":"2026-08-06T10:00:00Z","url":"https://a1b2c3.ngrok-free.app"}';
  assert.equal(PROVIDERS.ngrok.match(line), 'https://a1b2c3.ngrok-free.app');
  // Every request through the tunnel logs a line too; none of them is the URL.
  assert.equal(
    PROVIDERS.ngrok.match('{"lvl":"info","msg":"join connections","obj":"join","t":"2026-08-06T10:00:01Z"}'),
    null
  );
});

test('the custom matcher takes the first https URL and ignores http', () => {
  assert.equal(matchCustom('listening on https://x.example.com now'), 'https://x.example.com');
  assert.equal(matchCustom('bound http://127.0.0.1:4599'), null);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `node --test test/tunnel.test.js`
Expected: FAIL — `Cannot find module '../src/tunnel.js'`.

- [ ] **Step 3: Write the pure half of `src/tunnel.js`**

```js
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';

/**
 * What each provider needs on the command line, and how to find the public URL
 * in what it prints.
 *
 * These are records rather than classes because that is all the variation
 * there is — and because the matchers are the part most likely to need
 * changing under us: neither provider documents its output as an interface.
 * When one of them does change, `--public-url` is the path that keeps working
 * (see the design doc), which is why the failure below is loud rather than a
 * silent wait.
 */
export const PROVIDERS = {
  cloudflare: {
    bin: 'cloudflared',
    install: 'brew install cloudflared',
    // --no-autoupdate is not politeness: an autoupdate restarts the binary and
    // drops the tunnel mid-session, which would read as a random disconnect.
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
    // deliberately not used — it is a second port, and it moves when a second
    // agent is already running.
    argv: ({ port }) => ['http', String(port), '--log', 'stdout', '--log-format', 'json'],
    match: (chunk) => {
      for (const line of chunk.split('\n')) {
        if (!line.includes('started tunnel')) continue;
        try {
          const rec = JSON.parse(line);
          if (typeof rec.url === 'string' && rec.url.startsWith('https://')) return rec.url;
        } catch {
          // Not JSON after all — fall through to the regex below rather than
          // giving up, since the log format is not a contract.
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
  return m ? m[0].replace(/[.]+$/, '') : null;
}

const TTL_UNITS = { s: 1000, m: 60_000, h: 3_600_000 };

/** "30m" -> 1800000. A bare number is refused, not guessed at. */
export function parseTtl(value) {
  const m = String(value ?? '').trim().match(/^(\d+)(s|m|h)$/i);
  const n = m ? Number(m[1]) : 0;
  if (!m || n <= 0) {
    throw new Error(`--tunnel-ttl must look like 45s, 30m or 2h — got ${JSON.stringify(value)}`);
  }
  return n * TTL_UNITS[m[2].toLowerCase()];
}

/**
 * Split a provider-argument string the way a shell would for the simple cases,
 * without invoking one. Provider binaries are spawned without a shell so that
 * nothing in --tunnel-args can start a second process; the cost is that we owe
 * the operator quote handling, because `--header "X-A: b"` is a normal thing
 * to pass.
 */
export function splitArgs(str) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(str ?? '')))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `node --test test/tunnel.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tunnel.js test/tunnel.test.js
git commit -m "feat: provider records for cloudflared and ngrok"
```

---

### Task 3: The `Tunnel` child process

**Files:**
- Modify: `src/tunnel.js`
- Test: `test/tunnel.test.js`

**Interfaces:**
- Consumes: `PROVIDERS`, `matchCustom`, `splitArgs` from Task 2.
- Produces: `class Tunnel extends EventEmitter` with `constructor({provider, cmd, args, port, host, publicUrl, timeoutMs})`, `async start() -> {url, host}`, `stop()`, event `'exit' (info)` where `info = {code, signal, tail}`.

- [ ] **Step 1: Write the failing tests**

Append to `test/tunnel.test.js`:

```js
import { Tunnel } from '../src/tunnel.js';

/** A stand-in tunnel binary: prints what it is told, then stays up. */
function fakeCmd(script) {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

test('a custom command publishes the URL it prints, and stop() kills it', async () => {
  const t = new Tunnel({
    cmd: fakeCmd("console.log('tunnel at https://demo.example.net'); setInterval(() => {}, 1000);"),
    port: 4599,
  });
  const { url, host } = await t.start();
  assert.equal(url, 'https://demo.example.net');
  assert.equal(host, 'demo.example.net');

  const pid = t.pid;
  const exited = new Promise((r) => t.once('exit', r));
  t.stop();
  await exited;
  // The shell's grandchild is what actually holds a tunnel, so "the promise
  // resolved" is not evidence. Ask the OS.
  await new Promise((r) => setTimeout(r, 100));
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the process group should be gone');
});

test('a command that prints no URL fails loudly, with what it did print', async () => {
  const t = new Tunnel({
    cmd: fakeCmd("console.error('could not reach the edge'); setInterval(() => {}, 1000);"),
    port: 4599,
    timeoutMs: 300,
  });
  await assert.rejects(t.start(), (err) => {
    assert.match(err.message, /no public URL/i);
    assert.match(err.message, /could not reach the edge/, 'the child output must be in the error');
    return true;
  });
  t.stop();
});

test('an --public-url skips scraping entirely', async () => {
  // This is the only way a named cloudflared tunnel can work: it prints no URL
  // anywhere, because its hostname lives in the operator's DNS.
  const t = new Tunnel({
    cmd: fakeCmd('setInterval(() => {}, 1000);'),
    port: 4599,
    publicUrl: 'https://cctv.example.com',
    timeoutMs: 300,
  });
  const { url, host } = await t.start();
  assert.equal(url, 'https://cctv.example.com');
  assert.equal(host, 'cctv.example.com');
  t.stop();
});

test('a missing binary is reported as missing, not as a crash', async () => {
  const t = new Tunnel({ provider: 'cloudflare', port: 4599, timeoutMs: 500 });
  t.spawnBin = 'agent-cctv-no-such-binary';
  await assert.rejects(t.start(), /not installed|not found/i);
});

test('a child that dies during startup rejects with its exit code', async () => {
  const t = new Tunnel({ cmd: fakeCmd("console.error('bad authtoken'); process.exit(3);"), port: 4599 });
  await assert.rejects(t.start(), (err) => {
    assert.match(err.message, /bad authtoken/);
    return true;
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `node --test test/tunnel.test.js`
Expected: FAIL — `Tunnel` is not exported.

- [ ] **Step 3: Implement `Tunnel`**

Append to `src/tunnel.js`:

```js
const DEFAULT_TIMEOUT_MS = 30_000;
/** Enough of the child's own words to diagnose a failure, bounded so a chatty
 *  provider cannot grow this without limit over a long run. */
const TAIL_LINES = 40;

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
    this.provider = provider;
    this.cmd = cmd;
    this.args = args;
    this.port = port;
    // 0.0.0.0 and :: mean "everything", and loopback is part of everything —
    // but a bind to one specific private interface is not reachable on 127.0.0.1.
    this.target = `http://${!host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host}:${port}`;
    this.publicUrl = publicUrl || null;
    this.timeoutMs = timeoutMs;
    this.spawnBin = provider ? PROVIDERS[provider].bin : null;
    this.child = null;
    this.pid = null;
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
      // machine — the same trust as their prompt — and hand-splitting a shell
      // command line is how quoting bugs are born. detached so we can kill the
      // whole group: the shell's *grandchild* is what holds the tunnel, and it
      // survives child.kill().
      this.child = spawn(this.cmd, { shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } else {
      // No shell for a provider binary: --tunnel-args must not be able to
      // start a second process. Same process group, so a terminal ctrl-c
      // reaches the child too.
      this.child = spawn(this.spawnBin, [...rec.argv({ port: this.port, target: this.target }), ...splitArgs(this.args)], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
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
        done(reject, new Error(`${this.label}: no public URL after ${Math.round(this.timeoutMs / 1000)}s.\n${this.output()}`));
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
      // stream is a request that never ends — stop reading and the 64 KB pipe
      // fills and the child blocks forever.
      this.child.stdout.on('data', onChunk);
      this.child.stderr.on('data', onChunk);

      // ENOENT arrives here, asynchronously — not as a throw from spawn().
      // Unhandled it takes the whole process down.
      this.child.on('error', (err) => {
        const hint = rec ? `${rec.bin} is not installed.\n  Install it with:  ${rec.install}` : err.message;
        done(reject, new Error(err.code === 'ENOENT' ? hint : `${this.label}: ${err.message}`));
      });

      this.child.on('exit', (code, signal) => {
        const info = { code, signal, tail: this.output() };
        done(reject, new Error(`${this.label} exited (code ${code}) before publishing.\n${info.tail}`));
        if (!this.stopped) this.emit('exit', info);
      });

      // A URL we were given rather than told: nothing to wait for, but the
      // child still has to be up, so resolve on the next tick rather than
      // synchronously — an immediate spawn failure should still reject.
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
      // the tunnel open after we are gone.
      if (this.cmd) process.kill(-this.pid, 'SIGTERM');
      else this.child.kill('SIGTERM');
    } catch {
      // Already gone. Nothing to do, and nothing worth reporting.
    }
  }
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `node --test test/tunnel.test.js`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tunnel.js test/tunnel.test.js
git commit -m "feat: spawn, drain and stop a tunnel child process"
```

---

### Task 4: Tunnel configuration and its refusals

**Files:**
- Modify: `src/config.js`
- Test: `test/config.test.js`

**Interfaces:**
- Consumes: `parseTtl` from Task 2.
- Produces: `resolve()` returning additionally `{tunnel, tunnelArgs, tunnelCmd, tunnelTtlMs, assumeYes, tty}`; `validate()` throwing `ConfigError` for each refusal.

- [ ] **Step 1: Write the failing tests**

Append to `test/config.test.js`:

```js
/** resolve() for a tunnel run, on a terminal unless told otherwise. */
function tunnelCfg(flags, over = {}) {
  return resolve({ flags, env: {}, file: {}, makeToken: stub, tty: true, ...over });
}

test('a tunnel run carries the token that makes it legal', () => {
  const cfg = validate(tunnelCfg({ tunnel: 'cloudflare' }));
  assert.equal(cfg.tunnel, 'cloudflare');
  assert.equal(cfg.token, 'r'.repeat(32));
  assert.equal(cfg.tunnelTtlMs, null);
});

test('--tunnel with --no-token is refused before anything binds', () => {
  assert.throws(() => validate(tunnelCfg({ tunnel: 'cloudflare', 'no-token': true })), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /--no-token/);
    assert.match(err.message, /source code/, 'the message must say what is being published');
    return true;
  });
});

test('an unknown provider is refused rather than defaulted', () => {
  assert.throws(() => validate(tunnelCfg({ tunnel: 'wireguard' })), /wireguard/);
  assert.throws(() => validate(tunnelCfg({ tunnel: 'wireguard' })), /cloudflare, ngrok/);
});

test('--tunnel and --tunnel-cmd together are refused rather than ranked', () => {
  assert.throws(() => validate(tunnelCfg({ tunnel: 'ngrok', 'tunnel-cmd': 'bore local 4599' })), /--tunnel-cmd/);
});

test('--tunnel-args without a provider is refused, not silently dropped', () => {
  assert.throws(() => validate(tunnelCfg({ 'tunnel-args': '--region us' })), /--tunnel-args/);
  // With --tunnel-cmd too: that string already carries its own arguments.
  assert.throws(
    () => validate(tunnelCfg({ 'tunnel-cmd': 'bore local 4599', 'tunnel-args': '--x' })),
    /--tunnel-args/
  );
});

test('an ambiguous --tunnel-ttl is refused', () => {
  assert.throws(() => validate(tunnelCfg({ tunnel: 'ngrok', 'tunnel-ttl': '30' })), /45s, 30m or 2h/);
  assert.equal(validate(tunnelCfg({ tunnel: 'ngrok', 'tunnel-ttl': '30m' })).tunnelTtlMs, 1_800_000);
});

test('publishing from a non-terminal requires --yes to have been written down', () => {
  // A unit file, a CI job or a background & must never start publishing
  // because nobody was there to be asked.
  assert.throws(() => validate(tunnelCfg({ tunnel: 'cloudflare' }, { tty: false })), /--yes/);
  assert.doesNotThrow(() => validate(tunnelCfg({ tunnel: 'cloudflare', yes: true }, { tty: false })));
});

test('AGENT_CCTV_TUNNEL configures a tunnel the same way the flag does', () => {
  const cfg = validate(
    resolve({ flags: {}, env: { AGENT_CCTV_TUNNEL: 'ngrok', AGENT_CCTV_TUNNEL_ARGS: '--region eu' }, makeToken: stub, tty: true })
  );
  assert.equal(cfg.tunnel, 'ngrok');
  assert.equal(cfg.tunnelArgs, '--region eu');
});

test('no tunnel means no tunnel fields set, and nothing else changes', () => {
  const cfg = validate(bare());
  assert.equal(cfg.tunnel, null);
  assert.equal(cfg.tunnelCmd, null);
  assert.equal(cfg.assumeYes, false);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `node --test test/config.test.js`
Expected: FAIL — `cfg.tunnel` is undefined.

- [ ] **Step 3: Extend `resolve()`**

In `src/config.js`, add the import and the new fields:

```js
import { parseTtl, PROVIDERS } from './tunnel.js';
```

Inside `resolve()`, before the return, add:

```js
  // A tunnel is the same "reachable beyond this machine" fact as a public URL,
  // arriving by a different route — so it goes through the same refusals, and
  // the hostname it will add to the allowlist simply is not known yet.
  const tunnel = flags.tunnel || env.AGENT_CCTV_TUNNEL || null;
  const tunnelCmd = flags['tunnel-cmd'] || null;
  const tunnelArgs = flags['tunnel-args'] || env.AGENT_CCTV_TUNNEL_ARGS || null;
  const tunnelTtlRaw = flags['tunnel-ttl'] || null;
  const assumeYes = flags.yes === true;
```

and add to the returned object:

```js
    tunnel: typeof tunnel === 'string' ? tunnel.toLowerCase() : tunnel,
    tunnelCmd,
    tunnelArgs,
    tunnelTtlRaw,
    tunnelTtlMs: null, // validate() fills this in, so a bad value is a refusal
    assumeYes,
    tty: tty ?? !!process.stdout.isTTY,
```

Change the signature to accept `tty`:

```js
export function resolve({ flags = {}, env = process.env, file = readConfig(), makeToken = newToken, tty = undefined } = {}) {
```

- [ ] **Step 4: Add the refusals to `validate()`**

At the top of `validate(cfg)`, before the existing public-URL rules:

```js
  const publishing = !!(cfg.tunnel || cfg.tunnelCmd);

  if (cfg.tunnel && !Object.hasOwn(PROVIDERS, cfg.tunnel)) {
    throw new ConfigError(
      `Unknown tunnel provider: ${cfg.tunnel}\n` +
        `  Known providers: ${Object.keys(PROVIDERS).join(', ')}\n` +
        `  Anything else goes through --tunnel-cmd '<command>'.`
    );
  }

  if (cfg.tunnel && cfg.tunnelCmd) {
    throw new ConfigError(`--tunnel and --tunnel-cmd both name a way to publish. Pick one.`);
  }

  if (cfg.tunnelArgs && !cfg.tunnel) {
    throw new ConfigError(
      cfg.tunnelCmd
        ? `--tunnel-args needs --tunnel. With --tunnel-cmd, put the arguments in the command itself.`
        : `--tunnel-args needs --tunnel — on its own it would be silently ignored.`
    );
  }

  if (cfg.tunnelTtlRaw) {
    if (!publishing) throw new ConfigError(`--tunnel-ttl needs --tunnel or --tunnel-cmd.`);
    try {
      cfg.tunnelTtlMs = parseTtl(cfg.tunnelTtlRaw);
    } catch (err) {
      throw new ConfigError(err.message);
    }
  }

  if (publishing && !cfg.token) {
    throw new ConfigError(
      `--no-token cannot be combined with a tunnel.\n` +
        `  A tunnel puts this dashboard on the public internet, and it serves your\n` +
        `  transcripts, which contain source code. Drop --no-token.`
    );
  }

  if (publishing && !cfg.tty && !cfg.assumeYes) {
    throw new ConfigError(
      `Refusing to publish from a non-interactive session without --yes.\n` +
        `  There is nobody here to confirm that putting this machine's transcripts\n` +
        `  on the internet is intended. Add --yes to say so in writing.`
    );
  }
```

- [ ] **Step 5: Run and watch it pass**

Run: `node --test test/config.test.js`
Expected: PASS.

- [ ] **Step 6: Run the full suite** — the existing config tests must be untouched by this.

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/config.js test/config.test.js
git commit -m "feat: resolve and refuse tunnel configuration"
```

---

### Task 5: The server's tunnel slot

**Files:**
- Modify: `src/server.js:50-62` (host/origin), `:90-103` (constructor), `:199-209` (cookie), `:227-232` (health), `:239` and `:301` (snapshot), `:377-383` (exports)
- Test: `test/server.test.js`

**Interfaces:**
- Produces: `server.setTunnel({host, provider, url, since} | null)`; `/api/health` → `{ok, capabilities, tunnel}`; `/api/state` and the SSE `snapshot` frame → `{...store.snapshot(), tunnel}`; SSE event `tunnel`.

- [ ] **Step 1: Write the failing tests**

Append to `test/server.test.js`:

```js
test('a tunnel host is allowed only while the tunnel is up', async () => {
  const s = await serve({ token: TOKEN });
  try {
    const before = await s.raw('/api/health', { host: 'demo.trycloudflare.com' });
    assert.equal(before.status, 403, 'an unknown host is refused before a tunnel exists');

    s.server.setTunnel({ host: 'demo.trycloudflare.com', provider: 'cloudflare', url: 'https://demo.trycloudflare.com', since: Date.now() });
    const during = await s.raw('/api/health', { host: 'demo.trycloudflare.com' });
    assert.equal(during.status, 200);

    s.server.setTunnel(null);
    const after = await s.raw('/api/health', { host: 'demo.trycloudflare.com' });
    assert.equal(after.status, 403, 'closing the tunnel closes the door behind it');
  } finally {
    await s.close();
  }
});

test('loopback stays allowed while a tunnel is up', async () => {
  const s = await serve({ token: TOKEN });
  try {
    s.server.setTunnel({ host: 'demo.trycloudflare.com', provider: 'cloudflare', url: 'https://demo.trycloudflare.com', since: Date.now() });
    const res = await s.raw('/api/health', { host: 'localhost' });
    assert.equal(res.status, 200);
  } finally {
    await s.close();
  }
});

test('Secure follows the host the request actually arrived on', async () => {
  // The tunnel edge is https and loopback is not, in the same run. One
  // construction-time boolean is wrong in one direction or the other.
  const s = await serve({ token: TOKEN });
  try {
    s.server.setTunnel({ host: 'demo.trycloudflare.com', provider: 'cloudflare', url: 'https://demo.trycloudflare.com', since: Date.now() });

    const viaTunnel = await s.raw(`/api/state?token=${TOKEN}`, { host: 'demo.trycloudflare.com' });
    assert.equal(viaTunnel.status, 200);
    const local = await s.raw(`/api/state?token=${TOKEN}`, { host: '127.0.0.1' });
    assert.equal(local.status, 200);
  } finally {
    await s.close();
  }
});

test('/api/health reports that a tunnel exists but never its URL', async () => {
  const s = await serve({ token: TOKEN });
  try {
    s.server.setTunnel({ host: 'demo.trycloudflare.com', provider: 'cloudflare', url: 'https://demo.trycloudflare.com', since: 1754400000000 });
    const res = await fetch(s.url('/api/health'));
    const body = await res.json();
    assert.equal(body.tunnel.provider, 'cloudflare');
    assert.equal(body.tunnel.since, 1754400000000);
    assert.equal(body.tunnel.url, undefined, 'the URL is not for an endpoint that needs no credential');
    assert.equal(body.tunnel.host, undefined);
  } finally {
    await s.close();
  }
});

test('/api/state carries the tunnel, so the dashboard learns of it authenticated', async () => {
  const s = await serve({ token: TOKEN });
  try {
    s.server.setTunnel({ host: 'demo.trycloudflare.com', provider: 'cloudflare', url: 'https://demo.trycloudflare.com', since: 1754400000000 });
    const res = await fetch(s.url(`/api/state?token=${TOKEN}`));
    const body = await res.json();
    assert.equal(body.tunnel.host, 'demo.trycloudflare.com');
    assert.equal(body.tunnel.url, 'https://demo.trycloudflare.com');
    assert.ok(Array.isArray(body.sessions), 'the sessions snapshot is still there');
  } finally {
    await s.close();
  }
});
```

The `Secure` assertions need the raw helper to return headers. Extend `serve()`'s `raw` in the same file:

```js
    raw: (path, headers = {}) =>
      new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
        });
        req.on('error', reject);
        req.end();
      }),
```

and finish the `Secure` test's assertions:

```js
    assert.match(String(viaTunnel.headers['set-cookie']), /Secure/i);
    assert.doesNotMatch(String(local.headers['set-cookie']), /Secure/i);
```

- [ ] **Step 2: Run and watch it fail**

Run: `node --test test/server.test.js`
Expected: FAIL — `server.setTunnel is not a function`.

- [ ] **Step 3: Add the slot**

In `createServer`, after the `allowed` Set is built:

```js
  /*
    One slot, not another allowlist entry. A tunnel's hostname is not known
    until its child process prints it, and a re-opened quick tunnel comes back
    on a different one — so the set would accumulate dead hostnames across
    restarts, and a bug in the remove path could evict loopback from its own
    allowlist. A slot cannot do either: it holds one hostname or nothing.
  */
  let tunnel = null;
```

Change the host and origin checks to take the slot (they are module-level functions, so pass it):

```js
function hostAllowed(req, allowed, tunnelHost) {
  const h = hostname(req.headers.host);
  return allowed.has(h) || (!!tunnelHost && h === tunnelHost);
}

function originAllowed(req, allowed, tunnelHost) {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin navigations and curl send none
  try {
    const h = hostname(new URL(origin).hostname);
    return allowed.has(h) || (!!tunnelHost && h === tunnelHost);
  } catch {
    return false;
  }
}
```

and at the two call sites:

```js
    if (!hostAllowed(req, allowed, tunnel?.host)) return json(res, 403, { error: 'bad host' });
    if (!originAllowed(req, allowed, tunnel?.host)) return json(res, 403, { error: 'bad origin' });
```

- [ ] **Step 4: Make `Secure` a per-request decision**

Replace the `set-cookie` block:

```js
  /*
    Secure is decided per request, not per process. With a tunnel up, the same
    server answers https at the tunnel's edge and plain http on loopback in the
    same run — an unconditional Secure would never reach a local browser, and an
    unconditional plain cookie would travel a public URL without it. The host is
    what tells us which we are on; X-Forwarded-Proto would mean trusting whoever
    sent it.
  */
  function secureFor(req) {
    const h = hostname(req.headers.host);
    if (tunnel?.host && h === tunnel.host) return true;
    return secureCookie;
  }
```

and use it:

```js
      res.setHeader(
        'set-cookie',
        `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_S}` +
          (secureFor(req) ? '; Secure' : '')
      );
```

- [ ] **Step 5: Surface it on the three endpoints**

Health:

```js
    if (route === '/api/health') {
      // Unauthenticated on purpose: load balancers and alerting rules need it.
      // `capabilities` is included so operators can alert on a Claude Code
      // update having moved the internals out from under us; `tunnel` so they
      // can alert on a box that is unexpectedly publishing. The URL is left
      // out — knowing one exists is an operational fact, and the address is a
      // credential-adjacent one.
      return json(res, 200, {
        ok: true,
        capabilities: store.capabilities,
        tunnel: tunnel ? { provider: tunnel.provider, since: tunnel.since } : null,
      });
    }
```

A snapshot helper beside `broadcast`, and the two places that send one:

```js
  /** The store is about sessions; a tunnel is not one. Merged here instead. */
  const snapshot = () => ({ ...store.snapshot(), tunnel });
```

```js
    if (route === '/api/state') return json(res, 200, snapshot());
```

```js
      res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
```

And the setter, next to the other `server.*` assignments at the end:

```js
  /** The tunnel's whole interface to the server: one hostname, or none. */
  server.setTunnel = (t) => {
    tunnel = t
      ? { ...t, host: String(t.host).trim().toLowerCase().replace(/^\[|\]$/g, '') }
      : null;
    broadcast('tunnel', tunnel);
    return tunnel;
  };
```

- [ ] **Step 6: Run and watch it pass**

Run: `node --test test/server.test.js`
Expected: PASS. The pre-existing `Secure is set only when the deployment is https` test must still pass — `secureCookie` keeps its meaning when no tunnel is up.

- [ ] **Step 7: Commit**

```bash
git add src/server.js test/server.test.js
git commit -m "feat: a tunnel slot the host check and the cookie both read"
```

---

### Task 6: Wire it into the CLI

**Files:**
- Modify: `bin/cctv.js` (HELP, `cmdStart`, shutdown)
- Test: `test/cli.test.js`

**Interfaces:**
- Consumes: `Tunnel` (Task 3), tunnel config fields (Task 4), `server.setTunnel` (Task 5).

- [ ] **Step 1: Write the failing tests**

Append to `test/cli.test.js`:

```js
test('a tunnel from a non-terminal without --yes is refused, and nothing binds', () => {
  const r = run(['--tunnel', 'cloudflare']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--yes/);
  assert.doesNotMatch(r.stderr + r.stdout, /watching/, 'the banner must not have printed');
});

test('an unknown provider names the ones that exist', () => {
  const r = run(['--tunnel', 'wireguard', '--yes']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cloudflare, ngrok/);
});

test('--tunnel with --no-token is refused', () => {
  const r = run(['--tunnel', 'cloudflare', '--yes', '--no-token']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--no-token/);
});

test('a tunnel command that never publishes fails with what the child printed', () => {
  const script = "console.error('edge unreachable'); setInterval(() => {}, 1000);";
  const r = run([
    '--tunnel-cmd', `${process.execPath} -e ${JSON.stringify(script)}`,
    '--tunnel-ttl', '1h',
    '--yes',
  ]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /edge unreachable/);
});
```

Note `run()` already appends `--no-open` and uses `spawnSync` with a 10 s timeout; the scrape timeout must therefore be overridable. Add `AGENT_CCTV_TUNNEL_TIMEOUT_MS` support in `cmdStart` (documented as a test seam, not in `--help`) and set it in `run()`'s env:

```js
    const env = { ...process.env, AGENT_CCTV_HOME: home, AGENT_CCTV_CLAUDE_DIR: claudeDir, AGENT_CCTV_TUNNEL_TIMEOUT_MS: '1500' };
```

- [ ] **Step 2: Run and watch it fail**

Run: `node --test test/cli.test.js`
Expected: FAIL — no refusal, the server starts.

- [ ] **Step 3: Add the confirmation gate**

In `bin/cctv.js`, add near the other helpers:

```js
import readline from 'node:readline';

/**
 * The one place a person is asked. Everything else about this feature is
 * mechanism; this is the part that makes publishing a decision rather than a
 * typo. --yes skips it, and a non-TTY without --yes was already refused in
 * validate(), so reaching here means somebody is watching.
 */
async function confirmPublish(cfg) {
  if (cfg.assumeYes) return true;
  const what = cfg.tunnel ? `${cfg.tunnel} (${cfg.tunnel === 'ngrok' ? 'ngrok' : 'cloudflared'})` : cfg.tunnelCmd;
  console.log('');
  console.log(`  ${c.yellow('This publishes the dashboard on the public internet.')}`);
  console.log('');
  console.log(`  Anyone with the link and its token can read every session on this`);
  console.log(`  machine — including the source code your agents are working on.`);
  console.log('');
  console.log(`  ${c.dim('through')}  ${what}`);
  console.log(`  ${c.dim('guarded by')}  a ${cfg.token.length}-character token in the link`);
  console.log('');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question(`  Type ${c.bold('yes')} to publish: `, r));
  rl.close();
  return answer.trim().toLowerCase() === 'yes';
}
```

- [ ] **Step 4: Start the tunnel after the bind, and tear it down with the server**

In `cmdStart`, after `validate(resolve({flags}))` and the `--<name> requires a value` loop (add `tunnel`, `tunnel-cmd`, `tunnel-args`, `tunnel-ttl` to that loop's list), and **before** `start({...})`:

```js
  if ((cfg.tunnel || cfg.tunnelCmd) && !(await confirmPublish(cfg))) {
    console.log(c.dim('\n  Nothing was published. Run without --tunnel for the local wall.\n'));
    return;
  }
```

After the server is listening and `writeConfig` has run, before the banner:

```js
  let tunnel = null;
  if (cfg.tunnel || cfg.tunnelCmd) {
    tunnel = new Tunnel({
      provider: cfg.tunnel,
      cmd: cfg.tunnelCmd,
      args: cfg.tunnelArgs,
      port,
      host,
      publicUrl: cfg.publicUrlRaw,
      timeoutMs: Number(process.env.AGENT_CCTV_TUNNEL_TIMEOUT_MS) || undefined,
    });
    try {
      const { url, host: tunnelHost } = await tunnel.start();
      server.setTunnel({ host: tunnelHost, provider: cfg.tunnel || 'custom', url, since: Date.now() });
      publicBase = url.endsWith('/') ? url : url + '/';
    } catch (err) {
      // A startup failure means the thing the operator asked for did not
      // happen and nothing was published — so it is an exit, not a warning. A
      // failure AFTER publishing is the opposite case; see the exit handler.
      tunnel.stop();
      server.close();
      console.error('');
      console.error(`  ${c.red('✗')} ${err.message}`);
      console.error('');
      process.exitCode = 1;
      return;
    }

    // Not a restart: a re-opened quick tunnel comes back on a different
    // hostname, so retrying cannot revive the link anyone was already sent. The
    // wall keeps running locally, because there may well be someone watching it.
    tunnel.on('exit', (info) => {
      server.setTunnel(null);
      console.log('');
      console.log(`  ${c.yellow('!')} the tunnel closed${info.code == null ? '' : ` (code ${info.code})`} — that link is dead now.`);
      console.log(`  ${c.dim('the wall is still running locally. re-run with --tunnel to publish again.')}`);
      console.log('');
    });

    if (cfg.tunnelTtlMs) {
      setTimeout(() => {
        console.log(c.dim(`\n  --tunnel-ttl reached — closing the tunnel. The wall stays up.\n`));
        tunnel.stop();
      }, cfg.tunnelTtlMs).unref();
    }
  }
```

Declare `let publicBase = null;` above, and use it in the banner. Replace the banner's URL section so the public link is printed separately, once, and without the token on the shareable line:

```js
  if (publicBase) {
    console.log('');
    console.log(`  ${c.yellow('public')}  ${c.cyan(publicBase)}`);
    console.log(`  ${c.dim('send this one, with its token, to one person — not a channel:')}`);
    console.log(`  ${c.dim(publicBase + (token ? `?token=${token}` : ''))}`);
    if (cfg.tunnel === 'ngrok') {
      console.log(c.dim('  ngrok free shows a click-through page first; the link still works after it.'));
    }
  }
```

Extend `shutdown` to stop the child before closing the server:

```js
  const shutdown = () => {
    console.log(c.dim('\n  stopping…'));
    tunnel?.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
```

Add the import: `import { Tunnel } from '../src/tunnel.js';`

- [ ] **Step 5: Update `--help`**

Add to `Options` and `Environment` in `HELP`:

```
  --tunnel <name>     Publish through cloudflare or ngrok  ${c.dim('(needs the binary installed)')}
  --tunnel-cmd <cmd>  Publish through any command that opens a tunnel
  --tunnel-args <a>   Extra arguments for the provider binary
  --tunnel-ttl <30m>  Close the tunnel after this long; the wall keeps running
  --yes               Skip the confirmation ${c.dim('(required when not on a terminal)')}
```

```
  AGENT_CCTV_TUNNEL      Same as --tunnel
  AGENT_CCTV_TUNNEL_ARGS Same as --tunnel-args
```

- [ ] **Step 6: Run and watch it pass**

Run: `node --test test/cli.test.js`
Expected: PASS.

- [ ] **Step 7: Try it by hand, against a fake tunnel**

Run:

```bash
node bin/cctv.js --no-open --yes --tunnel-cmd "node -e \"console.log('https://demo.example.net'); setInterval(()=>{},1000)\"" --tunnel-ttl 60s
```

Expected: the banner prints a `public https://demo.example.net` line and a tokened link; `curl -s -H 'Host: demo.example.net' http://127.0.0.1:4599/api/health` returns 200 with `"tunnel":{"provider":"custom",…}` and no `url`; ctrl-c leaves no `node -e` process behind (`pgrep -f "setInterval"`).

- [ ] **Step 8: Commit**

```bash
git add bin/cctv.js test/cli.test.js
git commit -m "feat: publish the wall through a tunnel, on purpose"
```

---

### Task 7: Say so in the dashboard

**Files:**
- Modify: `public/index.html` (inside `.bar-status`), `public/styles.css`, `public/app.js`
- Test: `test/spa-guard.test.js` (must keep passing), `npm test`

**Interfaces:**
- Consumes: SSE `tunnel` event and `snapshot.tunnel` (Task 5).

- [ ] **Step 1: Add the badge to the region that already exists for machine state**

In `public/index.html`, inside `<div class="bar-status">`, before the clock:

```html
        <!-- Only ever present while a tunnel is up, which is why it lives in
             this region rather than becoming a seventh one: a new region would
             need its own shed tier and hairline to display something that is
             absent almost always. -->
        <div class="public-badge" id="public-badge" hidden>
          <svg class="i" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="8.5" />
            <path d="M3.5 12h17M12 3.5a13 13 0 0 1 0 17M12 3.5a13 13 0 0 0 0 17" />
          </svg>
          <span class="clips" id="public-host">public</span>
        </div>
```

- [ ] **Step 2: Style it**

In `public/styles.css`, beside the other `.bar-status` rules:

```css
/*
  --ember-ink, not --tally-ink. The red is the wall's "a session needs you"
  signal and it is the only thing on screen allowed to mean that; a second
  permanent red in the same bar would cost the first one its meaning. Ember is
  a warning that reads as a warning without competing.
*/
.public-badge {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--ember-ink);
}

.public-badge[hidden] {
  display: none;
}
```

Both palette blocks matter: check whether `--ember-ink` is defined in the light
theme too (`grep -n 'ember' public/styles.css`) and add the light value beside
the other `-ink` overrides if it is missing.

- [ ] **Step 3: Wire it to the stream**

In `public/app.js`, next to the other element lookups, add:

```js
const publicBadge = document.getElementById('public-badge');
const publicHost = document.getElementById('public-host');
```

(`public/app.js` has no `$` helper — `const link = document.getElementById('link')` at line 48 is the house style.)

Add the renderer near `setLink`:

```js
/**
 * The wall says nothing about who can see it, which is fine while the answer
 * is "this machine". Once a tunnel is up the answer is "the internet", and the
 * person staring at the wall all day is the one most likely to forget.
 */
function setTunnel(t) {
  publicBadge.hidden = !t;
  if (!t) return;
  publicHost.textContent = t.host || 'public';
  publicBadge.title = `Published at ${t.url || t.host} — anyone with the link and its token can read these sessions.`;
}
```

Call it from the snapshot handler and its own event:

```js
  es.addEventListener('snapshot', (e) => {
    const data = JSON.parse(e.data);
    setTunnel(data.tunnel);
    /* …existing body… */
  });

  es.addEventListener('tunnel', (e) => setTunnel(JSON.parse(e.data)));
```

- [ ] **Step 4: Run the guards**

Run: `npm test`
Expected: PASS — in particular `test/spa-guard.test.js` (this uses `textContent` only) and `test/header-markup.test.js` (the badge is a `<div>`, so the icon-only-*button* rule does not apply, and no readout or mode was touched).

- [ ] **Step 5: See it**

Run the fake-tunnel command from Task 6 Step 7 without `--no-open`, and confirm the badge appears at the right of the bar with the hostname, that the bar is still one row at 1280px and at 900px, and that it disappears when the tunnel's TTL closes it.

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/styles.css public/app.js
git commit -m "feat: the wall says when it is public"
```

---

### Task 8: Documentation and the deployment example

**Files:**
- Create: `deploy/agent-cctv-tunnel.service.example`
- Modify: `README.md` (after the "Running it for a team" section), `CLAUDE.md` (Architecture + Constraints)

- [ ] **Step 1: Write the systemd example**

`deploy/agent-cctv-tunnel.service.example`:

```ini
# A permanently published wall: a NAMED cloudflared tunnel, which keeps a
# hostname you own across restarts. Quick tunnels are the other shape — a
# throwaway hostname, opened by hand, for minutes — and are not what a unit
# file is for.
#
# The named tunnel prints no URL anywhere (its hostname lives in your
# Cloudflare DNS), so AGENT_CCTV_PUBLIC_URL is not optional here: it is where
# agent-cctv learns the hostname to allow.
#
# Put Cloudflare Access in front of the hostname. agent-cctv's token says
# "somebody with the link"; Access says which person, and writes it down.

[Unit]
Description=agent-cctv (published)
After=network-online.target

[Service]
Type=simple
User=agents
EnvironmentFile=/etc/agent-cctv.env
# --yes because there is no terminal here to confirm on. Writing it out is the
# point: a unit file that publishes says so on its own ExecStart line.
ExecStart=/usr/bin/agent-cctv --no-open --yes \
  --tunnel cloudflare \
  --tunnel-args "run my-wall"
Restart=on-failure
RestartSec=5
StateDirectory=agent-cctv
Environment=AGENT_CCTV_HOME=/var/lib/agent-cctv

[Install]
WantedBy=multi-user.target
```

And the env fragment it reads, in the same file as a comment block or appended to `deploy/agent-cctv.env.example`:

```sh
AGENT_CCTV_TOKEN=<openssl rand -hex 32>
AGENT_CCTV_PUBLIC_URL=https://cctv.example.com
```

- [ ] **Step 2: Write the README section**

Add after "Running it for a team", in the README's existing voice:

```markdown
## Putting it on the internet

Two shapes, one flag.

**For ten minutes.** `agent-cctv --tunnel cloudflare` opens a Cloudflare quick
tunnel and prints a public https link. No account, no DNS, no proxy. It asks
you to type `yes` first, because of what the next paragraph says. `--tunnel
ngrok` does the same through ngrok, and `--tunnel-cmd '<command>'` through
anything else that prints a URL. `--tunnel-ttl 30m` closes it again without
you having to remember.

**For good.** Point `--tunnel-args` at a named tunnel or a reserved domain and
set `AGENT_CCTV_PUBLIC_URL` to the hostname you own — a named cloudflared
tunnel prints no URL anywhere, so that variable is how agent-cctv learns which
hostname to allow. See `deploy/agent-cctv-tunnel.service.example`.

Either way, the trust model does not change and it is worth reading twice:

> Everyone who can reach agent-cctv can read every session's full transcript,
> including source code. There is no per-user filtering.

On loopback, "everyone" means you. Through a tunnel it means anyone holding
the link, which is a bearer credential that survives being pasted into a
channel or a screenshot. agent-cctv refuses to publish without a token and
refuses to publish from a script without `--yes`, but it cannot un-send a URL.
If you want to know *which person* read the wall, put Cloudflare Access or
your own SSO in front of a hostname you own — the token says "somebody".

The dashboard shows a `public` badge in the top-right for as long as a tunnel
is up. If a tunnel drops, the link is dead — a re-opened quick tunnel comes
back on a different hostname — and the wall keeps running locally.
```

- [ ] **Step 3: Update `CLAUDE.md`**

Add to Architecture, after the Server section:

```markdown
### Tunnels (`src/tunnel.js`)

`--tunnel` spawns a provider binary the operator already installed and scrapes
the public URL out of its output. Provider records are data (argv builder + URL
matcher) because the matchers are the part most likely to break under us:
neither cloudflared's banner nor ngrok's log schema is an interface. When one
changes, `--public-url` is the path that keeps working — and it is also the
*only* path for a named cloudflared tunnel, which prints no URL at all.

The server holds one tunnel **slot**, not another allowlist entry
(`setTunnel`). A re-opened quick tunnel returns on a different hostname, so a
set would accumulate dead ones, and a bug in the remove path could evict
loopback from its own allowlist. There is deliberately no respawn: a new
hostname cannot revive the link somebody was already sent.
```

Add to Constraints:

```markdown
- `Secure` on the auth cookie is a **per-request** decision (`secureFor`), not a
  process-wide one — with a tunnel up, https at the edge and plain http on
  loopback are the same run. It keys off the request's `Host`, never
  `X-Forwarded-Proto`, which anyone can send.
- No test may spawn `cloudflared` or `ngrok`. Provider records are data; the
  process machinery is tested through `--tunnel-cmd` with `node` as the child.
```

- [ ] **Step 4: Run everything one last time**

Run: `npm test`
Expected: PASS, all files.

Run: `node bin/cctv.js --help`
Expected: the five new options appear and the existing ones are unchanged.

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md deploy/
git commit -m "docs: how to publish the wall, and what it costs"
```

---

### Task 9: Merge

- [ ] **Step 1: Full suite, one more time**

Run: `npm test`
Expected: PASS.

- [ ] **Step 2: Merge with a summarizing commit**

```bash
git checkout main
git merge --no-ff feat/public-tunnels
```

The merge commit body should say what the feature is, and record the two
decisions a future reader will otherwise re-litigate: why there is no respawn,
and why `--public-url` is the path that always works.
