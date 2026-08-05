# agent-cctv Self-Hosted Team Deployment — Implementation Plan (Release 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a company run `agent-cctv` on a shared server behind their own reverse proxy, authenticated by a stable token, without changing anything about the single-developer `npx agent-cctv` experience.

**Architecture:** No new modes. A new `src/config.js` resolves settings in the order flags → environment → config file → defaults, and refuses to start on four dangerous combinations. `src/server.js` gains a configurable Host/Origin allowlist, authentication on `/ingest` (currently missing), and cookie-based auth so the token stops riding in the query string. The reader — sources, tailer, store, liveness, history — is not touched at all.

**Tech Stack:** Node ≥18, ESM, zero runtime dependencies, `node:test` + `node:assert/strict`, plain `node:http`.

**Spec:** `docs/superpowers/specs/2026-08-05-self-hosted-deployment-design.md`

## Global Constraints

- Node ≥18. ESM only (`"type": "module"`). MIT.
- **Zero runtime dependencies.** Do not add a package to `dependencies` for any reason. `devDependencies` must also stay empty — tests use `node:test`.
- **The individual experience must not regress.** `npx agent-cctv` with no environment set must behave exactly as it does today: bind `127.0.0.1`, mint a random per-run token, open a browser.
- **Read-only.** Do not add any endpoint that acts on a session (kill, answer prompt, send input). This is what makes a shared token proportionate.
- The reader is out of scope: do not modify `src/sources/**`, `src/tail.js`, `src/store.js`, `src/liveness.js`, or `src/history.js`.
- Tests run with `npm test` → `node --test "test/*.test.js"`.
- Minimum token length is **16** characters, defined once as `MIN_TOKEN_LENGTH` in `src/config.js`.

## Deliberate divergences from the spec

Two, both found while writing the plan. Neither changes the delivered behaviour.

1. **`src/paths.js` is not modified.** The spec has it read `AGENT_CCTV_TOKEN`,
   `AGENT_CCTV_PUBLIC_URL`, and `AGENT_CCTV_HOST`. Putting them there would split
   environment handling across two modules, and `paths.js` would be reading settings that
   are not paths. `src/config.js` reads them instead, so one module owns the whole
   precedence chain and can be tested by passing an `env` object. `paths.js` keeps its
   existing `AGENT_CCTV_HOME`/`_CLAUDE_DIR`/`_CODEX_DIR` path overrides.

2. **The two refusal rows about a tokenless public bind are one condition.** The spec lists
   "non-loopback and no token" and "`--no-token` with a non-loopback bind" separately. They
   are the same predicate; the implementation branches only on the error *message*, so the
   one naming `--no-token` appears when that flag caused it. Both are tested separately.

---

### Task 1: Initialize the repository

The project directory is not a git repository (`git rev-parse` fails). Every later task ends in a commit, so this has to come first.

**Files:**
- Create: `.gitignore`

**Interfaces:**
- Consumes: nothing
- Produces: a git repository with a clean initial commit, so all later `git commit` steps work

- [ ] **Step 1: Confirm the repository really is uninitialized**

Run: `git rev-parse --is-inside-work-tree`
Expected: `fatal: not a git repository`. If it instead prints `true`, skip this entire task — it is already done.

- [ ] **Step 2: Create `.gitignore`**

```
node_modules/
.DS_Store
*.log
```

- [ ] **Step 3: Initialize and make the first commit**

```bash
git init
git add -A
git commit -m "chore: initial commit of agent-cctv at v0.1.0"
```

- [ ] **Step 4: Verify**

Run: `git log --oneline -1 && git status --porcelain`
Expected: one commit listed, and empty output from `status` (nothing uncommitted).

---

### Task 2: Authenticate `/ingest`

`/ingest` is handled at `src/server.js:120`, *before* the auth gate at `:142`, so it accepts unauthenticated POSTs. `src/store.js:125-131` mints a session — each holding a `Ring(400)` — for any `sessionId` it has not seen, so a POST loop grows memory without bound. This is a live defect on developer machines today, not only on servers.

This task also establishes the HTTP test harness that every later task reuses. There is currently no HTTP test in the suite.

**Files:**
- Create: `test/helpers/env.js`
- Create: `test/server.test.js`
- Modify: `src/server.js` (the `/ingest` branch beginning at line 120)

**Interfaces:**
- Consumes: `createServer({ store, token, withSource })` from `src/server.js` — already exists and already supports `withSource: false`
- Produces: `serve(opts) -> { port, url(path), close() }` test helper in `test/server.test.js`, and `TEST_HOME` from `test/helpers/env.js`

- [ ] **Step 1: Create the environment isolation helper**

`src/paths.js` reads `AGENT_CCTV_HOME` at module load, and the server's `listening` handler calls `drainSpool()`, which would otherwise read the developer's real `~/.agent-cctv/spool.jsonl` into the test store. ESM evaluates imports in order, so importing this file *before* any `src/` module is what makes the override take effect.

Create `test/helpers/env.js`:

```js
// Must be imported BEFORE any src/ module. src/paths.js reads these environment
// variables at module load, and ESM evaluates imports in source order.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cctv-test-home-'));
process.env.AGENT_CCTV_HOME = TEST_HOME;
```

- [ ] **Step 2: Write the failing tests**

Create `test/server.test.js`:

```js
import './helpers/env.js'; // must come first — see the file's comment
import { test } from 'node:test';
import assert from 'node:assert/strict';

import http from 'node:http';
import { createServer } from '../src/server.js';
import { Store } from '../src/store.js';

const TOKEN = 'k'.repeat(32);

/*
  Two request functions on purpose. Node's fetch() silently REWRITES the Host
  header to the real target — verified: sending `host: evil.example` arrives as
  `127.0.0.1:<port>`. Any allowlist test written with fetch is therefore
  meaningless. node:http passes Host through verbatim, so Host-header tests use
  raw(). Origin is passed through by fetch correctly, so everything else can
  use the friendlier API.
*/

/** Start a server on an ephemeral port with no filesystem sources attached. */
async function serve(opts = {}) {
  const server = createServer({ store: new Store(), withSource: false, ...opts });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    server,
    url: (p) => `http://127.0.0.1:${port}${p}`,
    /** A request whose Host header is actually what you asked for. */
    raw: (path, headers = {}) =>
      new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.end();
      }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function hookEnvelope(sessionId) {
  return JSON.stringify({
    source: 'claude-code',
    receivedAt: Date.now(),
    pid: 1234,
    payload: { session_id: sessionId, hook_event_name: 'SessionStart', cwd: '/tmp/x' },
  });
}

