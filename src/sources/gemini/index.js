import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { GEMINI_TMP } from '../../paths.js';
import { ChatTailer, SOURCE } from './chats.js';

export { SOURCE };

/**
 * The Gemini CLI source.
 *
 * Same standing as Codex: a transcript and nothing else. No registry, no pid,
 * no approval event — the chat log records what was said and called, so state
 * is inferred from activity and a Gemini tile can never raise the wall's
 * urgent signal. What Gemini does add over Codex is a per-project
 * .project_root file, which makes cwd exact rather than parsed out of a
 * message.
 */

export function capabilities() {
  return {
    source: SOURCE,
    chats: fs.existsSync(GEMINI_TMP),
    authoritative: false,
    urgency: false,
  };
}

/** Chat-log facts -> a session patch. Shared with the history reader. */
export function patchFromMeta(meta, file) {
  const patch = { source: SOURCE, transcriptPath: file };
  if (meta.cwd) patch.cwd = meta.cwd;
  if (meta.model) patch.model = meta.model;
  if (meta.usage) patch.usage = meta.usage;
  if (meta.startedAt) patch.startedAt = meta.startedAt;
  return patch;
}

export class GeminiSource extends EventEmitter {
  constructor({ root = GEMINI_TMP } = {}) {
    super();
    this.tailer = new ChatTailer({ root });
    this.caps = capabilities();
  }

  start() {
    this.tailer.on('batch', ({ sessionId, file, events, meta, bootstrap }) => {
      this.emit('update', { sessionId, patch: patchFromMeta(meta, file), events, bootstrap });
    });
    this.tailer.start();
    return this.caps;
  }

  stop() {
    this.tailer.stop();
  }
}
