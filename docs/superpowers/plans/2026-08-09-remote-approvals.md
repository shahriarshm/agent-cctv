# Remote Approvals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a paired remote device Allow/Deny Claude Code permission requests from the wall, with the terminal prompt as the fallback for every failure mode.

**Architecture:** A new blocking `PermissionRequest` hook (`src/approve-hook.js`) long-polls the server; the pending approval *is* that held HTTP response (`src/approvals.js` owns armed/pairing/pending state, `src/server.js` owns the sockets). The frontend renders pending cards per tile and gates Allow/Deny behind a second cookie minted by a short-lived pairing code. Spec: `docs/superpowers/specs/2026-08-09-remote-approvals-design.md`.

**Tech Stack:** Node ≥18.2 core modules only, `node --test`, vanilla ESM frontend.

## Global Constraints

- **Zero runtime dependencies.** Nothing gets installed, ever.
- **No test spawns `claude`** (mirror of the no-`cloudflared` rule). Hook tests spawn `node` with scripted stdin.
- **`textContent` only** in `public/` — `test/spa-guard.test.js` enforces it.
- Every test file that touches `src/` imports `./helpers/env.js` (or `../helpers/env.js`) **first**.
- Version floor for approvals install: `2.1.226` (the spike-verified Claude Code build).
- Hook self-deadline **270_000 ms**; settings.json backstop timeout **300** s.
- Auto-disarm **4 h**; pairing code TTL **5 min**, **5** attempts, one-time; act cookie `cctv-act`, Max-Age **7 days**.
- Deny message constant, exactly: `Denied from the agent-cctv wall.` — never interpolated content.
- The act secret is accepted from the `cctv-act` cookie **only** — never query, never header.
- Nothing about approvals is ever written to disk.
- Behavior changes and README/help text land in the same commit as the code.

---

### Task 1: `src/approvals.js` — armed / pending / pairing state

**Files:**
- Create: `src/approvals.js`
- Create: `test/approvals.test.js`

