import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const HOME = os.homedir();

/** Where agent-cctv keeps its own state. Overridable for tests. */
export const ROOT = process.env.AGENT_CCTV_HOME || path.join(HOME, '.agent-cctv');
export const CONFIG_FILE = path.join(ROOT, 'config.json');
export const EVENTS_DIR = path.join(ROOT, 'events');
export const SPOOL_FILE = path.join(ROOT, 'spool.jsonl');

/**
 * Where view presets are read from — and only ever read. Under the shipped
 * systemd unit this lands in /var/lib/agent-cctv/views, where one directory of
 * views is shared by everyone on the box, which is the right default there.
 */
export const VIEWS_DIR = process.env.AGENT_CCTV_VIEWS_DIR || path.join(ROOT, 'views');

/**
 * Claude Code's own state, which agent-cctv reads but never writes.
 * These are undocumented internals — everything that touches them is behind
 * the claude-code source adapter and capability-checked at startup.
 */
export const CLAUDE_DIR = process.env.AGENT_CCTV_CLAUDE_DIR || path.join(HOME, '.claude');
export const CLAUDE_SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
export const CLAUDE_PROJECTS = path.join(CLAUDE_DIR, 'projects');
export const CLAUDE_SESSIONS = path.join(CLAUDE_DIR, 'sessions');
export const CLAUDE_TASKS = path.join(CLAUDE_DIR, 'tasks');

/**
 * Codex CLI's state. Same deal as Claude's: undocumented, read-only, and behind
 * the codex source adapter. Codex keeps no session registry, so this is
 * rollouts and a thread index and nothing that says who is running.
 */
export const CODEX_DIR = process.env.AGENT_CCTV_CODEX_DIR || path.join(HOME, '.codex');
export const CODEX_SESSIONS = path.join(CODEX_DIR, 'sessions');
export const CODEX_INDEX = path.join(CODEX_DIR, 'session_index.jsonl');

export const DEFAULT_PORT = 4599;
export const DEFAULT_HOST = '127.0.0.1';

export function ensureDirs() {
  fs.mkdirSync(ROOT, { recursive: true });
}

export function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function writeConfig(patch) {
  ensureDirs();
  const next = { ...readConfig(), ...patch };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return next;
}

export function resolvePort() {
  return Number(process.env.AGENT_CCTV_PORT) || readConfig().port || DEFAULT_PORT;
}

export function eventLogPath(date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  return path.join(EVENTS_DIR, `events-${day}.jsonl`);
}
