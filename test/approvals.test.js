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
