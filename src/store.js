import { EventEmitter } from 'node:events';
import { Ring, projectName } from './util.js';

/**
 * The session wall.
 *
 * The store does not infer state when it doesn't have to — Claude Code's own
 * session registry is authoritative for busy/idle/waiting, and the store just
 * merges patches from sources. Inference is reserved for sessions we only know
 * about through a transcript (`authoritative: false`).
 */

export const STATES = ['busy', 'waiting', 'idle', 'ended', 'unknown'];

/** How long an ended session keeps its tile before it leaves the wall. */
const KEEP_ENDED_MS = 30 * 60e3;
/** A transcript-only session with no activity this long is no longer "live". */
const TRANSCRIPT_IDLE_MS = 3 * 60e3;
/** With no pid to check, a silent session this old is assumed gone. */
const GHOST_AFTER_MS = 30 * 60e3;

function blank(id) {
  return {
    id,
    source: null,
    name: null,
    title: null,
    cwd: '',
    project: '',
    gitBranch: null,
    model: null,
    version: null,
    permissionMode: null,
    kind: null,
    entrypoint: null,
    slug: null,
    state: 'unknown',
    stateSince: Date.now(),
    waitingFor: null,
    registryDetail: null,
    agentName: null,
    endedReason: null,
    authoritative: false,
    startedAt: Date.now(),
    lastEventAt: 0,
    lastActivityAt: 0,
    currentTool: null,
    pendingTools: new Map(),
    lastText: null,
    lastTextAt: null,
    lastThinking: null,
    lastPrompt: null,
    queued: [],
    transcriptPath: null,
    process: { pid: null, alive: null, procStart: null },
    tasks: null,
    taskSummary: null,
    usage: null,
    subagentsActive: 0,
    stats: { tools: 0, prompts: 0, turns: 0, errors: 0, subagents: 0, turnMs: 0 },
    events: new Ring(400),
  };
}

export function serialize(s, { withEvents = false, eventLimit = 8 } = {}) {
  const out = {
    id: s.id,
    source: s.source,
    name: s.name || s.project || s.id.slice(0, 8),
    title: s.title,
    cwd: s.cwd,
    project: s.project,
    gitBranch: s.gitBranch,
    model: s.model,
    version: s.version,
    permissionMode: s.permissionMode,
    kind: s.kind,
    entrypoint: s.entrypoint,
    state: s.state,
    stateSince: s.stateSince,
    waitingFor: s.waitingFor,
    urgent: isUrgent(s),
    registryDetail: s.registryDetail,
    agentName: s.agentName,
    endedReason: s.endedReason,
    authoritative: s.authoritative,
    startedAt: s.startedAt,
    lastActivityAt: s.lastActivityAt,
    currentTool: s.currentTool,
    lastText: s.lastText,
    lastTextAt: s.lastTextAt,
    lastThinking: s.lastThinking,
    lastPrompt: s.lastPrompt,
    queued: s.queued.slice(-3),
    process: s.process,
    tasks: withEvents ? s.tasks : undefined,
    taskSummary: s.taskSummary,
    usage: s.usage,
    subagentsActive: s.subagentsActive,
    stats: s.stats,
    hasTranscript: !!s.transcriptPath,
  };
  const all = s.events.toArray();
  out.events = withEvents ? all : all.slice(-eventLimit);
  return out;
}

export function isUrgent(s) {
  if (s.state !== 'waiting') return false;
  const w = (s.waitingFor || '').toLowerCase();
  // "input needed" just means the turn ended; a dialog is what actually blocks.
  return !!w && !w.includes('input needed');
}