test('/ingest refuses a POST with no token', async () => {
  const s = await serve({ token: TOKEN });
  try {
    const res = await fetch(s.url('/ingest'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: hookEnvelope('11111111-1111-1111-1111-111111111111'),
    });
    assert.equal(res.status, 401);
  } finally {
    await s.close();
  }
});

test('an unauthenticated /ingest cannot create a session', async () => {
  const store = new Store();
  const s = await serve({ store, token: TOKEN });
  try {
    await fetch(s.url('/ingest'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: hookEnvelope('22222222-2222-2222-2222-222222222222'),
    });
    assert.equal(store.sessions.size, 0, 'a rejected POST must not allocate a session');
  } finally {
    await s.close();
  }
});

test('/ingest accepts a POST carrying x-cctv-token', async () => {
  const s = await serve({ token: TOKEN });
  try {
    const res = await fetch(s.url('/ingest'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cctv-token': TOKEN },
      body: hookEnvelope('33333333-3333-3333-3333-333333333333'),
    });
    assert.equal(res.status, 202);
  } finally {
    await s.close();
  }
});

test('/ingest is open when the server runs without a token', async () => {
  const s = await serve({ token: null });
  try {
    const res = await fetch(s.url('/ingest'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: hookEnvelope('44444444-4444-4444-4444-444444444444'),
    });
    assert.equal(res.status, 202);
  } finally {
    await s.close();
  }
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test test/server.test.js`
Expected: FAIL. The first two tests fail because an untokened POST currently returns `202` and creates a session. The last two should already pass.

- [ ] **Step 4: Add the auth check**

In `src/server.js`, inside the `/ingest` branch, add the gate as the first line of the block:

```js
    // Optional hook ingestion. Enrichment only — the registry still wins on state.
    if (route === '/ingest' && req.method === 'POST') {
      // Before the generic /api/ gate below, so this needs its own check. An open
      // /ingest lets any local process mint sessions, and each one costs a Ring(400).
      if (!authed(req, url)) return json(res, 401, { error: 'token required' });
      try {
```

Leave the rest of the block unchanged. `src/hook.js:87` already sends `x-cctv-token`, so the hook path keeps working.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/server.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS. No existing test touches `/ingest` over HTTP, so nothing should break.

- [ ] **Step 7: Commit**

```bash
git add test/helpers/env.js test/server.test.js src/server.js
git commit -m "fix: require the token on /ingest

An unauthenticated /ingest let any local process mint sessions, each
costing a Ring(400) of event history — unbounded memory growth. The
hook reporter already sends x-cctv-token, so nothing on that path
changes."
```

---

### Task 3: Config resolution and refusal rules

**Files:**
- Create: `src/config.js`
- Create: `test/config.test.js`
- Modify: `src/server.js:264-266` (move `newToken` out, re-export it)

**Interfaces:**
- Consumes: `DEFAULT_PORT`, `DEFAULT_HOST`, `readConfig` from `src/paths.js`
- Produces:
  - `newToken() -> string` (32 hex characters)
  - `MIN_TOKEN_LENGTH: 16`
  - `isLoopback(host: string) -> boolean`
  - `class ConfigError extends Error`
  - `resolve({ flags, env, file, makeToken }) -> Config`
  - `validate(cfg: Config) -> Config` (throws `ConfigError`)
  - `Config = { port: number, host: string, token: string|null, noToken: boolean, publicUrlRaw: string|null, publicHost: string|null, secureCookie: boolean, openBrowser: boolean, allowedHosts: string[] }`

- [ ] **Step 1: Write the failing tests**

Create `test/config.test.js`:

```js
import './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolve, validate, ConfigError, isLoopback, MIN_TOKEN_LENGTH } from '../src/config.js';

const GOOD = 't'.repeat(MIN_TOKEN_LENGTH);
const stub = () => 'r'.repeat(32);

/** resolve() with nothing configured anywhere — the individual's default path. */
function bare(over = {}) {
  return resolve({ flags: {}, env: {}, file: {}, makeToken: stub, ...over });
}

test('defaults reproduce the current single-developer behaviour', () => {
  const cfg = bare();
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.port, 4599);
  assert.equal(cfg.token, 'r'.repeat(32), 'a random token is minted when none is configured');
  assert.equal(cfg.openBrowser, true);
  assert.equal(cfg.publicHost, null);
  assert.equal(cfg.secureCookie, false);
  assert.deepEqual(cfg.allowedHosts, ['localhost', '127.0.0.1', '::1']);
});

test('precedence runs flags over env over file over defaults', () => {
  assert.equal(bare({ flags: { port: '1' }, env: { AGENT_CCTV_PORT: '2' }, file: { port: 3 } }).port, 1);
  assert.equal(bare({ env: { AGENT_CCTV_PORT: '2' }, file: { port: 3 } }).port, 2);
  assert.equal(bare({ file: { port: 3 } }).port, 3);
  assert.equal(bare().port, 4599);
});

test('AGENT_CCTV_TOKEN is used instead of minting a random one', () => {
  assert.equal(bare({ env: { AGENT_CCTV_TOKEN: GOOD } }).token, GOOD);
});

test('--no-token yields a null token', () => {
  assert.equal(bare({ flags: { 'no-token': true } }).token, null);
  assert.equal(bare({ flags: { token: false } }).token, null);
});

test('--no-open suppresses the browser', () => {
  assert.equal(bare({ flags: { 'no-open': true } }).openBrowser, false);
  assert.equal(bare({ flags: { open: false } }).openBrowser, false);
});

test('a public URL contributes its hostname to the allowlist', () => {
  const cfg = bare({ env: { AGENT_CCTV_PUBLIC_URL: 'https://cctv.corp.example' } });
  assert.equal(cfg.publicHost, 'cctv.corp.example');
  assert.equal(cfg.secureCookie, true);
  assert.deepEqual(cfg.allowedHosts, ['localhost', '127.0.0.1', '::1', 'cctv.corp.example']);
});

test('a plain-http public URL does not ask for a Secure cookie', () => {
  // An unconditional Secure cookie is never returned over http, which would
  // break every non-TLS deployment.
  assert.equal(bare({ env: { AGENT_CCTV_PUBLIC_URL: 'http://box.internal:4599' } }).secureCookie, false);
});

test('isLoopback recognises the three loopback spellings', () => {
  for (const h of ['localhost', '127.0.0.1', '::1', 'LOCALHOST', '[::1]']) {
    assert.equal(isLoopback(h), true, h);
  }
  for (const h of ['0.0.0.0', '10.0.0.5', 'cctv.corp.example']) {
    assert.equal(isLoopback(h), false, h);
  }
});

/* ── refusals ──────────────────────────────────────────────────────────── */

test('validate accepts the default configuration', () => {
  assert.equal(validate(bare()).host, '127.0.0.1');
});

test('validate refuses a public bind with no token', () => {
  // Built by hand rather than through resolve(): resolve() always mints a token
  // unless --no-token, so this branch is validate() standing on its own as a
  // guard for any future caller that assembles a config differently.
  assert.throws(
    () => validate({ host: '0.0.0.0', token: null, noToken: false, publicUrlRaw: null, publicHost: null }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /Refusing to bind 0\.0\.0\.0/);
      return true;
    }
  );
});

test('--no-token combined with a public bind is refused, and says so', () => {
  const cfg = bare({ flags: { host: '0.0.0.0', 'no-token': true } });
  assert.throws(() => validate(cfg), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /--no-token/);
    return true;
  });
});

