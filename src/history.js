import fs from 'node:fs';
import path from 'node:path';
import { Store, serialize } from './store.js';
import { CLAUDE_PROJECTS, CODEX_SESSIONS, CODEX_INDEX, GEMINI_TMP, OPENCODE_DB, HERMES_DB } from './paths.js';
import { TranscriptTailer } from './sources/claude-code/transcript.js';
import { RolloutTailer } from './sources/codex/rollout.js';
import { ChatTailer } from './sources/gemini/chats.js';
import { patchFromMeta as claudePatch, SOURCE as CLAUDE } from './sources/claude-code/index.js';
import { patchFromMeta as codexPatch, SOURCE as CODEX } from './sources/codex/index.js';
import { patchFromMeta as geminiPatch, SOURCE as GEMINI } from './sources/gemini/index.js';
import * as opencode from './sources/opencode/index.js';
import * as hermes from './sources/hermes/index.js';
import { loadSqlite } from './sqlite-poll.js';
import { projectName, safeJson, truncate } from './util.js';

/**
 * Looking back at sessions that are no longer on the wall.
 *
 * The wall is deliberately a live instrument — a tile retires half an hour after
 * its session ends and the store forgets it. That is the right behaviour for a
 * monitor, and it used to mean the only way to see yesterday's work was to widen
 * AGENT_CCTV_LOOKBACK_MS and restart.
 *
 * This does not change that, and in particular it does not persist anything.
 * The agents' own logs are already the durable store, sitting on disk with the
 * source code in exactly one place; history is a read of what is already there,
 * on demand, for one session at a time. Nothing is copied into ~/.agent-cctv,
 * no transcript is held in memory after the response, and a session you never
 * click is never opened.
 */

/** How much of a transcript's tail a history read pulls in. */
const HISTORY_BYTES = 512 * 1024;
/** Cheap metadata is read from the two ends of a file, not the whole thing. */
const PEEK_BYTES = 16 * 1024;

/** How to read each agent's logs. The same mapping the live sources use. */
const ADAPTERS = {
  [CLAUDE]: { Tailer: TranscriptTailer, patch: claudePatch },
  [CODEX]: { Tailer: RolloutTailer, patch: codexPatch },
  [GEMINI]: { Tailer: ChatTailer, patch: geminiPatch },
};

export function defaultRoots() {
  return [
    { source: CLAUDE, root: CLAUDE_PROJECTS },
    { source: CODEX, root: CODEX_SESSIONS, index: CODEX_INDEX },
    { source: GEMINI, root: GEMINI_TMP },
  ];
}

/**
 * The sqlite-backed agents contribute the same two operations from queries:
 * listing recent sessions is one indexed read, opening one replays its rows
 * through the same event mappers the live source uses. Cheaper than any
 * file peek, and read-through all the same — the database stays where the
 * agent put it.
 */
export function defaultDbs() {
  return [
    { source: opencode.SOURCE, dbPath: OPENCODE_DB },
    { source: hermes.SOURCE, dbPath: HERMES_DB },
  ];
}

function openDb(dbPath) {
  const sqlite = loadSqlite();
  if (!sqlite || !fs.existsSync(dbPath)) return null;
  try {
    return new sqlite.DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null; // a WAL database whose owner is away; history just goes quiet
  }
}

