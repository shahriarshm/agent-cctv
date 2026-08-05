import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
