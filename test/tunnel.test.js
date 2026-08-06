import './helpers/env.js'; // must come first — see the file's comment
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PROVIDERS, parseTtl, splitArgs, matchCustom, Tunnel } from '../src/tunnel.js';

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

/*
  Nothing below spawns cloudflared or ngrok. The provider records above are
  data; the process machinery is what needs exercising, and `node -e` is a
  perfectly good stand-in for a binary that prints a URL and then stays up.
*/

/** A stand-in tunnel binary: prints what it is told, then stays up. */
function fakeCmd(script) {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

const STAY_UP = 'setInterval(() => {}, 1000);';

test('a custom command publishes the URL it prints, and stop() kills it', async () => {
  const t = new Tunnel({
    cmd: fakeCmd(`console.log('tunnel at https://demo.example.net'); ${STAY_UP}`),
    port: 4599,
  });
  const { url, host } = await t.start();
  assert.equal(url, 'https://demo.example.net');
  assert.equal(host, 'demo.example.net');

  const pid = t.pid;
  t.stop();
  // The shell's grandchild is what actually holds a tunnel, so "stop() returned"
  // is not evidence of anything. Ask the OS.
  await new Promise((r) => setTimeout(r, 300));
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the process group should be gone');
});

test('a command that prints no URL fails loudly, with what it did print', async () => {
  const t = new Tunnel({
    cmd: fakeCmd(`console.error('could not reach the edge'); ${STAY_UP}`),
    port: 4599,
    timeoutMs: 400,
  });
  await assert.rejects(t.start(), (err) => {
    assert.match(err.message, /no public URL/i);
    assert.match(err.message, /could not reach the edge/, 'the child output must be in the error');
    return true;
  });
  t.stop();
});

test('a public URL skips scraping entirely', async () => {
  // This is the only way a named cloudflared tunnel can work: it prints no URL
  // anywhere, because its hostname lives in the operator's DNS.
  const t = new Tunnel({
    cmd: fakeCmd(STAY_UP),
    port: 4599,
    publicUrl: 'https://cctv.example.com',
    timeoutMs: 400,
  });
  const { url, host } = await t.start();
  assert.equal(url, 'https://cctv.example.com');
  assert.equal(host, 'cctv.example.com');
  t.stop();
});

test('a missing binary is reported as missing, not as a crash', async () => {
  const t = new Tunnel({ provider: 'cloudflare', port: 4599, timeoutMs: 2000 });
  // ENOENT arrives as an async 'error' event on the child, not as a throw from
  // spawn(). Unhandled it takes the whole process down.
  t.spawnBin = 'agent-cctv-no-such-binary';
  await assert.rejects(t.start(), /cloudflared is not installed/);
});

test('a child that dies during startup rejects with what it said on the way out', async () => {
  const t = new Tunnel({ cmd: fakeCmd("console.error('bad authtoken'); process.exit(3);"), port: 4599 });
  await assert.rejects(t.start(), (err) => {
    assert.match(err.message, /bad authtoken/);
    return true;
  });
});

test('a child that dies after publishing emits exit rather than rejecting', async () => {
  // The opposite case, and the reason the two are separated: by this point
  // there is a working wall and possibly someone watching it.
  const t = new Tunnel({
    cmd: fakeCmd("console.log('https://gone.example.net'); setTimeout(() => process.exit(1), 50);"),
    port: 4599,
  });
  await t.start();
  const info = await new Promise((r) => t.once('exit', r));
  assert.equal(info.code, 1);
});

test('the bound interface decides what the tunnel points at', () => {
  // 0.0.0.0 and :: include loopback; one specific private interface does not.
  assert.equal(new Tunnel({ cmd: 'x', port: 4599, host: '0.0.0.0' }).target, 'http://127.0.0.1:4599');
  assert.equal(new Tunnel({ cmd: 'x', port: 4599, host: '::' }).target, 'http://127.0.0.1:4599');
  assert.equal(new Tunnel({ cmd: 'x', port: 4599 }).target, 'http://127.0.0.1:4599');
  assert.equal(new Tunnel({ cmd: 'x', port: 4599, host: '10.0.0.5' }).target, 'http://10.0.0.5:4599');
});