**Interfaces:**
- Consumes: `node:crypto` only.
- Produces (used by Task 2 and Task 3's tests):
  - `createApprovals({ onChange, autoDisarmMs, pairTtlMs }) -> approvals`
  - `approvals.isArmed() -> boolean`
  - `approvals.setArmed(on: boolean) -> boolean` (new state; disarming drains)
  - `approvals.add(meta, resolve) -> {id, ...meta, since, deadline}` (`resolve(decision|null)` called exactly once or never)
  - `approvals.remove(id) -> boolean` (socket closed; no resolve call)
  - `approvals.decide(id, behavior) -> {ok:true} | {ok:false, outcome:'allow'|'deny'|'expired'}`
  - `approvals.drain() -> number` (resolve `null` on all)
  - `approvals.list() -> [{id, sessionId, toolName, toolInput, cwd, permissionMode, since, deadline}]`
  - `approvals.state() -> {armed, until, pendings}`
  - `approvals.mintCode() -> {code, ttlMs}` / `approvals.tryPair(code) -> {ok, secret?}` / `approvals.isDevice(secret) -> boolean`
  - Constants: `HOOK_SELF_DEADLINE_MS = 270_000`, `AUTO_DISARM_MS`, `PAIR_TTL_MS`, `PAIR_MAX_ATTEMPTS`

- [ ] **Step 1: Write the failing tests**

Create `test/approvals.test.js`:

```js
import './helpers/env.js'; // must come first — see the file's comment
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApprovals, PAIR_MAX_ATTEMPTS } from '../src/approvals.js';

const META = {
  sessionId: 's1',
  toolName: 'Bash',
  toolInput: { command: 'touch x' },
  cwd: '/tmp/p',
  permissionMode: 'default',
};

test('a pending resolves once with the decision and is gone afterwards', () => {
  const a = createApprovals();
  a.setArmed(true);
  const got = [];
  const p = a.add(META, (d) => got.push(d));
  assert.equal(a.list().length, 1);
  assert.equal(a.list()[0].toolName, 'Bash');
  assert.ok(p.deadline > p.since, 'deadline is derived for the UI countdown');
  assert.deepEqual(a.decide(p.id, 'allow'), { ok: true });
  assert.deepEqual(got, [{ behavior: 'allow' }]);
  assert.equal(a.list().length, 0);
  // A second decision reports what happened, so a losing tap reads as an
  // outcome rather than an error.
  assert.deepEqual(a.decide(p.id, 'deny'), { ok: false, outcome: 'allow' });
});

test('a removed (socket-closed) pending never resolves and later reads as expired', () => {
  const a = createApprovals();
  a.setArmed(true);
  const got = [];
  const p = a.add(META, (d) => got.push(d));
  assert.equal(a.remove(p.id), true);
  assert.deepEqual(got, [], 'resolve must not fire into a dead socket');
  assert.deepEqual(a.decide(p.id, 'allow'), { ok: false, outcome: 'expired' });
  assert.equal(a.remove('nope'), false);
});

test('disarming drains every pending with null', () => {
  const a = createApprovals();
  a.setArmed(true);
  const got = [];
  a.add(META, (d) => got.push(d));
  a.add({ ...META, sessionId: 's2' }, (d) => got.push(d));
  a.setArmed(false);
  assert.deepEqual(got, [null, null]);
  assert.equal(a.list().length, 0);
  assert.equal(a.isArmed(), false);
});

test('auto-disarm fires, drains, and reports through onChange', async () => {
  const reasons = [];
  const a = createApprovals({ onChange: (r) => reasons.push(r), autoDisarmMs: 20 });
  const got = [];
  a.setArmed(true);
  a.add(META, (d) => got.push(d));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(a.isArmed(), false);
  assert.deepEqual(got, [null]);
  assert.ok(reasons.includes('auto-disarm'));
});

test('re-arming resets the auto-disarm clock instead of stacking timers', async () => {
  const a = createApprovals({ autoDisarmMs: 50 });
  a.setArmed(true);
  await new Promise((r) => setTimeout(r, 30));
  a.setArmed(true); // refresh
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(a.isArmed(), true, 'the first timer must not still be live');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(a.isArmed(), false);
});

test('pairing: the code is one-time and mints a recognised device secret', () => {
  const a = createApprovals();
  const { code, ttlMs } = a.mintCode();
  assert.match(code, /^\d{6}$/);
  assert.ok(ttlMs > 0);
  const r = a.tryPair(code);
  assert.equal(r.ok, true);
  assert.equal(a.isDevice(r.secret), true);
  assert.equal(a.isDevice('not-a-secret'), false);
  // One-time: the same code must not pair a second device.
  assert.equal(a.tryPair(code).ok, false);
});

test(`pairing: the code dies after ${PAIR_MAX_ATTEMPTS} wrong attempts`, () => {
  const a = createApprovals();
  const { code } = a.mintCode();
  for (let i = 0; i < PAIR_MAX_ATTEMPTS; i++) assert.equal(a.tryPair('000000').ok, false);
  assert.equal(a.tryPair(code).ok, false, 'the right code arrives too late');
});

test('pairing: the code expires by TTL and a new mint replaces the old code', () => {
  const a = createApprovals({ pairTtlMs: -1 }); // already expired at birth
  const { code } = a.mintCode();
  assert.equal(a.tryPair(code).ok, false);
  const b = createApprovals();
  const first = b.mintCode().code;
  const second = b.mintCode().code;
  assert.equal(b.tryPair(first).ok, false, 'minting again invalidates the old code');
  assert.equal(b.tryPair(second).ok, true);
});

test('state() is the single serializable truth the SSE layer ships', () => {
  const a = createApprovals();
  assert.deepEqual(a.state(), { armed: false, until: null, pendings: [] });
  a.setArmed(true);
  const s = a.state();
  assert.equal(s.armed, true);
  assert.ok(s.until > Date.now());
  assert.deepEqual(s.pendings, []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/approvals.test.js`
Expected: FAIL — `Cannot find module '../src/approvals.js'`

- [ ] **Step 3: Implement `src/approvals.js`**

```js
import crypto from 'node:crypto';

/*
  Remote-approval state: the armed bit, the held pendings, the pairing codes
  and device secrets. Everything lives in this process's memory and nowhere
  else — a restart revokes every pairing and disarms, which is the emergency
  kill switch, not a bug. Nothing here touches HTTP; the server owns sockets
  and hands this module resolve callbacks.
*/

/** The hook exits silently at this deadline; the server never times a pending
 *  out itself. Carried on each pending so the card can show a countdown. */
export const HOOK_SELF_DEADLINE_MS = 270_000;
/** A forgotten toggle must not re-route next week's sessions. Re-arming from
 *  a paired phone is one tap, so erring short costs little. */
export const AUTO_DISARM_MS = 4 * 60 * 60 * 1000;
export const PAIR_TTL_MS = 5 * 60 * 1000;
export const PAIR_MAX_ATTEMPTS = 5;
/** How many resolved outcomes to remember, so a losing tap can be told what
 *  happened instead of a bare 409. Small and bounded — this is UX, not audit. */
const RECENT_CAP = 20;

function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

export function createApprovals({
  onChange = () => {},
  autoDisarmMs = AUTO_DISARM_MS,
  pairTtlMs = PAIR_TTL_MS,
} = {}) {
  let armed = false;
  let until = null;
  let disarmTimer = null;
  let seq = 0;
  /** @type {Map<string, {meta: object, since: number, deadline: number, resolve: Function}>} */
  const pendings = new Map();
  /** id -> 'allow' | 'deny' | 'expired', insertion-ordered, capped. */
  const recent = new Map();
  const devices = new Set();
  let pairCode = null; // { code, expiresAt, attempts }

  function remember(id, outcome) {
    recent.set(id, outcome);
    if (recent.size > RECENT_CAP) recent.delete(recent.keys().next().value);
  }

  function drain() {
    let n = 0;
    for (const [id, p] of pendings) {
      remember(id, 'expired');
      try {
        p.resolve(null);
      } catch {}
      n++;
    }
    pendings.clear();
    if (n) onChange('drained');
    return n;
  }

  function setArmed(on) {
    if (disarmTimer) clearTimeout(disarmTimer);
    disarmTimer = null;
    const next = !!on;
    const changed = next !== armed;
    armed = next;
    if (armed) {
      until = Date.now() + autoDisarmMs;
      disarmTimer = setTimeout(() => {
        armed = false;
        until = null;
        disarmTimer = null;
        drain();
        onChange('auto-disarm');
      }, autoDisarmMs);
      disarmTimer.unref?.();
      onChange('armed');
    } else {
      until = null;
      drain();
      if (changed) onChange('disarmed');
    }
    return armed;
  }

  return {
    isArmed: () => armed,
    setArmed,

    add(meta, resolve) {
      const since = Date.now();
      const id = `p${++seq}-${crypto.randomBytes(4).toString('hex')}`;
      pendings.set(id, { meta, since, deadline: since + HOOK_SELF_DEADLINE_MS, resolve });
      onChange('pending');
      return { id, ...meta, since, deadline: since + HOOK_SELF_DEADLINE_MS };
    },

    remove(id) {
      const p = pendings.get(id);
      if (!p) return false;
      // The socket is gone; resolving would write into it. Just forget.
      pendings.delete(id);
      remember(id, 'expired');
      onChange('expired');
      return true;
    },

    decide(id, behavior) {
      const p = pendings.get(id);
      if (!p) return { ok: false, outcome: recent.get(id) || 'expired' };
      pendings.delete(id);
      remember(id, behavior);
      try {
        p.resolve({ behavior });
      } catch {}
      onChange('resolved');
      return { ok: true };
    },

    drain,

    list() {
      return [...pendings.entries()].map(([id, p]) => ({
        id,
        ...p.meta,
        since: p.since,
        deadline: p.deadline,
      }));
    },

    state() {
      return { armed, until, pendings: this.list() };
    },

    mintCode() {
      // crypto, not Math.random: six digits is little enough entropy without
      // handing an observer the PRNG state too.
      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      pairCode = { code, expiresAt: Date.now() + pairTtlMs, attempts: 0 };
      return { code, ttlMs: pairTtlMs };
    },

    tryPair(candidate) {
      if (!pairCode) return { ok: false };
      if (Date.now() > pairCode.expiresAt) {
        pairCode = null;
        return { ok: false };
      }
      pairCode.attempts++;
      const match = sameSecret(String(candidate), pairCode.code);
      if (!match) {
        if (pairCode.attempts >= PAIR_MAX_ATTEMPTS) pairCode = null;
        return { ok: false };
      }
      pairCode = null; // one-time
      const secret = crypto.randomBytes(32).toString('hex');
      devices.add(secret);
      return { ok: true, secret };
    },

    isDevice(secret) {
      // timingSafeEqual per candidate rather than Set.has: the secret is a
      // credential on a network-reachable port, same rule as the token.
      for (const d of devices) if (sameSecret(secret, d)) return true;
      return false;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/approvals.test.js`
Expected: PASS (all 9)

- [ ] **Step 5: Commit**

```bash
git add src/approvals.js test/approvals.test.js
git commit -m "feat: approvals state — armed bit, socket-shaped pendings, pairing lifecycle"
```

---

### Task 2: server endpoints — held pendings, decisions, arming, pairing

**Files:**
- Modify: `src/server.js`
- Test: `test/server.test.js` (append)

**Interfaces:**
- Consumes: everything Task 1 produces.
- Produces (relied on by Tasks 3, 5, 7):
  - `POST /api/approvals/pending` (token auth): disarmed → `200 {armed:false}` immediately; armed → response held, later `200 {armed:true, decision:{behavior}|null}`.
  - `POST /api/approvals/<id>/decision` `{behavior}` (act cookie): `200 {ok:true}` / `409 {outcome}` / `403 {error:'pairing required'}`.
  - `POST /api/approvals/armed` `{on}` (act cookie): `200` with `approvals.state()`.
  - `POST /api/pair/new` (token auth): `200 {code, ttlMs}`.
  - `POST /api/pair` `{code}` (view auth): `200 {ok:true}` + `Set-Cookie: cctv-act=…`; `403 {error:'bad or expired code'}`.
  - SSE event `approvals` carrying `approvals.state()`; snapshot and `/api/state` gain `approvals`.
  - `server.approvals` exposed (tests and Task 3's tests drive arming through it).

- [ ] **Step 1: Write the failing tests**

Append to `test/server.test.js`. It already has `serve()`, `raw()`, `TOKEN` (top of file). Add a raw POST helper beside the tests (raw() is GET-only):

```js
/** raw() for POSTs: Host passes through verbatim, response cookies visible. */
function rawPost(port, path, { headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** Pair a device over HTTP and hand back its act cookie. */
async function pairDevice(s) {
  const { code } = await (
    await fetch(s.url('/api/pair/new'), { method: 'POST', headers: { 'x-cctv-token': TOKEN } })
  ).json();
  const res = await fetch(s.url('/api/pair'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cctv-token': TOKEN },
    body: JSON.stringify({ code }),
  });
  assert.equal(res.status, 200);
  const setCookie = res.headers.get('set-cookie');
  assert.match(setCookie, /cctv-act=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  return setCookie.split(';')[0]; // "cctv-act=<secret>"
}

test('a pending POST while disarmed returns armed:false immediately', async () => {
  const s = await serve({ token: TOKEN });
  try {
    const res = await fetch(s.url('/api/approvals/pending'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cctv-token': TOKEN },
      body: JSON.stringify({ session_id: 'x', tool_name: 'Bash', tool_input: { command: 'ls' } }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { armed: false });
  } finally {
    await s.close();
  }
});

test('the whole loop: pair, arm, hold a pending, decide allow', async () => {
  const s = await serve({ token: TOKEN });
  try {
    const cookie = await pairDevice(s);
    const armRes = await fetch(s.url('/api/approvals/armed'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cctv-token': TOKEN, cookie },
      body: JSON.stringify({ on: true }),
    });
    assert.equal(armRes.status, 200);
    assert.equal((await armRes.json()).armed, true);

    // Fire the hook's POST but do not await it — it is designed to hang.
    const held = fetch(s.url('/api/approvals/pending'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cctv-token': TOKEN },
      body: JSON.stringify({
        session_id: 'sess-1',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf build' },
        cwd: '/tmp/p',
        permission_mode: 'default',
      }),
    });
    // The pending must appear in state before anything resolves it.
    let pendings = [];
    for (let i = 0; i < 50 && !pendings.length; i++) {
      await new Promise((r) => setTimeout(r, 20));
      pendings = (await (await fetch(s.url('/api/state'), { headers: { 'x-cctv-token': TOKEN } })).json())
        .approvals.pendings;
    }
    assert.equal(pendings.length, 1);
    assert.equal(pendings[0].toolName, 'Bash');
    assert.equal(pendings[0].sessionId, 'sess-1');

    const decide = await fetch(s.url(`/api/approvals/${pendings[0].id}/decision`), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cctv-token': TOKEN, cookie },
      body: JSON.stringify({ behavior: 'allow' }),
    });
    assert.equal(decide.status, 200);
    const hookSaw = await (await held).json();
    assert.deepEqual(hookSaw, { armed: true, decision: { behavior: 'allow' } });

    // A second decision on the same id tells the loser what happened.
    const again = await fetch(s.url(`/api/approvals/${pendings[0].id}/decision`), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cctv-token': TOKEN, cookie },
      body: JSON.stringify({ behavior: 'deny' }),
    });
    assert.equal(again.status, 409);
    assert.deepEqual(await again.json(), { outcome: 'allow' });
  } finally {
    await s.close();
  }
});

test('the view token alone can never decide or arm', async () => {
  const s = await serve({ token: TOKEN });
  try {
    for (const [path, body] of [
      ['/api/approvals/whatever/decision', { behavior: 'allow' }],
      ['/api/approvals/armed', { on: true }],
    ]) {
      const res = await fetch(s.url(path), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-cctv-token': TOKEN },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 403, `${path} must demand the act cookie`);
    }
    // And the act secret is cookie-only: query and header spellings are dead.
    const cookie = await pairDevice(s);
    const secret = cookie.split('=')[1];
    const viaHeader = await fetch(s.url('/api/approvals/armed'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cctv-token': TOKEN, 'x-cctv-act': secret },
      body: JSON.stringify({ on: true }),
    });
    assert.equal(viaHeader.status, 403);
    const viaQuery = await fetch(s.url(`/api/approvals/armed?act=${secret}`), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cctv-token': TOKEN },
      body: JSON.stringify({ on: true }),
    });
    assert.equal(viaQuery.status, 403);
  } finally {
    await s.close();
  }
});

test('disarming resolves held pendings with a null decision', async () => {
  const s = await serve({ token: TOKEN });
  try {
    const cookie = await pairDevice(s);
    s.server.approvals.setArmed(true);
    const held = fetch(s.url('/api/approvals/pending'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cctv-token': TOKEN },
      body: JSON.stringify({ session_id: 'x', tool_name: 'Bash', tool_input: {} }),
    });
    await new Promise((r) => setTimeout(r, 50));
    const off = await fetch(s.url('/api/approvals/armed'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cctv-token': TOKEN, cookie },
      body: JSON.stringify({ on: false }),
    });
    assert.equal(off.status, 200);
    assert.deepEqual(await (await held).json(), { armed: true, decision: null });
  } finally {
    await s.close();
  }
});

test('a pending whose hook socket dies expires and later reads as such', async () => {
  const s = await serve({ token: TOKEN });
  try {
    const cookie = await pairDevice(s);
    s.server.approvals.setArmed(true);
    const ac = new AbortController();
    fetch(s.url('/api/approvals/pending'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cctv-token': TOKEN },
      body: JSON.stringify({ session_id: 'x', tool_name: 'Bash', tool_input: {} }),
      signal: ac.signal,
    }).catch(() => {});
    let pendings = [];
    for (let i = 0; i < 50 && !pendings.length; i++) {
      await new Promise((r) => setTimeout(r, 20));
      pendings = s.server.approvals.list();
    }
    const id = pendings[0].id;
    ac.abort();
    for (let i = 0; i < 50 && s.server.approvals.list().length; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(s.server.approvals.list().length, 0, 'socket close must expire the pending');
    const late = await fetch(s.url(`/api/approvals/${id}/decision`), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cctv-token': TOKEN, cookie },
      body: JSON.stringify({ behavior: 'allow' }),
    });
    assert.equal(late.status, 409);
    assert.deepEqual(await late.json(), { outcome: 'expired' });
  } finally {
    await s.close();
  }
});

test('the wrong pairing code five times kills the code', async () => {
  const s = await serve({ token: TOKEN });
  try {
    const { code } = await (
      await fetch(s.url('/api/pair/new'), { method: 'POST', headers: { 'x-cctv-token': TOKEN } })
    ).json();
    for (let i = 0; i < 5; i++) {
      const res = await fetch(s.url('/api/pair'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-cctv-token': TOKEN },
        body: JSON.stringify({ code: '000000' }),
      });
      assert.equal(res.status, 403);
    }
    const real = await fetch(s.url('/api/pair'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cctv-token': TOKEN },
      body: JSON.stringify({ code }),
    });
    assert.equal(real.status, 403, 'the burned code must not pair');
  } finally {
    await s.close();
  }
});

test('pairing requires view auth', async () => {
  const s = await serve({ token: TOKEN });
  try {
    const res = await fetch(s.url('/api/pair'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '123456' }),
    });
    assert.equal(res.status, 401, 'the open internet cannot even attempt the code');
  } finally {
    await s.close();
  }
});

test('the act cookie is Secure through the tunnel host and not on loopback', async () => {
  const s = await serve({ token: TOKEN });
  try {
    s.server.setTunnel({ host: 'abc.trycloudflare.com', provider: 'cloudflare', url: 'https://abc.trycloudflare.com', since: 1 });
    const mint = () =>
      fetch(s.url('/api/pair/new'), { method: 'POST', headers: { 'x-cctv-token': TOKEN } }).then((r) => r.json());

    const { code: c1 } = await mint();
    const viaTunnel = await rawPost(s.port, '/api/pair', {
      headers: {
        host: 'abc.trycloudflare.com',
        'content-type': 'application/json',
        'x-cctv-token': TOKEN,
      },
      body: JSON.stringify({ code: c1 }),
    });
    assert.equal(viaTunnel.status, 200);
    assert.match(String(viaTunnel.headers['set-cookie']), /Secure/);

    const { code: c2 } = await mint();
    const viaLoopback = await rawPost(s.port, '/api/pair', {
      headers: { host: 'localhost', 'content-type': 'application/json', 'x-cctv-token': TOKEN },
      body: JSON.stringify({ code: c2 }),
    });
    assert.equal(viaLoopback.status, 200);
    assert.doesNotMatch(String(viaLoopback.headers['set-cookie']), /Secure/);
  } finally {
    await s.close();
  }
});

test('snapshot and the SSE stream carry approvals state', async () => {
  const s = await serve({ token: TOKEN });
  try {
    const state = await (await fetch(s.url('/api/state'), { headers: { 'x-cctv-token': TOKEN } })).json();
    assert.deepEqual(state.approvals, { armed: false, until: null, pendings: [] });
    // Arming broadcasts an `approvals` frame to connected SSE clients.
    const res = await new Promise((resolve, reject) => {
      const req = http.get(
        { host: '127.0.0.1', port: s.port, path: '/api/stream', headers: { 'x-cctv-token': TOKEN } },
        resolve
      );
      req.on('error', reject);
    });
    let buf = '';
    const sawApprovals = new Promise((resolveSeen) => {
      res.on('data', (c) => {
        buf += c;
        if (buf.includes('event: approvals')) resolveSeen();
      });
    });
    s.server.approvals.setArmed(true);
    await sawApprovals;
    res.destroy();
    assert.ok(buf.includes('"armed":true'));
  } finally {
    await s.close();
  }
});

test('server.close() drains held approval long-polls so shutdown is not hostage to them', async () => {
  const s = await serve({ token: TOKEN });
  try {
    s.server.approvals.setArmed(true);
    const held = fetch(s.url('/api/approvals/pending'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cctv-token': TOKEN },
      body: JSON.stringify({ session_id: 'x', tool_name: 'Bash', tool_input: {} }),
    });
    await new Promise((r) => setTimeout(r, 50));
    await s.close(); // must return, not hang
    const body = await (await held).json();
    assert.deepEqual(body, { armed: true, decision: null });
  } finally {
    try {
      await s.close();
    } catch {}
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/server.test.js`
Expected: FAIL — 404s / missing `approvals` on state (existing tests still pass).

- [ ] **Step 3: Implement in `src/server.js`**

At the top, import and constants (beside `COOKIE_NAME` / `COOKIE_MAX_AGE_S`, `src/server.js:33-38`):

```js
import { createApprovals } from './approvals.js';
```

```js
const ACT_COOKIE = 'cctv-act';
/** 7 days where the view cookie gets 30: this one is execute power on a
 *  stealable phone — and server memory is the real authority anyway, so a
 *  longer-lived cookie would only outlive its own validity. */
const ACT_COOKIE_MAX_AGE_S = 7 * 24 * 60 * 60;
```

Generalise the cookie scan: rename the body of `cookieTokens(req)` into a
`cookieValues(req, name)` helper and keep `cookieTokens(req)` as
`cookieValues(req, COOKIE_NAME)` — the multi-pair rationale in its comment
applies to both names verbatim.

Inside `createServer()`, after the `clients` Set and `broadcast` are defined:

```js
const approvals = createApprovals({
  onChange: (reason) => {
    broadcast('approvals', approvals.state());
    // The terminal is the operator's log of record for arming — a remote
    // toggle they did not expect deserves a line they will actually see.
    if (reason === 'armed') console.log('  approvals armed — permission prompts also go to the wall');
    if (reason === 'disarmed') console.log('  approvals disarmed');
    if (reason === 'auto-disarm') console.log('  approvals auto-disarmed (4h) — re-arm from a paired device');
  },
});

function actAuthed(req) {
  return cookieValues(req, ACT_COOKIE).some((v) => approvals.isDevice(v));
}
```

Snapshot (`src/server.js:235`) becomes:

```js
const snapshot = () => ({ ...store.snapshot(), tunnel, approvals: approvals.state() });
```

Routes, inserted **after** the generic `/api/` auth gate (`src/server.js:306-308`) and before `/api/state`:

```js
if (route === '/api/approvals/pending' && req.method === 'POST') {
  let body;
  try {
    body = safeJson(await readBody(req));
  } catch {
    return json(res, 413, { error: 'too large' });
  }
  if (!body || typeof body !== 'object') return json(res, 400, { error: 'bad json' });
  if (!approvals.isArmed()) return json(res, 200, { armed: false });
  const meta = {
    sessionId: String(body.session_id || ''),
    toolName: String(body.tool_name || ''),
    toolInput: body.tool_input ?? null,
    cwd: String(body.cwd || ''),
    permissionMode: String(body.permission_mode || ''),
  };
  // The pending IS this response. resolve() fires exactly once — from a
  // decision, a drain, or never (socket close removes it first).
  const pending = approvals.add(meta, (decision) => {
    try {
      json(res, 200, { armed: true, decision });
    } catch {}
  });
  req.on('close', () => approvals.remove(pending.id));
  return; // held open on purpose
}

const decision = route.match(/^\/api\/approvals\/([\w-]+)\/decision$/);
if (decision && req.method === 'POST') {
  if (!actAuthed(req)) return json(res, 403, { error: 'pairing required' });
  let body;
  try {
    body = safeJson(await readBody(req, 64 * 1024));
  } catch {
    return json(res, 413, { error: 'too large' });
  }
  const behavior = body?.behavior;
  if (behavior !== 'allow' && behavior !== 'deny') {
    return json(res, 400, { error: 'behavior must be allow or deny' });
  }
  const r = approvals.decide(decision[1], behavior);
  if (!r.ok) return json(res, 409, { outcome: r.outcome });
  return json(res, 200, { ok: true });
}

if (route === '/api/approvals/armed' && req.method === 'POST') {
  if (!actAuthed(req)) return json(res, 403, { error: 'pairing required' });
  let body;
  try {
    body = safeJson(await readBody(req, 4 * 1024));
  } catch {
    return json(res, 413, { error: 'too large' });
  }
  if (typeof body?.on !== 'boolean') return json(res, 400, { error: 'on must be a boolean' });
  approvals.setArmed(body.on);
  return json(res, 200, approvals.state());
}

if (route === '/api/pair/new' && req.method === 'POST') {
  return json(res, 200, approvals.mintCode());
}

if (route === '/api/pair' && req.method === 'POST') {
  let body;
  try {
    body = safeJson(await readBody(req, 4 * 1024));
  } catch {
    return json(res, 413, { error: 'too large' });
  }
  const r = approvals.tryPair(String(body?.code ?? ''));
  if (!r.ok) return json(res, 403, { error: 'bad or expired code' });
  // Append, never overwrite: the view-cookie swap above may have set one
  // already on this same response.
  const prev = res.getHeader('set-cookie');
  const act =
    `${ACT_COOKIE}=${r.secret}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ACT_COOKIE_MAX_AGE_S}` +
    (secureFor(req) ? '; Secure' : '');
  res.setHeader('set-cookie', [...(Array.isArray(prev) ? prev : prev ? [prev] : []), act]);
  return json(res, 200, { ok: true });
}
```

In the `server.close` override (`src/server.js:427-446`), before
`closeIdleConnections()`:

```js
// Held approval long-polls are in-flight requests; close() would wait on
// them for up to the hook deadline. Draining answers them with no-decision,
// which is also the right message: this server is going away.
approvals.drain();
```

Expose beside `server.store` (`src/server.js:448`):

```js
server.approvals = approvals;
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS — new tests green, nothing existing broken.

- [ ] **Step 5: Commit**

```bash
git add src/server.js test/server.test.js
git commit -m "feat: approval endpoints — the pending is the hook's held socket"
```

---

### Task 3: `src/approve-hook.js` — the blocking decision hook

**Files:**
- Create: `src/approve-hook.js`
- Create: `test/approve-hook.test.js`

**Interfaces:**
- Consumes: `POST /api/approvals/pending` (Task 2), `CONFIG_FILE` shape `{port, host, token}` from `src/paths.js`.
- Produces: stdout is either empty or one line of
  `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{...}}}`;
  exit code is always 0. Env knobs: `AGENT_CCTV_APPROVE_DEADLINE_MS` (default 270000), `AGENT_CCTV_PORT`.
- Task 4 registers this file's path in settings.json.

- [ ] **Step 1: Write the failing tests**

Create `test/approve-hook.test.js`:

```js
import './helpers/env.js'; // must come first — see the file's comment
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/server.js';
import { Store } from '../src/store.js';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'approve-hook.js');
const TOKEN = 't'.repeat(32);

