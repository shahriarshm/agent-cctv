import './helpers/env.js'; // must come first — bin/cctv.js imports src/paths.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs } from '../bin/cctv.js';

/*
  The command line is the only interface this tool has for saying "publish
  this", and the arguments that say how are provider arguments — which look
  exactly like our own. Both cases below were real bugs found while designing
  --tunnel-args, and both are silent: nothing throws, the value is just quietly
  not what was typed.
*/

test('a flag value containing = survives parsing whole', () => {
  // --tunnel-args=--log=stdout used to arrive as '--log': the old
  // split('=') destructured [k, v] and dropped everything after the second.
  const { flags } = parseArgs(['--tunnel-args=--log=stdout']);
  assert.equal(flags['tunnel-args'], '--log=stdout');
});

test('a value beginning with a dash is still a value, for flags that take one', () => {
  // `--tunnel-args '--region us'` is the normal way to pass provider flags.
  const { flags } = parseArgs(['--tunnel-args', '--region us']);
  assert.equal(flags['tunnel-args'], '--region us');
});

test('--yes is a boolean and does not swallow the subcommand', () => {
  const { flags, _ } = parseArgs(['--yes', 'start']);
  assert.equal(flags.yes, true);
  assert.deepEqual(_, ['start']);
});

test('a value flag left empty is still reported as valueless', () => {
  // cmdStart turns `=== true` into "--tunnel requires a value".
  assert.equal(parseArgs(['--tunnel']).flags.tunnel, true);
});

test('a flag that takes no value still refuses to eat the next token', () => {
  // The pre-existing guarantee, kept: --no-open must not consume "start".
  const { flags, _ } = parseArgs(['--no-open', 'start']);
  assert.equal(flags['no-open'], true);
  assert.deepEqual(_, ['start']);
});

test('a value flag never swallows one of our own flags', () => {
  // "May begin with a dash" is not "takes whatever comes next". `--host
  // --no-open` has to stay a missing value, or the refusal it should produce
  // turns into a DNS lookup for "--no-open" — which is exactly what the
  // existing cli.test.js refusal cases caught when this was greedy.
  assert.equal(parseArgs(['--host', '--no-open']).flags.host, true);
  assert.equal(parseArgs(['--host', '--no-open']).flags['no-open'], true);
  assert.equal(parseArgs(['--tunnel', '--yes']).flags.tunnel, true);
  // …but a token that is not ours is a value, dash or no dash.
  assert.equal(parseArgs(['--tunnel-args', '--region']).flags['tunnel-args'], '--region');
});

test('--approvals is a boolean flag and does not eat the subcommand', () => {
  const args = parseArgs(['install', '--approvals']);
  assert.deepEqual(args._, ['install']);
  assert.equal(args.flags.approvals, true);
  const reversed = parseArgs(['--approvals', 'install']);
  assert.deepEqual(reversed._, ['install']);
  assert.equal(reversed.flags.approvals, true);
});
