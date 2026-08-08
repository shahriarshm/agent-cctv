// Must come first: src/paths.js reads env at module load.
import './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ChatTailer } from '../src/sources/gemini/chats.js';
import { patchFromMeta as geminiPatch } from '../src/sources/gemini/index.js';
import { describeArgs } from '../src/util.js';
import { loadSqlite } from '../src/sqlite-poll.js';
import { OpencodeSource, capabilities as opencodeCaps } from '../src/sources/opencode/index.js';
import { HermesSource, patchFromRow as hermesPatch } from '../src/sources/hermes/index.js';
import { listSessions, loadSession } from '../src/history.js';

function tmpdir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cctv-${name}-`));
}

/* ── gemini chats ──────────────────────────────────────────────────────── */

const GEMINI_SESSION = 'bc647be8-149f-4faa-a5fb-4af87d608f3b';

function writeChat(lines, { slug = 'myproject', projectRoot = '/home/u/myproject' } = {}) {
  const root = tmpdir('gemini');
  const dir = path.join(root, slug, 'chats');
  fs.mkdirSync(dir, { recursive: true });
  if (projectRoot) fs.writeFileSync(path.join(root, slug, '.project_root'), projectRoot + '\n');
  fs.writeFileSync(
    path.join(dir, 'session-2026-08-06T10-00-bc647be8.jsonl'),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  );
  return root;
}

const header = {
  sessionId: GEMINI_SESSION,
  projectHash: 'abc123',
  startTime: '2026-08-06T10:00:00.000Z',
  lastUpdated: '2026-08-06T10:00:00.000Z',
  kind: 'main',
};

function collectChats(root) {
  const tailer = new ChatTailer({ root, freshWindowMs: 60 * 60e3 });
  const batches = [];
  tailer.on('batch', (b) => batches.push(b));
  tailer.scan(true);
  tailer.stop();
  return batches;
}

test('a gemini chat is found two directories deep and named by its header uuid', () => {
  const root = writeChat([
    header,
    { id: 'm1', timestamp: '2026-08-06T10:00:05Z', type: 'user', content: [{ text: 'ship it' }] },
  ]);
  const [batch] = collectChats(root);
  assert.equal(batch.sessionId, GEMINI_SESSION, 'the uuid comes off the header line, not the filename');
  assert.equal(batch.meta.cwd, '/home/u/myproject', 'cwd is read from .project_root, not guessed');
  assert.equal(batch.meta.startedAt, Date.parse(header.startTime));
  const kinds = batch.events.map((e) => e.kind);
  assert.deepEqual(kinds, ['session_start', 'prompt']);
  assert.equal(batch.events[1].detail, 'ship it');
  assert.equal(batch.events[1].source, 'gemini');
});

test('context the CLI injects as a user message is not a prompt', () => {
  const root = writeChat([
    header,
    { id: 'm1', timestamp: '2026-08-06T10:00:01Z', type: 'user', content: [{ text: '<session_context>today is…</session_context>' }] },
    { id: 'm2', timestamp: '2026-08-06T10:00:05Z', type: 'user', content: [{ text: 'real question' }] },
  ]);
  const prompts = collectChats(root)[0].events.filter((e) => e.kind === 'prompt');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].detail, 'real question');
});

test('a streaming re-append repeats no text but still surfaces late tool calls', () => {
  const gm = {
    id: 'g1',
    timestamp: '2026-08-06T10:00:10Z',
    type: 'gemini',
    content: [],
    thoughts: [{ subject: 'Plan', description: 'run the tests' }],
    model: 'gemini-3.5-flash',
  };
  const root = writeChat([
    header,
    gm,
    // The same message id again — this time carrying the toolCalls array,
    // which is exactly how the real log delivers it.
    { ...gm, toolCalls: [{ id: 'call-1', name: 'run_shell_command', args: { command: 'npm test' } }] },
    {
      id: 'u2',
      timestamp: '2026-08-06T10:00:14Z',
      type: 'user',
      content: [{ functionResponse: { id: 'call-1', name: 'run_shell_command', response: { output: 'ok' } } }],
    },
  ]);
  const events = collectChats(root)[0].events;
  const kinds = events.map((e) => e.kind);
  assert.deepEqual(kinds, ['session_start', 'thinking', 'tool_start', 'tool_end']);
  const start = events.find((e) => e.kind === 'tool_start');
  assert.equal(start.detail, 'npm test');
  assert.equal(start.tool.category, 'exec');
  const end = events.find((e) => e.kind === 'tool_end');
  assert.equal(end.tool.durationMs, 4000);
  assert.equal(end.detail, 'npm test', 'the result inherits the call it belongs to');
});

test('a $set snapshot and a later append of the same message emit once', () => {
  const msg = { id: 'm1', timestamp: '2026-08-06T10:00:05Z', type: 'user', content: [{ text: 'hello' }] };
  const root = writeChat([header, { $set: { messages: [msg] } }, msg]);
  const prompts = collectChats(root)[0].events.filter((e) => e.kind === 'prompt');
  assert.equal(prompts.length, 1);
});

test('gemini usage: latest input is the context, output sums once per message', () => {
  const gm = (id, input, output, cached = 0) => ({
    id,
    timestamp: '2026-08-06T10:00:10Z',
    type: 'gemini',
    content: [{ text: 'ok' }],
    tokens: { input, output, cached, thoughts: 10, tool: 0, total: input + output },
    model: 'gemini-3.5-flash',
  });
  const root = writeChat([header, gm('g1', 1000, 50), gm('g1', 1000, 50), gm('g2', 2000, 70, 500)]);
  const { usage, model } = collectChats(root)[0].meta;
  assert.equal(model, 'gemini-3.5-flash');
  assert.equal(usage.context, 2000, 'the newest request is the whole context');
  assert.equal(usage.output, 50 + 10 + 70 + 10, 'summed once per message id, thoughts included');
  assert.equal(usage.outputPartial, false, 'read from byte zero, so the sum is a true total');
  assert.equal(usage.input, 1000 + 1500, 'uncached input sums once per message id — cached is a subset of input');
  assert.equal(usage.cacheRead, 500);
  assert.equal(usage.cacheWrite, null, 'gemini records no cache-write number');
  assert.equal(usage.cost, null);
});

test('gemini patch carries transcript facts and nothing invented', () => {
  const patch = geminiPatch(
    { cwd: '/home/u/p', model: 'gemini-3.5-pro', startedAt: 123, usage: { context: 1 } },
    '/tmp/f.jsonl'
  );
  assert.equal(patch.source, 'gemini');
  assert.equal(patch.transcriptPath, '/tmp/f.jsonl');
  assert.equal(patch.cwd, '/home/u/p');
  assert.equal(patch.state, undefined, 'no registry means no claimed state');
});

test('describeArgs picks the argument a person would recognise', () => {
  assert.equal(describeArgs({ command: 'npm test', description: 'tests' }), 'npm test');
  assert.equal(describeArgs({ absolute_path: '/a/b/server.js' }), 'server.js');
  assert.equal(describeArgs({ query: 'node sqlite' }), 'node sqlite');
  assert.equal(describeArgs({}), '');
});

/* ── sqlite-backed sources ─────────────────────────────────────────────── */

// The whole point of the capability gate: on a Node without node:sqlite these
// adapters report unavailable and everything else runs. Same deal here.
const sqlite = loadSqlite();
const NOW = Date.now();

function openDb(name, ddl) {
  const file = path.join(tmpdir(name), `${name}.db`);
  const db = new sqlite.DatabaseSync(file);
  db.exec(ddl);
  return { file, db };
}

const OPENCODE_DDL = `
  CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT,
    model TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER,
    tokens_output INTEGER DEFAULT 0, tokens_reasoning INTEGER DEFAULT 0);
  CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER,
    time_updated INTEGER, data TEXT);
  CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
    time_created INTEGER, time_updated INTEGER, data TEXT);