const ENVELOPE = JSON.stringify({
  session_id: 'sess-hook',
  hook_event_name: 'PermissionRequest',
  cwd: '/tmp/p',
  permission_mode: 'default',
  tool_name: 'Bash',
  tool_input: { command: 'touch x' },
});

/** A home whose config.json points the hook at the given port. */
function homeFor(port) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cctv-approve-'));
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ port, host: '127.0.0.1', token: TOKEN }),
    { mode: 0o600 }
  );
  return home;
}

/** Run the hook to completion: resolves {code, stdout, ms}. */
function runHook({ port, deadlineMs = 30000, input = ENVELOPE }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [HOOK], {
      env: {
        ...process.env,
        AGENT_CCTV_HOME: homeFor(port),
        AGENT_CCTV_APPROVE_DEADLINE_MS: String(deadlineMs),
        AGENT_CCTV_PORT: '', // the config file, not the test process env, names the port
      },
    });
    let stdout = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.on('exit', (code) => resolve({ code, stdout, ms: Date.now() - started }));
    child.stdin.end(input);
    child.testKill = () => child.kill('SIGTERM');
    runHook.last = child;
  });
}

async function serveApprovals() {
  const server = createServer({ store: new Store(), withSource: false, token: TOKEN });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

test('disarmed: the hook exits 0 quickly with no output', async () => {
  const s = await serveApprovals();
  try {
    const r = await runHook({ port: s.port });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.ok(r.ms < 5000);
  } finally {
    await s.close();
  }
});

test('armed + allow: the hook prints the PermissionRequest allow output', async () => {
  const s = await serveApprovals();
  try {
    s.server.approvals.setArmed(true);
    const done = runHook({ port: s.port });
    let list = [];
    for (let i = 0; i < 100 && !list.length; i++) {
      await new Promise((r) => setTimeout(r, 20));
      list = s.server.approvals.list();
    }
    assert.equal(list[0].toolName, 'Bash');
    s.server.approvals.decide(list[0].id, 'allow');
    const r = await done;
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out, {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    });
  } finally {
    await s.close();
  }
});

