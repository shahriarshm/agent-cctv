import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store, serialize } from './store.js';
import { SPOOL_FILE, DEFAULT_HOST, DEFAULT_PORT } from './paths.js';
import { safeJson } from './util.js';
import { ClaudeCodeSource, capabilities, SOURCE as CLAUDE } from './sources/claude-code/index.js';
import { CodexSource, capabilities as codexCapabilities, SOURCE as CODEX } from './sources/codex/index.js';
import { fromHook } from './sources/claude-code/hooks.js';
import { readTasks } from './sources/claude-code/tasks.js';
import { listSessions, loadSession } from './history.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/**
 * The dashboard streams source code out of transcripts, so loopback alone is not
 * a security boundary: any page in the browser can POST to 127.0.0.1, and a
 * DNS-rebound hostname resolves there too. We check Host and Origin, and require
 * a per-run token for anything that returns session data.
 */
/** `example.com:4599` and `[::1]:4599` both reduce to a bare hostname. */
function hostname(value) {
  const h = String(value || '').trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']')); // [::1]:4599
  return h.split(':')[0];
}

function hostAllowed(req, allowed) {
  return allowed.has(hostname(req.headers.host));
}

function originAllowed(req, allowed) {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin navigations and curl send none
  try {
    return allowed.has(hostname(new URL(origin).hostname));
  } catch {
    return false;
  }
}

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(data);
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) {
        reject(new Error('too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export function createServer({
  store = new Store(),
  token = null,
  withSource = true,
  allowedHosts = ['localhost', '127.0.0.1', '::1'],
} = {}) {
  // Do NOT run these through hostname(): that function strips a :port, and a
  // bare '::1' would reduce to '' — silently dropping loopback from its own
  // allowlist. Allowlist entries are already bare hostnames.
  const allowed = new Set(
    allowedHosts.map((h) => String(h).trim().toLowerCase().replace(/^\[|\]$/g, ''))
  );

  /** @type {Set<import('node:http').ServerResponse>} */
  const clients = new Set();

  function broadcast(type, data) {
    if (!clients.size) return;
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try {
        res.write(frame);
      } catch {
        clients.delete(res);
      }
    }
  }

  store.on('session', (s) => broadcast('session', serialize(s)));
  store.on('activity', (ev, s) => broadcast('activity', { ...ev, sessionName: s.name || s.project }));
  store.on('removed', (id) => broadcast('removed', { id }));

  /** Every source is just a thing that emits `{sessionId, patch, events}`. */
  let sources = [];
  if (withSource) {
    sources = [new ClaudeCodeSource(), new CodexSource()];
    for (const s of sources) s.on('update', (u) => store.apply(u));
    // Keyed by source: authority over a session's state belongs to whichever
    // agent produced it, and they do not all have the same reach.
    store.capabilities = { [CLAUDE]: capabilities(), [CODEX]: codexCapabilities() };
  }

  function authed(req, url) {
    if (!token) return true;
    return url.searchParams.get('token') === token || req.headers['x-cctv-token'] === token;
  }

  const server = http.createServer(async (req, res) => {
    if (!hostAllowed(req, allowed)) return json(res, 403, { error: 'bad host' });
    if (!originAllowed(req, allowed)) return json(res, 403, { error: 'bad origin' });

    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname;

    // Optional hook ingestion. Enrichment only — the registry still wins on state.
    if (route === '/ingest' && req.method === 'POST') {
      // Before the generic /api/ gate below, so this needs its own check. An open
      // /ingest lets any local process mint sessions, and each one costs a Ring(400).
      if (!authed(req, url)) return json(res, 401, { error: 'token required' });
      try {
        const envelope = safeJson(await readBody(req));
        if (!envelope) return json(res, 400, { error: 'bad json' });
        const update = fromHook(envelope);
        if (update) store.apply(update);
        return json(res, 202, { ok: true });
      } catch {
        return json(res, 413, { error: 'too large' });
      }
    }

    if (route === '/api/health') {
      return json(res, 200, {
        ok: true,
        pid: process.pid,
        sessions: store.sessions.size,
        capabilities: store.capabilities,
      });
    }

    // Everything below returns session content.
    if (route.startsWith('/api/') && !authed(req, url)) {
      return json(res, 401, { error: 'token required' });
    }

    if (route === '/api/state') return json(res, 200, store.snapshot());

    // Sessions that have already left the wall. Read straight from the agents'
    // own logs on demand — nothing is persisted here to make this work.
    if (route === '/api/history') {
      const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days')) || 7));
      return json(res, 200, {
        days,
        ...listSessions({ sinceMs: days * 24 * 60 * 60e3, live: new Set(store.sessions.keys()) }),
      });
    }

    if (route.startsWith('/api/history/')) {
      const id = decodeURIComponent(route.slice('/api/history/'.length));
      const detail = loadSession(id);
      if (!detail) return json(res, 404, { error: 'no such session' });
      return json(res, 200, detail);
    }

    if (route.startsWith('/api/session/')) {
      const id = decodeURIComponent(route.slice('/api/session/'.length));
      const s = store.get(id);
      if (!s) return json(res, 404, { error: 'no such session' });
      const detail = serialize(s, { withEvents: true });
      detail.tasks = s.tasks || readTasks(id);
      detail.transcriptPath = s.transcriptPath;
      return json(res, 200, detail);
    }

    if (route === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      res.write(`event: snapshot\ndata: ${JSON.stringify(store.snapshot())}\n\n`);
      clients.add(res);
      const ping = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {}
      }, 20000);
      ping.unref?.();
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 405, { error: 'method not allowed' });
    }

    const rel = route === '/' ? 'index.html' : route.replace(/^\/+/, '');
    const file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR) {
      return json(res, 403, { error: 'nope' });
    }

    fs.readFile(file, (err, data) => {
      if (err) return json(res, 404, { error: 'not found' });
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'content-length': data.length,
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  });

  server.on('listening', () => {
    drainSpool(store);
    for (const s of sources) s.start();
  });

  const sweeper = setInterval(() => store.sweep(), 5000);
  sweeper.unref();

  server.on('close', () => {
    clearInterval(sweeper);
    for (const s of sources) s.stop();
    for (const res of clients) {
      try {
        res.end();
      } catch {}
    }
  });

  server.store = store;
  server.sources = sources;
  server.clientCount = () => clients.size;
  return server;
}

/** Hook events recorded while the dashboard was down. */
function drainSpool(store) {
  try {
    if (!fs.existsSync(SPOOL_FILE)) return 0;
    const lines = fs.readFileSync(SPOOL_FILE, 'utf8').split('\n').filter(Boolean);
    fs.rmSync(SPOOL_FILE, { force: true });
    let n = 0;
    for (const line of lines) {
      const update = fromHook(safeJson(line));
      if (update) {
        store.apply({ ...update, bootstrap: true });
        n++;
      }
    }
    return n;
  } catch {
    return 0;
  }
}

export { newToken } from './config.js';

export function start({ port = DEFAULT_PORT, host = DEFAULT_HOST, store, token, allowedHosts } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer({ store, token, allowedHosts });
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
