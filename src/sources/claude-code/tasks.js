import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_TASKS } from '../../paths.js';
import { safeJson } from '../../util.js';

/**
 * ~/.claude/tasks/<sessionId>/<n>.json is the session's live task list — the
 * same one the agent is working through. It answers "what is this agent trying
 * to accomplish", which no single event can.
 */

const cache = new Map(); // sessionId -> {mtimeMs, tasks}

export function available(dir = CLAUDE_TASKS) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function readTasks(sessionId, { dir = CLAUDE_TASKS } = {}) {
  const sessionDir = path.join(dir, sessionId);
  let st;
  try {
    st = fs.statSync(sessionDir);
  } catch {
    return null;
  }

  const hit = cache.get(sessionId);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.tasks;

  let names;
  try {
    names = fs.readdirSync(sessionDir);
  } catch {
    return null;
  }

  const tasks = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const t = safeJson(readSafe(path.join(sessionDir, name)));
    if (!t || !t.subject) continue;
    if (t.status === 'deleted') continue;
    tasks.push({
      id: String(t.id ?? path.basename(name, '.json')),
      subject: t.subject,
      activeForm: t.activeForm || null,
      status: t.status || 'pending',
      blockedBy: Array.isArray(t.blockedBy) ? t.blockedBy : [],
    });
  }
  tasks.sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));

  cache.set(sessionId, { mtimeMs: st.mtimeMs, tasks });
  return tasks;
}

export function summarizeTasks(tasks) {
  if (!tasks?.length) return null;
  const done = tasks.filter((t) => t.status === 'completed').length;
  const active = tasks.find((t) => t.status === 'in_progress');
  return {
    total: tasks.length,
    done,
    active: active ? active.activeForm || active.subject : null,
    activeId: active?.id || null,
  };
}

function readSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}