test('armed + deny: the output carries the fixed template message', async () => {
  const s = await serveApprovals();
  try {
    s.server.approvals.setArmed(true);
    const done = runHook({ port: s.port });
    let list = [];
    for (let i = 0; i < 100 && !list.length; i++) {
      await new Promise((r) => setTimeout(r, 20));
      list = s.server.approvals.list();
    }
    s.server.approvals.decide(list[0].id, 'deny');
    const out = JSON.parse((await done).stdout);
    assert.equal(out.hookSpecificOutput.decision.behavior, 'deny');
    assert.equal(out.hookSpecificOutput.decision.message, 'Denied from the agent-cctv wall.');
  } finally {
    await s.close();
  }
});

test('a drain (disarm) mid-poll means silence, not a decision', async () => {
  const s = await serveApprovals();
  try {
    s.server.approvals.setArmed(true);
    const done = runHook({ port: s.port });
    for (let i = 0; i < 100 && !s.server.approvals.list().length; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    s.server.approvals.setArmed(false);
    const r = await done;
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
  } finally {
    await s.close();
  }
});

test('no server: exit 0, silent, fast', async () => {
  const r = await runHook({ port: 1 }); // nothing listens on port 1
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.ok(r.ms < 5000);
});

test('self-deadline: an unanswered pending ends in silence before the backstop', async () => {
  const s = await serveApprovals();
  try {
    s.server.approvals.setArmed(true);
    const r = await runHook({ port: s.port, deadlineMs: 400 });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.ok(r.ms < 5000);
  } finally {
    await s.close();
  }
});

test('SIGTERM mid-poll (the local operator answered first): exit 0, silent', async () => {
  const s = await serveApprovals();
  try {
    s.server.approvals.setArmed(true);
    const done = runHook({ port: s.port });
    for (let i = 0; i < 100 && !s.server.approvals.list().length; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    runHook.last.kill('SIGTERM');
    const r = await done;
    assert.equal(r.stdout, '');
  } finally {
    await s.close();
  }
});

test('garbage stdin: exit 0, silent', async () => {
  const r = await runHook({ port: 1, input: 'not json' });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/approve-hook.test.js`
Expected: FAIL — the hook file does not exist (spawn exits non-zero / no output contract).

- [ ] **Step 3: Implement `src/approve-hook.js`**

```js
#!/usr/bin/env node
/**
 * The approvals decision hook. Claude Code runs this on PermissionRequest.
 *
 * This is src/hook.js's opposite, and deliberately a separate file: that one
 * must never block and never write stdout; this one exists to block and its
 * stdout IS the decision. What they share is the exit contract:
 *
 *   1. Every exit is exit 0. A hook failure must read as "no opinion",
 *      never as an error in the operator's session.
 *   2. Silence (no stdout) means "fall through to the terminal prompt".
 *      That is the documented Claude Code semantic, and it is the entire
 *      fail-safe: server down, disarmed, deadline, drain, SIGTERM — silence.
 *   3. The deadline is OURS (270 s), enforced here, under the settings.json
 *      backstop of 300 s. What a cancelled hook means is undocumented; what
 *      exit-0-no-output means is documented. We only ever rely on the latter.
 */
import fs from 'node:fs';
import http from 'node:http';
import { CONFIG_FILE, DEFAULT_PORT, DEFAULT_HOST } from './paths.js';

const DEADLINE_MS = Number(process.env.AGENT_CCTV_APPROVE_DEADLINE_MS) || 270_000;
/** Model-visible, fixed on purpose. Free text from the phone would be
 *  operator speech; interpolated tool input would be an injection surface. */
const DENY_MESSAGE = 'Denied from the agent-cctv wall.';

let done = false;
function finish(output) {
  if (done) return;
  done = true;
  if (output) {
    try {
      process.stdout.write(output);
    } catch {}
  }
  process.exit(0);
}

const bail = setTimeout(() => finish(), DEADLINE_MS);
bail.unref?.();
// The local operator answering the terminal prompt first kills this process.
// That is a normal ending, not an error.
process.on('SIGTERM', () => finish());
process.on('SIGINT', () => finish());

function config() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      data += c;
      if (data.length > 4 * 1024 * 1024) resolve(data);
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function output(decision) {
  if (!decision) return null;
  if (decision.behavior !== 'allow' && decision.behavior !== 'deny') return null;
  const d = { behavior: decision.behavior };
  if (d.behavior === 'deny') d.message = DENY_MESSAGE;
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: d },
  });
}

async function main() {
  const raw = (await readStdin()).trim();
  if (!raw) return finish();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return finish();
  }

  const cfg = config();
  const body = JSON.stringify({
    session_id: payload.session_id || '',
    tool_name: payload.tool_name || '',
    tool_input: payload.tool_input ?? null,
    cwd: payload.cwd || '',
    permission_mode: payload.permission_mode || '',
  });

  const req = http.request(
    {
      host: cfg.host || DEFAULT_HOST,
      port: Number(process.env.AGENT_CCTV_PORT) || cfg.port || DEFAULT_PORT,
      path: '/api/approvals/pending',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-cctv-token': cfg.token || '',
      },
    },
    (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          finish(output(JSON.parse(data).decision));
        } catch {
          finish();
        }
      });
      res.on('error', () => finish());
    }
  );
  // No req.setTimeout: the response is SUPPOSED to hang while armed. The bail
  // timer above is the only clock, and it exits before the settings backstop.
  req.on('error', () => finish());
  req.end(body);
}

