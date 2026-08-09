import crypto from 'node:crypto';

/*
  Remote-approval state: the armed bit, the held pendings, the pairing codes
  and device secrets. Everything lives in this process's memory and nowhere
  else — a restart revokes every pairing and disarms, which is the emergency
  kill switch, not a bug. Nothing here touches HTTP; the server owns sockets
  and hands this module resolve callbacks.
*/

/** The hook exits silently at this deadline; the server never times a pending
 *  out itself. Carried on each pending so the card can show a countdown. */
export const HOOK_SELF_DEADLINE_MS = 270_000;
/** A forgotten toggle must not re-route next week's sessions. Re-arming from
 *  a paired phone is one tap, so erring short costs little. */
export const AUTO_DISARM_MS = 4 * 60 * 60 * 1000;
export const PAIR_TTL_MS = 5 * 60 * 1000;
export const PAIR_MAX_ATTEMPTS = 5;
/** How many resolved outcomes to remember, so a losing tap can be told what
 *  happened instead of a bare 409. Small and bounded — this is UX, not audit. */
const RECENT_CAP = 20;

function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

export function createApprovals({
  onChange = () => {},
  autoDisarmMs = AUTO_DISARM_MS,
  pairTtlMs = PAIR_TTL_MS,
} = {}) {
  let armed = false;
  let until = null;
  let disarmTimer = null;
  let seq = 0;
  /** @type {Map<string, {meta: object, since: number, deadline: number, resolve: Function}>} */
  const pendings = new Map();
  /** id -> 'allow' | 'deny' | 'expired', insertion-ordered, capped. */
  const recent = new Map();
  const devices = new Set();
  let pairCode = null; // { code, expiresAt, attempts }

  function remember(id, outcome) {
    recent.set(id, outcome);
    if (recent.size > RECENT_CAP) recent.delete(recent.keys().next().value);
  }

  function drain() {
    let n = 0;
    for (const [id, p] of pendings) {
      remember(id, 'expired');
      try {
        p.resolve(null);
      } catch {}
      n++;
    }
    pendings.clear();
    if (n) onChange('drained');
    return n;
  }

  function setArmed(on) {
    if (disarmTimer) clearTimeout(disarmTimer);
    disarmTimer = null;
    const next = !!on;
    const changed = next !== armed;
    armed = next;
    if (armed) {
      until = Date.now() + autoDisarmMs;
      disarmTimer = setTimeout(() => {
        armed = false;
        until = null;
        disarmTimer = null;
        drain();
        onChange('auto-disarm');
      }, autoDisarmMs);
      disarmTimer.unref?.();
      onChange('armed');
    } else {
      until = null;
      drain();
      if (changed) onChange('disarmed');
    }
    return armed;
  }

  function list() {
    return [...pendings.entries()].map(([id, p]) => ({
      id,
      ...p.meta,
      since: p.since,
      deadline: p.deadline,
    }));
  }

  return {
    isArmed: () => armed,
    setArmed,

    add(meta, resolve) {
      const since = Date.now();
      const id = `p${++seq}-${crypto.randomBytes(4).toString('hex')}`;
      pendings.set(id, { meta, since, deadline: since + HOOK_SELF_DEADLINE_MS, resolve });
      onChange('pending');
      return { id, ...meta, since, deadline: since + HOOK_SELF_DEADLINE_MS };
    },

    remove(id) {
      const p = pendings.get(id);
      if (!p) return false;
      // The socket is gone; resolving would write into it. Just forget.
      pendings.delete(id);
      remember(id, 'expired');
      onChange('expired');
      return true;
    },

    decide(id, behavior) {
      const p = pendings.get(id);
      if (!p) return { ok: false, outcome: recent.get(id) || 'expired' };
      pendings.delete(id);
      remember(id, behavior);
      try {
        p.resolve({ behavior });
      } catch {}
      onChange('resolved');
      return { ok: true };
    },

    drain,
    list,

    state() {
      return { armed, until, pendings: list() };
    },

    mintCode() {
      // crypto, not Math.random: six digits is little enough entropy without
      // handing an observer the PRNG state too.
      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      pairCode = { code, expiresAt: Date.now() + pairTtlMs, attempts: 0 };
      return { code, ttlMs: pairTtlMs };
    },

    tryPair(candidate) {
      if (!pairCode) return { ok: false };
      if (Date.now() > pairCode.expiresAt) {
        pairCode = null;
        return { ok: false };
      }
      pairCode.attempts++;
      const match = sameSecret(String(candidate), pairCode.code);
      if (!match) {
        if (pairCode.attempts >= PAIR_MAX_ATTEMPTS) pairCode = null;
        return { ok: false };
      }
      pairCode = null; // one-time
      const secret = crypto.randomBytes(32).toString('hex');
      devices.add(secret);
      return { ok: true, secret };
    },

    isDevice(secret) {
      // timingSafeEqual per candidate rather than Set.has: the secret is a
      // credential on a network-reachable port, same rule as the token.
      for (const d of devices) if (sameSecret(secret, d)) return true;
      return false;
    },
  };
}
