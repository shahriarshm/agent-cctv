#!/usr/bin/env node
import { spawn } from 'node:child_process';
import process from 'node:process';
import { start, newToken } from '../src/server.js';
import { Store } from '../src/store.js';
import { capabilities } from '../src/sources/claude-code/index.js';
import { capabilities as codexCaps } from '../src/sources/codex/index.js';
import { writeConfig, readConfig, DEFAULT_PORT, DEFAULT_HOST } from '../src/paths.js';
import * as installer from '../src/install.js';

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      args.flags[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : true);
    } else if (a.startsWith('-') && a.length > 1) {
      args.flags[a.slice(1)] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

const HELP = `
${c.bold('agent-cctv')} — a live wall of what your coding agents are doing

${c.bold('Usage')}
  agent-cctv [start]        Start the dashboard  ${c.dim('(default)')}
  agent-cctv status         What it can see, from the terminal
  agent-cctv install        Optional: add Claude Code hooks for instant events
  agent-cctv uninstall      Remove those hooks
  agent-cctv doctor         Check what agent-cctv can read on this machine

${c.bold('Options')}
  --port <n>       Port to serve on            ${c.dim(`(default ${DEFAULT_PORT})`)}
  --host <addr>    Bind address                ${c.dim(`(default ${DEFAULT_HOST}, loopback only)`)}
  --no-open        Don't open a browser
  --no-token       Skip the URL token          ${c.dim('(only if nothing else runs on this machine)')}
  --project        install/uninstall into ./.claude/settings.json instead of global

${c.dim('No installation is required to watch Claude Code — just run it.')}
`;

function openBrowser(url) {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' }).unref();
  } catch {}
}

