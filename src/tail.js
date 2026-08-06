import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { safeJson } from './util.js';

/**
 * Follows append-only JSONL logs.
 *
 * Every agent that keeps a transcript keeps it this way, so the awkward part —
 * tracking a byte offset per file, stitching a line split across two reads,
 * starting mid-file without choking on the fragment, noticing a file that was
 * truncated and replaced — is written once here. A source subclasses this and
 * says only what its files are called and what its lines mean.
 *
 * Files can be tens of MB; nothing here ever reads one whole.
 */

const DEBOUNCE_MS = 120;
const SCAN_MS = 3000;
const MAX_SEEN = 4000;
/**
 * How long a file may sit untouched before its dedup set is dropped.
 *
 * That set holds up to MAX_SEEN/2 uuids per file, so a machine with months of
 * transcripts kept tens of megabytes describing files nothing has written to
 * since spring. Four times the longest fresh window any source uses; a session
 * silent that long left the wall hours ago.
 */
const SHED_AFTER_MS = 4 * 60 * 60e3;

export class JsonlTailer extends EventEmitter {
  constructor({ root, freshWindowMs, bootstrapBytes = 96 * 1024, maxDepth = 1, scanMs = SCAN_MS } = {}) {
    super();
    this.root = root;
    this.freshWindowMs = freshWindowMs;
    this.bootstrapBytes = bootstrapBytes;
    this.maxDepth = maxDepth;
    this.scanMs = scanMs;
    this.files = new Map(); // file -> {offset, partial, sessionId, seen, size, ...}
    this.timers = new Map();
    this.watcher = null;
    this.scanTimer = null;
  }

  /* ── what a subclass fills in ────────────────────────────────────────── */

  /** The session a file belongs to, or null to ignore the file entirely. */
  sessionIdFor() {
    return null;
  }

  /** Extra per-file bookkeeping (open tool calls, and so on). */
  initState() {
    return {};
  }

  /** One parsed line -> zero or more normalized events. */
  toEvents() {
    return [];
  }

  /** One parsed line -> session-level facts (cwd, model, title...). */
  collectMeta() {}

  /* ── the part that is the same everywhere ────────────────────────────── */

  start() {
    if (!this.root || !fs.existsSync(this.root)) return false;
    this.scan(true);
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_t, filename) => {
        if (filename && filename.endsWith('.jsonl')) this.schedule(path.join(this.root, filename));
      });
      this.watcher.on('error', () => {});
    } catch {
      // Recursive watch is unavailable on some platforms; the scan covers it.
    }
    this.scanTimer = setInterval(() => this.scan(false), this.scanMs);
    this.scanTimer.unref?.();
    return true;
  }

  stop() {
    try {
      this.watcher?.close();
    } catch {}
    clearInterval(this.scanTimer);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  schedule(file) {
    clearTimeout(this.timers.get(file));
    const t = setTimeout(() => {
      this.timers.delete(file);
      this.read(file);
    }, DEBOUNCE_MS);
    t.unref?.();
    this.timers.set(file, t);
  }

  *walk(dir, depth) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth > 0) yield* this.walk(p, depth - 1);
      } else if (e.name.endsWith('.jsonl')) {
        yield p;
      }
    }
  }

  scan(initial) {
    const cutoff = Date.now() - this.freshWindowMs;
    for (const file of this.walk(this.root, this.maxDepth)) {
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (st.mtimeMs < cutoff) continue;
      const known = this.files.get(file);
      if (known && known.size === st.size) continue;
      if (initial) this.read(file);
      else this.schedule(file);
    }
    this.shed();
  }

  /**
   * Drop a long-idle file's dedup set, keeping everything else.
   *
   * Deleting the whole entry would be simpler and wrong: the next write to that
   * file would look like a file we had never seen, and re-bootstrapping replays
   * the last 96 KB — a second copy of events the session's ring may still be
   * holding. Keeping the offset means it resumes exactly where it stopped.
   *
   * Only `seen` goes. A subclass's own state is not cache: `tools` and `calls`
   * hold the *open* calls, which is how a result finds the call it belongs to.
   * Clearing those would cost a session blocked on a permission prompt
   * overnight the name, argument and duration of the very call it was blocked
   * on — and that session is the one this wall exists to show you.
   *
   * What an empty `seen` widens: `seen` only matters after a truncate-and-
   * replace, when the file is re-read from byte zero. Such a re-read after a
   * shed re-emits everything as live rather than bootstrap. MAX_SEEN trimming
   * already made that partly true for any large transcript, and nothing
   * rewrites these logs in practice.
   */
  shed(now = Date.now()) {
    for (const state of this.files.values()) {
      if (state.shed || now - (state.readAt || 0) < SHED_AFTER_MS) continue;
      state.seen = new Set();
      state.shed = true;
    }
  }

  /** Follow a specific file even if it falls outside the scan window. */
  track(file) {
    if (file && !this.files.has(file)) this.read(file);
  }

  read(file) {
    const sessionId = this.sessionIdFor(file);
    if (!sessionId) return;

    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return;
    }

    let state = this.files.get(file);
    const first = !state;
    if (first) {
      state = {
        offset: Math.max(0, st.size - this.bootstrapBytes),
        partial: '',
        sessionId,
        seen: new Set(),
        size: 0,
        ...this.initState(sessionId, file),
      };
      // Whether we joined this log at its beginning. Anything a source
      // accumulates by summing is only a true total when this is set — a big
      // transcript is picked up mid-way and its running totals start late.
      state.fromStart = state.offset === 0;
      this.files.set(file, state);
    }
    if (st.size < state.offset) {
      // Truncated or replaced — start over from the top.
      state.offset = 0;
      state.partial = '';
    }
    state.readAt = Date.now();
    state.shed = false;
    if (st.size === state.offset) {
      state.size = st.size;
      return;
    }

    const length = st.size - state.offset;
    let chunk = '';
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(length);
      const bytes = fs.readSync(fd, buf, 0, length, state.offset);
      chunk = buf.subarray(0, bytes).toString('utf8');
      state.offset += bytes;
      state.size = st.size;
    } catch {
      return;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {}
      }
    }

    const lines = (state.partial + chunk).split('\n');
    state.partial = lines.pop() ?? '';
    // A bootstrap read starts mid-file, so the first line is probably a fragment.
    if (first && state.offset > length) lines.shift();

    const events = [];
    const meta = { sessionId, file };
    for (const line of lines) {
      if (!line.trim()) continue;
      const entry = safeJson(line);
      if (!entry) continue;
      this.collectMeta(meta, entry, state);
      for (const ev of this.toEvents(entry, state, file)) events.push(ev);
    }

    if (state.seen.size > MAX_SEEN) {
      state.seen = new Set([...state.seen].slice(-MAX_SEEN / 2));
    }

    if (events.length || Object.keys(meta).length > 2) {
      this.emit('batch', { sessionId, file, events, meta, bootstrap: first });
    }
  }
}