export class Store extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.feed = new Ring(400);
    this.capabilities = {};
    this._dirty = new Set();
    this._flush = null;
  }

  ensure(id) {
    let s = this.sessions.get(id);
    if (!s) {
      s = blank(id);
      this.sessions.set(id, s);
    }
    return s;
  }

  /** Merge a patch from a source. Sources own their fields; we own derived state. */
  apply({ sessionId, patch = {}, events = [], bootstrap = false }) {
    if (!sessionId) return null;
    const s = this.ensure(sessionId);

    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (k === 'state') {
        // The registry outranks every other source; hooks and transcript
        // inference must not fight it.
        if (s.authoritative && !patch.authoritative) continue;
        s.hasExplicitState = true;
        if (s.state !== v) {
          s.state = v;
          s.stateSince = patch.statusUpdatedAt || Date.now();
        }
        continue;
      }
      if (k === 'process') {
        s.process = { ...s.process, ...v };
        continue;
      }
      s[k] = v;
    }
    if (patch.cwd) s.project = projectName(patch.cwd);
    if (patch.startedAt) s.startedAt = Math.min(s.startedAt, patch.startedAt);

    for (const ev of events) this.applyEvent(s, ev, bootstrap);

    if (this.shouldInfer(s)) this.infer(s);

    this.markDirty(s);
    return s;
  }

  applyEvent(s, ev, bootstrap) {
    s.events.push(ev);
    s.lastEventAt = Math.max(s.lastEventAt, ev.ts);
    s.lastActivityAt = Math.max(s.lastActivityAt, ev.ts);
    if (!bootstrap) this.feed.push({ ...ev, sessionName: s.name || s.project });


    if (!bootstrap) this.emit('activity', ev, s);

    const sub = ev.lane === 'sub';

    switch (ev.kind) {
      case 'prompt':
        s.lastPrompt = ev.detail;
        s.stats.prompts++;
        s.queued = [];
        break;

      case 'assistant_text':
        if (!sub) {
          s.lastText = ev.detail;
          s.lastTextAt = ev.ts;
        }
        break;

      case 'thinking':
        if (!sub) s.lastThinking = ev.detail;
        break;

      case 'tool_start':
        s.stats.tools++;
        if (ev.tool?.name === 'Task' || ev.tool?.name === 'Agent') s.stats.subagents++;
        if (sub) {
          s.subagentsActive = Math.max(s.subagentsActive, 1);
        } else {
          s.pendingTools.set(ev.tool.id, ev.tool);
          s.currentTool = {
            name: ev.tool.name,
            pretty: ev.tool.pretty,
            category: ev.tool.category,
            detail: ev.detail,
            startedAt: ev.ts,
          };
        }
        break;

      case 'tool_end':
        if (ev.tool?.ok === false) s.stats.errors++;
        if (!sub) {
          s.pendingTools.delete(ev.tool?.id);
          // Parallel calls: only clear the banner when nothing is outstanding.
          if (s.pendingTools.size === 0) s.currentTool = null;
          else {
            const next = [...s.pendingTools.values()].pop();
            s.currentTool = {
              name: next.name,
              pretty: next.pretty,
              category: next.category,
              detail: next.detail ?? '',
              startedAt: next.startedAt ?? ev.ts,
            };
          }
        }
        break;

      case 'turn_end':
        s.stats.turns++;
        if (ev.durationMs) s.stats.turnMs += ev.durationMs;
        s.pendingTools.clear();
        s.currentTool = null;
        s.subagentsActive = 0;
        break;

      case 'queued':
        s.queued.push(ev.detail);
        break;
    }
  }

  /**
   * Inference is the last resort: only for a session that no source has ever
   * given a state. Guessing over an explicit state would undo it (and stamp the
   * wrong transition time).
   *
   * Authority is per source, not global. Claude Code has a registry and so is
   * the last word on its own sessions; Codex has nothing of the kind. Asking
   * one global question would let a working Claude registry suppress inference
   * for a Codex session it knows nothing about, leaving that tile at 'unknown'
   * forever.
   */
  shouldInfer(s) {
    if (s.authoritative || s.hasExplicitState) return false;
    return !this.capabilities[s.source]?.authoritative;
  }

  /** Fallback state for sessions we only see through a transcript. */
  infer(s) {
    const quiet = Date.now() - s.lastActivityAt;
    let next;
    if (s.currentTool) next = 'busy';
    else if (quiet < TRANSCRIPT_IDLE_MS) next = 'busy';
    else next = 'idle';
    if (s.state !== next) {
      s.state = next;
      s.stateSince = Date.now();
    }
  }

  markDirty(s) {
    this._dirty.add(s.id);
    if (this._flush) return;
    // Coalesce bursts — a single transcript write can produce a dozen events.
    this._flush = setTimeout(() => {
      this._flush = null;
      const ids = [...this._dirty];
      this._dirty.clear();
      for (const id of ids) {
        const sess = this.sessions.get(id);
        if (sess) this.emit('session', sess);
      }
    }, 60);
    this._flush.unref?.();
  }

  /** Housekeeping: retire tiles for sessions that are long gone. */
  sweep(now = Date.now()) {
    for (const [id, s] of this.sessions) {
      if (s.state === 'ended' && now - Math.max(s.lastActivityAt, s.stateSince) > KEEP_ENDED_MS) {
        this.sessions.delete(id);
        this.emit('removed', id);
        continue;
      }
      if (s.state === 'ended') continue;
      const before = s.state;

      if (this.shouldInfer(s)) {
        this.infer(s);
      } else if (!s.authoritative && now - s.lastActivityAt > GHOST_AFTER_MS) {
        // Hooks-only sessions have no pid to check. If one goes silent for long
        // enough, its terminal is gone and the tile is a ghost.
        s.state = 'ended';
        s.endedReason = 'silent';
      }

      if (s.state !== before) {
        s.stateSince = now;
        this.emit('session', s);
      }
    }
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  snapshot() {
    return {
      now: Date.now(),
      capabilities: this.capabilities,
      sessions: this.list().map((s) => serialize(s)),
      feed: this.feed.toArray().slice(-60),
    };
  }

  /** Wall order: things that need you, then things that are working, then the rest. */
  list() {
    const rank = (s) => {
      if (isUrgent(s)) return 0;
      if (s.state === 'busy') return 1;
      if (s.state === 'waiting') return 2;
      if (s.state === 'idle') return 3;
      return 4;
    };
    return [...this.sessions.values()].sort(
      (a, b) => rank(a) - rank(b) || b.lastActivityAt - a.lastActivityAt
    );
  }
}