main().catch(() => finish());
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/approve-hook.test.js`
Expected: PASS (all 8)

- [ ] **Step 5: Commit**

```bash
git add src/approve-hook.js test/approve-hook.test.js
git commit -m "feat: the decision hook — blocks on purpose, fails to silence"
```

---

### Task 4: installer — the `PermissionRequest` entry, the version floor, the capability

**Files:**
- Modify: `src/install.js`
- Modify: `src/sources/claude-code/index.js` (the `capabilities()` function, around line 41)
- Test: `test/unit.test.js` (append to the `settings install` section, around line 800)

**Interfaces:**
- Consumes: `APPROVE_SCRIPT` path = `src/approve-hook.js` (Task 3).
- Produces (used by Task 5):
  - `installApprovals({file}) -> {file, backup, event, command}`
  - `approvalsInstalled({file}) -> boolean`
  - `claudeVersionOk(versionString) -> boolean`, `MIN_CLAUDE_VERSION = '2.1.226'`
  - `status({file})` gains an `approvals: boolean` key
  - `capabilities()` gains `approvals: boolean`

- [ ] **Step 1: Write the failing tests**

Append to `test/unit.test.js` (it already imports `* as installer` at line 12; add `os` import if missing — check the top of the file first):

```js
test('installApprovals writes one PermissionRequest entry with its own timeout', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cctv-approvals-install-'));
  const file = path.join(dir, 'settings.json');
  installer.installApprovals({ file });
  installer.installApprovals({ file }); // twice must not duplicate
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  const groups = settings.hooks.PermissionRequest;
  assert.equal(groups.length, 1);
  assert.equal(groups[0].matcher, '*');
  assert.equal(groups[0].hooks.length, 1);
  assert.equal(groups[0].hooks[0].timeout, 300, 'the 5s enrichment timeout must not leak in');
  assert.match(groups[0].hooks[0].command, /approve-hook\.js/);
  assert.equal(installer.approvalsInstalled({ file }), true);
  assert.equal(installer.status({ file }).approvals, true);

  // Plain install() must not add it, and uninstall() must remove it.
  const plain = path.join(dir, 'plain.json');
  installer.install({ file: plain });
  assert.equal(installer.approvalsInstalled({ file: plain }), false);
  installer.uninstall({ file });
  assert.equal(installer.approvalsInstalled({ file }), false);
  assert.equal(
    JSON.parse(fs.readFileSync(file, 'utf8')).hooks?.PermissionRequest,
    undefined,
    'the emptied group must not linger'
  );
});

test('claudeVersionOk enforces the spike-verified floor', () => {
  assert.equal(installer.MIN_CLAUDE_VERSION, '2.1.226');
  assert.equal(installer.claudeVersionOk('2.1.226 (Claude Code)'), true);
  assert.equal(installer.claudeVersionOk('2.1.227'), true);
  assert.equal(installer.claudeVersionOk('2.2.0'), true);
  assert.equal(installer.claudeVersionOk('3.0.0'), true);
  assert.equal(installer.claudeVersionOk('2.1.225'), false);
  assert.equal(installer.claudeVersionOk('2.0.999'), false);
  assert.equal(installer.claudeVersionOk('1.9.9'), false);
  assert.equal(installer.claudeVersionOk(''), false);
  assert.equal(installer.claudeVersionOk(null), false);
  assert.equal(installer.claudeVersionOk('no digits here'), false);
});

test('capabilities() reports whether the approvals hook is installed', async () => {
  const { capabilities } = await import('../src/sources/claude-code/index.js');
  assert.equal(typeof capabilities().approvals, 'boolean');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/unit.test.js --test-name-pattern "installApprovals|claudeVersionOk|approvals hook"`
Expected: FAIL — `installer.installApprovals is not a function`

- [ ] **Step 3: Implement in `src/install.js`**

Additions (constants beside `HOOK_SCRIPT` at line 7; `isOurs` at line 30 gains the new path):

```js
export const APPROVE_SCRIPT = path.join(__dirname, 'approve-hook.js');
export const APPROVALS_EVENT = 'PermissionRequest';
/** Its own number, not the shared enrichment `timeout: 5`. This is only the
 *  backstop — the hook self-deadlines at 270 s and exits 0 first, because
 *  what a *cancelled* hook means is undocumented and we refuse to rely on it. */
export const APPROVALS_TIMEOUT_S = 300;
/** The Claude Code build the PermissionRequest behavior was verified against.
 *  What an older build does with an unknown hook event is untested, and an
 *  opt-in feature is not worth finding out on the operator's machine. */
export const MIN_CLAUDE_VERSION = '2.1.226';

export function approveCommand() {
  return `"${process.execPath}" "${APPROVE_SCRIPT}"`;
}

export function claudeVersionOk(versionString) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(versionString || ''));
  if (!m) return false;
  const [maj, min, pat] = m.slice(1).map(Number);
  const [fMaj, fMin, fPat] = MIN_CLAUDE_VERSION.split('.').map(Number);
  if (maj !== fMaj) return maj > fMaj;
  if (min !== fMin) return min > fMin;
  return pat >= fPat;
}

