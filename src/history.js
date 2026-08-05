import fs from 'node:fs';
import path from 'node:path';
import { Store, serialize } from './store.js';
import { CLAUDE_PROJECTS, CODEX_SESSIONS, CODEX_INDEX } from './paths.js';
import { TranscriptTailer } from './sources/claude-code/transcript.js';
import { RolloutTailer } from './sources/codex/rollout.js';
import { patchFromMeta as claudePatch, SOURCE as CLAUDE } from './sources/claude-code/index.js';
import { patchFromMeta as codexPatch, SOURCE as CODEX } from './sources/codex/index.js';
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
};

export function defaultRoots() {
  return [
    { source: CLAUDE, root: CLAUDE_PROJECTS },
    { source: CODEX, root: CODEX_SESSIONS, index: CODEX_INDEX },
  ];
}

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
export function listSessions({ sinceMs = 7 * 24 * 60 * 60e3, limit = 300, live = new Set(), roots = defaultRoots() } = {}) {
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

  rows.sort((a, b) => b.endedAt - a.endedAt);
  const page = rows.slice(0, limit);

  return {
    total: rows.length,
    truncated: rows.length > page.length,
    sessions: page.map(({ id, source, file, endedAt, bytes, st }) => {
      const p = peek(file, source, st);
      return {
        id,
        source,
        endedAt,
        bytes,
        cwd: p.cwd,
        project: p.project,
        gitBranch: p.gitBranch,
        model: p.model,
        title: source === CODEX ? titles.get(id) || null : p.title,
        name: p.project || id.slice(0, 8),
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
export function loadSession(id, { roots = defaultRoots() } = {}) {
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
