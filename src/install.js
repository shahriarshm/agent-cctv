import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { CLAUDE_SETTINGS, CLAUDE_DIR } from './paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const HOOK_SCRIPT = path.join(__dirname, 'hook.js');

/** Every event we listen to, and whether Claude Code expects a tool matcher. */
export const HOOK_EVENTS = [
  { event: 'SessionStart', matcher: null },
  { event: 'UserPromptSubmit', matcher: null },
  { event: 'PreToolUse', matcher: '*' },
  { event: 'PostToolUse', matcher: '*' },
  { event: 'Notification', matcher: null },
  { event: 'Stop', matcher: null },
  { event: 'SubagentStop', matcher: null },
  { event: 'PreCompact', matcher: null },
  { event: 'SessionEnd', matcher: null },
];

const MARKER = 'agent-cctv';

export function hookCommand() {
  const node = process.execPath;
  return `"${node}" "${HOOK_SCRIPT}"`;
}

/** Anything we installed, however the path was spelled. */
function isOurs(entry) {
  const cmd = entry?.command || '';
  return cmd.includes(MARKER) || cmd.includes(HOOK_SCRIPT);
}

export function readSettings(file = CLAUDE_SETTINGS) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    throw new Error('settings.json is not an object');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    // A malformed settings file is the user's problem, not ours to overwrite.
    throw new Error(`Cannot parse ${file}: ${err.message}`);
  }
}

/** Write via temp+rename so a crash or a concurrent reader never sees half a file. */
export function writeSettings(settings, file = CLAUDE_SETTINGS) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(os.tmpdir(), `cctv-settings-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function backupSettings(file = CLAUDE_SETTINGS) {
  if (!fs.existsSync(file)) return null;
  const dest = `${file}.agent-cctv-backup`;
  if (!fs.existsSync(dest)) fs.copyFileSync(file, dest);
  return dest;
}

export function install({ file = CLAUDE_SETTINGS, command = hookCommand(), timeout = 5 } = {}) {
  const settings = readSettings(file);
  const backup = backupSettings(file);
  settings.hooks = settings.hooks || {};

  const added = [];
  for (const { event, matcher } of HOOK_EVENTS) {
    const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    // Drop any previous install of ours (path may have changed between versions).
    for (const g of groups) {
      if (Array.isArray(g.hooks)) g.hooks = g.hooks.filter((h) => !isOurs(h));
    }
    const entry = { type: 'command', command, timeout };
    const target = groups.find((g) => (g.matcher ?? null) === matcher);
    if (target) {
      target.hooks = target.hooks || [];
      target.hooks.push(entry);
    } else {
      groups.push(matcher ? { matcher, hooks: [entry] } : { hooks: [entry] });
    }
    settings.hooks[event] = groups.filter((g) => Array.isArray(g.hooks) && g.hooks.length);
    added.push(event);
  }

  writeSettings(settings, file);
  return { file, backup, events: added, command };
}

export function uninstall({ file = CLAUDE_SETTINGS } = {}) {
  if (!fs.existsSync(file)) return { file, removed: 0 };
  const settings = readSettings(file);
  if (!settings.hooks) return { file, removed: 0 };

  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!Array.isArray(g.hooks)) continue;
      const before = g.hooks.length;
      g.hooks = g.hooks.filter((h) => !isOurs(h));
      removed += before - g.hooks.length;
    }
    // Leave the user's own groups alone; only clear ones we emptied.
    settings.hooks[event] = groups.filter((g) => !Array.isArray(g.hooks) || g.hooks.length);
    if (!settings.hooks[event].length) delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;

  if (removed) writeSettings(settings, file);
  return { file, removed };
}

export function status({ file = CLAUDE_SETTINGS } = {}) {
  let settings;
  try {
    settings = readSettings(file);
  } catch (err) {
    return { file, error: err.message, installed: [], missing: HOOK_EVENTS.map((h) => h.event) };
  }
  const installed = [];
  const missing = [];
  for (const { event } of HOOK_EVENTS) {
    const groups = settings.hooks?.[event];
    const has =
      Array.isArray(groups) && groups.some((g) => Array.isArray(g.hooks) && g.hooks.some(isOurs));
    (has ? installed : missing).push(event);
  }
  return { file, installed, missing, exists: fs.existsSync(file) };
}

export function projectSettingsPath(cwd = process.cwd()) {
  return path.join(cwd, '.claude', 'settings.json');
}

export { CLAUDE_SETTINGS, CLAUDE_DIR };
