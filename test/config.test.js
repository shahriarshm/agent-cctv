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

test('precedence runs flags over env over file over defaults', () => {
  assert.equal(bare({ flags: { port: '1' }, env: { AGENT_CCTV_PORT: '2' }, file: { port: 3 } }).port, 1);
  assert.equal(bare({ env: { AGENT_CCTV_PORT: '2' }, file: { port: 3 } }).port, 2);
  assert.equal(bare({ file: { port: 3 } }).port, 3);
  assert.equal(bare().port, 4599);
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
