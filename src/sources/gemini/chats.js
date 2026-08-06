import fs from 'node:fs';
import path from 'node:path';
import { GEMINI_TMP } from '../../paths.js';
import { describeArgs, prose, uid } from '../../util.js';
import { JsonlTailer } from '../../tail.js';

/**
 * Tails ~/.gemini/tmp/<project-slug>/chats/session-*.jsonl.
 *
 * The file is an op log, not a message log, and the distinction is the whole
 * adapter. Three line shapes, read off real files:
 *
 *   - line 1 is a header: {sessionId, projectHash, startTime, kind}
 *   - {"$set":{"messages":[...]}} replaces the whole message array — the
 *     first one is the session snapshot, and one can appear again later
 *   - a bare {id, timestamp, type, content} object is one appended message
 *   - {"$set":{"lastUpdated":...}} is a heartbeat and carries nothing else
 *
 * The trap is that the same message id is appended repeatedly as streaming
 * fills it in — and a later copy can carry *more* than an earlier one (the
 * toolCalls array lands on a re-append). So text and thoughts dedupe on the
 * message id, first sight wins, while tool calls and their responses dedupe
 * on the call id, which is the only way a late-arriving call still surfaces.
 */

export const SOURCE = 'gemini';

const FRESH_WINDOW_MS = Number(process.env.AGENT_CCTV_LOOKBACK_MS) || 45 * 60e3;

/** Enough of the head to contain the header line's sessionId. */
const HEADER_BYTES = 512;

export class ChatTailer extends JsonlTailer {
  constructor({ root = GEMINI_TMP, freshWindowMs = FRESH_WINDOW_MS } = {}) {
    // tmp/<project-slug>/chats/<file>
    super({ root, freshWindowMs, maxDepth: 2 });
    this.headerIds = new Map(); // file -> sessionId from its header line
    this.roots = new Map(); // project dir -> contents of .project_root
  }

  /**
   * The filename carries only eight hex characters of the id; the full uuid is
   * on the header line. One small read per file, cached forever — a file's
   * header never changes.
   */
  sessionIdFor(file) {
    if (!path.basename(file).startsWith('session-')) return null;
    const hit = this.headerIds.get(file);
    if (hit !== undefined) return hit;
    let id = null;
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(HEADER_BYTES);
      const bytes = fs.readSync(fd, buf, 0, HEADER_BYTES, 0);
      const m = /"sessionId"\s*:\s*"([0-9a-f-]{8,})"/i.exec(buf.subarray(0, bytes).toString('utf8'));
      if (m) id = m[1];
    } catch {
      return null;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {}
      }
    }
    // A miss is not cached: a freshly created file may not have flushed its
    // header line yet, and caching null would ignore that session forever.
    if (id) this.headerIds.set(file, id);
    return id;
  }

  initState() {
    return {
      calls: new Map(), // call id -> {name, detail, startedAt}
      seenCalls: new Set(),
      seenResponses: new Set(),
      usageCounted: new Set(), // message ids whose tokens are already summed
      outputSeen: 0,
    };
  }

  /** The real cwd lives in .project_root beside the chats directory. */
  cwdFor(file) {
    const dir = path.dirname(path.dirname(file)); // <slug>/chats/x.jsonl -> <slug>
    const hit = this.roots.get(dir);
    if (hit !== undefined) return hit;
    let cwd = null;
    try {
      cwd = fs.readFileSync(path.join(dir, '.project_root'), 'utf8').split('\n')[0].trim() || null;
    } catch {}
    this.roots.set(dir, cwd);
    return cwd;
  }

  collectMeta(meta, entry, state) {
    const cwd = this.cwdFor(meta.file);
    if (cwd) meta.cwd = cwd;

    if (entry?.sessionId && entry.startTime) {
      const t = Date.parse(entry.startTime);
      if (t) meta.startedAt = t;
      return;
    }

    for (const msg of messagesIn(entry)) {
      if (msg.type !== 'gemini') continue;
      if (msg.model) meta.model = msg.model;
      /**
       * Same arithmetic as the Claude source: input counts the whole resent
       * context (cached included), so the latest message *is* the context;
       * output is incremental and must be summed — once per message id, since
       * streaming re-appends the same message with the same numbers.
       */
      const t = msg.tokens;
      if (t && typeof t.input === 'number' && !state.usageCounted.has(msg.id)) {
        state.usageCounted.add(msg.id);
        state.outputSeen += (t.output || 0) + (t.thoughts || 0);
        meta.usage = {
          context: t.input,
          contextWindow: null,
          output: state.outputSeen,
          outputPartial: !state.fromStart,
        };
      }
    }
  }

  toEvents(entry, state, file) {
    const out = [];
    if (entry?.sessionId && entry.startTime) {
      const e = base(entry.startTime, file, state.sessionId, 'session_start');
      e.label = 'Session started';
      out.push(e);
      return out;
    }
    for (const msg of messagesIn(entry)) out.push(...fromMessage(msg, state, file));
    return out;
  }
}

