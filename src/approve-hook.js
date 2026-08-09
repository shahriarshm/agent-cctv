#!/usr/bin/env node
/**
 * The approvals decision hook. Claude Code runs this on PermissionRequest.
 *
 * This is src/hook.js's opposite, and deliberately a separate file: that one
 * must never block and never write stdout; this one exists to block and its
 * stdout IS the decision. What they share is the exit contract:
 *
 *   1. Every exit is exit 0. A hook failure must read as "no opinion",
 *      never as an error in the operator's session.
 *   2. Silence (no stdout) means "fall through to the terminal prompt".
 *      That is the documented Claude Code semantic, and it is the entire
 *      fail-safe: server down, disarmed, deadline, drain, SIGTERM — silence.
 *   3. The deadline is OURS (270 s), enforced here, under the settings.json
 *      backstop of 300 s. What a cancelled hook means is undocumented; what
 *      exit-0-no-output means is documented. We only ever rely on the latter.
 */
import fs from 'node:fs';
import http from 'node:http';
import { CONFIG_FILE, DEFAULT_PORT, DEFAULT_HOST } from './paths.js';

const DEADLINE_MS = Number(process.env.AGENT_CCTV_APPROVE_DEADLINE_MS) || 270_000;
/** Model-visible, fixed on purpose. Free text from the phone would be
 *  operator speech; interpolated tool input would be an injection surface. */
const DENY_MESSAGE = 'Denied from the agent-cctv wall.';

let done = false;
function finish(output) {
  if (done) return;
  done = true;
  if (output) {
    try {
      process.stdout.write(output);
    } catch {}
  }
  process.exit(0);
}

const bail = setTimeout(() => finish(), DEADLINE_MS);
bail.unref?.();
// The local operator answering the terminal prompt first kills this process.
// That is a normal ending, not an error.
process.on('SIGTERM', () => finish());
process.on('SIGINT', () => finish());

function config() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
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

function output(decision) {
  if (!decision) return null;
  if (decision.behavior !== 'allow' && decision.behavior !== 'deny') return null;
  const d = { behavior: decision.behavior };
  if (d.behavior === 'deny') d.message = DENY_MESSAGE;
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: d },
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
  const body = JSON.stringify({
    session_id: payload.session_id || '',
    tool_name: payload.tool_name || '',
    tool_input: payload.tool_input ?? null,
    cwd: payload.cwd || '',
    permission_mode: payload.permission_mode || '',
  });

  const req = http.request(
    {
      host: cfg.host || DEFAULT_HOST,
      port: Number(process.env.AGENT_CCTV_PORT) || cfg.port || DEFAULT_PORT,
      path: '/api/approvals/pending',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-cctv-token': cfg.token || '',
      },
    },
    (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          finish(output(JSON.parse(data).decision));
        } catch {
          finish();
        }
      });
      res.on('error', () => finish());
    }
  );
  // No req.setTimeout: the response is SUPPOSED to hang while armed. The bail
  // timer above is the only clock, and it exits before the settings backstop.
  req.on('error', () => finish());
  req.end(body);
}

main().catch(() => finish());