const SQLITE_HISTORY = {
  [opencode.SOURCE]: {
    list(db, cutoff) {
      return db
        .prepare(
          `SELECT id, directory, title, model, time_created, time_updated
             FROM session WHERE parent_id IS NULL AND time_updated >= ? ORDER BY time_updated DESC`
        )
        .all(cutoff)
        .map((r) => ({
          id: r.id,
          endedAt: r.time_updated,
          bytes: null,
          cwd: r.directory || '',
          gitBranch: null,
          model: r.model,
          title: r.title ? truncate(r.title, 200) : null,
        }));
    },
    load(db, id) {
      const row = db
        .prepare(`SELECT ${opencode.SESSION_COLS} FROM session WHERE parent_id IS NULL AND id = ?`)
        .get(id);
      if (!row) return null;
      const state = opencode.newPartState();
      const meta = {};
      const events = [];
      const parts = db
        .prepare(
          `SELECT p.id, p.session_id, p.time_created, p.time_updated, p.data, m.data AS mdata
             FROM part p JOIN message m ON m.id = p.message_id
            WHERE p.session_id = ? ORDER BY p.time_created, p.id`
        )
        .all(id);
      let model = null;
      for (const p of parts) {
        const m = safeJson(p.mdata) || {};
        if (m.modelID) model = m.modelID;
        events.push(...opencode.eventsFromPart(p, m.role, state, meta));
      }
      return { patch: opencode.patchFromRow(row, { context: meta.context, model }), events, endedAt: row.time_updated };
    },
  },
  [hermes.SOURCE]: {
    list(db, cutoff) {
      return db
        .prepare(
          `SELECT ${hermes.SESSION_COLS} FROM sessions
            WHERE source = 'cli' AND parent_session_id IS NULL
              AND COALESCE(ended_at, started_at) * 1000 >= ?
            ORDER BY started_at DESC`
        )
        .all(cutoff)
        .map((r) => ({
          id: r.id,
          endedAt: Math.round((r.ended_at || r.started_at) * 1000),
          bytes: null,
          cwd: r.cwd || '',
          gitBranch: r.git_branch,
          model: r.model,
          title: r.title ? truncate(r.title, 200) : null,
        }));
    },
    load(db, id) {
      const row = db
        .prepare(`SELECT ${hermes.SESSION_COLS} FROM sessions WHERE source = 'cli' AND parent_session_id IS NULL AND id = ?`)
        .get(id);
      if (!row) return null;
      const calls = new Map();
      const events = [];
      const messages = db
        .prepare(
          `SELECT id, session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, reasoning_content
             FROM messages WHERE session_id = ? AND active = 1 ORDER BY id`
        )
        .all(id);
      for (const m of messages) events.push(...hermes.eventsFromMessage(m, calls));
      return {
        patch: hermes.patchFromRow(row),
        events,
        endedAt: Math.round((row.ended_at || row.started_at) * 1000),
      };
    },
  },
};

/** Summaries are keyed by file identity, so a re-listing costs nothing. */
const peekCache = new Map();

function readSlice(file, start, length) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(length);
    const bytes = fs.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, bytes).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

const grab = (text, key) => {
  const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(text);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return null;
  }
};

/**
 * Enough to list a session without parsing it: read the head (where a session
 * declares its cwd and title) and the tail (where the freshest facts are).
 * Two small reads regardless of whether the file is 4 KB or 40 MB.
 */
function peek(file, source, st) {
  const key = `${file}:${st.size}:${st.mtimeMs}`;
  const hit = peekCache.get(key);
  if (hit) return hit;

  const head = readSlice(file, 0, Math.min(st.size, PEEK_BYTES));
  const tail = st.size > PEEK_BYTES ? readSlice(file, Math.max(0, st.size - PEEK_BYTES), PEEK_BYTES) : head;

  const cwd = grab(tail, 'cwd') || grab(head, 'cwd');
  const out = {
    cwd: cwd || '',
    project: cwd ? projectName(cwd) : '',
    gitBranch: grab(tail, 'gitBranch') || null,
    model: grab(tail, 'model') || grab(head, 'model') || null,
    title:
      source === CLAUDE
        ? grab(head, 'aiTitle') || grab(tail, 'aiTitle') || firstPrompt(head)
        : null,
  };
  peekCache.set(key, out);
  if (peekCache.size > 2000) peekCache.delete(peekCache.keys().next().value);
  return out;
}

/** Failing an ai-title, a session is best identified by what it was asked to do. */
function firstPrompt(head) {
  for (const line of head.split('\n')) {
    if (!line.includes('"type":"user"')) continue;
    const entry = safeJson(line);
    const content = entry?.message?.content;
    const text = typeof content === 'string' ? content : null;
    if (text && !text.startsWith('<')) return truncate(text, 120);
  }
  return null;
}

function codexTitles(indexFile) {
  const titles = new Map();
  if (!indexFile) return titles;
  try {
    for (const line of fs.readFileSync(indexFile, 'utf8').split('\n')) {
      const rec = line.trim() && safeJson(line);
      if (rec?.id && rec.thread_name) titles.set(rec.id, truncate(rec.thread_name, 200));
    }
  } catch {}
  return titles;
}

/** Every log file on disk, with the session and adapter it belongs to. */
function* index(roots) {
  for (const { source, root, index: indexFile } of roots) {
    const adapter = ADAPTERS[source];
    if (!adapter || !root || !fs.existsSync(root)) continue;
    const walker = new adapter.Tailer({ root });
    for (const file of walker.walk(root, walker.maxDepth)) {
      const id = walker.sessionIdFor(file);
      if (id) yield { id, file, source, indexFile, ...adapter };
    }
  }
}

/**
 * Sessions that finished within the window. `live` ids are excluded so the
 * history panel is strictly "things not already on the wall".
 */