test('--no-token on loopback is still allowed', () => {
  assert.doesNotThrow(() => validate(bare({ flags: { 'no-token': true } })));
});

test('a short token is refused', () => {
  assert.throws(
    () => validate(bare({ env: { AGENT_CCTV_TOKEN: 'hunter2' } })),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /16/);
      return true;
    }
  );
});

test('an unparseable public URL is refused', () => {
  assert.throws(
    () => validate(bare({ env: { AGENT_CCTV_PUBLIC_URL: 'cctv.corp.example' } })),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /AGENT_CCTV_PUBLIC_URL/);
      return true;
    }
  );
});

test('a public bind with a strong token is accepted', () => {
  assert.doesNotThrow(() =>
    validate(bare({ flags: { host: '0.0.0.0' }, env: { AGENT_CCTV_TOKEN: GOOD } }))
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/config.test.js`
Expected: FAIL — `Cannot find module '../src/config.js'`.

- [ ] **Step 3: Write `src/config.js`**

```js
import crypto from 'node:crypto';
import { DEFAULT_PORT, DEFAULT_HOST, readConfig } from './paths.js';

/** A shared secret on a team-reachable port is the whole security model. */
export const MIN_TOKEN_LENGTH = 16;

const LOOPBACK = ['localhost', '127.0.0.1', '::1'];

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function newToken() {
  return crypto.randomBytes(16).toString('hex');
}

export function isLoopback(host) {
  const h = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return LOOPBACK.includes(h);
}

/**
 * Settings come from flags, then the environment, then the config file, then
 * defaults. There is deliberately no "server mode": a company deployment is
 * two environment variables, not a second code path.
 */
export function resolve({ flags = {}, env = process.env, file = readConfig(), makeToken = newToken } = {}) {
  const port = Number(flags.port) || Number(env.AGENT_CCTV_PORT) || Number(file.port) || DEFAULT_PORT;
  const host = flags.host || env.AGENT_CCTV_HOST || file.host || DEFAULT_HOST;

  const noToken = flags['no-token'] === true || flags.token === false;
  const token = noToken ? null : env.AGENT_CCTV_TOKEN || makeToken();

  const publicUrlRaw = flags['public-url'] || env.AGENT_CCTV_PUBLIC_URL || null;
  let publicHost = null;
  let secureCookie = false;
  if (publicUrlRaw) {
    try {
      const u = new URL(publicUrlRaw);
      publicHost = u.hostname.toLowerCase().replace(/^\[|\]$/g, '') || null;
      secureCookie = u.protocol === 'https:';
    } catch {
      publicHost = null; // validate() turns this into a refusal
    }
  }

  const openBrowser = !(flags['no-open'] === true || flags.open === false);

  return {
    port,
    host,
    token,
    noToken,
    publicUrlRaw,
    publicHost,
    secureCookie,
    openBrowser,
    allowedHosts: publicHost ? [...LOOPBACK, publicHost] : [...LOOPBACK],
  };
}

/** Every refusal exits before the socket binds. */
export function validate(cfg) {
  if (cfg.publicUrlRaw && !cfg.publicHost) {
    throw new ConfigError(
      `AGENT_CCTV_PUBLIC_URL is not a valid absolute URL: ${cfg.publicUrlRaw}\n` +
        `  Expected something like https://cctv.example.com`
    );
  }

  if (!isLoopback(cfg.host) && !cfg.token) {
    throw new ConfigError(
      cfg.noToken
        ? `--no-token cannot be combined with --host ${cfg.host}.\n` +
          `  The dashboard serves your transcripts, which contain source code.\n` +
          `  Drop --no-token, or bind 127.0.0.1.`
        : `Refusing to bind ${cfg.host} without a token.\n` +
          `  The dashboard serves your transcripts, which contain source code.\n` +
          `  Set AGENT_CCTV_TOKEN to a secret of at least ${MIN_TOKEN_LENGTH} characters,\n` +
          `  or bind 127.0.0.1 and put a reverse proxy in front.`
    );
  }

  if (cfg.token && cfg.token.length < MIN_TOKEN_LENGTH) {
    throw new ConfigError(
      `AGENT_CCTV_TOKEN is too short: ${cfg.token.length} characters, minimum ${MIN_TOKEN_LENGTH}.\n` +
        `  Generate one with:  openssl rand -hex 32`
    );
  }

  return cfg;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/config.test.js`
Expected: PASS, 14 tests.

- [ ] **Step 5: Move `newToken` out of `src/server.js`**

`newToken` now lives in `src/config.js`. Delete this from `src/server.js` (lines 264-266):

```js
export function newToken() {
  return crypto.randomBytes(16).toString('hex');
}
```

and replace it with a re-export so `bin/cctv.js` keeps working unchanged for now:

```js
export { newToken } from './config.js';
```

Leave the `import crypto from 'node:crypto';` at the top of `src/server.js` in place — Task 5 uses it for the constant-time comparison.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/config.js test/config.test.js src/server.js
git commit -m "feat: add config resolution with refusal rules

Resolves flags > env > config file > defaults, and refuses to start on
a public bind with no token, a short token, or a malformed public URL.
No mode switch: a server deployment is two environment variables."
```

---

### Task 4: Wire the resolved config into the CLI

**Files:**
- Modify: `bin/cctv.js` — imports (lines 4-9), `cmdStart` (lines 64-125), `HELP` (lines 36-54)

**Interfaces:**
- Consumes: `resolve`, `validate`, `ConfigError` from `src/config.js` (Task 3)
- Produces: a `cmdStart` that binds using the resolved config and prints `ConfigError` messages without a stack trace

- [ ] **Step 1: Update the imports**

In `bin/cctv.js`, replace the `newToken` import from `../src/server.js` and add the config module:

```js
import { start } from '../src/server.js';
import { Store } from '../src/store.js';
import { resolve, validate, ConfigError } from '../src/config.js';
import { capabilities } from '../src/sources/claude-code/index.js';
import { capabilities as codexCaps } from '../src/sources/codex/index.js';
import { writeConfig, readConfig, DEFAULT_PORT, DEFAULT_HOST } from '../src/paths.js';
import * as installer from '../src/install.js';
```

- [ ] **Step 2: Replace the settings block in `cmdStart`**

Delete these three lines (currently `bin/cctv.js:74-76`):

```js
  const port = Number(flags.port) || DEFAULT_PORT;
  const host = flags.host || DEFAULT_HOST;
  const token = flags.token === false || flags['no-token'] ? null : newToken();
```

and put this in their place:

```js
  let cfg;
  try {
    cfg = validate(resolve({ flags }));
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error('');
    console.error(`  ${c.red('✗')} ${err.message}`);
    console.error('');
    process.exitCode = 1;
    return;
  }
  const { port, host, token } = cfg;
```

- [ ] **Step 3: Pass the new settings to the server and honour `openBrowser`**

Change the `start(...)` call to forward the allowlist and cookie flag:

```js
    server = await start({
      port,
      host,
      store: new Store(),
      token,
      allowedHosts: cfg.allowedHosts,
      secureCookie: cfg.secureCookie,
    });
```

Change the URL line so a configured public URL is what gets printed and opened:

```js
  const local = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`;
  const url = (cfg.publicUrlRaw || local) + (token ? `?token=${token}` : '');
```

Replace the browser-open line (currently `if (!flags['no-open'] && flags.open !== false) openBrowser(url);`) with:

```js
  if (cfg.openBrowser) openBrowser(url);
```

`start` and `createServer` do not accept `allowedHosts` or `secureCookie` until Tasks 5 and 6 — extra properties are ignored until then, so the CLI keeps working in the meantime.

- [ ] **Step 4: Document the new settings in `HELP`**

Add to the `Options` block, after the `--no-token` line:

```
  --public-url <url>  Public URL when behind a reverse proxy ${c.dim('(adds its host to the allowlist)')}
```

And add a new section before the closing backtick:

```
${c.bold('Environment')}
  AGENT_CCTV_TOKEN       Stable token, 16+ chars ${c.dim('(otherwise a random one per run)')}
  AGENT_CCTV_PUBLIC_URL  Public URL when behind a reverse proxy
  AGENT_CCTV_HOST        Bind address
  AGENT_CCTV_PORT        Port
```

- [ ] **Step 5: Verify the default path is unchanged**

Run: `node bin/cctv.js --help`
Expected: help text including the new `Environment` block.

Run: `AGENT_CCTV_TOKEN=short node bin/cctv.js start; echo "exit=$?"`
Expected: `✗ AGENT_CCTV_TOKEN is too short: 5 characters, minimum 16.` and `exit=1`.

Run: `node bin/cctv.js start --host 0.0.0.0 --no-token; echo "exit=$?"`
Expected: the `--no-token cannot be combined with --host 0.0.0.0` message and `exit=1`.

Run: `node bin/cctv.js start --no-open` then press ctrl-c.
Expected: it starts normally and prints a `127.0.0.1` URL with a token, exactly as before.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add bin/cctv.js
git commit -m "feat: resolve CLI settings through src/config.js"
```

---

### Task 5: Configurable Host and Origin allowlist

Also fixes a latent parsing bug: `hostAllowed` does `.split(':')[0]` before stripping brackets, so an IPv6 `Host: [::1]:4599` reduces to `[` and never matches. Covered by a test below.

**Files:**
- Modify: `src/server.js:35-49` (`hostAllowed`, `originAllowed`), `:77` (`createServer` signature), `:113-114` (call sites), `:268-274` (`start` signature)
- Modify: `test/server.test.js` (append)

**Interfaces:**
- Consumes: `cfg.allowedHosts` from `src/config.js` (Task 3), passed by `bin/cctv.js` (Task 4)
- Produces: `createServer({ store, token, withSource, allowedHosts })` and `start({ port, host, store, token, allowedHosts })`

- [ ] **Step 1: Write the failing tests**

Append to `test/server.test.js`:

```js
/* ── host and origin allowlist ─────────────────────────────────────────── */

// These three use raw(), not fetch() — see the note on the helper.
test('a configured public host is accepted in the Host header', async () => {
  const s = await serve({ token: null, allowedHosts: ['localhost', '127.0.0.1', '::1', 'cctv.corp.example'] });
  try {
    assert.equal((await s.raw('/api/health', { host: 'cctv.corp.example' })).status, 200);
  } finally {
    await s.close();
  }
});

test('an unlisted host is rejected', async () => {
  const s = await serve({ token: null, allowedHosts: ['localhost', '127.0.0.1', '::1'] });
  try {
    assert.equal((await s.raw('/api/health', { host: 'evil.example' })).status, 403);
  } finally {
    await s.close();
  }
});

test('a bracketed IPv6 Host header is parsed correctly', async () => {
  // Pre-existing bug: split(':')[0] on "[::1]:4599" yields "[", so ::1 never
  // matched the loopback allowlist it was supposedly in.
  const s = await serve({ token: null });
  try {
    assert.equal((await s.raw('/api/health', { host: '[::1]:4599' })).status, 200);
  } finally {
    await s.close();
  }
});

test('a request with no Origin is still allowed', async () => {
  const s = await serve({ token: null });
  try {
    assert.equal((await fetch(s.url('/api/health'))).status, 200);
  } finally {
    await s.close();
  }
});

test('an unlisted Origin is rejected', async () => {
  const s = await serve({ token: null });
  try {
    const res = await fetch(s.url('/api/health'), { headers: { origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
  } finally {
    await s.close();
  }
});

test('a configured public Origin is accepted', async () => {
  const s = await serve({ token: null, allowedHosts: ['localhost', '127.0.0.1', '::1', 'cctv.corp.example'] });
  try {
    const res = await fetch(s.url('/api/health'), { headers: { origin: 'https://cctv.corp.example' } });
    assert.equal(res.status, 200);
  } finally {
    await s.close();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/server.test.js`
Expected: FAIL on the public-host, IPv6, and public-Origin tests — `allowedHosts` is ignored and the bracketed host does not parse.

- [ ] **Step 3: Rewrite the two guards**

Replace `hostAllowed` and `originAllowed` in `src/server.js` (lines 35-49) with:

```js
/** `example.com:4599` and `[::1]:4599` both reduce to a bare hostname. */
function hostname(value) {
  const h = String(value || '').trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']')); // [::1]:4599
  return h.split(':')[0];
}

function hostAllowed(req, allowed) {
  return allowed.has(hostname(req.headers.host));
}

function originAllowed(req, allowed) {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin navigations and curl send none
  try {
    return allowed.has(hostname(new URL(origin).hostname));
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Thread the allowlist through `createServer` and `start`**

Change the `createServer` signature:

```js
export function createServer({
  store = new Store(),
  token = null,
  withSource = true,
  allowedHosts = ['localhost', '127.0.0.1', '::1'],
} = {}) {
  // Do NOT run these through hostname(): that function strips a :port, and a
  // bare '::1' would reduce to '' — silently dropping loopback from its own
  // allowlist. Allowlist entries are already bare hostnames.
  const allowed = new Set(
    allowedHosts.map((h) => String(h).trim().toLowerCase().replace(/^\[|\]$/g, ''))
  );
```

Update the two call sites at the top of the request handler:

```js
    if (!hostAllowed(req, allowed)) return json(res, 403, { error: 'bad host' });
    if (!originAllowed(req, allowed)) return json(res, 403, { error: 'bad origin' });
```

And forward it from `start`:

```js
export function start({ port = DEFAULT_PORT, host = DEFAULT_HOST, store, token, allowedHosts } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer({ store, token, allowedHosts });
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/server.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server.js test/server.test.js
git commit -m "feat: make the Host/Origin allowlist configurable

Also fixes bracketed IPv6 Host headers, which reduced to '[' under the
old split(':')[0] and never matched the loopback allowlist."
```

---

### Task 6: Cookie authentication

`EventSource` cannot set headers, so the SPA puts the token in the query string of every request including the long-lived `/api/stream`, where it lands in every reverse-proxy access log. After this task the token is exchanged once for an `HttpOnly` cookie.

**Files:**
- Modify: `src/server.js` — `authed` (lines 107-110), the request handler, `createServer` signature, `start` signature
- Modify: `public/app.js:8-9`
- Modify: `test/server.test.js` (append)

**Interfaces:**
- Consumes: `cfg.secureCookie` from `src/config.js` (Task 3), passed by `bin/cctv.js` (Task 4)
- Produces: `createServer({ ..., secureCookie })`, `start({ ..., secureCookie })`; a `cctv` cookie accepted by `authed`

- [ ] **Step 1: Write the failing tests**

Append to `test/server.test.js`:

```js
/* ── cookie auth ───────────────────────────────────────────────────────── */

function cookieFrom(res) {
  const raw = res.headers.get('set-cookie');
  return raw ? raw.split(';')[0] : null;
}

test('a query-string auth exchanges the token for a cookie', async () => {
  const s = await serve({ token: TOKEN });
  try {
    const res = await fetch(s.url(`/api/state?token=${TOKEN}`));
    assert.equal(res.status, 200);
    const set = res.headers.get('set-cookie');
    assert.ok(set, 'expected a Set-Cookie header');
    assert.match(set, /^cctv=/);
    assert.match(set, /HttpOnly/i);
    assert.match(set, /SameSite=Strict/i);
  } finally {
    await s.close();
  }
});

test('the cookie alone authorizes a later request', async () => {
  const s = await serve({ token: TOKEN });
  try {
    const first = await fetch(s.url(`/api/state?token=${TOKEN}`));
    const res = await fetch(s.url('/api/state'), { headers: { cookie: cookieFrom(first) } });
    assert.equal(res.status, 200);
  } finally {
    await s.close();
  }
});

test('a wrong cookie does not authorize', async () => {
  const s = await serve({ token: TOKEN });
  try {
    const res = await fetch(s.url('/api/state'), { headers: { cookie: 'cctv=nope' } });
    assert.equal(res.status, 401);
  } finally {
    await s.close();
  }
});

test('Secure is set only when the deployment is https', async () => {
  const plain = await serve({ token: TOKEN, secureCookie: false });
  try {
    const res = await fetch(plain.url(`/api/state?token=${TOKEN}`));
    assert.doesNotMatch(res.headers.get('set-cookie'), /Secure/i);
  } finally {
    await plain.close();
  }

  const tls = await serve({ token: TOKEN, secureCookie: true });
  try {
    const res = await fetch(tls.url(`/api/state?token=${TOKEN}`));
    assert.match(res.headers.get('set-cookie'), /Secure/i);
  } finally {
    await tls.close();
  }
});

test('loading the page with a token sets the cookie before any API call', async () => {
  const s = await serve({ token: TOKEN });
  try {
    const res = await fetch(s.url(`/?token=${TOKEN}`));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie') || '', /^cctv=/);
  } finally {
    await s.close();
  }
});

test('an already-cookied request is not re-issued a cookie', async () => {
  const s = await serve({ token: TOKEN });
  try {
    const first = await fetch(s.url(`/api/state?token=${TOKEN}`));
    const res = await fetch(s.url('/api/state'), { headers: { cookie: cookieFrom(first) } });
    assert.equal(res.headers.get('set-cookie'), null);
  } finally {
    await s.close();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/server.test.js`
Expected: FAIL — no `Set-Cookie` is ever sent and a cookie does not authenticate.

- [ ] **Step 3: Replace `authed` with a source-aware version**

In `src/server.js`, replace the `authed` function (lines 107-110) with:

```js
  /** Constant-time compare — this is a shared secret on a network-reachable port. */
  function sameSecret(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const A = Buffer.from(a);
    const B = Buffer.from(b);
    if (A.length !== B.length) return false;
    return crypto.timingSafeEqual(A, B);
  }

  function cookieToken(req) {
    const raw = req.headers.cookie;
    if (!raw) return null;
    for (const part of raw.split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() !== COOKIE_NAME) continue;
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
    return null;
  }

  /** Which credential authenticated this request, or null. */
  function authSource(req, url) {
    if (!token) return 'open';
    if (sameSecret(url.searchParams.get('token'), token)) return 'query';
    if (sameSecret(req.headers['x-cctv-token'], token)) return 'header';
    if (sameSecret(cookieToken(req), token)) return 'cookie';
    return null;
  }

  function authed(req, url) {
    return authSource(req, url) !== null;
  }
```

Add the cookie name as a module-level constant near `MIME`:

```js
const COOKIE_NAME = 'cctv';
```

- [ ] **Step 4: Issue the cookie on the first query or header auth**

Add `secureCookie = false` to the `createServer` signature:

```js
export function createServer({
  store = new Store(),
  token = null,
  withSource = true,
  allowedHosts = ['localhost', '127.0.0.1', '::1'],
  secureCookie = false,
} = {}) {
```

Then in the request handler, immediately after the `url` and `route` are computed and before the `/ingest` branch, add:

```js
    // Swap a URL or header token for a cookie once, so the token stops appearing
    // in the query string of every request — including the long-lived SSE stream,
    // which EventSource cannot send headers on.
    const credential = authSource(req, url);
    if (credential === 'query' || credential === 'header') {
      res.setHeader(
        'set-cookie',
        `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict` +
          (secureCookie ? '; Secure' : '')
      );
    }
```

`res.setHeader` before `res.writeHead` is preserved by Node, so `json()` and the static file response both keep it.

Forward it from `start`:

```js
export function start({ port = DEFAULT_PORT, host = DEFAULT_HOST, store, token, allowedHosts, secureCookie } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer({ store, token, allowedHosts, secureCookie });
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/server.test.js`
Expected: PASS, 16 tests.

- [ ] **Step 6: Make the SPA use the cookie**

Replace `public/app.js:8-9`:

```js
const token = new URLSearchParams(location.search).get('token') || '';
const api = (p) => p + (token ? (p.includes('?') ? '&' : '?') + 'token=' + token : '');
```

with:

```js
const token = new URLSearchParams(location.search).get('token') || '';
/*
  The document request already carried the token, so the server has issued an
  HttpOnly cookie. Probe once without the token: if the cookie works we stop
  sending it entirely and scrub it from the address bar, which keeps it out of
  proxy access logs. If cookies are blocked we fall back to the query string.
*/
let useCookie = false;
const api = (p) => (useCookie || !token ? p : p + (p.includes('?') ? '&' : '?') + 'token=' + token);

async function establishSession() {
  if (!token) return;
  try {
    const probe = await fetch('/api/state', { credentials: 'same-origin' });
    useCookie = probe.ok;
  } catch {
    useCookie = false;
  }
  if (useCookie) history.replaceState(null, '', location.pathname);
}
```

- [ ] **Step 7: Call it before the stream opens**

`public/app.js` ends with these two lines (1197-1198), where `connect()` opens the
`EventSource` on `api('/api/stream')`:

```js
layout();
connect();
```

The cookie must be established before the stream opens, or the long-lived stream request
carries the token in its query string — the exact thing this task removes. Change the last
line to:

```js
layout();
establishSession().then(connect);
```

`layout()` stays synchronous and first: it renders the empty wall immediately rather than
leaving a blank page for the duration of the probe.

- [ ] **Step 8: Verify in a browser**

Run: `node bin/cctv.js --no-open` and open the printed URL.
Expected: the wall loads, the address bar loses `?token=...` shortly after load, tiles keep updating (proving the SSE stream authenticated by cookie), and reloading the bare URL still works.

- [ ] **Step 9: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/server.js public/app.js test/server.test.js
git commit -m "feat: exchange the URL token for an HttpOnly cookie

EventSource cannot set headers, so the token rode in the query string of
every request including the long-lived stream, landing in every proxy
access log. It is now swapped once for a SameSite=Strict cookie."
```

---

### Task 7: Trim `/api/health`

`/api/health` is the one endpoint deliberately reachable without a credential, so a load balancer and an alerting rule can use it. It currently also returns the pid and a live session count. `capabilities` stays, because operators should be able to alert on registry degradation without a token.

**Files:**
- Modify: `src/server.js:132-139`
- Modify: `test/server.test.js` (append)

**Interfaces:**
- Consumes: `store.capabilities`
- Produces: `GET /api/health -> { ok: true, capabilities: object }`

- [ ] **Step 1: Write the failing test**

Append to `test/server.test.js`:

```js
/* ── health ────────────────────────────────────────────────────────────── */

test('/api/health reveals liveness and capabilities, and nothing else', async () => {
  const s = await serve({ token: TOKEN });
  try {
    const res = await fetch(s.url('/api/health'));
    assert.equal(res.status, 200, 'health must not require the token');
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['capabilities', 'ok']);
    assert.equal(body.ok, true);
  } finally {
    await s.close();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/server.test.js`
Expected: FAIL — the key list is `['capabilities', 'ok', 'pid', 'sessions']`.

- [ ] **Step 3: Trim the response**

Replace the `/api/health` block in `src/server.js`:

```js
    if (route === '/api/health') {
      // Unauthenticated on purpose: load balancers and alerting rules need it.
      // `capabilities` is included so operators can alert on a Claude Code
      // update having moved the internals out from under us.
      return json(res, 200, { ok: true, capabilities: store.capabilities });
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/server.test.js`
Expected: PASS, 17 tests.

- [ ] **Step 5: Check nothing consumed the removed fields**

Run: `grep -an "api/health" public/*.js bin/*.js src/*.js`
Expected: no consumer reading `.pid` or `.sessions` from the health response. If one exists, update it to use `/api/state` instead.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server.js test/server.test.js
git commit -m "refactor: reduce unauthenticated /api/health to ok + capabilities"
```

---

### Task 8: Fix the NUL byte and guard the SPA against innerHTML

`public/app.js:982` contains a literal NUL byte, used deliberately as a join separator but written as a raw byte instead of the `'\0'` escape. It makes `file` classify the whole file as `data`, so plain `grep` skips it **silently** — a grep-based guard would pass while checking nothing.

The guard matters more after this release than before. The SPA renders all session data through `textContent`, so an `innerHTML` slip is self-XSS on localhost today. On a team server, a malicious repository — whose content reaches transcripts — would pop every viewer's browser from behind the SSO gate.

**Files:**
- Modify: `public/app.js:982`
- Create: `test/spa-guard.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Confirm the NUL byte is there**

Run: `file public/app.js && perl -ne 'print "line $.\n" if /\x00/' public/app.js`
Expected: `public/app.js: data` and `line 982`.

- [ ] **Step 2: Replace the raw byte with the escape**

Run: `perl -i -pe 's/\x00/\\0/g' public/app.js`

This turns the source text `current.join('<NUL>')` into `current.join('\0')` — the same string value at runtime, written portably.

- [ ] **Step 3: Verify the file is text again and behaviour is unchanged**

Do **not** verify this with `grep`. A `grep` pattern for `\0` is interpreted by the regex
engine, and the file you are checking is the one that was breaking `grep` in the first
place. Count in JavaScript instead:

```bash
node -e '
const s = require("fs").readFileSync("public/app.js", "utf8");
console.log("raw NUL bytes:      ", (s.match(/\u0000/g) || []).length);
console.log("escaped separators: ", (s.match(/join\(.\\0.\)/g) || []).length);
'
```

Expected: `raw NUL bytes: 0` and `escaped separators: 2` — the two `join` calls on line 982.

Run: `file public/app.js`
Expected: `JavaScript text` or `ASCII text` — no longer `data`.

Run: `node --check public/app.js`
Expected: exit 0, no output. (`package.json` sets `"type": "module"`, so `--check` parses it
as ESM. Verified.)

- [ ] **Step 4: Write the guard test**

Create `test/spa-guard.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

/*
  Read and scan in JavaScript rather than shelling out to grep: a file
  containing a NUL byte classifies as binary and grep skips it silently, so a
  grep-based guard passes while checking nothing. That is exactly what happened
  to public/app.js before this test existed.
*/

/** Right-hand sides that are static icon markup, never session data. */
const STATIC_ICON_SOURCES = [
  'meta.icon',
  'sourceMeta(key).icon',
  'sourceMeta(s.source).icon',
  '`<svg viewBox="0 0 24 24" aria-hidden="true">${THEME_ICON[pref]}</svg>`',
];

function scripts() {
  return fs
    .readdirSync(PUBLIC)
    .filter((f) => f.endsWith('.js'))
    .map((f) => [f, fs.readFileSync(path.join(PUBLIC, f), 'utf8')]);
}

test('no served script contains a NUL byte', () => {
  for (const [name, src] of scripts()) {
    assert.ok(!src.includes('\u0000'), `${name} contains a raw NUL byte; write it as \\0`);
  }
});

test('innerHTML is only ever assigned static icon markup', () => {
  const assignment = /\.(?:innerHTML|outerHTML)\s*=\s*([^;\n]+)/g;
  for (const [name, src] of scripts()) {
    for (const m of src.matchAll(assignment)) {
      const rhs = m[1].trim();
      assert.ok(
        STATIC_ICON_SOURCES.includes(rhs),
        `${name}: innerHTML assigned from ${rhs}\n` +
          `Session data must be rendered with textContent. Transcripts contain\n` +
          `repository content, and on a shared server this is stored XSS behind\n` +
          `the SSO gate. If this really is static markup, add it to\n` +
          `STATIC_ICON_SOURCES in ${path.basename(import.meta.url)}.`
      );
    }
  }
});

test('insertAdjacentHTML is never used', () => {
  for (const [name, src] of scripts()) {
    assert.ok(!src.includes('insertAdjacentHTML'), `${name} uses insertAdjacentHTML`);
  }
});
```

- [ ] **Step 5: Run the guard tests**

Run: `node --test test/spa-guard.test.js`
Expected: PASS, 3 tests. If the `innerHTML` test fails, the reported right-hand side is a real finding — check whether it renders session data before adding it to the allowlist.

- [ ] **Step 6: Prove the guard actually bites**

Temporarily add `wall.innerHTML = s.lastText;` to `public/app.js`, run `node --test test/spa-guard.test.js`, confirm it FAILS naming `s.lastText`, then remove the line and confirm it passes again.

- [ ] **Step 7: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add public/app.js test/spa-guard.test.js
git commit -m "fix: write the join separator as \\0 instead of a raw NUL byte

The raw byte made public/app.js classify as binary, so grep skipped it
silently. Adds a guard test that reads the file in JS — keeping the SPA's
textContent discipline, which becomes a security boundary once the wall
is shared, enforced by something that cannot be disarmed the same way."
```

---

### Task 9: Deployment artifacts and operator documentation

**Files:**
- Create: `deploy/agent-cctv.service`
- Create: `deploy/agent-cctv.env.example`
- Create: `deploy/Caddyfile.example`
- Create: `deploy/nginx-oauth2-proxy.conf.example`
- Modify: `README.md` (new section after "Privacy"), `package.json` (`files` array)

**Interfaces:**
- Consumes: the environment variables defined in Task 3
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Write the systemd unit**

Create `deploy/agent-cctv.service`. No daemonization, pidfile, or log rotation is written — that is systemd's job.

```ini
[Unit]
Description=agent-cctv — live wall of coding agent sessions
After=network.target

[Service]
Type=simple
# Run as the account the agents run as, or one sharing its group.
# Never root: this process serves file contents over HTTP.
User=agents
Group=agents
EnvironmentFile=/etc/agent-cctv/agent-cctv.env
ExecStart=/usr/bin/npx --yes agent-cctv start --no-open
Restart=on-failure
RestartSec=5

# It only ever reads. Give it nothing else.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Write the environment example**

Create `deploy/agent-cctv.env.example`:

```sh
# Generate with: openssl rand -hex 32
# Minimum 16 characters; agent-cctv refuses to start below that.
AGENT_CCTV_TOKEN=replace-me-with-a-real-secret

# The URL your users reach it on. Its hostname is added to the Host/Origin
# allowlist, and https here makes the session cookie Secure.
AGENT_CCTV_PUBLIC_URL=https://cctv.corp.example

# Leave the bind on loopback. The reverse proxy runs on this same box, because
# the agents do. Only set this if the proxy is on a different machine, and then
# use a private interface, never 0.0.0.0.
# AGENT_CCTV_HOST=127.0.0.1
AGENT_CCTV_PORT=4599
```

- [ ] **Step 3: Write the Caddy example**

Create `deploy/Caddyfile.example`:

```
# Caddy gets a certificate automatically. agent-cctv ships no TLS of its own.
cctv.corp.example {
	# Your SSO. Anything that authenticates the human works here.
	forward_auth authelia.internal:9091 {
		uri /api/verify?rd=https://auth.corp.example
		copy_headers Remote-User Remote-Groups
	}

	reverse_proxy 127.0.0.1:4599 {
		# The dashboard streams server-sent events; do not buffer them.
		flush_interval -1
	}
}
```

- [ ] **Step 4: Write the nginx example**

Create `deploy/nginx-oauth2-proxy.conf.example`:

```nginx
server {
    listen 443 ssl;
    server_name cctv.corp.example;

    ssl_certificate     /etc/ssl/certs/cctv.crt;
    ssl_certificate_key /etc/ssl/private/cctv.key;

    # oauth2-proxy authenticates the human before anything reaches agent-cctv.
    auth_request /oauth2/auth;
    error_page 401 = /oauth2/sign_in;

    location /oauth2/ {
        proxy_pass http://127.0.0.1:4180;
        proxy_set_header Host             $host;
        proxy_set_header X-Real-IP        $remote_addr;
    }

    location / {
        proxy_pass http://127.0.0.1:4599;
        proxy_set_header Host $host;

        # Server-sent events: no buffering, no timeout.
        proxy_buffering     off;
        proxy_cache         off;
        proxy_read_timeout  24h;
        proxy_http_version  1.1;
    }
}
```

- [ ] **Step 5: Ship `deploy/` in the package**

In `package.json`, add `"deploy"` to the `files` array:

```json
  "files": [
    "bin",
    "src",
    "public",
    "deploy",
    "README.md"
  ],
```

- [ ] **Step 6: Add the README section**

Insert after the "Privacy" section of `README.md`:

````markdown
## Running it for a team

agent-cctv works on a shared server — a CI box, a cloud dev machine, an agent
fleet — as long as the agents run on that same machine. There is no separate
mode: it is two environment variables and a systemd unit.

```sh
AGENT_CCTV_TOKEN=$(openssl rand -hex 32)
AGENT_CCTV_PUBLIC_URL=https://cctv.corp.example
```

Everything you need is in [`deploy/`](deploy/): a systemd unit, an environment
file, and reverse-proxy examples for Caddy and nginx + oauth2-proxy.

### The trust model, stated plainly

**Everyone who can reach agent-cctv can read every session's full transcript,
including source code. There is no per-user filtering.**

That is deliberate. It is an observability wall; seeing the whole wall is the
point. It is also the honest boundary — the process can read every transcript on
the box anyway, so a per-user filter would be decoration that someone would
eventually mistake for a security control.

So: **scope access to people who could already `ssh` to this box.** If you need
real isolation between teams, run two instances over different directories.

agent-cctv authenticates with a single shared token and nothing else. Your
reverse proxy authenticates the *human* — SSO, oauth2-proxy, Cloudflare Access,
whatever you already run — and terminates TLS. agent-cctv ships no TLS and no
user accounts, and it never will: they are your proxy's job, and it already does
them better.

Keep the bind on `127.0.0.1`. The proxy is on the same box, because the agents
are. agent-cctv refuses to start if you bind a public interface without a token.

### Retention

agent-cctv still stores nothing. The agents' own JSONL logs are the durable
record, and on this topology they are on the same disk.

- The history window is whatever Claude Code keeps — see `cleanupPeriodDays` in
  its settings, default about 30 days. Change it there, not here.
- For real retention or analytics, point the log shipper you already run (Vector,
  Filebeat) at `~/.claude/projects/**/*.jsonl`. agent-cctv does not need to be in
  that path.

### Operating it

- **Never run it as root.** It serves file contents over HTTP. Run it as the
  account the agents use, or one sharing that group. Liveness checks work fine
  unprivileged.
- **Pin your Claude Code version, and alert on degradation.** The internals it
  reads are undocumented. `GET /api/health` needs no token and returns
  `capabilities`; alert on `capabilities['claude-code'].registry === false`,
  which means an update moved something and the wall is about to go stale.
- **Docker is not supported as the primary path.** Without `--pid=host` the
  liveness check fails for every host pid and every session reads as dead —
  it destroys the one authoritative signal the tool has. Use npm + systemd.
- **Agents inside containers are out of scope.** Their state directory is
  invisible and their pids are in another namespace.
- **Hooks and the daemon must share a user.** `agent-cctv install` writes a token
  to `~/.agent-cctv/config.json` (mode 0600). If the dashboard runs as a
  different user than the agents, hooks cannot authenticate. Hooks are optional;
  this only matters if you install them.
````

- [ ] **Step 7: Verify the packaged file list**

Run: `npm pack --dry-run 2>&1 | grep -c deploy/`
Expected: `4` — the four files in `deploy/`.

- [ ] **Step 8: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add deploy/ README.md package.json
git commit -m "docs: add deployment artifacts and the team trust model

systemd unit, environment example, and Caddy / nginx+oauth2-proxy
snippets, plus a README section stating plainly that everyone past the
proxy sees every transcript."
```

---

## Final verification

- [ ] **Full suite**

Run: `npm test`
Expected: PASS across `test/unit.test.js`, `test/server.test.js`, `test/config.test.js`, `test/spa-guard.test.js`.

- [ ] **The individual path is unchanged**

Run: `node bin/cctv.js` with no environment variables set.
Expected: binds `127.0.0.1:4599`, mints a random token, opens a browser, the wall loads and updates.

- [ ] **The server path works end to end**

```bash
AGENT_CCTV_TOKEN=$(openssl rand -hex 32) \
AGENT_CCTV_PUBLIC_URL=http://localhost:4599 \
node bin/cctv.js start --no-open
```
Expected: starts, prints the public URL with the token appended, and the wall loads at that URL. Restart it and confirm the same URL still works — that is the point of a stable token.

- [ ] **Every refusal fires**

```bash
node bin/cctv.js start --host 0.0.0.0                          # refuse: no token
node bin/cctv.js start --host 0.0.0.0 --no-token               # refuse: --no-token named
AGENT_CCTV_TOKEN=short node bin/cctv.js start                  # refuse: too short
AGENT_CCTV_PUBLIC_URL=cctv.example node bin/cctv.js start      # refuse: not absolute
```
Expected: each exits 1 with its specific message and never binds a socket.

## Out of scope for this release

Release 2, specced separately: labelled multi-root config, an `owner` field and group-by-owner, per-root capabilities in `doctor`. A possible third: a `/metrics` Prometheus endpoint.

Do not add during this release: user accounts, RBAC, in-app TLS, any persistence layer, a remote-collector protocol, or any endpoint that acts on a session.
