import path from 'node:path';
import { CLAUDE_PROJECTS } from '../../paths.js';
import { truncate, prose, uid } from '../../util.js';
import { JsonlTailer } from '../../tail.js';
import { describeTool, toolVerb, toolCategory, prettyToolName } from './describe.js';

/**
 * Tails ~/.claude/projects/<slug>/<sessionId>.jsonl.
 *
 * The file-following mechanics live in JsonlTailer; what's left here is the
 * part that is actually about Claude Code — which files belong to a session and
 * what its entry types mean.
 *
 * We never copy transcript content into a durable store — an event keeps a
 * {file, uuid} pointer back to the source line instead, so raw data stays in
 * exactly one place on disk (Claude's, mode 600) and memory stays bounded.
 */

/**
 * Auto-discovery window. Live sessions are tracked explicitly via the registry
 * regardless of age, so this only governs how far back we pick up transcripts
 * for sessions that have already finished.
 */
export const FRESH_WINDOW_MS = Number(process.env.AGENT_CCTV_LOOKBACK_MS) || 45 * 60e3;

export class TranscriptTailer extends JsonlTailer {
  constructor({ root = CLAUDE_PROJECTS, freshWindowMs = FRESH_WINDOW_MS } = {}) {
    super({ root, freshWindowMs, maxDepth: 1 });
  }

  /** Claude names the file after the session, one directory per project. */
  sessionIdFor(file) {
    const id = path.basename(file, '.jsonl');
    return /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(id) ? id : null;
  }

  initState() {
    return { tools: new Map(), outputSeen: 0, inputSeen: 0, cacheReadSeen: 0, cacheWriteSeen: 0, context: null };
  }

  collectMeta(meta, entry, state) {
    return collectMeta(meta, entry, state);
  }

  toEvents(entry, state, file) {
    return toEvents(entry, state, file);
  }
}

/**
 * User entries are not always something a human typed. Slash commands arrive as
 * an XML envelope, command output and system reminders are injected the same
 * way. Return '' for anything that isn't a real prompt so it never reaches a tile.
 */
export function cleanPrompt(text) {
  if (!text) return '';
  const t = text.trim();

  const name = t.match(/<command-name>([^<]*)<\/command-name>/);
  if (name) {
    const args = (t.match(/<command-args>([^<]*)<\/command-args>/) || [])[1] || '';
    return `${name[1].trim()} ${args.trim()}`.trim();
  }
  if (/^<(local-command-(stdout|stderr)|command-message)>/.test(t)) return '';

  const stripped = t
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/^Caveat: The messages below.*$/im, '')
    .trim();
  // A message that was nothing but injected context isn't a prompt.
  return stripped;
}

/**
 * What the context number means, and why it is not a sum.
 *
 * Claude reports usage per request, and every request resends the whole
 * conversation — so `input_tokens + cache_read + cache_creation` on the newest
 * assistant message *is* the session's current context, exactly, no matter
 * where we started reading. Adding those up across messages would produce tens
 * of millions and mean nothing.
 *
 * Output tokens are the opposite: genuinely incremental, so they must be
 * summed — and that sum is only a true total when we read the log from its
 * start, which `fromStart` records honestly rather than pretending otherwise.
 *
 * Subagents are counted in the sums and excluded from the context. A sidechain
 * request carries its own separate context — letting one land on `context`
 * would make a full session look like it had suddenly emptied — but its tokens
 * are this session's work all the same, and a total that quietly dropped
 * subagent requests would understate every session that delegated anything.
 */
