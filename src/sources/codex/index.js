import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { CODEX_SESSIONS, CODEX_INDEX } from '../../paths.js';
import { safeJson, truncate } from '../../util.js';
import { RolloutTailer, SOURCE } from './rollout.js';

export { SOURCE };

/**
 * The Codex CLI source.
 *
 * Be clear about what this can and cannot do, because it is weaker than the
 * Claude Code source in one way that matters:
 *
 *   Codex keeps no session registry. There is no pid, no status file, and — the
 *   important one — no approval event in a rollout. Codex records the approval
 *   *policy* a turn ran under, never that a turn is sitting blocked on a
 *   prompt. So a Codex tile can tell you what a session is doing, but it can
 *   never raise the wall's one urgent signal. It is not that we haven't wired
 *   it up; the information is not written down.
 *
 * What we do get is honest turn boundaries — `task_started` and `task_complete`
 * bracket every turn — so state is explicit rather than guessed from timing.
 * Liveness is not: a Codex session that dies mid-turn looks busy until the
 * store's silence sweep retires it.
 */

export function capabilities() {
  return {
    source: SOURCE,
    rollouts: fs.existsSync(CODEX_SESSIONS),
    index: fs.existsSync(CODEX_INDEX),
    // No registry, so nothing here is ever the last word on a session's state.
    authoritative: false,
    urgency: false,
  };
}

/** Rollout facts -> a session patch. Shared with the history reader. */
export function patchFromMeta(meta, file) {
  const patch = { source: SOURCE, transcriptPath: file };
  if (meta.cwd) patch.cwd = meta.cwd;
  if (meta.model) patch.model = meta.model;
  if (meta.version) patch.version = meta.version;
  if (meta.entrypoint) patch.entrypoint = meta.entrypoint;
  if (meta.permissionMode) patch.permissionMode = meta.permissionMode;
  if (meta.usage) patch.usage = meta.usage;
  // Explicit, from task_started/task_complete — but never authoritative,
  // because nothing here proves the process is still alive.
  if (meta.state) patch.state = meta.state;
  return patch;
}

export class CodexSource extends EventEmitter {
  constructor({ root = CODEX_SESSIONS, indexFile = CODEX_INDEX } = {}) {
    super();
    this.indexFile = indexFile;
    this.tailer = new RolloutTailer({ root });
    this.caps = capabilities();
    this.titles = new Map();
  }

  start() {
    this.readIndex();

    this.tailer.on('batch', ({ sessionId, file, events, meta, bootstrap }) => {
      const patch = patchFromMeta(meta, file);
      const title = this.titles.get(sessionId);
      if (title) patch.title = title;
      this.emit('update', { sessionId, patch, events, bootstrap });
    });

    this.tailer.start();

    // Thread names land in the index after the rollout is already being written.
    this.indexTimer = setInterval(() => this.readIndex(), 5000);
    this.indexTimer.unref?.();
    return this.caps;
  }

  stop() {
    this.tailer.stop();
    clearInterval(this.indexTimer);
  }

  /**
   * ~/.codex/session_index.jsonl names threads. It is the only place a Codex
   * session gets a human title, so it is worth the small poll — without it every
   * tile is a uuid.
   */
  readIndex() {
    let raw;
    try {
      raw = fs.readFileSync(this.indexFile, 'utf8');
    } catch {
      return;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const rec = safeJson(line);
      if (rec?.id && rec.thread_name) this.titles.set(rec.id, truncate(rec.thread_name, 200));
    }
  }
}
