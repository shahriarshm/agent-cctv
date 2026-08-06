import './helpers/env.js'; // must come first — see the file's comment
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PROVIDERS, parseTtl, splitArgs, matchCustom } from '../src/tunnel.js';

/*
  The matchers are the part of this feature most likely to break under us:
  neither cloudflared's banner nor ngrok's log schema is a documented
  interface. These fixtures are real output, kept verbatim, so a provider
  change shows up here as a failing test rather than in the field as a
  thirty-second hang.
*/

test('parseTtl accepts a suffixed duration and rejects an ambiguous one', () => {
  assert.equal(parseTtl('45s'), 45_000);
  assert.equal(parseTtl('30m'), 30 * 60_000);
  assert.equal(parseTtl('2h'), 2 * 3600_000);
  // A bare number is 30 of what? A safety timer that guesses is worse than one
  // that refuses.
  for (const bad of ['30', 'soon', '-5m', '', '0m', '1d']) {
    assert.throws(() => parseTtl(bad), /tunnel-ttl/, `${JSON.stringify(bad)} should be refused`);
  }
});

test('splitArgs respects quotes so a provider flag can carry a space', () => {
  assert.deepEqual(splitArgs('--region us'), ['--region', 'us']);
  assert.deepEqual(splitArgs('--header "X-A: b" --x'), ['--header', 'X-A: b', '--x']);
  assert.deepEqual(splitArgs("run 'my tunnel'"), ['run', 'my tunnel']);
  assert.deepEqual(splitArgs('   '), []);
  assert.deepEqual(splitArgs(undefined), []);
});

test('cloudflared is invoked with autoupdate off and pointed at our port', () => {
  const argv = PROVIDERS.cloudflare.argv({ port: 4599, target: 'http://127.0.0.1:4599' });
  assert.deepEqual(argv, ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:4599']);
});

test('ngrok is forced out of its TTY interface and into parseable logging', () => {
  const argv = PROVIDERS.ngrok.argv({ port: 4599, target: 'http://127.0.0.1:4599' });
  assert.deepEqual(argv, ['http', '4599', '--log', 'stdout', '--log-format', 'json']);
});

test('the cloudflared banner yields its URL', () => {
  const banner = [
    '2026-08-06T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...',
    '+--------------------------------------------------------------------------+',
    '|  Your quick Tunnel has been created! Visit it at (it may take some time   |',
    '|  to be reachable):                                                        |',
    '|  https://modern-stack-42d9.trycloudflare.com                              |',
    '+--------------------------------------------------------------------------+',
  ].join('\n');
  assert.equal(PROVIDERS.cloudflare.match(banner), 'https://modern-stack-42d9.trycloudflare.com');
  assert.equal(PROVIDERS.cloudflare.match('INF Connection registered connIndex=0'), null);
});

test('the ngrok started-tunnel line yields its URL', () => {
  const line =
    '{"addr":"http://localhost:4599","lvl":"info","msg":"started tunnel",' +
    '"name":"command_line","obj":"tunnels","t":"2026-08-06T10:00:00Z","url":"https://a1b2c3.ngrok-free.app"}';
  assert.equal(PROVIDERS.ngrok.match(line), 'https://a1b2c3.ngrok-free.app');
  // Every request through the tunnel logs a line too; none of them is the URL.
  assert.equal(
    PROVIDERS.ngrok.match('{"lvl":"info","msg":"join connections","obj":"join","t":"2026-08-06T10:00:01Z"}'),
    null
  );
});

test('the custom matcher takes the first https URL and ignores http', () => {
  assert.equal(matchCustom('listening on https://x.example.com now'), 'https://x.example.com');
  assert.equal(matchCustom('bound http://127.0.0.1:4599'), null);
  // Trailing punctuation is prose, not part of the host.
  assert.equal(matchCustom('open https://y.example.com.'), 'https://y.example.com');
});
