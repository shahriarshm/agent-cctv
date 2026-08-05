#!/usr/bin/env node
/**
 * The hook reporter. Claude Code runs this once per hook event.
 *
 * Non-negotiables, in order:
 *   1. Never block the agent. Hard deadline, then exit.
 *   2. Never fail the agent. Always exit 0, never write to stdout.
 *   3. Never lose the event if the dashboard is simply not running yet — spool it.
 */
import fs from 'node:fs';
import http from 'node:http';
import { ROOT, SPOOL_FILE, CONFIG_FILE, DEFAULT_PORT, DEFAULT_HOST } from './paths.js';

const DEADLINE_MS = Number(process.env.AGENT_CCTV_HOOK_TIMEOUT) || 400;
const MAX_SPOOL_BYTES = 8 * 1024 * 1024;

let done = false;
function finish() {
  if (done) return;
  done = true;
  process.exit(0);
}

// Absolute backstop: whatever happens, we are gone before the agent notices.
const bail = setTimeout(finish, DEADLINE_MS);
bail.unref?.();

function config() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function spool(body) {
  try {
    fs.mkdirSync(ROOT, { recursive: true });
    const size = fs.existsSync(SPOOL_FILE) ? fs.statSync(SPOOL_FILE).size : 0;
    if (size > MAX_SPOOL_BYTES) return;
    fs.appendFileSync(SPOOL_FILE, body + '\n');
  } catch {}
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      data += c;
      if (data.length > 4 * 1024 * 1024) resolve(data); // pathological payload guard
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

async function main() {
  const raw = (await readStdin()).trim();
  if (!raw) return finish();

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return finish();
  }

  const cfg = config();
  const envelope = JSON.stringify({
    source: 'claude-code',
    receivedAt: Date.now(),
    pid: process.ppid,
    payload,
  });

  const req = http.request(
    {
      host: cfg.host || DEFAULT_HOST,
      port: Number(process.env.AGENT_CCTV_PORT) || cfg.port || DEFAULT_PORT,
      path: '/ingest',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(envelope),
        'x-cctv-token': cfg.token || '',
      },
    },
    (res) => {
      res.resume();
      res.on('end', finish);
      finish();
    }
  );

  req.setTimeout(DEADLINE_MS - 50, () => {
    req.destroy();
    spool(envelope);
    finish();
  });

  req.on('error', () => {
    // Dashboard is not up (or died). Keep the event for when it starts.
    spool(envelope);
    finish();
  });

  req.end(envelope);
}

main().catch(finish);
