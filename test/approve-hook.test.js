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
  const started = Date.now();
  const child = spawn(process.execPath, [HOOK], {
    env: {
      ...process.env,
      AGENT_CCTV_HOME: homeFor(port),
      AGENT_CCTV_APPROVE_DEADLINE_MS: String(deadlineMs),
      AGENT_CCTV_PORT: '', // the config file, not the test process env, names the port
    },
  });
  runHook.last = child;
  const done = new Promise((resolve) => {
    let stdout = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.on('exit', (code) => resolve({ code, stdout, ms: Date.now() - started }));
  });
  child.stdin.end(input);
  return done;
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