`;

function opencodeFixture() {
  const { file, db } = openDb('opencode', OPENCODE_DDL);
  db.prepare('INSERT INTO session (id, directory, title, model, agent, time_created, time_updated, tokens_output, tokens_reasoning) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('ses_1', '/home/u/proj', 'Fix the tests', 'kimi-k3', 'build', NOW - 60e3, NOW - 1000, 500, 20);
  // A subagent session: excluded from tiles, and its parts must not leak.
  db.prepare('INSERT INTO session (id, parent_id, directory, time_created, time_updated) VALUES (?,?,?,?,?)')
    .run('ses_child', 'ses_1', '/home/u/proj', NOW - 50e3, NOW - 1000);
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)')
    .run('msg_u', 'ses_1', NOW - 50e3, NOW - 50e3, JSON.stringify({ role: 'user', time: { created: NOW - 50e3 } }));
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)')
    .run('msg_a', 'ses_1', NOW - 40e3, NOW - 1000, JSON.stringify({ role: 'assistant', modelID: 'kimi-k3', providerID: 'openrouter' }));
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)')
    .run('msg_c', 'ses_child', NOW - 30e3, NOW - 1000, JSON.stringify({ role: 'assistant' }));
  const part = (id, msg, ses, t, data) =>
    db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)')
      .run(id, msg, ses, t, t, JSON.stringify(data));
  part('prt_prompt', 'msg_u', 'ses_1', NOW - 50e3, { type: 'text', text: 'make the tests pass' });
  part('prt_think', 'msg_a', 'ses_1', NOW - 39e3, { type: 'reasoning', text: 'looking at the failures' });
  part('prt_tool', 'msg_a', 'ses_1', NOW - 38e3, {
    type: 'tool', tool: 'bash', callID: 'bash_1',
    state: { status: 'completed', input: { command: 'npm test' }, title: 'npm test' },
  });
  part('prt_leak', 'msg_c', 'ses_child', NOW - 29e3, { type: 'text', text: 'subagent chatter' });
  part('prt_step', 'msg_a', 'ses_1', NOW - 36e3, {
    type: 'step-finish', reason: 'stop',
    tokens: { input: 300, output: 100, reasoning: 20, cache: { read: 9000, write: 0 } },
  });
  return { file, db };
}

function collectSqlite(source, db, polls = 1) {
  const updates = [];
  source.on('update', (u) => updates.push(u));
  for (let i = 0; i < polls; i++) source.poll(db, i === 0);
  return updates;
}

test('opencode: sessions become patches, parts become events, children stay invisible', { skip: !sqlite }, () => {
  const { file, db } = opencodeFixture();
  const updates = collectSqlite(new OpencodeSource({ dbPath: file }), db);

  const ids = new Set(updates.map((u) => u.sessionId));
  assert.ok(!ids.has('ses_child'), 'a subagent session never becomes a tile');
  const main = updates.find((u) => u.sessionId === 'ses_1');
  assert.equal(main.patch.cwd, '/home/u/proj');
  assert.equal(main.patch.title, 'Fix the tests');
  assert.equal(main.patch.state, undefined, 'no registry means no claimed state');
  assert.equal(main.patch.usage.output, 520, "opencode's own running total, reasoning included");
  assert.equal(main.patch.usage.context, 300 + 9000, 'the step-finish input, cached portion included');
  assert.equal(main.bootstrap, true);

  const kinds = main.events.map((e) => e.kind);
  assert.deepEqual(kinds, ['prompt', 'thinking', 'tool_start', 'tool_end', 'turn_end']);
  const start = main.events.find((e) => e.kind === 'tool_start');
  assert.equal(start.detail, 'npm test');
  assert.equal(start.tool.category, 'exec');
  assert.ok(!main.events.some((e) => e.detail === 'subagent chatter'), "a child's parts do not leak into the parent");
});

test('opencode: a second poll over the same rows emits nothing twice', { skip: !sqlite }, () => {
  const { file, db } = opencodeFixture();
  const source = new OpencodeSource({ dbPath: file });
  const updates = collectSqlite(source, db, 2);
  const events = updates.flatMap((u) => u.events);
  assert.equal(events.filter((e) => e.kind === 'prompt').length, 1);
  assert.equal(events.filter((e) => e.kind === 'tool_end').length, 1);
});

test('opencode: a streaming text part re-emits only when it has grown', { skip: !sqlite }, () => {
  const { file, db } = opencodeFixture();
  const source = new OpencodeSource({ dbPath: file });
  const updates = collectSqlite(source, db);
  db.prepare('UPDATE part SET data = ?, time_updated = ? WHERE id = ?')
    .run(JSON.stringify({ type: 'text', text: 'make the tests pass — all of them' }), NOW + 1000, 'prt_prompt');
  source.poll(db, false);
  const prompts = updates.flatMap((u) => u.events).filter((e) => e.kind === 'prompt');
  assert.equal(prompts.length, 2, 'growth re-emits');
  assert.match(prompts[1].detail, /all of them/);
  source.poll(db, false);
  assert.equal(updates.flatMap((u) => u.events).filter((e) => e.kind === 'prompt').length, 2, 'no growth, no repeat');
});

test('opencode: an archived session is ended, with the reason stated', { skip: !sqlite }, () => {
  const { file, db } = opencodeFixture();
  db.prepare('UPDATE session SET time_archived = ? WHERE id = ?').run(NOW, 'ses_1');
  const updates = collectSqlite(new OpencodeSource({ dbPath: file }), db);
  const main = updates.find((u) => u.sessionId === 'ses_1');
  assert.equal(main.patch.state, 'ended');
  assert.equal(main.patch.endedReason, 'archived');
});

test('opencode capabilities: no database file means sqlite is not even the question', () => {
  const caps = opencodeCaps();
  assert.equal(caps.authoritative, false);
  assert.equal(caps.urgency, false, 'the permission table is an allowlist, not a pending queue');
});

/* ── hermes ────────────────────────────────────────────────────────────── */

const HERMES_DDL = `
  CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, parent_session_id TEXT, model TEXT,
    started_at REAL, ended_at REAL, end_reason TEXT, cwd TEXT, git_branch TEXT, title TEXT,
    output_tokens INTEGER DEFAULT 0, reasoning_tokens INTEGER DEFAULT 0);
  CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT,
    content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL,
    reasoning_content TEXT, active INTEGER DEFAULT 1);
