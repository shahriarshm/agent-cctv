import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { OPENCODE_DB } from '../../paths.js';
import { SqlitePoller, loadSqlite } from '../../sqlite-poll.js';
import { describeArgs, prose, safeJson, truncate, uid } from '../../util.js';

/**
 * The OpenCode source.
 *
 * OpenCode keeps everything in one sqlite database: a `session` row per
 * session, a `message` row per turn, and a `part` row per piece of a message
 * (text, reasoning, one tool call, a step boundary). Parts are where the
 * events live; sessions are where the facts live.
 *
 * Same standing as Codex: no pid, and no pending-approval record — the
 * `permission` table is a remembered allowlist (project/action/resource),
 * not a queue of prompts waiting on a human. So state is inferred from
 * activity, a tile can never raise the urgent signal, and `time_archived`
 * is the one explicit terminal fact we get.
 *
 * Child sessions (`parent_id` set) are subagents. Their parts are excluded
 * at the query so a subagent burst never conjures tiles of its own.
 */

export const SOURCE = 'opencode';

const FRESH_WINDOW_MS = Number(process.env.AGENT_CCTV_LOOKBACK_MS) || 45 * 60e3;

export function capabilities() {
  const db = fs.existsSync(OPENCODE_DB);
  return {
    source: SOURCE,
    db,
    // Only meaningful once there is a database to read; checking earlier
    // would print node's experimental-module warning on machines that will
    // never need the module.
    sqlite: db ? !!loadSqlite() : null,
    authoritative: false,
    urgency: false,
  };
}

/** Session-row facts -> a session patch. Shared with the history reader. */
export function patchFromRow(row, { context = null, model = null } = {}) {
  const patch = { source: SOURCE };
  if (row.directory) patch.cwd = row.directory;
  if (row.title) patch.title = truncate(row.title, 200);
  if (row.model || model) patch.model = row.model || model;
  if (row.agent) patch.agentName = row.agent;
  if (row.time_created) patch.startedAt = row.time_created;
  if (row.time_archived) {
    patch.state = 'ended';
    patch.endedReason = 'archived';
  }
  patch.usage = {
    context,
    contextWindow: null,
    // OpenCode maintains this running total itself, so it is exact no matter
    // when we started reading.
    output: (row.tokens_output || 0) + (row.tokens_reasoning || 0),
    outputPartial: false,
  };
  return patch;
}

export const SESSION_COLS =
  'id, directory, title, model, agent, time_created, time_updated, time_archived, tokens_output, tokens_reasoning';

function baseEvent(ts, sessionId, kind) {
  return {
    id: uid(),
    ts,
    source: SOURCE,
    sessionId,
    kind,
    lane: 'main',
    uuid: null,
    ref: { file: null, uuid: null },
    label: '',
    detail: '',
    tool: null,
  };
}

/**
 * Per-session dedup state. Parts are re-fetched whenever their row updates
 * (streaming text grows, a tool call completes), so every emission decision
 * is "have I already said this" rather than "is this row new".
 */
export function newPartState() {
  return {
    textLen: new Map(), // part id -> chars already emitted
    calls: new Map(), // callID -> {name, detail, startedAt}
    started: new Set(), // part ids whose tool_start went out
    ended: new Set(), // part ids whose tool_end / turn_end went out
  };
}

/**
 * One part row -> zero or more events. `mrole` is the owning message's role,
 * which is what decides whether a text part is a prompt or the reply.
 */
export function eventsFromPart(row, mrole, state, meta = {}) {
  const out = [];
  const data = safeJson(row.data);
  if (!data) return out;
  const ev = (kind) => baseEvent(row.time_created || Date.now(), row.session_id, kind);

  switch (data.type) {
    case 'text':
    case 'reasoning': {
      const text = prose(data.text || '', data.type === 'text' ? 700 : 500);
      if (!text) break;
      // A streaming part updates in place; emit only when there is more to
      // say than last time, so the tile refreshes without the feed repeating.
      if ((state.textLen.get(row.id) || 0) >= text.length) break;
      state.textLen.set(row.id, text.length);
      if (data.type === 'reasoning') {
        const e = ev('thinking');
        e.label = 'Thinking';
        e.detail = text;
        out.push(e);
      } else if (mrole === 'user') {
        const e = ev('prompt');
        e.label = 'You said';
        e.detail = text;
        out.push(e);
      } else {
        const e = ev('assistant_text');
        e.label = 'Says';
        e.detail = text;
        out.push(e);
      }
      break;
    }

    case 'tool': {
      const name = data.tool || 'tool';
      const status = data.state?.status;
      const detail = data.state?.title || describeArgs(data.state?.input);
      if (!state.started.has(row.id)) {
        state.started.add(row.id);
        const e = ev('tool_start');
        e.label = `Running ${name}`;
        e.detail = detail;
        e.tool = { name, pretty: name, id: data.callID || row.id, category: categoryFor(name), phase: 'start' };
        state.calls.set(row.id, { detail, startedAt: e.ts });
        out.push(e);
      }
      if ((status === 'completed' || status === 'error') && !state.ended.has(row.id)) {
        state.ended.add(row.id);
        const started = state.calls.get(row.id);
        state.calls.delete(row.id);
        const ok = status !== 'error';
        const e = ev('tool_end');
        e.ts = row.time_updated || e.ts;
        e.label = `${name} ${ok ? 'done' : 'failed'}`;
        e.detail = ok ? started?.detail || detail : truncate(errorText(data.state), 300) || detail;
        e.tool = {
          name,
          pretty: name,
          id: data.callID || row.id,
          category: categoryFor(name),
          phase: 'end',
          ok,
          durationMs: started ? Math.max(0, e.ts - started.startedAt) : null,
        };
        out.push(e);
      }
      break;
    }

    case 'step-finish': {
      /**
       * Every request resends the whole conversation, so this step's input
       * (cached portion included) *is* the session's context — the same
       * arithmetic as the Claude source.
       */
      const t = data.tokens;
      if (t && typeof t.input === 'number') {
        meta.context = (t.input || 0) + (t.cache?.read || 0) + (t.cache?.write || 0);
      }
      if (data.reason === 'stop' && !state.ended.has(row.id)) {
        state.ended.add(row.id);
        const e = ev('turn_end');
        e.label = 'Turn complete';
        out.push(e);
      }
      break;
    }
  }
  return out;
}

