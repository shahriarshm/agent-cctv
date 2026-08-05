import './helpers/env.js'; // must come first — see the file's comment
import { test } from 'node:test';
import assert from 'node:assert/strict';

import http from 'node:http';
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
          res.on('end', () => resolve({ status: res.statusCode, body }));
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
