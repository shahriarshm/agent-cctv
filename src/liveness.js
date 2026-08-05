import { execFile } from 'node:child_process';

/**
 * Binding a session to a real OS process.
 *
 * Hook payloads carry no pid, so the reporter sends its own parent pid. That is
 * usually the shell Claude Code spawned the hook from, so we walk up the process
 * tree until we find the agent binary. Once we have that pid, liveness is just
 * `kill(pid, 0)` — no polling cost.
 */

const AGENT_PROCESS = /(^|\/)(claude|claude-code|node)$/;
const AGENT_ARGS = /claude/i;
const MAX_WALK = 6;

function ps(pid) {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'ppid=,comm=,args=', '-p', String(pid)], { timeout: 2000 }, (err, stdout) => {
      if (err || !stdout?.trim()) return resolve(null);
      const line = stdout.trim();
      const m = line.match(/^\s*(\d+)\s+(\S+)\s*(.*)$/);
      if (!m) return resolve(null);
      resolve({ ppid: Number(m[1]), comm: m[2], args: m[3] || '' });
    });
  });
}

/** Walk up from `pid` looking for the process that is actually the agent. */
export async function resolveAgentPid(startPid) {
  let pid = Number(startPid);
  if (!Number.isInteger(pid) || pid <= 1) return null;

  for (let i = 0; i < MAX_WALK; i++) {
    const info = await ps(pid);
    if (!info) return null;
    const isAgent =
      AGENT_PROCESS.test(info.comm) && (AGENT_ARGS.test(info.args) || /claude/.test(info.comm));
    if (isAgent) return pid;
    if (!info.ppid || info.ppid <= 1) return null;
    pid = info.ppid;
  }
  return null;
}

export function isAlive(pid) {
  if (!pid) return null; // unknown, not "dead"
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists but owned by someone else
  }
}