function collectUsage(meta, entry, state) {
  const u = entry.message?.usage;
  if (!u) return;
  state.inputSeen += u.input_tokens || 0;
  state.cacheReadSeen += u.cache_read_input_tokens || 0;
  state.cacheWriteSeen += u.cache_creation_input_tokens || 0;
  state.outputSeen += u.output_tokens || 0;
  if (!entry.isSidechain) {
    state.context =
      (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  }
  meta.usage = {
    context: state.context,
    // Claude does not record the model's window anywhere in the transcript, so
    // there is no honest denominator to show a percentage against.
    contextWindow: null,
    output: state.outputSeen,
    outputPartial: !state.fromStart,
    input: state.inputSeen,
    cacheRead: state.cacheReadSeen,
    cacheWrite: state.cacheWriteSeen,
    cost: null,
    costEstimated: false,
  };
}

function collectMeta(meta, entry, state) {
  switch (entry.type) {
    case 'ai-title':
      meta.title = entry.aiTitle || entry.title || null;
      break;
    case 'permission-mode':
      meta.permissionMode = entry.permissionMode || null;
      break;
    case 'mode':
      meta.mode = entry.mode || null;
      break;
    case 'assistant':
      if (entry.message?.model) meta.model = entry.message.model;
      if (entry.cwd) meta.cwd = entry.cwd;
      if (entry.gitBranch) meta.gitBranch = entry.gitBranch;
      if (entry.version) meta.version = entry.version;
      if (entry.slug) meta.slug = entry.slug;
      collectUsage(meta, entry, state);
      break;
    case 'user':
      if (entry.cwd) meta.cwd = entry.cwd;
      if (entry.gitBranch) meta.gitBranch = entry.gitBranch;
      break;
  }
}

function base(entry, file, kind) {
  return {
    id: uid(),
    ts: Date.parse(entry.timestamp) || Date.now(),
    source: 'claude-code',
    sessionId: entry.sessionId || path.basename(file, '.jsonl'),
    kind,
    lane: entry.isSidechain ? 'sub' : 'main',
    uuid: entry.uuid || null,
    ref: { file, uuid: entry.uuid || null },
    label: '',
    detail: '',
    tool: null,
  };
}

/** One transcript entry -> zero or more normalized events. */
function toEvents(entry, state, file) {
  const out = [];

  if (entry.uuid) {
    if (state.seen.has(entry.uuid)) return out;
    state.seen.add(entry.uuid);
  }

  if (entry.type === 'assistant') {
    const blocks = Array.isArray(entry.message?.content) ? entry.message.content : [];
    for (const b of blocks) {
      if (b.type === 'thinking' && b.thinking?.trim()) {
        const ev = base(entry, file, 'thinking');
        ev.label = 'Thinking';
        ev.detail = prose(b.thinking, 500);
        out.push(ev);
      } else if (b.type === 'text' && b.text?.trim()) {
        const ev = base(entry, file, 'assistant_text');
        ev.label = 'Says';
        ev.detail = prose(b.text, 700);
        out.push(ev);
      } else if (b.type === 'tool_use') {
        const ev = base(entry, file, 'tool_start');
        const pretty = prettyToolName(b.name);
        ev.label = `${toolVerb(b.name)} ${pretty}`;
        ev.detail = describeTool(b.name, b.input);
        ev.tool = {
          name: b.name,
          pretty,
          id: b.id,
          category: toolCategory(b.name),
          phase: 'start',
        };
        state.tools.set(b.id, { name: b.name, pretty, startedAt: ev.ts, detail: ev.detail });
        out.push(ev);
      }
    }
    return out;
  }

  if (entry.type === 'user') {
    const content = entry.message?.content;
    if (typeof content === 'string') {
      const text = cleanPrompt(content);
      if (text) {
        const ev = base(entry, file, 'prompt');
        ev.label = 'You said';
        ev.detail = prose(text, 600);
        out.push(ev);
      }
      return out;
    }
    if (!Array.isArray(content)) return out;

    for (const b of content) {
      if (b.type === 'tool_result') {
        const started = state.tools.get(b.tool_use_id);
        state.tools.delete(b.tool_use_id);
        const ev = base(entry, file, 'tool_end');
        const failed = b.is_error === true;
        const pretty = started?.pretty || 'tool';
        ev.label = `${pretty} ${failed ? 'failed' : 'done'}`;
        ev.detail = started?.detail || '';
        ev.tool = {
          name: started?.name || null,
          pretty,
          id: b.tool_use_id,
          category: toolCategory(started?.name || ''),
          phase: 'end',
          ok: !failed,
          durationMs: started ? Math.max(0, (Date.parse(entry.timestamp) || Date.now()) - started.startedAt) : null,
        };
        if (failed) ev.detail = truncate(resultText(b) || ev.detail, 300);
        out.push(ev);
      } else if (b.type === 'text') {
        const text = cleanPrompt(b.text);
        if (!text) continue;
        const ev = base(entry, file, 'prompt');
        ev.label = 'You said';
        ev.detail = prose(text, 600);
        out.push(ev);
      }
    }
    return out;
  }

  if (entry.type === 'system' && entry.subtype === 'turn_duration') {
    const ev = base(entry, file, 'turn_end');
    ev.label = 'Turn complete';
    ev.detail = entry.durationMs ? `${Math.round(entry.durationMs / 1000)}s` : '';
    ev.durationMs = entry.durationMs || null;
    out.push(ev);
    return out;
  }

  if (entry.type === 'queue-operation' && entry.operation === 'enqueue') {
    const ev = base(entry, file, 'queued');
    ev.sessionId = entry.sessionId || ev.sessionId;
    ev.label = 'Queued prompt';
    ev.detail = prose(entry.content || '', 300);
    out.push(ev);
    return out;
  }

  return out;
}

function resultText(block) {
  const c = block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : x?.text || '')).join(' ');
  return '';
}
