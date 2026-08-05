import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'bin', 'cctv.js');

/**
 * Spawns `bin/cctv.js start <args> --no-open` with its own throwaway
 * AGENT_CCTV_HOME and AGENT_CCTV_CLAUDE_DIR.
 *
 * AGENT_CCTV_HOME matters because cmdStart() calls writeConfig() on a
 * successful start, and reads a stale port back out of it on the next run —
 * without an isolated home, running this suite against a developer's real
 * ~/.agent-cctv/config.json would leak state between runs (this bit the
 * reviewer during manual testing of this exact fix).
 *
 * AGENT_CCTV_CLAUDE_DIR matters because cmdStart() bails out early with a
 * "No agent data found" message — a different, unrelated exit path — unless
 * it can see *something* under ~/.claude. A fake `projects` directory is
 * enough to satisfy that check without touching the real one.
 */
function run(args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cctv-cli-home-'));
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cctv-cli-claude-'));
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });
  try {
    const env = { ...process.env, AGENT_CCTV_HOME: home, AGENT_CCTV_CLAUDE_DIR: claudeDir };
    // Never let a variable from the invoking shell mask the case under test.
    delete env.AGENT_CCTV_TOKEN;
    delete env.AGENT_CCTV_HOST;
    delete env.AGENT_CCTV_PORT;
    delete env.AGENT_CCTV_PUBLIC_URL;
    return spawnSync(process.execPath, [CLI, 'start', ...args, '--no-open'], {
      encoding: 'utf8',
      env,
      timeout: 10_000,
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  }
}

/** [label, argv, the flag name expected in the refusal message] */
const CASES = [
  ['--host with no value', ['--host'], '--host'],
  ['--host= (empty value)', ['--host='], '--host'],
  ['--port with no value', ['--port'], '--port'],
  ['--port= (empty value)', ['--port='], '--port'],
  ['--public-url with no value', ['--public-url'], '--public-url'],
  ['--public-url= (empty value)', ['--public-url='], '--public-url'],
];

for (const [label, args, flagName] of CASES) {
  test(`${label} is refused with a ConfigError, not silently accepted`, () => {
    const r = run(args);
    assert.notEqual(r.status, 0, `expected a non-zero exit; got ${r.status}\nstderr: ${r.stderr}`);
    // flagName (e.g. "--host") has no characters that need regex-escaping.
    assert.match(r.stderr, new RegExp(`${flagName} requires a value`));
    // The "no agent data found" early-exit is a different refusal — make sure
    // that isn't what we actually tripped.
    assert.doesNotMatch(r.stderr, /No agent data found/);
  });
}

test('a well-formed --host value is not mistaken for a missing one', () => {
  // Regression guard against an over-broad match: a real value that goes on
  // to be refused for an unrelated reason (public bind with no token) must be
  // refused for THAT reason, never "requires a value". Chosen because it
  // fails fast inside validate(), unlike a successful start, which would
  // hang here until SIGINT/timeout.
  const r = run(['--host', '0.0.0.0', '--no-token']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--no-token cannot be combined/);
  assert.doesNotMatch(r.stderr, /requires a value/);
});

/** Polls `predicate` until it's true or `timeoutMs` elapses. */
function waitFor(predicate, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (predicate()) return resolvePromise();
      if (Date.now() > deadline) return reject(new Error('timed out waiting for condition'));
      setTimeout(tick, 50);
    };
    tick();
  });
}

