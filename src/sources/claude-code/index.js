import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { CLAUDE_PROJECTS, CLAUDE_SESSIONS, CLAUDE_TASKS } from '../../paths.js';
import { SessionRegistry, available as registryAvailable } from './registry.js';
import { TranscriptTailer } from './transcript.js';
import { readTasks, summarizeTasks, available as tasksAvailable } from './tasks.js';
import { approvalsInstalled } from '../../install.js';

export const SOURCE = 'claude-code';

/**
 * The Claude Code source: a pure observer.
 *
 * Three signals, in order of authority:
 *   1. ~/.claude/sessions/<pid>.json — who is alive and their status. Claude
 *      Code writes this itself on every transition, so we never infer it.
 *   2. ~/.claude/projects/**\/<sessionId>.jsonl — the activity stream.
 *   3. ~/.claude/tasks/<sessionId>/ — what the agent is working through.
 *
 * Nothing here writes to Claude's state, and nothing requires installation.
 */

/** Claude Code slugifies the cwd to name the project directory. */
export function projectSlug(cwd) {
  return String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
}

export function transcriptPathFor(cwd, sessionId, root = CLAUDE_PROJECTS) {
  const direct = path.join(root, projectSlug(cwd), `${sessionId}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  // Resumed or moved sessions may not sit under the current cwd's slug.
  try {
    for (const dir of fs.readdirSync(root)) {
      const candidate = path.join(root, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {}
  return null;
}

export function capabilities() {
  const registry = registryAvailable(CLAUDE_SESSIONS);
  return {
    source: SOURCE,
    registry,
    transcripts: fs.existsSync(CLAUDE_PROJECTS),
    tasks: tasksAvailable(CLAUDE_TASKS),
    // With the registry readable, Claude Code states are the last word and the
    // store must never infer over them. Without it, inference is all we have.
    authoritative: registry,
    // Claude records *why* a session is waiting, so it can raise the wall's
    // urgent signal. Not every agent can.
    urgency: true,
    // Remote approvals are wired only when the operator opted in with
    // `agent-cctv install --approvals` — the wall's honesty about which
    // tiles can grow buttons starts here.
    approvals: approvalsInstalled(),
  };
}

/**
 * Transcript facts -> a session patch. Shared with the history reader, which
 * replays an old transcript through this same mapping so a session read back
 * later is described exactly as it was when it was live.
 */
export function patchFromMeta(meta, file) {
  const patch = { transcriptPath: file, source: SOURCE };
  if (meta.title) patch.title = meta.title;
  if (meta.model) patch.model = meta.model;
  if (meta.version) patch.version = meta.version;
  if (meta.cwd) patch.cwd = meta.cwd;
  if (meta.gitBranch) patch.gitBranch = meta.gitBranch;
  if (meta.permissionMode) patch.permissionMode = meta.permissionMode;
  if (meta.slug) patch.slug = meta.slug;
  if (meta.usage) patch.usage = meta.usage;
  return patch;
}

export class ClaudeCodeSource extends EventEmitter {
  constructor({ projectsRoot = CLAUDE_PROJECTS, sessionsDir = CLAUDE_SESSIONS } = {}) {
    super();
    this.projectsRoot = projectsRoot;
    this.registry = new SessionRegistry({ dir: sessionsDir });
    this.tailer = new TranscriptTailer({ root: projectsRoot });
    this.caps = capabilities();
  }

  start() {
    this.registry.on('appeared', (rec) => this.onRegistry(rec, true));
    this.registry.on('changed', (rec) => this.onRegistry(rec, false));
    this.registry.on('gone', ({ sessionId, pid, reason }) => {
      this.emit('update', {
        sessionId,
        patch: {
          state: 'ended',
          endedReason: reason,
          // Without this, the store's own authority guard (set by this source's
          // earlier patches) refuses the state write and the tile never retires.
          authoritative: true,
          process: { pid, alive: false },
          currentTool: null,
          waitingFor: null,
        },
      });
    });

    this.tailer.on('batch', ({ sessionId, file, events, meta, bootstrap }) => {
      const patch = patchFromMeta(meta, file);
      // If the registry works, absence from it is proof the session is not
      // running — no timeout guessing needed.
      if (this.caps.registry && !this.registry.bySessionId(sessionId)) {
        patch.state = 'ended';
        patch.endedReason = 'not-running';
        patch.authoritative = true;
        patch.process = { pid: null, alive: false };
      }
      this.emit('update', { sessionId, patch, events, bootstrap });
    });

    this.registry.start();
    this.tailer.start();

    // Tasks change without touching the transcript, so poll them for live sessions.
    this.taskTimer = setInterval(() => this.pollTasks(), 2000);
    this.taskTimer.unref?.();
    this.pollTasks();
    return this.caps;
  }

  stop() {
    this.registry.stop();
    this.tailer.stop();
    clearInterval(this.taskTimer);
  }

  onRegistry(rec) {
    const transcriptPath = transcriptPathFor(rec.cwd, rec.sessionId, this.projectsRoot);

    // Emit the authoritative state before tracking the transcript. `track()`
    // reads and emits synchronously, and a transcript batch that lands first
    // would make the store infer a state — and stamp it with the wrong time.
    this.emit('update', {
      sessionId: rec.sessionId,
      patch: {
        source: SOURCE,
        state: mapState(rec),
        waitingFor: rec.waitingFor || null,
        registryDetail: rec.detail || null,
        agentName: rec.agent || null,
        name: rec.name || null,
        cwd: rec.cwd || undefined,
        version: rec.version || undefined,
        kind: rec.kind,
        entrypoint: rec.entrypoint,
        startedAt: rec.startedAt || undefined,
        statusUpdatedAt: rec.statusUpdatedAt || undefined,
        transcriptPath: transcriptPath || undefined,
        authoritative: true,
        process: {
          pid: rec.pid,
          alive: rec.alive,
          procStart: rec.procStart,
        },
      },
    });

    if (transcriptPath) this.tailer.track(transcriptPath);
  }

  pollTasks() {
    if (!this.caps.tasks) return;
    for (const rec of this.registry.list()) {
      const tasks = readTasks(rec.sessionId);
      if (!tasks) continue;
      this.emit('update', {
        sessionId: rec.sessionId,
        patch: { tasks, taskSummary: summarizeTasks(tasks) },
      });
    }
  }

  /** All sessions the registry currently knows about. */
  liveSessions() {
    return this.registry.list();
  }
}

/**
 * Claude's status vocabulary is {busy, idle, waiting, shell}; ours adds `ended`
 * for processes that are gone. `waiting` splits in the UI by `waitingFor`, because
 * "permission prompt" is an interrupt and "input needed" is just a finished turn.
 */
function mapState(rec) {
  if (!rec.alive) return 'ended';
  switch (rec.status) {
    case 'busy':
      return 'busy';
    case 'waiting':
      return 'waiting';
    case 'idle':
      return 'idle';
    case 'shell':
      // The user's `!` command running inside the session — work, not idleness.
      return 'busy';
    default:
      return 'unknown';
  }
}

export function isUrgent(session) {
  const w = (session?.waitingFor || '').toLowerCase();
  return session?.state === 'waiting' && !!w && !w.includes('input needed');
}
