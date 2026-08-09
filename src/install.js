import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE_SETTINGS, CLAUDE_DIR } from './paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const HOOK_SCRIPT = path.join(__dirname, 'hook.js');
export const APPROVE_SCRIPT = path.join(__dirname, 'approve-hook.js');

export const APPROVALS_EVENT = 'PermissionRequest';
/** Its own number, not the shared enrichment `timeout: 5`. This is only the
 *  backstop — the hook self-deadlines at 270 s and exits 0 first, because
 *  what a *cancelled* hook means is undocumented and we refuse to rely on it. */
export const APPROVALS_TIMEOUT_S = 300;
/** The Claude Code build the PermissionRequest behavior was verified against.
 *  What an older build does with an unknown hook event is untested, and an
 *  opt-in feature is not worth finding out on the operator's machine. */
export const MIN_CLAUDE_VERSION = '2.1.226';

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

export function approveCommand() {
  return `"${process.execPath}" "${APPROVE_SCRIPT}"`;
}

export function claudeVersionOk(versionString) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(versionString || ''));
  if (!m) return false;
  const [maj, min, pat] = m.slice(1).map(Number);
  const [fMaj, fMin, fPat] = MIN_CLAUDE_VERSION.split('.').map(Number);
  if (maj !== fMaj) return maj > fMaj;
  if (min !== fMin) return min > fMin;
  return pat >= fPat;
}

/** Anything we installed, however the path was spelled. */
function isOurs(entry) {
  const cmd = entry?.command || '';
  return cmd.includes(MARKER) || cmd.includes(HOOK_SCRIPT) || cmd.includes(APPROVE_SCRIPT);
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
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  // Beside the destination, not in os.tmpdir(): rename cannot cross a
  // filesystem, and /tmp is tmpfs on plenty of the Linux boxes this installs
  // on — there the write did not degrade to non-atomic, it threw EXDEV and
  // installed nothing. writeView() places its temp file the same way.
  const tmp = path.join(dir, `.${path.basename(file)}.cctv-${process.pid}.tmp`);
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

/**
 * The opt-in on top of the opt-in: `install --approvals` only. Deliberately
 * not part of HOOK_EVENTS — the enrichment hooks observe, this one decides,
 * and a plain `install` must never grow a decision channel by surprise.
 */
export function installApprovals({ file = CLAUDE_SETTINGS, command = approveCommand() } = {}) {
  const settings = readSettings(file);
  const backup = backupSettings(file);
  settings.hooks = settings.hooks || {};
  const groups = Array.isArray(settings.hooks[APPROVALS_EVENT]) ? settings.hooks[APPROVALS_EVENT] : [];
  for (const g of groups) {
    if (Array.isArray(g.hooks)) g.hooks = g.hooks.filter((h) => !isOurs(h));
  }
  const entry = { type: 'command', command, timeout: APPROVALS_TIMEOUT_S };
  const target = groups.find((g) => (g.matcher ?? null) === '*');
  if (target) {
    target.hooks = target.hooks || [];
    target.hooks.push(entry);
  } else {
    groups.push({ matcher: '*', hooks: [entry] });
  }
  settings.hooks[APPROVALS_EVENT] = groups.filter((g) => Array.isArray(g.hooks) && g.hooks.length);
  writeSettings(settings, file);
  return { file, backup, event: APPROVALS_EVENT, command };
}

export function approvalsInstalled({ file = CLAUDE_SETTINGS } = {}) {
  try {
    const groups = readSettings(file).hooks?.[APPROVALS_EVENT];
    return Array.isArray(groups) && groups.some((g) => Array.isArray(g.hooks) && g.hooks.some(isOurs));
  } catch {
    return false;
  }
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
    return {
      file,
      error: err.message,
      installed: [],
      missing: HOOK_EVENTS.map((h) => h.event),
      approvals: false,
    };
  }
  const installed = [];
  const missing = [];
  for (const { event } of HOOK_EVENTS) {
    const groups = settings.hooks?.[event];
    const has =
      Array.isArray(groups) && groups.some((g) => Array.isArray(g.hooks) && g.hooks.some(isOurs));
    (has ? installed : missing).push(event);
  }
  return { file, installed, missing, exists: fs.existsSync(file), approvals: approvalsInstalled({ file }) };
}

export function projectSettingsPath(cwd = process.cwd()) {
  return path.join(cwd, '.claude', 'settings.json');
}

export { CLAUDE_SETTINGS, CLAUDE_DIR };
