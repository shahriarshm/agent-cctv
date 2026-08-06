import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { HERMES_DB } from '../../paths.js';
import { SqlitePoller, loadSqlite } from '../../sqlite-poll.js';
import { describeArgs, prose, safeJson, truncate, uid } from '../../util.js';

/**
 * The Hermes source.
 *
 * Hermes (Nous Research's agent) keeps a sessions table and a messages table
 * in ~/.hermes/state.db, and the sessions table is unusually honest: cwd,
 * git branch, title, token counts, and — alone among the non-Claude agents —
 * a real `ended_at` with a reason. A finished Hermes session retires
 * promptly instead of waiting out the silence sweep.
 *
 * Two filters shape everything. `source = 'cli'`: Hermes also logs gateway
 * chat sessions (Telegram and friends), and this is a coding-agent wall.
 * `parent_session_id IS NULL`: children are subagents, not tiles.
 *
 * Still `authoritative: false` — ended is a fact, but for a live session
 * there is no pid and no approval record, so busy/idle stays inferred and a
 * Hermes tile never raises the urgent signal.
 */

export const SOURCE = 'hermes';

const FRESH_WINDOW_MS = Number(process.env.AGENT_CCTV_LOOKBACK_MS) || 45 * 60e3;
/** A still-open session older than this is a crashed leftover, not a tile. */
const OPEN_SESSION_MAX_AGE_MS = 24 * 60 * 60e3;

export function capabilities() {
  const db = fs.existsSync(HERMES_DB);
  return {
    source: SOURCE,
    db,
    sqlite: db ? !!loadSqlite() : null,
    authoritative: false,
    urgency: false,
  };
}

/** Session-row facts -> a session patch. Shared with the history reader. */
export function patchFromRow(row) {
  const patch = { source: SOURCE };
  if (row.cwd) patch.cwd = row.cwd;
  if (row.git_branch) patch.gitBranch = row.git_branch;
  if (row.title) patch.title = truncate(row.title, 200);
  if (row.model) patch.model = row.model;
  if (row.started_at) patch.startedAt = Math.round(row.started_at * 1000);
  if (row.ended_at) {
    patch.state = 'ended';
    patch.endedReason = row.end_reason || 'ended';
  }
  patch.usage = {
    // Hermes records cumulative input, which is not a context size, and
    // inventing one from it would be confidently wrong.
    context: null,
    contextWindow: null,
    output: (row.output_tokens || 0) + (row.reasoning_tokens || 0),
    outputPartial: false,
  };
  return patch;
}

export const SESSION_COLS =
  'id, model, started_at, ended_at, end_reason, cwd, git_branch, title, output_tokens, reasoning_tokens';

