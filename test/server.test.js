import './helpers/env.js'; // must come first — see the file's comment
import { test } from 'node:test';
import assert from 'node:assert/strict';

import http from 'node:http';
import net from 'node:net';
import { createServer } from '../src/server.js';
import { Store } from '../src/store.js';

const TOKEN = 'k'.repeat(32);

/*
  Two request functions on purpose. Node's fetch() silently REWRITES the Host
  header to the real target — verified: sending `host: evil.example` arrives as
  `127.0.0.1:<port>`. Any allowlist test written with fetch is therefore
  meaningless. node:http passes Host through verbatim, so Host-header tests use
  raw(). Origin is passed through by fetch correctly, so everything else can
  use the friendlier API.
*/

/** Start a server on an ephemeral port with no filesystem sources attached. */
async function serve(opts = {}) {
  const server = createServer({ store: new Store(), withSource: false, ...opts });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    server,
    url: (p) => `http://127.0.0.1:${port}${p}`,
    /** A request whose Host header is actually what you asked for. */
    raw: (path, headers = {}) =>
      new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
        });
        req.on('error', reject);
        req.end();
      }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function hookEnvelope(sessionId) {
  return JSON.stringify({
    source: 'claude-code',
    receivedAt: Date.now(),
    pid: 1234,
    payload: { session_id: sessionId, hook_event_name: 'SessionStart', cwd: '/tmp/x' },
  });
}

test('/ingest refuses a POST with no token', async () => {
  const s = await serve({ token: TOKEN });
  try {
    const res = await fetch(s.url('/ingest'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: hookEnvelope('11111111-1111-1111-1111-111111111111'),
    });
    assert.equal(res.status, 401);
  } finally {
    await s.close();
  }
});

test('an unauthenticated /ingest cannot create a session', async () => {
  const store = new Store();
  const s = await serve({ store, token: TOKEN });
  try {
    await fetch(s.url('/ingest'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: hookEnvelope('22222222-2222-2222-2222-222222222222'),
    });
    assert.equal(store.sessions.size, 0, 'a rejected POST must not allocate a session');
  } finally {
    await s.close();
  }
});

test('/ingest accepts a POST carrying x-cctv-token', async () => {
  const s = await serve({ token: TOKEN });
  try {
    const res = await fetch(s.url('/ingest'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cctv-token': TOKEN },
      body: hookEnvelope('33333333-3333-3333-3333-333333333333'),
    });
    assert.equal(res.status, 202);
  } finally {
    await s.close();
  }
});

test('/ingest is open when the server runs without a token', async () => {
  const s = await serve({ token: null });
  try {
    const res = await fetch(s.url('/ingest'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: hookEnvelope('44444444-4444-4444-4444-444444444444'),
    });
    assert.equal(res.status, 202);
  } finally {
    await s.close();
  }
});

/* ── host and origin allowlist ─────────────────────────────────────────── */

// These three use raw(), not fetch() — see the note on the helper.
test('a configured public host is accepted in the Host header', async () => {
  const s = await serve({ token: null, allowedHosts: ['localhost', '127.0.0.1', '::1', 'cctv.corp.example'] });
  try {
    assert.equal((await s.raw('/api/health', { host: 'cctv.corp.example' })).status, 200);
  } finally {
    await s.close();
  }
});

test('an unlisted host is rejected', async () => {
  const s = await serve({ token: null, allowedHosts: ['localhost', '127.0.0.1', '::1'] });
  try {
    assert.equal((await s.raw('/api/health', { host: 'evil.example' })).status, 403);
  } finally {
    await s.close();
  }
});

test('a bracketed IPv6 Host header is parsed correctly', async () => {
  // Pre-existing bug: split(':')[0] on "[::1]:4599" yields "[", so ::1 never
  // matched the loopback allowlist it was supposedly in.
  const s = await serve({ token: null });
  try {
    assert.equal((await s.raw('/api/health', { host: '[::1]:4599' })).status, 200);
  } finally {
    await s.close();
  }
});