export function installApprovals({ file = CLAUDE_SETTINGS, command = approveCommand() } = {}) {
  const settings = readSettings(file);
  const backup = backupSettings(file);
  settings.hooks = settings.hooks || {};
  const groups = Array.isArray(settings.hooks[APPROVALS_EVENT]) ? settings.hooks[APPROVALS_EVENT] : [];
  for (const g of groups) {
    if (Array.isArray(g.hooks)) g.hooks = g.hooks.filter((h) => !isOurs(h));
  }
  const entry = { type: 'command', command, timeout: APPROVALS_TIMEOUT_S };
  const target = groups.find((g) => (g.matcher ?? null) === '*');
  if (target) {
    target.hooks = target.hooks || [];
    target.hooks.push(entry);
  } else {
    groups.push({ matcher: '*', hooks: [entry] });
  }
  settings.hooks[APPROVALS_EVENT] = groups.filter((g) => Array.isArray(g.hooks) && g.hooks.length);
  writeSettings(settings, file);
  return { file, backup, event: APPROVALS_EVENT, command };
}

export function approvalsInstalled({ file = CLAUDE_SETTINGS } = {}) {
  try {
    const groups = readSettings(file).hooks?.[APPROVALS_EVENT];
    return Array.isArray(groups) && groups.some((g) => Array.isArray(g.hooks) && g.hooks.some(isOurs));
  } catch {
    return false;
  }
}
```

`isOurs` becomes:

```js
function isOurs(entry) {
  const cmd = entry?.command || '';
  return cmd.includes(MARKER) || cmd.includes(HOOK_SCRIPT) || cmd.includes(APPROVE_SCRIPT);
}
```

`status()` return gains `approvals: approvalsInstalled({ file })` (guard: `status` already try/catches readSettings — compute it inside the happy path and set `approvals: false` in the error return).

Note `uninstall()` needs no change: it walks **every** event key in
`settings.hooks` and filters with `isOurs`, which now matches the approve
script — the new test proves it.

In `src/sources/claude-code/index.js`, import at the top and extend `capabilities()`:

```js
import { approvalsInstalled } from '../../install.js';
```

```js
    // Remote approvals are wired only when the operator opted in with
    // `agent-cctv install --approvals` — the wall's honesty about which tiles
    // can grow buttons starts here.
    approvals: approvalsInstalled(),
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/install.js src/sources/claude-code/index.js test/unit.test.js
git commit -m "feat: install --approvals plumbing — its own entry, its own timeout, a version floor"
```

---

### Task 5: CLI — `pair`, `install --approvals`, help/status/doctor honesty

**Files:**
- Modify: `bin/cctv.js`
- Test: `test/args.test.js` (append)

**Interfaces:**
- Consumes: Task 4's `installApprovals`, `claudeVersionOk`, `MIN_CLAUDE_VERSION`, `status().approvals`; Task 2's `POST /api/pair/new`.
- Produces: `agent-cctv pair`, `agent-cctv install --approvals`; the printed code + TTL is the human half of the pairing flow Task 7's dialog completes.

- [ ] **Step 1: Write the failing test**

Append to `test/args.test.js` (match its existing import of `parseArgs` from `../bin/cctv.js`):

```js
test('--approvals is a boolean flag and does not eat the subcommand', () => {
  const args = parseArgs(['install', '--approvals']);
  assert.deepEqual(args._, ['install']);
  assert.equal(args.flags.approvals, true);
  const reversed = parseArgs(['--approvals', 'install']);
  assert.deepEqual(reversed._, ['install']);
  assert.equal(reversed.flags.approvals, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/args.test.js`
Expected: FAIL — `args.flags.approvals` is `'install'`, not `true` (the generic rule ate the subcommand).

- [ ] **Step 3: Implement in `bin/cctv.js`**

1. `BOOLEAN_FLAGS` (line 37) gains `'approvals'`.
2. Import `execFileSync` (extend the existing `node:child_process` import at line 2).
3. In `cmdInstall(flags)` (line 420), after the existing `installer.install({ file })` succeeds, add:

```js
    if (flags.approvals) {
      let version = null;
      try {
        version = execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 5000 });
      } catch {}
      if (!installer.claudeVersionOk(version)) {
        console.error('');
        console.error(
          c.red(`  ✗ remote approvals need Claude Code ≥ ${installer.MIN_CLAUDE_VERSION}`) +
            c.dim(version ? ` (found ${version.trim()})` : ' (could not run `claude --version`)')
        );
        console.error(c.dim('  The PermissionRequest hook is verified against that build; older ones are untested.'));
        console.error(c.dim('  The enrichment hooks above were still installed.'));
        process.exitCode = 1;
        return;
      }
      const a = installer.installApprovals({ file });
      console.log(`  ${c.green('✓')} remote approvals hook installed (${c.bold(a.event)})`);
      console.log(c.dim('  Arm it from the wall after pairing a device: agent-cctv pair'));
      console.log('');
    }
```

4. New `cmdPair()` and wiring in `main()` (`else if (cmd === 'pair') await cmdPair();`):

```js
async function cmdPair() {
  const cfg = readConfig();
  const port = Number(process.env.AGENT_CCTV_PORT) || cfg.port || DEFAULT_PORT;
  const host = !cfg.host || cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host;
  try {
    const res = await fetch(`http://${host}:${port}/api/pair/new`, {
      method: 'POST',
      headers: { 'x-cctv-token': cfg.token || '' },
    });
    if (!res.ok) throw new Error(`the wall answered ${res.status}`);
    const { code, ttlMs } = await res.json();
    const mins = Math.round(ttlMs / 60000);
    console.log('');
    console.log(`  pairing code  ${c.bold(c.cyan(code))}`);
    console.log('');
    console.log(c.dim(`  On the device that should get Allow/Deny buttons, open the wall,`));
    console.log(c.dim(`  tap the shield in the header, and enter this code.`));
    console.log(c.dim(`  One device, one use, ${mins} minutes. Restarting the wall unpairs everyone.`));
    console.log('');
  } catch (err) {
    console.error(c.red('  ✗ could not reach the wall — is agent-cctv running?'));
    console.error(c.dim(`    ${err.message}`));
    process.exitCode = 1;
  }
}
```

5. `HELP` (line 93): under Usage add
   `agent-cctv pair           Show a one-time code that lets a device approve permissions`
   and under Options add
   `--approvals      With install: also route permission prompts to the wall (Claude Code ≥ 2.1.226)`.
6. `cmdStatus()` hooks line (line 413): append `· approvals ${installer.status().approvals ? c.green('yes') : c.dim('no')}` (reuse the `hooks` variable already in scope).
7. `cmdDoctor()` (line 477): after the hooks row add:

```js
  console.log(
    `  ${hooks.approvals ? c.green('✓') : c.dim('–')} approvals${' '.repeat(14)} ${c.dim(
      hooks.approvals ? 'permission prompts can be answered from the wall' : 'not installed (agent-cctv install --approvals)'
    )}`
  );
```

- [ ] **Step 4: Run the suite and eyeball the help**

Run: `npm test && node bin/cctv.js help | grep -A1 pair`
Expected: tests PASS; the pair line prints.

- [ ] **Step 5: Commit**

```bash
git add bin/cctv.js test/args.test.js
git commit -m "feat: pair and install --approvals — the terminal half of the pairing flow"
```

---

### Task 6: `public/approvals.js` + `public/notify.js` — the DOM-free halves

**Files:**
- Create: `public/approvals.js`
- Modify: `public/notify.js`
- Test: `test/approvals.test.js` (append)
- Test: `test/unit.test.js` (append, beside the existing `shouldNotify` tests at line 740)

**Interfaces:**
- Consumes: pending shape from Task 2 (`{id, sessionId, toolName, toolInput, cwd, permissionMode, since, deadline}`).
- Produces (used by Task 7's DOM code):
  - `revealInvisibles(text) -> {text, count}`
  - `inputRows(toolName, toolInput) -> [[label, value], ...]`
  - `inputBytes(toolInput) -> number` and `fmtBytes(n) -> string`
  - `secondsLeft(deadline, now) -> number`
  - notify: `newPendings(prev, next) -> pending[]`, `describeApproval(p) -> {title, body, tag}`

- [ ] **Step 1: Write the failing tests**

Append to `test/approvals.test.js`:

```js
import {
  revealInvisibles,
  inputRows,
  inputBytes,
  fmtBytes,
  secondsLeft,
} from '../public/approvals.js';

test('revealInvisibles makes bidi overrides and controls visible and counts them', () => {
  const sneaky = 'echo ‮txt.hsab‬';
  const r = revealInvisibles(sneaky);
  assert.equal(r.count, 2);
  assert.ok(r.text.includes('⟨U+202E⟩'), 'the override must be spelled out, not rendered');
  assert.ok(!/[‪-‮]/.test(r.text));
  assert.deepEqual(revealInvisibles('plain text'), { text: 'plain text', count: 0 });
  // Newlines and tabs are formatting, not tricks.
  assert.equal(revealInvisibles('a\n\tb').count, 0);
});

test('inputRows shows the full payload for the tools people actually approve', () => {
  assert.deepEqual(inputRows('Bash', { command: 'rm -rf build', description: 'clean' }), [
    ['command', 'rm -rf build'],
    ['description', 'clean'],
  ]);
  assert.deepEqual(inputRows('Write', { file_path: '/a/b.js', content: 'x = 1' }), [
    ['file', '/a/b.js'],
    ['content', 'x = 1'],
  ]);
  assert.deepEqual(inputRows('Edit', { file_path: '/a/b.js', old_string: 'a', new_string: 'b' }), [
    ['file', '/a/b.js'],
    ['old', 'a'],
    ['new', 'b'],
  ]);
  // Unknown tools (mcp__*) fall back to the whole input, pretty-printed.
  const rows = inputRows('mcp__github__push', { repo: 'x' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0][0], 'input');
  assert.ok(rows[0][1].includes('"repo": "x"'));
});

test('inputBytes and fmtBytes tell the truth about size', () => {
  assert.equal(inputBytes({ command: 'ls' }), JSON.stringify({ command: 'ls' }).length);
  assert.equal(fmtBytes(17), '17 B');
  assert.equal(fmtBytes(4096), '4.0 KB');
  assert.equal(fmtBytes(1536), '1.5 KB');
});

test('secondsLeft clamps at zero', () => {
  assert.equal(secondsLeft(1000, 0), 1);
  assert.equal(secondsLeft(0, 5000), 0);
});
```

Append to `test/unit.test.js` (extend the notify import at line 16 with the new names):

```js
test('newPendings alerts only on ids not seen before', () => {
  const a = { id: 'p1', toolName: 'Bash' };
  const b = { id: 'p2', toolName: 'Write' };
  assert.deepEqual(newPendings([], [a, b]), [a, b]);
  assert.deepEqual(newPendings([a], [a, b]), [b]);
  assert.deepEqual(newPendings([a, b], [a, b]), []);
  assert.deepEqual(newPendings(undefined, [a]), [a], 'first state counts as all-new');
});

test('describeApproval never leaks tool input into a lock-screen notification', () => {
  const d = describeApproval({
    id: 'p1',
    toolName: 'Bash',
    toolInput: { command: 'secret-cmd --password hunter2' },
    cwd: '/home/me/proj',
  });
  assert.equal(d.title, 'Approval needed');
  assert.ok(d.body.includes('Bash'));
  assert.ok(d.body.includes('proj'));
  assert.ok(!JSON.stringify(d).includes('hunter2'), 'input content is banned from notifications');
  assert.equal(d.tag, 'cctv:approval:p1');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/approvals.test.js test/unit.test.js`
Expected: FAIL — missing module / missing exports.

- [ ] **Step 3: Implement**

Create `public/approvals.js`:

```js
/*
  The DOM-free half of the approval card, importable by node:test like
  notify.js and match.js. The card is a security surface: the person tapping
  Allow authorizes execution on the strength of what it shows, so nothing
  here may truncate, and characters that lie about their own rendering are
  spelled out instead of trusted.
*/

/** C0 controls (minus \n \t \r), DEL, zero-widths, bidi controls, BOM.
 *  Spelled in \u escapes on purpose — a literal bidi character in this file
 *  would be the very trick the function exists to reveal. */
const INVISIBLE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** U+202E can render `rm -rf /` as something innocuous. Make it loud. */
export function revealInvisibles(text) {
  let count = 0;
  const out = String(text).replace(INVISIBLE, (ch) => {
    count++;
    return `⟨U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}⟩`;
  });
  return { text: out, count };
}

/** Full payload, per tool. An ellipsized command beside an Allow button is
 *  the rubber stamp this feature must never ship. */
export function inputRows(toolName, toolInput) {
  const t = toolInput || {};
  if (toolName === 'Bash') {
    const rows = [['command', String(t.command ?? '')]];
    if (t.description) rows.push(['description', String(t.description)]);
    return rows;
  }
  if (toolName === 'Write') {
    return [
      ['file', String(t.file_path ?? '')],
      ['content', String(t.content ?? '')],
    ];
  }
  if (toolName === 'Edit') {
    return [
      ['file', String(t.file_path ?? '')],
      ['old', String(t.old_string ?? '')],
      ['new', String(t.new_string ?? '')],
    ];
  }
  return [['input', JSON.stringify(t, null, 2)]];
}

export function inputBytes(toolInput) {
  return JSON.stringify(toolInput || {}).length;
}

export function fmtBytes(n) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

export function secondsLeft(deadline, now = Date.now()) {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}
```

Append to `public/notify.js`:

```js
/**
 * Alert on a pending approval the previous state did not have. Same edge
 * discipline as shouldNotify: ids, not counts, so a resolve+new in one frame
 * still alerts and a repaint never does.
 */
export function newPendings(prev, next) {
  const seen = new Set((prev || []).map((p) => p.id));
  return (next || []).filter((p) => !seen.has(p.id));
}

/**
 * Same privacy rule as describe(): tool INPUT is command lines and file
 * contents, and a notification outlives the dashboard's token gate on the
 * lock screen. Which tool, which project — enough to decide to look.
 */
export function describeApproval(p) {
  const where = p.cwd ? p.cwd.split('/').filter(Boolean).pop() : '';
  return {
    title: 'Approval needed',
    body: `${p.toolName}${where ? ' · ' + where : ''}`,
    tag: `cctv:approval:${p.id}`,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/approvals.test.js test/unit.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add public/approvals.js public/notify.js test/approvals.test.js test/unit.test.js
git commit -m "feat: card logic and approval alerts, DOM-free where the decisions are"
```

---

### Task 7: the wall — cards, the shield, the pairing dialog

**Files:**
- Modify: `public/index.html` (`.bar-actions` around line 215, dialog markup before `</body>`)
- Modify: `public/app.js` (buildTile ~167, SSE handlers ~1344, alert flow ~357)
- Modify: `public/icons.js` (shield icon, following the existing icon-export pattern — read the file first and match it)
- Modify: `public/styles.css`
- Test: `node --test test/spa-guard.test.js test/header-markup.test.js` must stay green.

**Interfaces:**
- Consumes: Task 6's helpers; Task 2's endpoints and `approvals` SSE event/snapshot field.
- Produces: the operator-visible feature. No later task depends on this one's internals.

Implementation notes an engineer new to this file needs:

- **Tiles are patched, never rebuilt** (CLAUDE.md). `buildTile(s)` gets one new
  `div.approvals` child, created once; a `renderApprovals()` pass updates card
  nodes in place keyed by pending id (add missing, remove gone — same pattern
  `paintGroupHead` uses for members).
- **State:** module-level `let approvalsState = { armed: false, until: null, pendings: [] };`
  Updated from two places only: `es.addEventListener('approvals', …)` and the
  `snapshot` handler (`data.approvals`), both calling one `applyApprovals(next)`.
- `applyApprovals(next)`:
  1. Alert pass (only when `booted` — the snapshot-suppression rule
     `alertFor` already follows): for each of `newPendings(approvalsState.pendings, next.pendings)`,
     if `canAlert()` show a `Notification` from `describeApproval(p)`, reusing
     the exact `Notification` construction in `alertFor` (`public/app.js:367`).
  2. `approvalsState = next`.
  3. Shield button: `armedBtn.dataset.state = next.armed ? 'on' : 'off'`;
     `aria-pressed` likewise.
  4. Group `next.pendings` by `sessionId`, call `renderApprovals(tile, list)`
     for every live tile (empty list clears).
  5. One shared 1 s `setInterval` while any pending exists updates each card's
     countdown text via `secondsLeft` (store the deadline in `card.dataset.deadline`);
     cleared when none remain.
- **Card DOM** (in app.js, using Task 6 helpers — everything `textContent`):

```js
function buildApprovalCard(p) {
  const card = document.createElement('div');
  card.className = 'approval';
  card.dataset.id = p.id;
  card.dataset.deadline = String(p.deadline);

  const head = document.createElement('div');
  head.className = 'approval-head';
  head.textContent = `${p.toolName} wants to run · ${p.permissionMode || 'default'}`;
  card.append(head);

  let flagged = 0;
  for (const [label, value] of inputRows(p.toolName, p.toolInput)) {
    const row = document.createElement('div');
    row.className = 'approval-row';
    const k = document.createElement('span');
    k.className = 'approval-k';
    k.textContent = label;
    const v = document.createElement('pre');
    v.className = 'approval-v';
    const revealed = revealInvisibles(value);
    flagged += revealed.count;
    v.textContent = revealed.text; // full, untruncated; CSS scrolls, never clips
    row.append(k, v);
    card.append(row);
  }

  const meta = document.createElement('div');
  meta.className = 'approval-meta';
  meta.textContent =
    fmtBytes(inputBytes(p.toolInput)) +
    (flagged ? ` · ⚠ ${flagged} hidden character(s) revealed` : '') +
    ' · ';
  const clock = document.createElement('span');
  clock.className = 'approval-clock';
  meta.append(clock);
  card.append(meta);

  const acts = document.createElement('div');
  acts.className = 'approval-acts';
  const deny = document.createElement('button');
  deny.type = 'button';
  deny.className = 'approval-deny';
  deny.textContent = 'Deny';
  deny.addEventListener('click', (e) => {
    e.stopPropagation(); // the tile underneath opens the inspector on click
    decide(p.id, 'deny');
  });
  const allow = document.createElement('button');
  allow.type = 'button';
  allow.className = 'approval-allow';
  allow.textContent = 'Allow';
  allow.addEventListener('click', (e) => {
    e.stopPropagation();
    decide(p.id, 'allow');
  });
  acts.append(deny, allow);
  card.append(acts);
  return card;
}
```

- **decide() and the 403 → pairing path:**

```js
async function decide(id, behavior) {
  const res = await fetch(api(`/api/approvals/${id}/decision`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ behavior }),
  });
  if (res.status === 403) openPairDialog();
  // 200 and 409 both end in an `approvals` frame repainting the queue —
  // nothing to do here, which is the socket-bound design paying off.
}
```

- **Shield button** in `.bar-actions`, before the bell (`public/index.html:230`),
  markup mirroring the bell's shape:

```html
<button class="act shield" id="armed" type="button" data-state="off" aria-pressed="false" aria-label="Remote approvals"></button>
```

  Click handler: if `!approvalsState.armed` and not yet paired, the arm POST
  will 403 → `openPairDialog()`; otherwise toggle:

```js
armedBtn.addEventListener('click', async () => {
  const res = await fetch(api('/api/approvals/armed'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ on: !approvalsState.armed }),
  });
  if (res.status === 403) openPairDialog();
});
```

- **Pairing dialog**: a `<dialog id="pair-dialog">` before `</body>` with a
  6-digit `<input inputmode="numeric" autocomplete="one-time-code">`, a short
  line of copy ("Run `agent-cctv pair` on the machine and enter the code"),
  Cancel and Pair buttons. Submit → `POST api('/api/pair')` with `{code}`;
  `200` closes the dialog and retries nothing (the user taps again — simpler
  than replaying intent); `403` shows "wrong or expired code" in the dialog
  via `textContent`. All copy set as static markup or `textContent`.
- **Unpaired read-only**: no client-side capability check — buttons always
  render, a tap answers 403, the dialog opens. The server is the authority;
  the UI just reacts. (A "pair to act" hint line in the card footer appears
  after any 403: set `document.body.dataset.unpaired = 'true'` and let CSS
  show the hint.)
- **styles.css**: `.approval` card (attention-colored left border, `max-height`
  ~14em with `overflow:auto` on `.approval-v`, monospace), `.act.shield[data-state='on']`
  filled accent, dialog styles matching the inspector's palette. No new header
  region, no tier change — the shield rides `.bar-actions`, which already sheds.

- [ ] **Step 1: Implement the markup, styles, icon, and app.js wiring above**

- [ ] **Step 2: Run the guard tests**

Run: `node --test test/spa-guard.test.js test/header-markup.test.js`
Expected: PASS — no `innerHTML` outside the icon allowlist (add the shield icon the same way existing icons are allowlisted), every icon-only button has an `aria-label`.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: See it with real eyes (no `claude` involved)**

```bash
node bin/cctv.js --no-open &
# then, in another shell — arm and inject a pending through the real endpoints:
TOKEN=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.HOME+'/.agent-cctv/config.json')).token)")
node bin/cctv.js pair   # pair a browser via the dialog first, arm via the shield
curl -s -X POST -H "x-cctv-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"session_id":"demo","tool_name":"Bash","tool_input":{"command":"echo ‮gnp.tohsneercs‬"},"cwd":"/tmp/demo","permission_mode":"default"}' \
  http://127.0.0.1:4599/api/approvals/pending
