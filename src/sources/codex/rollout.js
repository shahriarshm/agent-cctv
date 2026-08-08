import path from 'node:path';
import { CODEX_SESSIONS } from '../../paths.js';
import { truncate, prose, uid } from '../../util.js';
import { JsonlTailer } from '../../tail.js';
import { describeCall, categoryFor, verbFor, prettyToolName } from './describe.js';

/**
 * Tails ~/.codex/sessions/YYYY/MM/DD/rollout-<stamp>-<sessionId>.jsonl.
 *
 * Codex rollouts are the same shape of problem as Claude transcripts — an
 * append-only JSONL log — with a different vocabulary and a date-partitioned
 * layout, so this is a mapping table on top of JsonlTailer and little else.
 *
 * Two envelopes carry everything we need, and they overlap: `event_msg` is the
 * UI's stream (prose, turn boundaries, token counts) while `response_item` is
 * the model's (tool calls, reasoning). Taking prose from `event_msg` and tool
 * calls from `response_item` covers the session exactly once — reading both for
 * either would double every message.
 */

export const SOURCE = 'codex';

const FRESH_WINDOW_MS = Number(process.env.AGENT_CCTV_LOOKBACK_MS) || 45 * 60e3;

/** rollout-2026-08-03T20-46-11-019fc8a0-37db-7163-b4b6-650a93911216.jsonl */
const ROLLOUT = /^rollout-.*?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export class RolloutTailer extends JsonlTailer {
  constructor({ root = CODEX_SESSIONS, freshWindowMs = FRESH_WINDOW_MS } = {}) {
    // sessions/<year>/<month>/<day>/<file>
    super({ root, freshWindowMs, maxDepth: 3 });
  }

  sessionIdFor(file) {
    const m = ROLLOUT.exec(path.basename(file, '.jsonl'));
    return m ? m[1] : null;
  }

  initState() {
    return { calls: new Map() };
  }

  collectMeta(meta, entry) {
    const p = entry?.payload;
    if (!p || typeof p !== 'object') return;

    if (entry.type === 'session_meta') {
      if (p.cwd) meta.cwd = p.cwd;
      if (p.cli_version) meta.version = p.cli_version;
      // "Codex Desktop", "vscode", "cli" — the same axis as Claude's entrypoint.
      if (p.originator || p.source) meta.entrypoint = p.originator || p.source;
      if (p.model_provider) meta.provider = p.model_provider;
      return;
    }
    if (entry.type === 'turn_context') {
      if (p.cwd) meta.cwd = p.cwd;
      if (p.model) meta.model = p.model;
      // Codex records the policy it is running under, not whether it is
      // currently blocked on one. This is a mode, never a state.
      if (p.approval_policy) meta.permissionMode = p.approval_policy;
      return;
    }
    // Turn boundaries are a state, not an event kind — the vocabulary is fixed
    // and `turn_end` already exists for the event side of this. Collected in
    // file order, so the last boundary in the batch is the current state.
    if (entry.type === 'event_msg') {
      if (p.type === 'task_started') meta.state = 'busy';
      else if (p.type === 'task_complete' || p.type === 'turn_aborted') meta.state = 'idle';
    }

    /**
     * Codex counts differently from Claude, so the arithmetic differs too.
     *
     * `last_token_usage.input_tokens` is the most recent request's input and
     * *includes* its cached portion — that is the live context. (Claude reports
     * cache reads separately and they have to be added.) And `total_token_usage`
     * is a running total Codex maintains itself, so output needs no summing on
     * our side and is exact even when we join the rollout mid-file.
     */
    if (entry.type === 'event_msg' && p.type === 'token_count') {
      const total = p.info?.total_token_usage;
      const last = p.info?.last_token_usage;
      if (total || last) {
        meta.usage = {
          context: last?.input_tokens ?? null,
          contextWindow: p.info?.model_context_window || null,
          output: total?.output_tokens ?? 0,
          outputPartial: false,
          // Same convention in the totals as in the live context: input_tokens
          // includes the cached portion, so uncached is a subtraction.
          input: total ? Math.max(0, (total.input_tokens || 0) - (total.cached_input_tokens || 0)) : null,
          cacheRead: total ? total.cached_input_tokens || 0 : null,
          cacheWrite: null,
          cost: null,
          costEstimated: false,
        };
      }
    }
  }

  toEvents(entry, state, file) {
    return toEvents(entry, state, file);
  }
}