test('a request with no Origin is still allowed', async () => {
  const s = await serve({ token: null });
  try {
    assert.equal((await fetch(s.url('/api/health'))).status, 200);
  } finally {
    await s.close();
  }
});

test('an unlisted Origin is rejected', async () => {
  const s = await serve({ token: null });
  try {
    const res = await fetch(s.url('/api/health'), { headers: { origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
  } finally {
    await s.close();
  }
});

test('a configured public Origin is accepted', async () => {
  const s = await serve({ token: null, allowedHosts: ['localhost', '127.0.0.1', '::1', 'cctv.corp.example'] });
  try {
    const res = await fetch(s.url('/api/health'), { headers: { origin: 'https://cctv.corp.example' } });
    assert.equal(res.status, 200);
  } finally {
    await s.close();
  }
});

/* ── cookie auth ───────────────────────────────────────────────────────── */

function cookieFrom(res) {
  const raw = res.headers.get('set-cookie');
  return raw ? raw.split(';')[0] : null;
}

test('a query-string auth exchanges the token for a cookie', async () => {
  const s = await serve({ token: TOKEN });
  try {
    const res = await fetch(s.url(`/api/state?token=${TOKEN}`));
    assert.equal(res.status, 200);
    const set = res.headers.get('set-cookie');
    assert.ok(set, 'expected a Set-Cookie header');
    assert.match(set, /^cctv=/);
    assert.match(set, /HttpOnly/i);
    assert.match(set, /SameSite=Strict/i);
  } finally {
    await s.close();
  }
});

test('the session cookie carries a Max-Age, so it outlives a browser restart', async () => {
  // Without it the cookie is session-only, but establishSession() has already
  // scrubbed the token out of the address bar and history by the time it's
  // set — so a restarted browser lands on a bare "/" with no way back in.
  const s = await serve({ token: TOKEN });
  try {
    const res = await fetch(s.url(`/api/state?token=${TOKEN}`));
    const set = res.headers.get('set-cookie');
    assert.match(set, /Max-Age=\d+/i);
    const [, seconds] = set.match(/Max-Age=(\d+)/i);
    assert.ok(Number(seconds) >= 29 * 24 * 60 * 60, `expected roughly 30 days, got ${seconds}s`);
  } finally {
    await s.close();
  }
});

test('the cookie alone authorizes a later request', async () => {
  const s = await serve({ token: TOKEN });
  try {
    const first = await fetch(s.url(`/api/state?token=${TOKEN}`));
    const res = await fetch(s.url('/api/state'), { headers: { cookie: cookieFrom(first) } });
    assert.equal(res.status, 200);
  } finally {
    await s.close();
  }
});

test('a wrong cookie does not authorize', async () => {
  const s = await serve({ token: TOKEN });
  try {
    const res = await fetch(s.url('/api/state'), { headers: { cookie: 'cctv=nope' } });
    assert.equal(res.status, 401);
  } finally {
    await s.close();
  }
});

test('a junk cctv= pair does not shadow a genuine one later in the header', async () => {
  // Cookie header ordering across origins/domains is not guaranteed, so a
  // sibling origin under a shared parent domain could plant its own `cctv=`
  // pair ahead of the real one. Every candidate must be checked, not just the
  // first with a matching name.
  const s = await serve({ token: TOKEN });
  try {
    const res = await fetch(s.url('/api/state'), { headers: { cookie: `cctv=junk; cctv=${TOKEN}` } });
    assert.equal(res.status, 200);
  } finally {
    await s.close();
  }
});

test('Secure is set only when the deployment is https', async () => {
  const plain = await serve({ token: TOKEN, secureCookie: false });
  try {
    const res = await fetch(plain.url(`/api/state?token=${TOKEN}`));
    assert.doesNotMatch(res.headers.get('set-cookie'), /Secure/i);
  } finally {
    await plain.close();
  }

  const tls = await serve({ token: TOKEN, secureCookie: true });
  try {
    const res = await fetch(tls.url(`/api/state?token=${TOKEN}`));
    assert.match(res.headers.get('set-cookie'), /Secure/i);
  } finally {
    await tls.close();
  }
});

test('loading the page with a token sets the cookie before any API call', async () => {
  const s = await serve({ token: TOKEN });
  try {
    const res = await fetch(s.url(`/?token=${TOKEN}`));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie') || '', /^cctv=/);
  } finally {
    await s.close();
  }
});

test('an already-cookied request is not re-issued a cookie', async () => {
  const s = await serve({ token: TOKEN });
  try {
    const first = await fetch(s.url(`/api/state?token=${TOKEN}`));
    const res = await fetch(s.url('/api/state'), { headers: { cookie: cookieFrom(first) } });
    assert.equal(res.headers.get('set-cookie'), null);
  } finally {
    await s.close();
  }
});

/* ── health ────────────────────────────────────────────────────────────── */

test('/api/health reveals liveness, capabilities and the tunnel, and nothing else', async () => {
  // The exact key set is the assertion, not a sample of it: this endpoint
  // needs no credential, and it used to return a pid and a live session count.
  // `tunnel` was added deliberately — "is this box publishing?" is the same
  // class of operator alert as registry degradation — and it is checked
  // elsewhere for carrying no URL.
  const s = await serve({ token: TOKEN });
  try {
    const res = await fetch(s.url('/api/health'));
    assert.equal(res.status, 200, 'health must not require the token');
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['capabilities', 'ok', 'tunnel']);
    assert.equal(body.ok, true);
  } finally {
    await s.close();
  }
});

/*
  The tunnel slot. A tunnel's hostname is not known until its child process
  prints it, and a re-opened quick tunnel comes back on a different one — so
  the server holds one slot rather than growing its allowlist, and these prove
  the door opens and closes with it.
*/

const TUNNEL = {
  host: 'demo.trycloudflare.com',
  provider: 'cloudflare',
  url: 'https://demo.trycloudflare.com',
  since: 1754400000000,
};

test('a tunnel host is allowed only while the tunnel is up', async () => {
  const s = await serve({ token: TOKEN });
  try {
    const before = await s.raw('/api/health', { host: 'demo.trycloudflare.com' });
    assert.equal(before.status, 403, 'an unknown host is refused before a tunnel exists');

    s.server.setTunnel(TUNNEL);
    const during = await s.raw('/api/health', { host: 'demo.trycloudflare.com' });
    assert.equal(during.status, 200);

    s.server.setTunnel(null);
    const after = await s.raw('/api/health', { host: 'demo.trycloudflare.com' });
    assert.equal(after.status, 403, 'closing the tunnel closes the door behind it');
  } finally {
    await s.close();
  }
});

test('loopback stays allowed while a tunnel is up', async () => {
  // The slot exists partly so this cannot break: nothing about opening a
  // tunnel may evict loopback from its own allowlist.
  const s = await serve({ token: TOKEN });
  try {
    s.server.setTunnel(TUNNEL);
    for (const host of ['localhost', '127.0.0.1']) {
      const res = await s.raw('/api/health', { host });
      assert.equal(res.status, 200, `${host} should still be allowed`);
    }
  } finally {
    await s.close();
  }
});

test('an Origin from the tunnel is allowed, and one from elsewhere is not', async () => {
  const s = await serve({ token: TOKEN });
  try {
    s.server.setTunnel(TUNNEL);
    const ok = await fetch(s.url('/api/health'), {
      headers: { origin: 'https://demo.trycloudflare.com' },
    });
    assert.equal(ok.status, 200);
    const bad = await fetch(s.url('/api/health'), {
      headers: { origin: 'https://other.trycloudflare.com' },
    });
    assert.equal(bad.status, 403);
  } finally {
    await s.close();
  }
});

test('Secure follows the host the request actually arrived on', async () => {
  // The tunnel edge is https and loopback is not, in the same run. One
  // construction-time boolean is wrong in one direction or the other.
  const s = await serve({ token: TOKEN });
  try {
    s.server.setTunnel(TUNNEL);

    const viaTunnel = await s.raw(`/api/state?token=${TOKEN}`, { host: 'demo.trycloudflare.com' });
    assert.equal(viaTunnel.status, 200);
    assert.match(String(viaTunnel.headers['set-cookie']), /Secure/i);

    const local = await s.raw(`/api/state?token=${TOKEN}`, { host: '127.0.0.1' });
    assert.equal(local.status, 200);
    assert.doesNotMatch(String(local.headers['set-cookie']), /Secure/i);
  } finally {
    await s.close();
  }
});

test('/api/health reports that a tunnel exists but never its URL', async () => {
  const s = await serve({ token: TOKEN });
  try {
    s.server.setTunnel(TUNNEL);
    const res = await fetch(s.url('/api/health'));
    const body = await res.json();
    assert.equal(body.tunnel.provider, 'cloudflare');
    assert.equal(body.tunnel.since, 1754400000000);
    assert.equal(body.tunnel.url, undefined, 'the URL is not for an endpoint that needs no credential');
    assert.equal(body.tunnel.host, undefined);
  } finally {
    await s.close();
  }
});

test('/api/health reports no tunnel as null rather than omitting it', async () => {
  const s = await serve({ token: TOKEN });
  try {
    const body = await (await fetch(s.url('/api/health'))).json();
    assert.equal(body.tunnel, null);
  } finally {
    await s.close();
  }
});

test('/api/state carries the tunnel, so the dashboard learns of it authenticated', async () => {
  const s = await serve({ token: TOKEN });
  try {
    s.server.setTunnel(TUNNEL);
    const body = await (await fetch(s.url(`/api/state?token=${TOKEN}`))).json();
    assert.equal(body.tunnel.host, 'demo.trycloudflare.com');
    assert.equal(body.tunnel.url, 'https://demo.trycloudflare.com');
    assert.ok(Array.isArray(body.sessions), 'the sessions snapshot is still there');
  } finally {
    await s.close();
  }
});

test('setTunnel normalises the hostname it is given', async () => {
  const s = await serve({ token: TOKEN });
  try {
    s.server.setTunnel({ ...TUNNEL, host: '  DEMO.TryCloudflare.com ' });
    const res = await s.raw('/api/health', { host: 'demo.trycloudflare.com' });
    assert.equal(res.status, 200);
  } finally {
    await s.close();
  }
});

/*
  A raw socket, not node:http — the client library refuses to *send* the request
  lines below, which is exactly why they were never covered. Node's server hands
  an absolute-form target through to req.url verbatim, and `new URL()` throws on
  a malformed one before the token gate has run.
*/
function rawLine(port, line) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(line));
    let body = '';
    socket.on('data', (c) => (body += c));
    socket.on('end', () => resolve(body));
    socket.on('error', reject);
  });
}