test('an unwritable AGENT_CCTV_HOME (e.g. systemd ProtectSystem=strict without the state dir redirected) does not crash the server', async () => {
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cctv-cli-claude-'));
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });

  // A directory whose PARENT is a regular file makes any mkdir/write under it
  // fail with ENOTDIR, reliably and without root — the same shape of failure
  // ProtectSystem=strict produces by making the home directory read-only.
  const blockerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cctv-cli-blocker-'));
  const blockerFile = path.join(blockerDir, 'not-a-directory');
  fs.writeFileSync(blockerFile, '');
  const home = path.join(blockerFile, 'agent-cctv-home');

  const port = 20000 + (process.pid % 10000);
  const env = { ...process.env, AGENT_CCTV_HOME: home, AGENT_CCTV_CLAUDE_DIR: claudeDir };
  delete env.AGENT_CCTV_TOKEN;
  delete env.AGENT_CCTV_HOST;
  delete env.AGENT_CCTV_PORT;
  delete env.AGENT_CCTV_PUBLIC_URL;

  const child = spawn(process.execPath, [CLI, 'start', '--port', String(port), '--no-open'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));

  try {
    // "watching" is only printed after the socket is bound and the (now
    // non-fatal) writeConfig() call has run — proof the process survived it.
    await waitFor(() => /watching/.test(stdout) || child.exitCode !== null, 5000);
    assert.equal(
      child.exitCode,
      null,
      `process exited early instead of serving (code ${child.exitCode})\nstdout: ${stdout}\nstderr: ${stderr}`
    );

    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);

    // The failure was reported, not silently swallowed.
    assert.match(stderr, /could not write/);
    assert.match(stderr, /ENOTDIR/);
  } finally {
    child.kill();
    fs.rmSync(claudeDir, { recursive: true, force: true });
    fs.rmSync(blockerDir, { recursive: true, force: true });
  }
});

/* ── boolean flags must not be order-sensitive (finding 9) ───────────────── */

test('a boolean flag before the subcommand does not swallow it as its value', () => {
  // Before the fix, `--no-token status` had `--no-token` consume "status" as
  // its value (flags['no-token'] = 'status'), leaving args._ empty — `cmd`
  // then silently fell back to its "start" default instead of running
  // `status`. This would run cmdStart() (which binds a port and never
  // returns) where the caller asked for cmdStatus() (which prints and exits).
  // Using "status" rather than "start" makes the wrong dispatch observable
  // without needing to wait on a live server.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cctv-cli-home-'));
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cctv-cli-claude-'));
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });
  try {
    const env = { ...process.env, AGENT_CCTV_HOME: home, AGENT_CCTV_CLAUDE_DIR: claudeDir };
    delete env.AGENT_CCTV_TOKEN;
    const r = spawnSync(process.execPath, [CLI, '--no-token', 'status'], {
      encoding: 'utf8',
      env,
      timeout: 10_000,
    });
    assert.equal(r.status, 0, `expected a clean exit; stderr: ${r.stderr}`);
    // cmdStatus()'s banner — cmdStart() prints "watching" instead and never exits.
    assert.match(r.stdout, /live session/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  }
});

test('--no-token before the subcommand disables the token rather than silently minting one', async () => {
  // Before the fix, `--no-token` here consumed "start" as its value
  // (flags['no-token'] = 'start'), which is truthy but not `=== true` — so
  // resolve()'s `flags['no-token'] === true` check missed it and a token was
  // minted anyway, defeating the flag entirely.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cctv-cli-home-'));
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cctv-cli-claude-'));
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });
  const port = 22000 + (process.pid % 5000);
  const env = { ...process.env, AGENT_CCTV_HOME: home, AGENT_CCTV_CLAUDE_DIR: claudeDir };
  delete env.AGENT_CCTV_TOKEN;
  delete env.AGENT_CCTV_HOST;
  delete env.AGENT_CCTV_PORT;
  delete env.AGENT_CCTV_PUBLIC_URL;

  const child = spawn(
    process.execPath,
    [CLI, '--no-token', 'start', '--port', String(port), '--no-open'],
    { env, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));

  try {
    await waitFor(() => /watching/.test(stdout) || child.exitCode !== null, 5000);
    assert.equal(child.exitCode, null, `expected the server to be running; stderr: ${stderr}`);
    assert.doesNotMatch(stdout, /token=/, 'no token should have been minted or printed');

    // No token configured means every endpoint is open.
    const res = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(res.status, 200);
  } finally {
    child.kill();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  }
});

/* ── the browser must get the token even when the banner hides it ────────── */