function base(entry, file, sessionId, kind) {
  return {
    id: uid(),
    ts: Date.parse(entry.timestamp) || Date.now(),
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

/** One rollout line -> zero or more normalized events. */
export function toEvents(entry, state, file) {
  const out = [];
  const p = entry?.payload;
  if (!p || typeof p !== 'object') return out;
  const sessionId = state.sessionId;
  const ev = (kind) => base(entry, file, sessionId, kind);

  if (entry.type === 'session_meta') {
    const e = ev('session_start');
    e.label = 'Session started';
    e.detail = p.originator || p.source || '';
    out.push(e);
    return out;
  }

  if (entry.type === 'event_msg') {
    switch (p.type) {
      case 'user_message': {
        const text = prose(p.message || '', 600);
        if (!text) break;
        const e = ev('prompt');
        e.label = 'You said';
        e.detail = text;
        out.push(e);
        break;
      }

      case 'agent_message': {
        const text = prose(p.message || '', 700);
        if (!text) break;
        const e = ev('assistant_text');
        e.label = 'Says';
        e.detail = text;
        out.push(e);
        break;
      }

      case 'agent_reasoning': {
        const text = prose(p.text || p.reasoning || '', 500);
        if (!text) break;
        const e = ev('thinking');
        e.label = 'Thinking';
        e.detail = text;
        out.push(e);
        break;
      }

      case 'task_complete': {
        const e = ev('turn_end');
        e.label = 'Turn complete';
        e.durationMs = p.duration_ms || null;
        e.detail = p.duration_ms ? `${Math.round(p.duration_ms / 1000)}s` : '';
        out.push(e);
        break;
      }

      case 'turn_aborted': {
        const e = ev('turn_end');
        e.label = 'Turn aborted';
        e.detail = p.reason || '';
        out.push(e);
        break;
      }

      // Codex reports these only on completion — there is no matching start
      // line, so each is a self-contained finished call rather than a pair.
      case 'mcp_tool_call_end': {
        const server = p.invocation?.server || 'mcp';
        const tool = p.invocation?.tool || 'call';
        const e = ev('tool_end');
        e.label = `${server}: ${tool} done`;
        e.detail = describeCall(tool, p.invocation?.arguments);
        e.tool = { name: `mcp__${server}__${tool}`, pretty: `${server}: ${tool}`, id: p.call_id || null, category: 'net', phase: 'end', ok: true };
        out.push(e);
        break;
      }

      case 'patch_apply_end': {
        const files = Object.keys(p.changes || {});
        const e = ev('tool_end');
        const ok = p.success !== false;
        e.label = `Patch ${ok ? 'applied' : 'failed'}`;
        e.detail = files.length === 1 ? path.basename(files[0]) : `${files.length} files`;
        if (!ok) e.detail = truncate(p.stderr || e.detail, 300);
        e.tool = { name: 'apply_patch', pretty: 'Patch', id: p.call_id || null, category: 'write', phase: 'end', ok };
        out.push(e);
        break;
      }

      case 'web_search_end': {
        const e = ev('tool_end');
        e.label = 'Web search done';
        e.detail = truncate(p.query || '', 160);
        e.tool = { name: 'web_search', pretty: 'Search', id: null, category: 'net', phase: 'end', ok: true };
        out.push(e);
        break;
      }
    }
    return out;
  }

  if (entry.type === 'response_item') {
    switch (p.type) {
      case 'function_call':
      case 'custom_tool_call': {
        const name = p.name || 'tool';
        // function_call carries a JSON argument string, custom_tool_call a code
        // string. describeCall handles both.
        const detail = describeCall(name, p.arguments ?? p.input);
        const pretty = prettyToolName(name);
        const e = ev('tool_start');
        e.label = `${verbFor(name)} ${pretty}`;
        e.detail = detail;
        e.tool = { name, pretty, id: p.call_id || p.id, category: categoryFor(name), phase: 'start' };
        state.calls.set(p.call_id || p.id, { name, detail, startedAt: e.ts });
        out.push(e);
        break;
      }

      case 'function_call_output':
      case 'custom_tool_call_output': {
        const key = p.call_id || p.id;
        const started = state.calls.get(key);
        state.calls.delete(key);
        const name = started?.name || 'tool';
        const pretty = prettyToolName(name);
        const ok = !isFailure(p.output);
        const e = ev('tool_end');
        e.label = `${pretty} ${ok ? 'done' : 'failed'}`;
        e.detail = started?.detail || '';
        if (!ok) e.detail = truncate(outputText(p.output) || e.detail, 300);
        e.tool = {
          name,
          pretty,
          id: key || null,
          category: categoryFor(name),
          phase: 'end',
          ok,
          durationMs: started ? Math.max(0, (Date.parse(entry.timestamp) || Date.now()) - started.startedAt) : null,
        };
        out.push(e);
        break;
      }
    }
  }

  return out;
}

function outputText(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output.map((x) => (typeof x === 'string' ? x : x?.text || '')).join(' ');
  return '';
}

/**
 * Codex has no is_error flag on a call output — a failed command comes back as
 * ordinary text. Rather than pattern-match prose and mis-flag a session that
 * merely printed the word "error", only an explicit non-zero exit counts.
 */
function isFailure(output) {
  return /\bexit(?: code)? [1-9]\d*\b/i.test(outputText(output).slice(0, 400));
}