`;

function hermesFixture() {
  const { file, db } = openDb('hermes', HERMES_DDL);
  const sec = NOW / 1000;
  db.prepare('INSERT INTO sessions (id, source, model, started_at, cwd, git_branch, title, output_tokens, reasoning_tokens) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('h1', 'cli', 'hermes-4', sec - 60, '/home/u/proj', 'main', 'Wire the sensor', 300, 40);
  // A gateway chat session: not a coding agent, not a tile.
  db.prepare('INSERT INTO sessions (id, source, started_at) VALUES (?,?,?)').run('h2', 'telegram', sec - 60);
  const msg = (ses, role, fields = {}) =>
    db.prepare('INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, reasoning_content) VALUES (?,?,?,?,?,?,?,?)')
      .run(ses, role, fields.content ?? null, fields.tool_call_id ?? null, fields.tool_calls ?? null, fields.tool_name ?? null, fields.timestamp ?? sec - 30, fields.reasoning_content ?? null);
  msg('h1', 'user', { content: 'wire it up', timestamp: sec - 50 });
  msg('h1', 'assistant', {
    tool_calls: JSON.stringify([{ id: 'c1', call_id: 'c1', type: 'function', function: { name: 'terminal', arguments: '{"command":"make flash"}' } }]),
    timestamp: sec - 40,
  });
  msg('h1', 'tool', { content: JSON.stringify({ output: 'flashed' }), tool_call_id: 'c1', tool_name: 'terminal', timestamp: sec - 35 });
  msg('h2', 'user', { content: 'gateway chatter', timestamp: sec - 30 });
  return { file, db, sec };
}

test('hermes: cli sessions only, with tool calls paired across rows', { skip: !sqlite }, () => {
  const { file, db } = hermesFixture();
  const updates = collectSqlite(new HermesSource({ dbPath: file }), db);

  assert.ok(!updates.some((u) => u.sessionId === 'h2'), 'gateway sessions are not coding tiles');
  const main = updates.find((u) => u.sessionId === 'h1');
  assert.equal(main.patch.cwd, '/home/u/proj');
  assert.equal(main.patch.gitBranch, 'main');
  assert.equal(main.patch.title, 'Wire the sensor');
  assert.equal(main.patch.usage.output, 340);
  assert.equal(main.patch.usage.context, null, 'cumulative input is not a context size');

  const kinds = main.events.map((e) => e.kind);
  assert.deepEqual(kinds, ['prompt', 'tool_start', 'tool_end']);
  const start = main.events.find((e) => e.kind === 'tool_start');
  assert.equal(start.detail, 'make flash', 'arguments are parsed out of the OpenAI-style envelope');
  assert.equal(start.tool.category, 'exec');
  const end = main.events.find((e) => e.kind === 'tool_end');
  assert.equal(end.tool.durationMs, 5000);
});

test('hermes: a finished session says so, and a second poll repeats nothing', { skip: !sqlite }, () => {
  const { file, db, sec } = hermesFixture();
  const source = new HermesSource({ dbPath: file });
  const updates = collectSqlite(source, db, 2);
  assert.equal(updates.filter((u) => u.sessionId === 'h1').length, 1, 'an unchanged session row is not re-emitted');

  db.prepare('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ?').run(sec, 'completed', 'h1');
  source.poll(db, false);
  const last = updates.at(-1);
  assert.equal(last.patch.state, 'ended');
  assert.equal(last.patch.endedReason, 'completed');
});

test('hermes: new messages after bootstrap arrive by id cursor', { skip: !sqlite }, () => {
  const { file, db } = hermesFixture();
  const source = new HermesSource({ dbPath: file });
  const updates = collectSqlite(source, db);
  db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)')
    .run('h1', 'assistant', 'done, flashed and verified', NOW / 1000);
  source.poll(db, false);
  const texts = updates.flatMap((u) => u.events).filter((e) => e.kind === 'assistant_text');
  assert.equal(texts.length, 1);
  assert.match(texts[0].detail, /flashed and verified/);
});

/* ── history for the new sources ───────────────────────────────────────── */

test('history lists gemini, opencode and hermes side by side', { skip: !sqlite }, () => {
  const geminiRoot = writeChat([
    header,
    { id: 'm1', timestamp: new Date(NOW - 30e3).toISOString(), type: 'user', content: [{ text: 'gemini work' }] },
  ]);
  const { file: ocFile } = opencodeFixture();
  const { file: hFile } = hermesFixture();

  const { sessions } = listSessions({
    roots: [{ source: 'gemini', root: geminiRoot }],
    dbs: [
      { source: 'opencode', dbPath: ocFile },
      { source: 'hermes', dbPath: hFile },
    ],
  });

  const bySource = Object.fromEntries(sessions.map((s) => [s.source, s]));
  assert.equal(bySource.gemini.cwd, '/home/u/myproject', 'cwd comes from .project_root, listing included');
  assert.equal(bySource.gemini.project, 'myproject');
  assert.equal(bySource.opencode.title, 'Fix the tests');
  assert.equal(bySource.hermes.title, 'Wire the sensor');
  assert.equal(bySource.hermes.gitBranch, 'main');
  assert.ok(!sessions.some((s) => s.id === 'ses_child'), 'subagents stay out of the archive too');

  const live = listSessions({
    roots: [],
    dbs: [{ source: 'opencode', dbPath: ocFile }],
    live: new Set(['ses_1']),
  });
  assert.equal(live.sessions.length, 0, 'a session on the wall is not also in the archive');
});

test('an opencode session reads back through the same mappers it had live', { skip: !sqlite }, () => {
  const { file } = opencodeFixture();
  const detail = loadSession('ses_1', { roots: [], dbs: [{ source: 'opencode', dbPath: file }] });
  assert.equal(detail.historical, true);
  assert.equal(detail.state, 'ended', 'a session read from the archive is stated as over, not guessed at');
  assert.equal(detail.project, 'proj');
  assert.deepEqual(
    detail.events.map((e) => e.kind),
    ['prompt', 'thinking', 'tool_start', 'tool_end', 'turn_end']
  );
  assert.equal(detail.usage.context, 9300, 'the same token arithmetic as a live tile');
  assert.equal(loadSession('ses_child', { roots: [], dbs: [{ source: 'opencode', dbPath: file }] }), null, 'subagent sessions do not open');
});

test('a hermes session reads back with its tool calls paired', { skip: !sqlite }, () => {
  const { file } = hermesFixture();
  const detail = loadSession('h1', { roots: [], dbs: [{ source: 'hermes', dbPath: file }] });
  assert.equal(detail.historical, true);
  assert.equal(detail.gitBranch, 'main');
  assert.deepEqual(detail.events.map((e) => e.kind), ['prompt', 'tool_start', 'tool_end']);
  assert.equal(detail.events[1].detail, 'make flash');
  assert.equal(loadSession('h2', { roots: [], dbs: [{ source: 'hermes', dbPath: file }] }), null, 'gateway sessions do not open');
});

test('hermes patch: ended is a fact with a reason, never a guess', () => {
  const patch = hermesPatch({ id: 'x', started_at: 100, ended_at: 200, end_reason: 'user_exit', cwd: '/p' });
  assert.equal(patch.state, 'ended');
  assert.equal(patch.endedReason, 'user_exit');
  assert.equal(patch.startedAt, 100_000, 'hermes clocks are seconds; the wall is milliseconds');
});