test(
  'openBrowser() still gets the token when AGENT_CCTV_TOKEN hides it from the banner',
  { skip: process.platform === 'win32' /* opener faking below assumes a shebang script on PATH */ },
  async () => {
    // Regression: the finding-8 fix (hide an env-sourced token from the
    // printed banner) and the finding-5 fix (a page with no token shows "no
    // credential") collided — cmdStart used to build one URL and hand it to
    // both console.log and openBrowser(), so hiding the token from the banner
    // also hid it from the browser tab this process opens for itself, which
    // then landed on the "no credential" wall instead of a working dashboard.
    //
    // No real browser is spawned here: `open`/`xdg-open` is faked with a tiny
    // script placed first on PATH that records its argv instead of opening
    // anything.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cctv-cli-home-'));
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cctv-cli-claude-'));
    fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cctv-cli-fakebin-'));
    const recordFile = path.join(binDir, 'opened-url.txt');
    const openerName = process.platform === 'darwin' ? 'open' : 'xdg-open';
    fs.writeFileSync(
      path.join(binDir, openerName),
      `#!/bin/sh\nprintf '%s' "$1" > "${recordFile}"\n`,
      { mode: 0o755 }
    );

    const token = 'e'.repeat(24);
    const port = 23000 + (process.pid % 5000);
    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      AGENT_CCTV_HOME: home,
      AGENT_CCTV_CLAUDE_DIR: claudeDir,
      AGENT_CCTV_TOKEN: token,
    };
    delete env.AGENT_CCTV_HOST;
    delete env.AGENT_CCTV_PORT;
    delete env.AGENT_CCTV_PUBLIC_URL;

    // Deliberately no --no-open: this is the "operator testing the server
    // interactively" path the regression broke.
    const child = spawn(process.execPath, [CLI, 'start', '--port', String(port)], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    try {
      await waitFor(() => /watching/.test(stdout) || child.exitCode !== null, 5000);
      assert.equal(child.exitCode, null, `expected the server to be running; stderr: ${stderr}`);
      await waitFor(() => fs.existsSync(recordFile), 2000);

      const openedUrl = fs.readFileSync(recordFile, 'utf8');
      assert.match(openedUrl, new RegExp(`token=${token}`), 'the opened tab must carry the token');

      // The two URLs must differ: the banner hides an env-sourced token, the
      // opened tab must not.
      assert.doesNotMatch(stdout, new RegExp(`token=${token}`), 'the banner must not print an env-sourced token');
      assert.match(stdout, /token from AGENT_CCTV_TOKEN/);
    } finally {
      child.kill();
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(claudeDir, { recursive: true, force: true });
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  }
);

/* ── views ───────────────────────────────────────────────────────────────── */

/** Runs a non-start subcommand against a throwaway views directory. */
function runViews(files) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cctv-cli-home-'));
  const views = path.join(home, 'views');
  if (files) {
    fs.mkdirSync(views, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(views, name), body);
    }
  }
  try {
    const env = { ...process.env, AGENT_CCTV_HOME: home };
    delete env.AGENT_CCTV_VIEWS_DIR;
    return spawnSync(process.execPath, [CLI, 'views'], { encoding: 'utf8', env, timeout: 10_000 });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('views names the directory it looked in and offers a starter when empty', () => {
  const r = runViews(null);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /views/);
  assert.match(r.stdout, /state: attention/, 'an empty directory should print something to paste');
});

test('views lists what loaded, with its match', () => {
  const r = runViews({ 'needs-me.yaml': 'name: Needs me\nmatch:\n  state: attention\n' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Needs me/);
  assert.match(r.stdout, /needs-me/);
  assert.match(r.stdout, /state attention/);
});

test('views reports a broken file with its line, and still exits 0', () => {
  const r = runViews({
    'good.yaml': 'name: Good\n',
    'bad.yaml': 'name: Bad\ngroupby: project\n',
  });
  assert.equal(r.status, 0, 'a broken view file is not a broken install');
  assert.match(r.stdout, /Good/);
  assert.match(r.stdout, /bad\.yaml/);
  assert.match(r.stdout, /:2/);
  assert.match(r.stdout, /unknown key "groupby"/);
});