test('a malformed request target answers 400 instead of killing the process', async () => {
  const s = await serve({ token: TOKEN });
  try {
    const reply = await rawLine(
      s.port,
      'GET http://[bad HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'
    );
    assert.match(reply, /400/);
    // The point of the test: the server is still answering afterwards.
    const after = await fetch(s.url('/api/health'));
    assert.equal(after.status, 200);
  } finally {
    await s.close();
  }
});

test('a stray percent in a session id is a bad request, not a crash', async () => {
  const s = await serve({ token: TOKEN });
  try {
    const res = await fetch(s.url(`/api/session/%?token=${TOKEN}`));
    assert.equal(res.status, 400);
    assert.equal((await fetch(s.url('/api/health'))).status, 200);
  } finally {
    await s.close();
  }
});

test('close() completes with an SSE stream still open', async () => {
  const s = await serve({ token: TOKEN });
  const stream = await fetch(s.url(`/api/stream?token=${TOKEN}`));
  // Read one chunk so the stream is genuinely established, then leave it open.
  const reader = stream.body.getReader();
  await reader.read();
  assert.equal(s.server.clientCount(), 1);

  // Without teardown on close-initiation this never resolves: close() waits on
  // the SSE response, and the code that ends it only ran on 'close'.
  await Promise.race([
    s.close(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('close() hung on an open SSE client')), 3000)),
  ]);
  reader.cancel().catch(() => {});
});
