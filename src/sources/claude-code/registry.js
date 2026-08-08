import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { CLAUDE_SESSIONS } from '../../paths.js';
import { safeJson } from '../../util.js';

/**
 * Claude Code maintains ~/.claude/sessions/<pid>.json for every running CLI, and
 * rewrites it on every status transition. That file is the authoritative answer
 * to "which agents are alive and what are they doing" — pid, cwd, sessionId, a
 * derived display name, and status ∈ {busy, idle, waiting, shell} with a
 * `waitingFor` reason for permission and input prompts.
 *
 * This is undocumented internal state, so `available()` capability-checks it and
 * the rest of the app degrades to transcript-only inference when it's missing.
 */

const POLL_MS = 1000;

export function available(dir = CLAUDE_SESSIONS) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function lstartOf(pid, env) {
  return new Promise((resolve) => {
    execFile('ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 2000, env }, (err, stdout) => {
      resolve(err ? null : stdout.trim() || null);
    });
  });
}

/**
 * `ps` start time for a pid, used to catch pid reuse after a session dies.
 * Rendered twice — local time and UTC — because Claude Code writes `procStart`
 * in UTC while a plain `ps` renders lstart in the machine's timezone. Comparing
 * against a single rendering condemned every live session as pid-reused on any
 * machine not at UTC, and the whole wall read NO SIGNAL seconds after start.
 */
function procStartOf(pid) {
  return Promise.all([lstartOf(pid), lstartOf(pid, { ...process.env, TZ: 'UTC' })]).then(
    ([local, utc]) => ({ local, utc })
  );
}

/** The recorded start disproves the binding only if it matches *neither* rendering. */
export function procStartMatches(recorded, starts) {
  if (!recorded) return true;
  const seen = [starts?.local, starts?.utc].filter(Boolean);
  return seen.length === 0 || seen.includes(recorded);
}

function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export class SessionRegistry extends EventEmitter {
  constructor({ dir = CLAUDE_SESSIONS } = {}) {
    super();
    this.dir = dir;
    this.entries = new Map(); // pid -> record
    this.verifiedPids = new Map(); // pid -> true once procStart matched
    this.watcher = null;
    this.timer = null;
  }

  start() {
    if (!available(this.dir)) return false;
    this.poll();
    try {
      this.watcher = fs.watch(this.dir, () => this.poll());
      this.watcher.on('error', () => {});
    } catch {}
    this.timer = setInterval(() => this.poll(), POLL_MS);
    this.timer.unref?.();
    return true;
  }

  stop() {
    try {
      this.watcher?.close();
    } catch {}
    this.watcher = null;
    clearInterval(this.timer);
  }

  poll() {
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }

    const seen = new Set();
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const pid = Number(path.basename(name, '.json'));
      if (!Number.isInteger(pid)) continue;

      const rec = safeJson(readFileSafe(path.join(this.dir, name)));
      if (!rec || !rec.sessionId) continue;
      seen.add(pid);

      const alive = pidExists(pid);
      // A killed CLI can leave its file behind; a later process can inherit the
      // pid. Confirm the recorded start time once before trusting the binding.
      if (alive && rec.procStart && !this.verifiedPids.has(pid)) {
        this.verifiedPids.set(pid, 'pending');
        procStartOf(pid).then((starts) => {
          const ok = procStartMatches(rec.procStart, starts);
          this.verifiedPids.set(pid, ok);
          if (!ok) this.emit('gone', { pid, sessionId: rec.sessionId, reason: 'pid-reused' });
        });
      }

      const next = {
        pid,
        sessionId: rec.sessionId,
        cwd: rec.cwd || '',
        name: rec.name || null,
        version: rec.version || null,
        kind: rec.kind || 'interactive',
        entrypoint: rec.entrypoint || null,
        startedAt: rec.startedAt || null,
        procStart: rec.procStart || null,
        status: alive ? rec.status || 'idle' : 'gone',
        waitingFor: rec.waitingFor || null,
        detail: rec.detail || null,
        agent: rec.agent || null,
        updatedAt: rec.updatedAt || null,
        statusUpdatedAt: rec.statusUpdatedAt || null,
        alive,
        raw: rec,
      };

      const prev = this.entries.get(pid);
      if (!prev) {
        this.entries.set(pid, next);
        this.emit('appeared', next);
      } else if (changed(prev, next)) {
        this.entries.set(pid, next);
        this.emit('changed', next, prev);
      }
    }

    for (const [pid, rec] of this.entries) {
      if (!seen.has(pid)) {
        this.entries.delete(pid);
        this.verifiedPids.delete(pid);
        this.emit('gone', { pid, sessionId: rec.sessionId, reason: 'file-removed' });
      }
    }
  }

  list() {
    return [...this.entries.values()];
  }

  bySessionId(sessionId) {
    for (const rec of this.entries.values()) if (rec.sessionId === sessionId) return rec;
    return null;
  }
}

const WATCHED_FIELDS = ['status', 'waitingFor', 'detail', 'alive', 'name', 'cwd', 'statusUpdatedAt', 'agent'];
function changed(a, b) {
  return WATCHED_FIELDS.some((k) => a[k] !== b[k]);
}

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}