function baseEvent(tsSeconds, sessionId, kind) {
  return {
    id: uid(),
    ts: Math.round((tsSeconds || Date.now() / 1000) * 1000),
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
 * One messages row -> zero or more events. Tool calls arrive OpenAI-style on
 * the assistant row ({function: {name, arguments}}); results arrive as a
 * separate `tool` row whose content is a JSON blob with an output field.
 * `calls` maps call ids to their starts so a result finds its name and
 * duration — shared with the history reader.
 */
export function eventsFromMessage(row, calls) {
  const out = [];
  const ev = (kind) => baseEvent(row.timestamp, row.session_id, kind);

  if (row.role === 'user') {
    const text = prose(row.content || '', 600);
    if (text && !text.startsWith('<')) {
      const e = ev('prompt');
      e.label = 'You said';
      e.detail = text;
      out.push(e);
    }
    return out;
  }

  if (row.role === 'assistant') {
    const thinking = prose(row.reasoning_content || '', 500);
    if (thinking) {
      const e = ev('thinking');
      e.label = 'Thinking';
      e.detail = thinking;
      out.push(e);
    }
    const text = prose(row.content || '', 700);
    if (text) {
      const e = ev('assistant_text');
      e.label = 'Says';
      e.detail = text;
      out.push(e);
    }
    for (const tc of safeJson(row.tool_calls) || []) {
      const id = tc?.call_id || tc?.id;
      if (!id) continue;
      const name = tc.function?.name || tc.name || 'tool';
      const detail = describeArgs(safeJson(tc.function?.arguments || '') || tc.args);
      const e = ev('tool_start');
      e.label = `Running ${name}`;
      e.detail = detail;
      e.tool = { name, pretty: name, id, category: categoryFor(name), phase: 'start' };
      calls.set(id, { name, detail, startedAt: e.ts });
      out.push(e);
    }
    return out;
  }

  if (row.role === 'tool') {
    const started = calls.get(row.tool_call_id);
    calls.delete(row.tool_call_id);
    const name = row.tool_name || started?.name || 'tool';
    const result = safeJson(row.content);
    const ok = !(result && typeof result === 'object' && result.error);
    const e = ev('tool_end');
    e.label = `${name} ${ok ? 'done' : 'failed'}`;
    e.detail = ok ? started?.detail || '' : truncate(String(result.error), 300);
    e.tool = {
      name,
      pretty: name,
      id: row.tool_call_id || null,
      category: categoryFor(name),
      phase: 'end',
      ok,
      durationMs: started ? Math.max(0, e.ts - started.startedAt) : null,
    };
    out.push(e);
  }

  return out;
}

export function categoryFor(name = '') {
  switch (name) {
    case 'terminal':
    case 'shell':
      return 'exec';
    case 'write_file':
    case 'edit_file':
    case 'apply_patch':
      return 'write';
    case 'read_file':
    case 'list_files':
    case 'search_files':
      return 'read';
    case 'web_search':
    case 'fetch_url':
      return 'net';
    default:
      return 'other';
  }
}

export class HermesSource extends EventEmitter {
  constructor({ dbPath = HERMES_DB, pollMs } = {}) {
    super();
    this.caps = capabilities();
    this.poller = new SqlitePoller({ dbPath, pollMs, poll: (db, first) => this.poll(db, first) });
    this.msgCursor = 0;
    this.calls = new Map();
    this.rowCache = new Map(); // session id -> serialized row, to emit only changes
  }

  start() {
    this.poller.start();
    return this.caps;
  }

  stop() {
    this.poller.stop();
  }

  poll(db, first) {
    const now = Date.now();
    const cutoffSec = (now - FRESH_WINDOW_MS) / 1000;
    const openCutoffSec = (now - OPEN_SESSION_MAX_AGE_MS) / 1000;

    /*
      The sessions table is small and has no updated-at column, so change
      detection is a straight re-read compared against what we last emitted.
      Cheaper than being clever, and immune to in-place updates.
    */
    const sessions = db
      .prepare(
        `SELECT ${SESSION_COLS} FROM sessions
          WHERE source = 'cli' AND parent_session_id IS NULL
            AND (started_at >= ? OR (ended_at IS NULL AND started_at >= ?))`
      )
      .all(cutoffSec, openCutoffSec);

    let messages = [];
    if (first) {
      // The bootstrap window is by time; the cursor is the table's high-water
      // mark, so history outside the window is never replayed later.
      this.msgCursor = db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM messages').get().n;
      messages = db
        .prepare(
          `SELECT m.id, m.session_id, m.role, m.content, m.tool_call_id, m.tool_calls,
                  m.tool_name, m.timestamp, m.reasoning_content
             FROM messages m
             JOIN sessions s ON s.id = m.session_id
            WHERE s.source = 'cli' AND s.parent_session_id IS NULL
              AND m.active = 1 AND m.timestamp >= ?
            ORDER BY m.id`
        )
        .all(cutoffSec);
    } else {
      messages = db
        .prepare(
          `SELECT m.id, m.session_id, m.role, m.content, m.tool_call_id, m.tool_calls,
                  m.tool_name, m.timestamp, m.reasoning_content
             FROM messages m
             JOIN sessions s ON s.id = m.session_id
            WHERE s.source = 'cli' AND s.parent_session_id IS NULL
              AND m.active = 1 AND m.id > ?
            ORDER BY m.id`
        )
        .all(this.msgCursor);
    }

    const events = new Map();
    for (const row of messages) {
      this.msgCursor = Math.max(this.msgCursor, row.id);
      const evs = eventsFromMessage(row, this.calls);
      if (evs.length) events.set(row.session_id, (events.get(row.session_id) || []).concat(evs));
    }

    for (const row of sessions) {
      const version = JSON.stringify(row);
      const evs = events.get(row.id);
      events.delete(row.id);
      if (!evs && this.rowCache.get(row.id) === version) continue;
      this.rowCache.set(row.id, version);
      this.emit('update', {
        sessionId: row.id,
        patch: patchFromRow(row),
        events: evs || [],
        bootstrap: first,
      });
    }
    // Messages for a session outside the fresh window (it just aged out
    // mid-poll) still ship rather than vanish.
    for (const [sessionId, evs] of events) {
      this.emit('update', { sessionId, patch: { source: SOURCE }, events: evs, bootstrap: first });
    }
  }
}