function errorText(state) {
  if (!state) return '';
  const out = state.error || state.output;
  return typeof out === 'string' ? out : '';
}

export function categoryFor(name = '') {
  switch (name) {
    case 'bash':
      return 'exec';
    case 'edit':
    case 'write':
    case 'patch':
      return 'write';
    case 'read':
    case 'grep':
    case 'glob':
    case 'list':
      return 'read';
    case 'webfetch':
    case 'websearch':
      return 'net';
    case 'task':
      return 'task';
    default:
      return name.includes('_') ? 'net' : 'other'; // mcp tools arrive namespaced
  }
}

export class OpencodeSource extends EventEmitter {
  constructor({ dbPath = OPENCODE_DB, pollMs } = {}) {
    super();
    this.caps = capabilities();
    this.poller = new SqlitePoller({ dbPath, pollMs, poll: (db, first) => this.poll(db, first) });
    this.sessionCursor = 0;
    this.partCursor = 0;
    this.partState = new Map(); // session id -> newPartState()
    this.models = new Map(); // session id -> modelID off the newest message
    this.contexts = new Map(); // session id -> live context tokens
  }

  start() {
    this.poller.start();
    return this.caps;
  }

  stop() {
    this.poller.stop();
  }

  stateFor(id) {
    let s = this.partState.get(id);
    if (!s) {
      s = newPartState();
      this.partState.set(id, s);
    }
    return s;
  }

  poll(db, first) {
    const cutoff = Date.now() - FRESH_WINDOW_MS;
    if (first) {
      this.sessionCursor = cutoff;
      this.partCursor = cutoff;
    }

    /*
      Parts use `>=` and a cursor that sits ON the newest timestamp: a part
      committed in the same millisecond as the previous poll's newest row
      would otherwise be missed forever. The cost is re-reading the boundary
      row every poll, and the per-part dedup state exists precisely so a
      re-read emits nothing twice. Sessions advance past the boundary
      instead — a re-read there would re-emit a patch every poll, and a
      session that races the boundary gets picked up by its next write,
      which for OpenCode is every part it produces.
    */
    const parts = db
      .prepare(
        `SELECT p.id, p.session_id, p.time_created, p.time_updated, p.data,
                m.data AS mdata
           FROM part p
           JOIN message m ON m.id = p.message_id
           JOIN session s ON s.id = p.session_id
          WHERE s.parent_id IS NULL AND p.time_updated >= ?
          ORDER BY p.time_updated, p.id`
      )
      .all(this.partCursor);

    const events = new Map(); // session id -> events
    for (const row of parts) {
      this.partCursor = Math.max(this.partCursor, row.time_updated);
      const m = safeJson(row.mdata) || {};
      if (m.modelID) this.models.set(row.session_id, m.modelID);
      const meta = {};
      const evs = eventsFromPart(row, m.role, this.stateFor(row.session_id), meta);
      if (meta.context) this.contexts.set(row.session_id, meta.context);
      if (evs.length) events.set(row.session_id, (events.get(row.session_id) || []).concat(evs));
    }

    const sessions = db
      .prepare(`SELECT ${SESSION_COLS} FROM session WHERE parent_id IS NULL AND time_updated >= ?`)
      .all(this.sessionCursor);

    const patched = new Set();
    for (const row of sessions) {
      this.sessionCursor = Math.max(this.sessionCursor, row.time_updated + 1);
      patched.add(row.id);
      this.emit('update', {
        sessionId: row.id,
        patch: patchFromRow(row, { context: this.contexts.get(row.id), model: this.models.get(row.id) }),
        events: events.get(row.id) || [],
        bootstrap: first,
      });
      events.delete(row.id);
    }
    // Events for sessions whose row did not change this poll still ship.
    for (const [sessionId, evs] of events) {
      this.emit('update', { sessionId, patch: { source: SOURCE }, events: evs, bootstrap: first });
    }
  }
}
