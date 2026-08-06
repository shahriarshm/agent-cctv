#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { start } from '../src/server.js';
import { Tunnel } from '../src/tunnel.js';
import { Store } from '../src/store.js';
import { resolve, validate, ConfigError } from '../src/config.js';
import { capabilities } from '../src/sources/claude-code/index.js';
import { capabilities as codexCaps } from '../src/sources/codex/index.js';
import { capabilities as geminiCaps } from '../src/sources/gemini/index.js';
import { capabilities as opencodeCaps } from '../src/sources/opencode/index.js';
import { capabilities as hermesCaps } from '../src/sources/hermes/index.js';
import { writeConfig, readConfig, CONFIG_FILE, DEFAULT_PORT, DEFAULT_HOST } from '../src/paths.js';
import * as installer from '../src/install.js';
import { loadViews } from '../src/views.js';

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

// These never take a value, so a bare mention always means true — regardless
// of what follows on the command line. Without this list, `--no-open start`
// consumes "start" as --no-open's value (flags['no-open'] = 'start'), which
// is truthy but not === true, so the strict boolean check in resolve() misses
// it and a browser opens anyway; `--no-token start` mints a token instead of
// disabling it the same way; and either one leaves the subcommand unparsed,
// so args._ is empty and `cmd` silently falls back to its "start" default —
// masking the bug rather than surfacing it for anything but "start" itself.
const BOOLEAN_FLAGS = new Set(['no-open', 'no-token', 'project', 'help', 'yes']);

// The mirror of the list above: flags whose value may begin with a dash. The
// generic rule below refuses one — sensible for `--host`, wrong for
// `--tunnel-args '--region us'`, where forwarding another program's flags is
// the entire point. Without this list that value is lost and `--region`
// becomes a flag of ours, which reads as agent-cctv not supporting a provider
// option rather than as a parser bug.
//
// "May begin with a dash" and not "always takes the next token": `--host
// --no-open` must still refuse rather than treat --no-open as a hostname, and
// bin's own test suite appends --no-open to every case, so the greedy version
// turned three existing refusal tests into a DNS lookup for "--no-open".
const VALUE_FLAGS = new Set([
  'port',
  'host',
  'public-url',
  'tunnel',
  'tunnel-args',
  'tunnel-cmd',
  'tunnel-ttl',
]);

/** A token that is one of our own flags, and so never somebody else's value. */
function isOurFlag(token) {
  if (typeof token !== 'string' || !token.startsWith('--')) return false;
  const key = token.slice(2).split('=')[0];
  return BOOLEAN_FLAGS.has(key) || VALUE_FLAGS.has(key);
}

export function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      // Split on the FIRST = only. `--tunnel-args=--log=stdout` is one value
      // with an = in it; destructuring [k, v] out of split('=') silently threw
      // away everything after the second one and passed `--log` to ngrok.
      const body = a.slice(2);
      const eq = body.indexOf('=');
      const k = eq < 0 ? body : body.slice(0, eq);
      const v = eq < 0 ? undefined : body.slice(eq + 1);
      if (BOOLEAN_FLAGS.has(k)) args.flags[k] = v ?? true;
      else if (v !== undefined) args.flags[k] = v;
      else if (VALUE_FLAGS.has(k))
        args.flags[k] = argv[i + 1] !== undefined && !isOurFlag(argv[i + 1]) ? argv[++i] : true;
      else args.flags[k] = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : true;
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
  agent-cctv views          List the view presets it can see
  agent-cctv install        Optional: add Claude Code hooks for instant events
  agent-cctv uninstall      Remove those hooks
  agent-cctv doctor         Check what agent-cctv can read on this machine

${c.bold('Options')}
  --port <n>       Port to serve on            ${c.dim(`(default ${DEFAULT_PORT})`)}
  --host <addr>    Bind address                ${c.dim(`(default ${DEFAULT_HOST}, loopback only)`)}
  --no-open        Don't open a browser
  --no-token       Skip the URL token          ${c.dim('(only if nothing else runs on this machine)')}
  --public-url <url>  Public URL when behind a reverse proxy ${c.dim('(adds its host to the allowlist)')}
  --project        install/uninstall into ./.claude/settings.json instead of global