```

Expected: a card appears (on whichever tile matches, or check `/api/state` shows the pending), the bidi trick is spelled out as `⟨U+202E⟩`, Allow resolves the curl with the decision JSON.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/app.js public/approvals.js public/icons.js public/styles.css
git commit -m "feat: approval cards on the wall — full payloads, revealed tricks, first tap wins"
```

---

### Task 8: README, CLAUDE.md, and the manual end-to-end

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md` (Server section + Constraints)
- Modify: `docs/superpowers/specs/2026-08-09-remote-approvals-design.md` (only if the e2e contradicts it)

- [ ] **Step 1: README — "Approving from your phone"**

A section after the tunnels/team material carrying, verbatim:

> An Approve button behind the watch credential turns read exposure into code execution on the operator's machine.

Then, in the README's voice: `install --approvals`, the pairing walkthrough
(`agent-cctv pair`, the shield, the code), what armed means (4 h auto-disarm,
the terminal prompt stays live and the first answer wins), every failure lands
on the terminal prompt, Claude Code ≥ 2.1.226 only — other agents' tiles never
grow buttons because no mechanism exists, restart unpairs everything (the kill
switch), and alerts require the tab to be open.

- [ ] **Step 2: CLAUDE.md**

- Server section: note the three credential classes (`/api/health` open, token
  views, `cctv-act` cookie acts) and that a pending approval is a held HTTP
  response — never stored state.
- Constraints: add the deny-message constant rule and "the act secret travels
  only as a cookie".

- [ ] **Step 3: The manual end-to-end (the one time a human drives `claude`)**

Follow the spec's procedure: scratch project **outside** `~/.claude` (sensitive
paths prompt even when allowlisted), `agent-cctv install --approvals`, wall
running, paired browser, armed. In the scratch project run `claude` and ask for
`touch e2e-marker.txt`. Verify, in order:

1. The card appears with the full command; the terminal prompt is on screen at the same time.
2. Allow from the wall → the TUI prints *⎿ Allowed by PermissionRequest hook* and the file exists.
3. Deny a second attempt → the model reports the template message. **If the TUI
   errors on the deny output instead, the `message` field name guessed in
   `approve-hook.js` is wrong** — check the current hooks doc for the deny
   shape on `PermissionRequest`, fix the one constant, re-run, and record the
   verified shape in the spec's risk section.
4. Let one prompt sit: at 270 s the card expires and the terminal prompt still answers.
5. Answer one at the terminal first: the card disappears, the hook exits silently.
6. Disarm from the wall while a prompt is pending: the card drains, the terminal prompt stands.

- [ ] **Step 4: Full suite, one last time**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md docs/superpowers/specs/2026-08-09-remote-approvals-design.md
git commit -m "docs: remote approvals — the trust sentence, the walkthrough, the verified deny shape"
```

---

## Plan Self-Review (performed while writing)

- **Spec coverage:** hook (T3), install + floor (T4/T5), endpoints + socket-bound
  pendings + drains + pairing + cookies (T2), state module + auto-disarm (T1),
  cards + shield + dialog + notify (T6/T7), capabilities/doctor/status honesty
  (T4/T5), README + manual e2e + deny-shape verification (T8). The spec's
  "no keep-alive on the long-poll" is honored by writing none.
- **Type consistency:** pending shape `{id, sessionId, toolName, toolInput, cwd,
  permissionMode, since, deadline}` is identical in T1's `list()`, T2's routes and
  tests, T3's server-driven tests, and T6/T7's consumers. `decision` is
  `{behavior}` from server to hook everywhere; the deny `message` exists only
  inside `approve-hook.js`.
- **Placeholders:** none; every step carries its code or exact edit location.