/** Every message a line carries: one bare append, or a whole $set snapshot. */
function messagesIn(entry) {
  if (Array.isArray(entry?.$set?.messages)) return entry.$set.messages.filter((m) => m && m.id);
  if (entry?.id && entry.type) return [entry];
  return [];
}

function base(timestamp, file, sessionId, kind) {
  return {
    id: uid(),
    ts: Date.parse(timestamp) || Date.now(),
    source: SOURCE,
    sessionId,
    kind,
    lane: 'main',
    uuid: null,
    ref: { file, uuid: null },
    label: '',
    detail: '',
    tool: null,
  };
}

function textOf(msg) {
  const parts = Array.isArray(msg.content) ? msg.content : [];
  return parts
    .map((p) => (typeof p === 'string' ? p : p?.text || ''))
    .join(' ')
    .trim();
}

function fromMessage(msg, state, file) {
  const out = [];
  const ev = (kind) => base(msg.timestamp, file, state.sessionId, kind);
  const firstSight = !state.seen.has(msg.id);

  if (msg.type === 'user') {
    for (const part of Array.isArray(msg.content) ? msg.content : []) {
      const fr = part?.functionResponse;
      if (!fr?.id) continue;
      if (state.seenResponses.has(fr.id)) continue;
      state.seenResponses.add(fr.id);
      const started = state.calls.get(fr.id);
      state.calls.delete(fr.id);
      const name = fr.name || started?.name || 'tool';
      const e = ev('tool_end');
      e.label = `${name} done`;
      e.detail = started?.detail || '';
      e.tool = {
        name,
        pretty: name,
        id: fr.id,
        category: categoryFor(name),
        phase: 'end',
        // Gemini records no error flag on a response; claiming success or
        // failure would be a guess either way.
        ok: true,
        durationMs: started ? Math.max(0, e.ts - started.startedAt) : null,
      };
      out.push(e);
    }
    if (firstSight) {
      state.seen.add(msg.id);
      const text = prose(textOf(msg), 600);
      // Context the CLI injects arrives as a user message wrapped in a tag;
      // nobody typed it, so it is not a prompt.
      if (text && !text.startsWith('<')) {
        const e = ev('prompt');
        e.label = 'You said';
        e.detail = text;
        out.push(e);
      }
    }
    return out;
  }

  if (msg.type !== 'gemini') return out;

  if (firstSight) {
    state.seen.add(msg.id);
    const thought = Array.isArray(msg.thoughts) && msg.thoughts[0];
    if (thought) {
      const e = ev('thinking');
      e.label = 'Thinking';
      e.detail = prose([thought.subject, thought.description].filter(Boolean).join(' — '), 500);
      if (e.detail) out.push(e);
    }
    const text = prose(textOf(msg), 700);
    if (text) {
      const e = ev('assistant_text');
      e.label = 'Says';
      e.detail = text;
      out.push(e);
    }
  }

  // Deliberately outside the firstSight gate — see the file comment.
  for (const tc of Array.isArray(msg.toolCalls) ? msg.toolCalls : []) {
    if (!tc?.id || state.seenCalls.has(tc.id)) continue;
    state.seenCalls.add(tc.id);
    const name = tc.name || 'tool';
    const detail = describeArgs(tc.args);
    const e = ev('tool_start');
    e.label = `${verbFor(name)} ${name}`;
    e.detail = detail;
    e.tool = { name, pretty: name, id: tc.id, category: categoryFor(name), phase: 'start' };
    state.calls.set(tc.id, { name, detail, startedAt: e.ts });
    out.push(e);
  }

  return out;
}

const VERBS = {
  run_shell_command: 'Running',
  google_web_search: 'Searching web',
  web_fetch: 'Fetching',
  write_file: 'Writing',
  replace: 'Editing',
  read_file: 'Reading',
  read_many_files: 'Reading',
  list_directory: 'Listing',
  glob: 'Globbing',
  search_file_content: 'Grepping',
  save_memory: 'Remembering',
};

export function verbFor(name = '') {
  return VERBS[name] || 'Using';
}

export function categoryFor(name = '') {
  switch (name) {
    case 'run_shell_command':
      return 'exec';
    case 'write_file':
    case 'replace':
      return 'write';
    case 'read_file':
    case 'read_many_files':
    case 'list_directory':
    case 'glob':
    case 'search_file_content':
      return 'read';
    case 'google_web_search':
    case 'web_fetch':
      return 'net';
    default:
      return 'other';
  }
}