async function cmdStart(flags) {
  const caps = capabilities();
  const codex = codexCaps();
  if (!caps.transcripts && !caps.registry && !codex.rollouts) {
    console.error(c.red('No agent data found at ~/.claude or ~/.codex.'));
    console.error(c.dim('Nothing to watch yet. Start a Claude Code or Codex session and try again.'));
    process.exitCode = 1;
    return;
  }

  const port = Number(flags.port) || DEFAULT_PORT;
  const host = flags.host || DEFAULT_HOST;
  const token = flags.token === false || flags['no-token'] ? null : newToken();

  let server;
  try {
    server = await start({ port, host, store: new Store(), token });
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(c.red(`Port ${port} is busy.`), c.dim('Is agent-cctv already running?'));
      console.error(c.dim(`Try: agent-cctv --port ${port + 1}`));
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  writeConfig({ port, host, token, startedAt: Date.now(), pid: process.pid });

  const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/${token ? `?token=${token}` : ''}`;
  console.log('');
  console.log(`  ${c.bold('agent-cctv')} ${c.dim('watching')}`);
  console.log(`  ${c.cyan(url)}`);
  console.log('');
  console.log(
    `  ${c.dim('claude code')}  ${caps.registry ? c.green('●') : c.yellow('○')} session registry   ` +
      `${caps.transcripts ? c.green('●') : c.yellow('○')} transcripts   ` +
      `${caps.tasks ? c.green('●') : c.yellow('○')} tasks`
  );
  console.log(
    `  ${c.dim('codex')}        ${codex.rollouts ? c.green('●') : c.yellow('○')} rollouts   ` +
      `${codex.index ? c.green('●') : c.yellow('○')} thread names   ` +
      `${c.dim('○ no registry — state inferred')}`
  );
  if (!caps.registry) {
    console.log(
      c.yellow('  ! No ~/.claude/sessions registry — falling back to transcript inference.')
    );
  }
  console.log(c.dim('  ctrl-c to stop'));
  console.log('');

  if (!flags['no-open'] && flags.open !== false) openBrowser(url);

  const shutdown = () => {
    console.log(c.dim('\n  stopping…'));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function cmdStatus() {
  const caps = capabilities();
  const { SessionRegistry } = await import('../src/sources/claude-code/registry.js');
  const reg = new SessionRegistry();
  reg.poll();
  const live = reg.list();

  console.log('');
  console.log(`  ${c.bold('agent-cctv')} ${c.dim('· ' + live.length + ' live session(s)')}`);
  console.log('');
  if (!live.length) {
    console.log(c.dim('  No Claude Code sessions running.'));
  }
  for (const s of live) {
    const dot =
      s.status === 'busy' ? c.green('●') : s.status === 'waiting' ? c.yellow('●') : c.dim('●');
    const where = s.cwd.replace(process.env.HOME, '~');
    console.log(`  ${dot} ${c.bold(s.name || s.sessionId.slice(0, 8))}  ${c.dim(where)}`);
    console.log(
      `    ${s.status}${s.waitingFor ? c.yellow(` — ${s.waitingFor}`) : ''}  ${c.dim(`pid ${s.pid} · v${s.version}`)}`
    );
  }

  const hooks = installer.status();
  console.log('');
  console.log(
    `  ${c.dim('sources:')} registry ${caps.registry ? c.green('yes') : c.red('no')} · ` +
      `transcripts ${caps.transcripts ? c.green('yes') : c.red('no')} · ` +
      `tasks ${caps.tasks ? c.green('yes') : c.red('no')} · ` +
      `codex ${codexCaps().rollouts ? c.green('yes') : c.red('no')} · ` +
      `hooks ${hooks.installed.length ? c.green(`${hooks.installed.length}/9`) : c.dim('not installed (optional)')}`
  );
  const cfg = readConfig();
  if (cfg.port) console.log(`  ${c.dim(`last served on http://${cfg.host || DEFAULT_HOST}:${cfg.port}`)}`);
  console.log('');
}

function cmdInstall(flags) {
  const file = flags.project ? installer.projectSettingsPath() : installer.CLAUDE_SETTINGS;
  try {
    const r = installer.install({ file });
    console.log('');
    console.log(`  ${c.green('✓')} hooks installed into ${c.bold(r.file.replace(process.env.HOME, '~'))}`);
    if (r.backup) console.log(`  ${c.dim('backup: ' + r.backup.replace(process.env.HOME, '~'))}`);
    console.log(`  ${c.dim(r.events.join(', '))}`);
    console.log('');
    console.log(c.dim('  Hooks are optional — agent-cctv already reads Claude Code state directly.'));
    console.log(c.dim('  They add sub-second tool events, at a small latency cost per tool call.'));
    console.log(c.dim('  Restart running Claude Code sessions to pick them up.'));
    console.log('');
  } catch (err) {
    console.error(c.red('  ✗ ' + err.message));
    process.exitCode = 1;
  }
}

function cmdUninstall(flags) {
  const file = flags.project ? installer.projectSettingsPath() : installer.CLAUDE_SETTINGS;
  try {
    const r = installer.uninstall({ file });
    console.log(
      r.removed
        ? `  ${c.green('✓')} removed ${r.removed} hook(s) from ${r.file.replace(process.env.HOME, '~')}`
        : `  ${c.dim('nothing to remove')}`
    );
  } catch (err) {
    console.error(c.red('  ✗ ' + err.message));
    process.exitCode = 1;
  }
}

function cmdDoctor() {
  const caps = capabilities();
  const codex = codexCaps();
  const rows = [
    ['~/.claude/sessions', caps.registry, 'live status, pid, cwd (authoritative)'],
    ['~/.claude/projects', caps.transcripts, 'activity stream'],
    ['~/.claude/tasks', caps.tasks, 'per-session task lists'],
    ['~/.codex/sessions', codex.rollouts, 'codex activity (no status — state inferred)'],
    ['~/.codex/session_index', codex.index, 'codex thread names'],
  ];
  console.log('');
  for (const [pathName, ok, why] of rows) {
    console.log(`  ${ok ? c.green('✓') : c.red('✗')} ${pathName.padEnd(22)} ${c.dim(why)}`);
  }
  const hooks = installer.status();
  console.log(
    `  ${hooks.installed.length ? c.green('✓') : c.dim('–')} hooks${' '.repeat(18)} ${c.dim(
      hooks.installed.length ? hooks.installed.join(', ') : 'not installed (optional)'
    )}`
  );
  console.log('');
  if (!caps.registry) {
    console.log(
      c.yellow('  The session registry is missing. This is an undocumented Claude Code internal;')
    );
    console.log(c.yellow('  a version change may have moved it. Transcript inference still works,'));
    console.log(c.yellow('  but "waiting for permission" will be less accurate.'));
    console.log('');
  }
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] || 'start';

if (args.flags.help || args.flags.h || cmd === 'help') {
  console.log(HELP);
} else if (cmd === 'start') {
  await cmdStart(args.flags);
} else if (cmd === 'status') {
  await cmdStatus();
} else if (cmd === 'install') {
  cmdInstall(args.flags);
} else if (cmd === 'uninstall') {
  cmdUninstall(args.flags);
} else if (cmd === 'doctor') {
  cmdDoctor();
} else {
  console.error(`Unknown command: ${cmd}`);
  console.log(HELP);
  process.exitCode = 1;
}
