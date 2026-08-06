import './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolve, validate, ConfigError, isLoopback, MIN_TOKEN_LENGTH } from '../src/config.js';

const GOOD = 't'.repeat(MIN_TOKEN_LENGTH);
const stub = () => 'r'.repeat(32);

/** resolve() with nothing configured anywhere — the individual's default path. */
function bare(over = {}) {
  return resolve({ flags: {}, env: {}, file: {}, makeToken: stub, ...over });
}

test('defaults reproduce the current single-developer behaviour', () => {
  const cfg = bare();
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.port, 4599);
  assert.equal(cfg.token, 'r'.repeat(32), 'a random token is minted when none is configured');
  assert.equal(cfg.openBrowser, true);
  assert.equal(cfg.publicHost, null);
  assert.equal(cfg.secureCookie, false);
  assert.deepEqual(cfg.allowedHosts, ['localhost', '127.0.0.1', '::1']);
});

test('precedence runs flags over env over defaults — the file layer never wins', () => {
  // `file` used to sit between env and DEFAULT_PORT; it no longer
  // participates at all (see the regression test below), so a `file.port`
  // with nothing overriding it must fall through to the default, not win.
  assert.equal(bare({ flags: { port: '1' }, env: { AGENT_CCTV_PORT: '2' }, file: { port: 3 } }).port, 1);
  assert.equal(bare({ env: { AGENT_CCTV_PORT: '2' }, file: { port: 3 } }).port, 2);
  assert.equal(bare({ file: { port: 3 } }).port, 4599);
  assert.equal(bare().port, 4599);
});

test('the state file never feeds host or port back into resolve()', () => {
  // ~/.agent-cctv/config.json is a runtime echo cmdStart writes on every
  // start (for the hook reporter) — not operator configuration. If it were
  // consulted here, one `--host 0.0.0.0`, ever, would stick forever: the
  // write side persists whatever a run resolved to, and the next flagless
  // run would read that back out as if it had been configured.
  const cfg = bare({ file: { host: '0.0.0.0', port: 9999 } });
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.port, 4599);
});

test('AGENT_CCTV_TOKEN is used instead of minting a random one', () => {
  assert.equal(bare({ env: { AGENT_CCTV_TOKEN: GOOD } }).token, GOOD);
});

test('--no-token yields a null token', () => {
  assert.equal(bare({ flags: { 'no-token': true } }).token, null);
  assert.equal(bare({ flags: { token: false } }).token, null);
});

test('--no-open suppresses the browser', () => {
  assert.equal(bare({ flags: { 'no-open': true } }).openBrowser, false);
  assert.equal(bare({ flags: { open: false } }).openBrowser, false);
});

test('a public URL contributes its hostname to the allowlist', () => {
  const cfg = bare({ env: { AGENT_CCTV_PUBLIC_URL: 'https://cctv.corp.example' } });
  assert.equal(cfg.publicHost, 'cctv.corp.example');
  assert.equal(cfg.secureCookie, true);
  assert.deepEqual(cfg.allowedHosts, ['localhost', '127.0.0.1', '::1', 'cctv.corp.example']);
});

test('a plain-http public URL does not ask for a Secure cookie', () => {
  // An unconditional Secure cookie is never returned over http, which would
  // break every non-TLS deployment.
  assert.equal(bare({ env: { AGENT_CCTV_PUBLIC_URL: 'http://box.internal:4599' } }).secureCookie, false);
});

test('isLoopback recognises the three loopback spellings', () => {
  for (const h of ['localhost', '127.0.0.1', '::1', 'LOCALHOST', '[::1]']) {
    assert.equal(isLoopback(h), true, h);
  }
  for (const h of ['0.0.0.0', '10.0.0.5', 'cctv.corp.example']) {
    assert.equal(isLoopback(h), false, h);
  }
});

/* ── refusals ──────────────────────────────────────────────────────────── */

test('validate accepts the default configuration', () => {
  assert.equal(validate(bare()).host, '127.0.0.1');
});

test('validate refuses a public bind with no token', () => {
  // Built by hand rather than through resolve(): resolve() always mints a token
  // unless --no-token, so this branch is validate() standing on its own as a
  // guard for any future caller that assembles a config differently.
  assert.throws(
    () => validate({ host: '0.0.0.0', token: null, noToken: false, publicUrlRaw: null, publicHost: null }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /Refusing to bind 0\.0\.0\.0/);
      return true;
    }
  );
});

test('--no-token combined with a public bind is refused, and says so', () => {
  const cfg = bare({ flags: { host: '0.0.0.0', 'no-token': true } });
  assert.throws(() => validate(cfg), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /--no-token/);
    return true;
  });
});

test('--no-token on loopback is still allowed', () => {
  assert.doesNotThrow(() => validate(bare({ flags: { 'no-token': true } })));
});

test('a short token is refused', () => {
  assert.throws(
    () => validate(bare({ env: { AGENT_CCTV_TOKEN: 'hunter2' } })),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /16/);
      return true;
    }
  );
});

test('an unparseable public URL is refused', () => {
  assert.throws(
    () => validate(bare({ env: { AGENT_CCTV_PUBLIC_URL: 'cctv.corp.example' } })),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /AGENT_CCTV_PUBLIC_URL/);
      return true;
    }
  );
});

test('a public bind with a strong token is accepted', () => {
  assert.doesNotThrow(() =>
    validate(bare({ flags: { host: '0.0.0.0' }, env: { AGENT_CCTV_TOKEN: GOOD } }))
  );
});