${c.bold('Publishing')} ${c.dim('— puts the dashboard on the public internet')}
  --tunnel <name>     Publish through ${c.bold('cloudflare')} or ${c.bold('ngrok')} ${c.dim('(the binary must be installed)')}
  --tunnel-cmd <cmd>  Publish through any command that opens a tunnel
  --tunnel-args <a>   Extra arguments for the provider binary
  --tunnel-ttl <30m>  Close the tunnel after this long ${c.dim('(the wall keeps running)')}
  --yes               Skip the confirmation ${c.dim('(required when not on a terminal)')}

${c.dim('No installation is required to watch Claude Code — just run it.')}

${c.bold('Environment')}
  AGENT_CCTV_TOKEN       Stable token, 16+ chars ${c.dim('(otherwise a random one per run)')}
  AGENT_CCTV_PUBLIC_URL  Public URL when behind a reverse proxy
  AGENT_CCTV_HOST        Bind address
  AGENT_CCTV_PORT        Port
  AGENT_CCTV_VIEWS_DIR   Where view presets are read from ${c.dim('(default ~/.agent-cctv/views)')}
  AGENT_CCTV_TUNNEL      Same as --tunnel
  AGENT_CCTV_TUNNEL_ARGS Same as --tunnel-args
`;

function openBrowser(url) {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' }).unref();
  } catch {}
}

/**
 * The one place a person is asked.
 *
 * Everything else about publishing is mechanism; this is the part that makes
 * it a decision rather than a typo. --yes skips it, and validate() has already
 * refused a non-TTY that did not pass --yes, so reaching here means there is
 * somebody to answer.
 */
async function confirmPublish(cfg) {
  if (cfg.assumeYes) return true;
  const how = cfg.tunnel ? `${cfg.tunnel} · ${cfg.tunnel === 'ngrok' ? 'ngrok' : 'cloudflared'}` : cfg.tunnelCmd;
  console.log('');
  console.log(`  ${c.yellow('This publishes the dashboard on the public internet.')}`);
  console.log('');
  console.log('  Anyone with the link and its token can read every session on this');
  console.log('  machine — including the source code your agents are working on.');
  console.log('');
  console.log(`  ${c.dim('through')}      ${how}`);
  console.log(`  ${c.dim('guarded by')}   a ${cfg.token.length}-character token, carried in the link`);
  console.log('');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // 'close' as well as an answer: validate() gates on stdout being a terminal,
  // and stdin can be closed while stdout is not (`agent-cctv --tunnel … <
  // /dev/null`). question()'s callback never fires on EOF, so waiting only on
  // it hangs the process forever with a prompt on screen. EOF is not "yes".
  const answer = await new Promise((r) => {
    rl.question(`  Type ${c.bold('yes')} to publish: `, r);
    rl.once('close', () => r(''));
  });
  rl.close();
  return answer.trim().toLowerCase() === 'yes';
}

