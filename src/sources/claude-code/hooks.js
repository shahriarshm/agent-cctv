import { uid, truncate, projectName } from '../../util.js';
import { describeTool, toolVerb, toolCategory, prettyToolName } from './describe.js';

/**
 * Optional hook enrichment.
 *
 * The dashboard does not need hooks — the session registry and transcripts
 * already carry everything. Hooks exist for two cases: a Claude Code build with
 * no ~/.claude/sessions registry, and users who want sub-second tool events
 * without waiting on a filesystem watch. Installing them is opt-in
 * (`agent-cctv install`) precisely because they add latency to every tool call.
 */

const KIND = {
  SessionStart: 'session_start',
  UserPromptSubmit: 'prompt',
  PreToolUse: 'tool_start',
  PostToolUse: 'tool_end',
  Notification: 'notification',
  Stop: 'turn_end',
  SubagentStop: 'subagent_end',
  PreCompact: 'compact',
  SessionEnd: 'session_end',
};

/** @returns {{sessionId: string, patch: object, events: object[]}|null} */
export function fromHook(envelope) {
  const p = envelope?.payload;
  if (!p) return null;
  const sessionId = p.session_id || p.sessionId;
  if (!sessionId) return null;

  const hook = p.hook_event_name || p.hookEventName;
  const kind = KIND[hook];
  if (!kind) return null;

  const ts = envelope.receivedAt || Date.now();
  const cwd = p.cwd || '';
  const patch = { source: 'claude-code', via: 'hooks' };
  if (cwd) {
    patch.cwd = cwd;
    patch.project = projectName(cwd);
  }
  if (p.transcript_path) patch.transcriptPath = p.transcript_path;
  if (p.permission_mode) patch.permissionMode = p.permission_mode;

  const ev = {
    id: uid(),
    ts,
    source: 'claude-code',
    sessionId,
    kind,
    lane: 'main',
    uuid: null,
    ref: p.transcript_path ? { file: p.transcript_path, uuid: null } : null,
    label: '',
    detail: '',
    tool: null,
    fromHook: true,
  };

  // These states only land when no session registry exists — the store ignores
  // them for any session the registry already owns.
  switch (kind) {
    case 'session_start':
      ev.label = 'Session started';
      ev.detail = p.source ? `via ${p.source}` : '';
      patch.startedAt = ts;
      patch.state = 'idle';
      return { sessionId, patch, events: [ev] };

    case 'prompt':
      ev.label = 'You said';
      ev.detail = truncate(p.prompt || '', 600);
      patch.state = 'busy';
      return { sessionId, patch, events: [ev] };

    case 'tool_start': {
      const pretty = prettyToolName(p.tool_name);
      ev.label = `${toolVerb(p.tool_name)} ${pretty}`;
      ev.detail = describeTool(p.tool_name, p.tool_input);
      ev.tool = {
        name: p.tool_name,
        pretty,
        id: `hook:${ts}:${p.tool_name}`,
        category: toolCategory(p.tool_name),
        phase: 'start',
      };
      patch.state = 'busy';
      return { sessionId, patch, events: [ev] };
    }

    case 'tool_end': {
      const pretty = prettyToolName(p.tool_name);
      const ok = !(p.tool_response?.is_error === true || p.tool_response?.success === false);
      ev.label = `${pretty} ${ok ? 'done' : 'failed'}`;
      ev.detail = describeTool(p.tool_name, p.tool_input);
      ev.tool = { name: p.tool_name, pretty, id: null, category: toolCategory(p.tool_name), phase: 'end', ok };
      return { sessionId, patch, events: [ev] };
    }

    case 'notification': {
      ev.label = 'Needs you';
      ev.detail = truncate(p.message || '', 300);
      const permission = /permission|approve|allow/i.test(p.message || '');
      patch.state = 'waiting';
      patch.waitingFor = permission ? 'permission prompt' : 'input needed';
      return { sessionId, patch, events: [ev] };
    }

    case 'turn_end':
      ev.label = 'Turn complete';
      patch.state = 'idle';
      return { sessionId, patch, events: [ev] };

    case 'subagent_end':
      ev.label = 'Subagent finished';
      return { sessionId, patch, events: [ev] };

    case 'compact':
      ev.label = 'Compacting context';
      ev.detail = p.trigger || '';
      return { sessionId, patch, events: [ev] };

    case 'session_end':
      ev.label = 'Session ended';
      ev.detail = p.reason || '';
      patch.state = 'ended';
      patch.endedReason = p.reason || 'session-end-hook';
      return { sessionId, patch, events: [ev] };
  }
  return null;
}