test('--no-token combined with a configured public URL is refused, and says so', () => {
  // Loopback bind, but AGENT_CCTV_PUBLIC_URL means a reverse proxy makes this
  // reachable beyond the machine — the same exposure a non-loopback bind has.
  const cfg = bare({
    flags: { 'no-token': true },
    env: { AGENT_CCTV_PUBLIC_URL: 'https://cctv.corp.example' },
  });
  assert.throws(() => validate(cfg), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /--no-token/);
    assert.match(err.message, /AGENT_CCTV_PUBLIC_URL|cctv\.corp\.example/);
    return true;
  });
});

test('a loopback bind with a public URL and a strong token is accepted', () => {
  assert.doesNotThrow(() =>
    validate(
      bare({ env: { AGENT_CCTV_PUBLIC_URL: 'https://cctv.corp.example', AGENT_CCTV_TOKEN: GOOD } })
    )
  );
});

// The individual developer's escape hatch — loopback bind, no public URL,
// --no-token — must not regress. Already covered above by
// '--no-token on loopback is still allowed'; that test still passes
// unmodified rather than being duplicated here.

/*
  A tunnel is the same "reachable beyond this machine" fact as a public URL,
  arriving by a different route — so it goes through the same refusals. The
  difference is that the hostname it will add to the allowlist does not exist
  yet, which is why none of these can be checked against one.
*/

/** resolve() for a tunnel run, on a terminal unless told otherwise. */
function tunnelCfg(flags, over = {}) {
  return resolve({ flags, env: {}, file: {}, makeToken: stub, tty: true, ...over });
}

test('a tunnel run carries the token that makes it legal', () => {
  const cfg = validate(tunnelCfg({ tunnel: 'cloudflare' }));
  assert.equal(cfg.tunnel, 'cloudflare');
  assert.equal(cfg.token, 'r'.repeat(32));
  assert.equal(cfg.tunnelTtlMs, null);
});

test('--tunnel with --no-token is refused before anything binds', () => {
  assert.throws(
    () => validate(tunnelCfg({ tunnel: 'cloudflare', 'no-token': true })),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /--no-token/);
      assert.match(err.message, /source code/, 'the message must say what is being published');
      return true;
    }
  );
});

test('an unknown provider is refused rather than defaulted', () => {
  assert.throws(() => validate(tunnelCfg({ tunnel: 'wireguard' })), /wireguard/);
  assert.throws(() => validate(tunnelCfg({ tunnel: 'wireguard' })), /cloudflare, ngrok/);
});

test('a provider name is matched case-insensitively', () => {
  assert.equal(validate(tunnelCfg({ tunnel: 'Cloudflare' })).tunnel, 'cloudflare');
});

test('--tunnel and --tunnel-cmd together are refused rather than ranked', () => {
  assert.throws(
    () => validate(tunnelCfg({ tunnel: 'ngrok', 'tunnel-cmd': 'bore local 4599' })),
    /--tunnel-cmd/
  );
});

test('--tunnel-args without a provider is refused, not silently dropped', () => {
  assert.throws(() => validate(tunnelCfg({ 'tunnel-args': '--region us' })), /--tunnel-args/);
  // With --tunnel-cmd too: that string already carries its own arguments, and
  // two places to put them is one too many.
  assert.throws(
    () => validate(tunnelCfg({ 'tunnel-cmd': 'bore local 4599', 'tunnel-args': '--x' })),
    /--tunnel-args/
  );
});

test('an ambiguous --tunnel-ttl is refused', () => {
  assert.throws(() => validate(tunnelCfg({ tunnel: 'ngrok', 'tunnel-ttl': '30' })), /45s, 30m or 2h/);
  assert.equal(validate(tunnelCfg({ tunnel: 'ngrok', 'tunnel-ttl': '30m' })).tunnelTtlMs, 1_800_000);
});

test('--tunnel-ttl without anything to close is refused', () => {
  assert.throws(() => validate(tunnelCfg({ 'tunnel-ttl': '30m' })), /--tunnel-ttl/);
});

test('publishing from a non-terminal requires --yes to have been written down', () => {
  // A unit file, a CI job or a background & must never start publishing
  // because there was nobody there to be asked.
  assert.throws(() => validate(tunnelCfg({ tunnel: 'cloudflare' }, { tty: false })), /--yes/);
  assert.doesNotThrow(() => validate(tunnelCfg({ tunnel: 'cloudflare', yes: true }, { tty: false })));
});

test('AGENT_CCTV_TUNNEL configures a tunnel the same way the flag does', () => {
  const cfg = validate(
    resolve({
      flags: {},
      env: { AGENT_CCTV_TUNNEL: 'ngrok', AGENT_CCTV_TUNNEL_ARGS: '--region eu' },
      makeToken: stub,
      tty: true,
    })
  );
  assert.equal(cfg.tunnel, 'ngrok');
  assert.equal(cfg.tunnelArgs, '--region eu');
});

test('no tunnel means no tunnel fields set, and nothing else changes', () => {
  const cfg = validate(bare());
  assert.equal(cfg.tunnel, null);
  assert.equal(cfg.tunnelCmd, null);
  assert.equal(cfg.assumeYes, false);
  assert.deepEqual(cfg.allowedHosts, ['localhost', '127.0.0.1', '::1']);
});