async function cmdStart(flags) {
  const caps = capabilities();
  const others = [codexCaps().rollouts, geminiCaps().chats, opencodeCaps().db, hermesCaps().db];
  if (!caps.transcripts && !caps.registry && !others.some(Boolean)) {
    console.error(c.red('No agent data found (~/.claude, ~/.codex, ~/.gemini, opencode, ~/.hermes).'));
    console.error(c.dim('Nothing to watch yet. Start an agent session and try again.'));
    process.exitCode = 1;
    return;
  }

  let cfg;
  try {
    for (const name of ['host', 'port', 'public-url', 'tunnel', 'tunnel-cmd', 'tunnel-args', 'tunnel-ttl']) {
      if (flags[name] === true || flags[name] === '') {
        throw new ConfigError(`--${name} requires a value.`);
      }
    }
    cfg = validate(resolve({ flags }));
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error('');
    console.error(`  ${c.red('✗')} ${err.message}`);
    console.error('');
    process.exitCode = 1;
    return;
  }
  const { port, host, token } = cfg;

  // Asked before anything binds, so declining leaves no trace at all.
  if ((cfg.tunnel || cfg.tunnelCmd) && !(await confirmPublish(cfg))) {
    console.log(c.dim('\n  Nothing was published. Run without --tunnel for the local wall.\n'));
    return;
  }

  let server;
  try {
    server = await start({
      port,
      host,
      store: new Store(),
      token,
      allowedHosts: cfg.allowedHosts,
      secureCookie: cfg.secureCookie,
    });
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(c.red(`Port ${port} is busy.`), c.dim('Is agent-cctv already running?'));
      console.error(c.dim(`Try: agent-cctv --port ${port + 1}`));
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  // Convenience state only (`status`'s "last served on" line, and the
  // optional hook reporter's token lookup) — never worth taking a running
  // server down for. A read-only home (e.g. systemd's ProtectSystem=strict
  // without AGENT_CCTV_HOME redirected) must not crash-loop the process.
  try {
    writeConfig({ port, host, token, startedAt: Date.now(), pid: process.pid });
  } catch (err) {
    console.error(c.dim(`  could not write ${CONFIG_FILE} (${err.message}) — continuing without it`));
  }

  // Started after the bind, so it points at the port actually taken rather
  // than the one requested — and after writeConfig, so a tunnel failure cannot
  // leave the state file describing a run that never happened.
  let tunnel = null;
  let publicBase = null;
  if (cfg.tunnel || cfg.tunnelCmd) {
    tunnel = new Tunnel({
      provider: cfg.tunnel,
      cmd: cfg.tunnelCmd,
      args: cfg.tunnelArgs,
      port,
      host,
      publicUrl: cfg.publicUrlRaw,
      timeoutMs: Number(process.env.AGENT_CCTV_TUNNEL_TIMEOUT_MS) || undefined,
    });
    try {
      const published = await tunnel.start();
      server.setTunnel({
        host: published.host,
        provider: cfg.tunnel || 'custom',
        url: published.url,
        since: Date.now(),
      });
      publicBase = published.url.endsWith('/') ? published.url : published.url + '/';
    } catch (err) {
      // A failure *before* publishing means the thing the operator asked for
      // did not happen and nothing is exposed — so it is an exit, and a
      // supervisor should see one. A failure after is the opposite case; see
      // the exit handler below.
      tunnel.stop();
      server.close();
      console.error('');
      console.error(`  ${c.red('✗')} ${err.message}`);
      console.error('');
      process.exitCode = 1;
      return;
    }

    // Not a restart. A re-opened quick tunnel comes back on a different
    // hostname, so retrying cannot revive the link anybody was already sent —
    // it would only mint a second one nobody has. The wall keeps running,
    // because there may well be someone watching it.
    tunnel.on('exit', (info) => {
      server.setTunnel(null);
      console.log('');
      console.log(
        `  ${c.yellow('!')} the tunnel closed${info.code == null ? '' : ` (code ${info.code})`} — that link is dead now.`
      );
      console.log(c.dim('  the wall is still running locally. re-run with --tunnel to publish again.'));
      console.log('');
    });

    if (cfg.tunnelTtlMs) {
      setTimeout(() => {
        console.log(c.dim('\n  --tunnel-ttl reached — closing the tunnel. The wall stays up.\n'));
        server.setTunnel(null);
        tunnel.stop();
      }, cfg.tunnelTtlMs).unref();
    }
  }

  const local = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`;
  const rawBase = cfg.publicUrlRaw || local;
  // Normalise to a trailing slash before appending a query string — publicUrlRaw
  // is operator-typed (e.g. "https://cctv.corp.example", no trailing slash) and
  // "https://cctv.corp.example?token=…" is missing the "/" a browser inserts
  // silently but a person handing the link out sees as broken.
  const base = rawBase.endsWith('/') ? rawBase : rawBase + '/';
  // Two different URLs, on purpose. A token that came from AGENT_CCTV_TOKEN is
  // the operator's to distribute — printing it in the banner just puts it in
  // the systemd journal too, readable by more people than "whoever could ssh
  // here". But the tab this process opens for *itself* is not a log: it still
  // needs the token, or it lands on a bare "/" with no cookie yet and hits the
  // "no credential" wall the SPA shows for a missing one. A freshly minted
  // token has no other channel than the banner, so it still prints in full.
  const tokenedUrl = base + (token ? `?token=${token}` : '');
  const showTokenInBanner = token && !cfg.tokenFromEnv;
  const bannerUrl = base + (showTokenInBanner ? `?token=${token}` : '');
  console.log('');
  console.log(`  ${c.bold('agent-cctv')} ${c.dim('watching')}`);
  console.log(`  ${c.cyan(bannerUrl)}`);
  if (token && cfg.tokenFromEnv) {
    console.log(`  ${c.dim('token from AGENT_CCTV_TOKEN — share it out of band, not this URL')}`);
  }
  // Two lines, on purpose. The bare URL is the one to say out loud; the
  // tokened one is a bearer credential that survives being pasted into a
  // channel, and printing them together invites the wrong one being copied.
  if (publicBase) {
    console.log('');
    console.log(`  ${c.yellow('public')}  ${c.cyan(publicBase)}`);
    console.log(c.dim('  send this one — with its token — to one person, not a channel:'));
    console.log(`  ${c.dim(publicBase + (token ? `?token=${token}` : ''))}`);
    if (cfg.tunnel === 'ngrok') {
      console.log(c.dim('  ngrok free shows a click-through page first; the link still works after it.'));
    }
  }
  console.log('');
  console.log(
    `  ${c.dim('claude code')}  ${caps.registry ? c.green('●') : c.yellow('○')} session registry   ` +
      `${caps.transcripts ? c.green('●') : c.yellow('○')} transcripts   ` +
      `${caps.tasks ? c.green('●') : c.yellow('○')} tasks`
  );
  const codex = codexCaps();
  console.log(
    `  ${c.dim('codex')}        ${codex.rollouts ? c.green('●') : c.yellow('○')} rollouts   ` +
      `${codex.index ? c.green('●') : c.yellow('○')} thread names   ` +
      `${c.dim('○ no registry — state inferred')}`
  );
  const opencode = opencodeCaps();
  const hermes = hermesCaps();
  // A dot per agent found; the ones this machine has never run stay quiet.
  const sqliteDot = (o) => (o.db && o.sqlite ? c.green('●') : o.db ? c.yellow('○') : c.dim('○'));
  console.log(
    `  ${c.dim('others')}       ${geminiCaps().chats ? c.green('●') : c.dim('○')} gemini   ` +
      `${sqliteDot(opencode)} opencode   ` +
      `${sqliteDot(hermes)} hermes` +
      ((opencode.db && opencode.sqlite === false) || (hermes.db && hermes.sqlite === false)
        ? c.yellow('   ! node:sqlite needs Node ≥ 22.13')
        : '')
  );
  if (!caps.registry) {
    console.log(
      c.yellow('  ! No ~/.claude/sessions registry — falling back to transcript inference.')
    );
  }
  console.log(c.dim('  ctrl-c to stop'));
  console.log('');

  if (cfg.openBrowser) openBrowser(tokenedUrl);

  const shutdown = () => {
    console.log(c.dim('\n  stopping…'));
    // Before the server, and explicitly: a provider binary shares our process
    // group and would usually get the same ctrl-c, but --tunnel-cmd's real
    // tunnel is a grandchild that would otherwise keep forwarding to a port
    // nothing is listening on.
    tunnel?.stop();
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
      `gemini ${geminiCaps().chats ? c.green('yes') : c.red('no')} · ` +
      `opencode ${opencodeCaps().db ? c.green('yes') : c.red('no')} · ` +
      `hermes ${hermesCaps().db ? c.green('yes') : c.red('no')} · ` +
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
  const gemini = geminiCaps();
  const opencode = opencodeCaps();
  const hermes = hermesCaps();
  /** A database we can see but this Node cannot read deserves its own words. */
  const sqliteWhy = (o, what) =>
    o.db && o.sqlite === false ? `${what} found, but node:sqlite needs Node ≥ 22.13` : `${what} (no status — state inferred)`;
  const rows = [
    ['~/.claude/sessions', caps.registry, 'live status, pid, cwd (authoritative)'],
    ['~/.claude/projects', caps.transcripts, 'activity stream'],
    ['~/.claude/tasks', caps.tasks, 'per-session task lists'],
    ['~/.codex/sessions', codex.rollouts, 'codex activity (no status — state inferred)'],
    ['~/.codex/session_index', codex.index, 'codex thread names'],
    ['~/.gemini/tmp', gemini.chats, 'gemini chats (no status — state inferred)'],
    ['opencode.db', opencode.db && opencode.sqlite !== false, sqliteWhy(opencode, 'opencode sessions')],
    ['~/.hermes/state.db', hermes.db && hermes.sqlite !== false, sqliteWhy(hermes, 'hermes sessions')],
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
  const views = loadViews();
  console.log(
    `  ${views.errors.length ? c.red('✗') : views.views.length ? c.green('✓') : c.dim('–')} ` +
      `${'~/.agent-cctv/views'.padEnd(22)} ${c.dim(
        views.errors.length
          ? `${views.views.length} view(s), ${views.errors.length} failed — run: agent-cctv views`
          : views.views.length
            ? `${views.views.length} view(s)`
            : 'no view presets (optional)'
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

/** Printed when the directory is empty — the whole feature in five lines. */
const STARTER = `name: Needs me
order: 10
match:
  state: attention
`;

/**
 * What loaded, where it looked, and what broke.
 *
 * This is the whole discoverability story for a feature that writes nothing:
 * agent-cctv never creates a view file, so the terminal has to be the thing
 * that says where they go and what one looks like.
 */
function cmdViews() {
  const { dir, views, errors } = loadViews();
  const home = (p) => p.replace(process.env.HOME, '~');
  console.log('');
  console.log(`  ${c.bold('views')} ${c.dim('· ' + home(dir))}`);
  console.log('');

  for (const v of views) {
    const bits = [];
    for (const [field, value] of Object.entries(v.match || {})) {
      if (field === 'exclude') continue;
      bits.push(`${field} ${[].concat(value).join(' | ')}`);
    }
    if (v.match?.exclude) bits.push(`not ${Object.keys(v.match.exclude).join(', ')}`);
    if (v.groupBy) bits.push(`grouped by ${v.groupBy}`);
    if (v.mode && v.mode !== 'wall') bits.push(`${v.mode} mode`);
    console.log(`  ${c.green('●')} ${c.bold(v.name)} ${c.dim(`(${v.id})`)}`);
    console.log(`    ${c.dim(bits.join('  ·  ') || 'everything')}`);
  }

  for (const e of errors) {
    console.log(`  ${c.red('✗')} ${c.bold(e.file)}${e.line ? c.dim(':' + e.line) : ''}`);
    console.log(`    ${c.red(e.message)}`);
  }

  if (!views.length && !errors.length) {
    console.log(c.dim('  No views yet. A view is a file; this one puts the blocked'));
    console.log(c.dim('  sessions on the wall and nothing else:'));
    console.log('');
    console.log(c.dim(`    mkdir -p ${home(dir)}`));
    console.log(c.dim(`    $EDITOR ${home(dir)}/needs-me.yaml`));
    console.log('');
    for (const line of STARTER.trimEnd().split('\n')) console.log(`    ${c.cyan(line)}`);
  }
  console.log('');
}

async function main() {
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
  } else if (cmd === 'views') {
    cmdViews();
  } else if (cmd === 'doctor') {
    cmdDoctor();
  } else {
    console.error(`Unknown command: ${cmd}`);
    console.log(HELP);
    process.exitCode = 1;
  }
}

// Importing this file must not start a server — test/args.test.js imports it
// for parseArgs alone. `import.meta.main` is Node 24+; comparing argv[1] to
// this module's own path is the spelling that works on the ≥18 this supports.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