/** Gemini keeps the cwd beside the log, not inside it. */
function geminiCwd(file) {
  try {
    return (
      fs
        .readFileSync(path.join(path.dirname(path.dirname(file)), '.project_root'), 'utf8')
        .split('\n')[0]
        .trim() || ''
    );
  } catch {
    return '';
  }
}

export function listSessions({
  sinceMs = 7 * 24 * 60 * 60e3,
  limit = 300,
  live = new Set(),
  roots = defaultRoots(),
  dbs = defaultDbs(),
} = {}) {
  const cutoff = Date.now() - sinceMs;
  const titles = codexTitles(roots.find((r) => r.source === CODEX)?.index);
  const rows = [];

  for (const { id, file, source } of index(roots)) {
    if (live.has(id)) continue;
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    if (st.mtimeMs < cutoff || !st.size) continue;
    rows.push({ id, source, file, endedAt: st.mtimeMs, bytes: st.size, st });
  }

  for (const { source, dbPath } of dbs) {
    const reader = SQLITE_HISTORY[source];
    if (!reader) continue;
    const db = openDb(dbPath);
    if (!db) continue;
    try {
      for (const row of reader.list(db, cutoff)) {
        if (live.has(row.id)) continue;
        rows.push({ ...row, source });
      }
    } catch {
      // A schema we no longer recognise lists nothing rather than throwing.
    } finally {
      db.close();
    }
  }

  rows.sort((a, b) => b.endedAt - a.endedAt);
  const page = rows.slice(0, limit);

  return {
    total: rows.length,
    truncated: rows.length > page.length,
    sessions: page.map(({ id, source, file, endedAt, bytes, st, ...row }) => {
      // Sqlite rows arrive already described; files still need the peek.
      const p = file ? peek(file, source, st) : row;
      const cwd = !file ? p.cwd : source === GEMINI ? geminiCwd(file) : p.cwd;
      return {
        id,
        source,
        endedAt,
        bytes,
        cwd,
        project: cwd ? projectName(cwd) : '',
        gitBranch: p.gitBranch,
        model: p.model,
        title: source === CODEX ? titles.get(id) || null : p.title,
        name: (cwd && projectName(cwd)) || id.slice(0, 8),
      };
    }),
  };
}

/**
 * Read one past session back in full.
 *
 * It is replayed through the same tailer, the same normalization and a throwaway
 * Store, so a session opened from history is described exactly as it was when it
 * was live — rather than by a second, subtly different code path. The store is
 * discarded when this returns; nothing is retained.
 */
export function loadSession(id, { roots = defaultRoots(), dbs = defaultDbs() } = {}) {
  for (const { source, dbPath } of dbs) {
    const reader = SQLITE_HISTORY[source];
    if (!reader) continue;
    const db = openDb(dbPath);
    if (!db) continue;
    let loaded = null;
    try {
      loaded = reader.load(db, id);
    } catch {
      loaded = null;
    } finally {
      db.close();
    }
    if (!loaded) continue;

    const store = new Store();
    store.capabilities = {};
    const patch = { ...loaded.patch, state: 'ended', endedReason: 'history', authoritative: true };
    store.apply({ sessionId: id, patch, events: loaded.events, bootstrap: true });
    const s = store.get(id);
    if (!s) return null;
    const detail = serialize(s, { withEvents: true });
    detail.historical = true;
    detail.endedAt = loaded.endedAt;
    return detail;
  }

  for (const entry of index(roots)) {
    if (entry.id !== id) continue;

    const store = new Store();
    // A finished session has no live source vouching for it, and there is no
    // process to check — so this is history, flatly stated, not a guess.
    store.capabilities = {};

    const tailer = new entry.Tailer({ root: path.dirname(entry.file) });
    tailer.bootstrapBytes = HISTORY_BYTES;
    // Codex keeps thread names outside the rollout, so a history read has to
    // fetch the title the same way the live source does.
    const title = entry.source === CODEX ? codexTitles(entry.indexFile).get(id) : null;

    tailer.on('batch', ({ sessionId, file, events, meta }) => {
      const patch = entry.patch(meta, file);
      if (title) patch.title = title;
      patch.state = 'ended';
      patch.endedReason = 'history';
      patch.authoritative = true;
      store.apply({ sessionId, patch, events, bootstrap: true });
    });
    tailer.read(entry.file);

    const s = store.get(id);
    if (!s) return null;
    const detail = serialize(s, { withEvents: true });
    detail.transcriptPath = entry.file;
    detail.historical = true;
    try {
      detail.endedAt = fs.statSync(entry.file).mtimeMs;
    } catch {}
    return detail;
  }
  return null;
}
