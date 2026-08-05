/*
  When the wall is allowed to interrupt you.

  Pure and DOM-free on purpose: the two decisions worth getting right — *when*
  to alert and *what the alert may say* — are testable under node:test, while
  app.js keeps the parts that need a browser (the permission gesture, the
  Notification handle, focusing the tab).
*/

/**
 * Alert on the edge into urgency and nowhere else.
 *
 * `urgent` is computed server-side (store.js `isUrgent`) and already excludes
 * "input needed", which means a turn ended rather than a session being blocked.
 * Re-deriving that rule here is exactly how the two ends drift apart, so this
 * reads the flag and nothing else.
 *
 * A session first seen already urgent (`prev` undefined) does alert — that is a
 * session that appeared and immediately blocked. The initial snapshot is a
 * separate case and is suppressed by the caller, because there the whole wall
 * is arriving at once and is on screen anyway.
 */
export function shouldNotify(prev, next) {
  if (!next || !next.urgent) return false;
  return !(prev && prev.urgent);
}

/**
 * What the alert is allowed to say.
 *
 * Deliberately not `currentTool.detail` and not `lastText`. Those carry real
 * command lines, file paths and the agent's own reasoning about your code — and
 * a notification is rendered on the lock screen, read aloud by screen readers,
 * and kept in the OS notification centre long after it is dismissed. That is a
 * worse exposure than the dashboard itself, which at least sits behind loopback
 * and a token. Which session, where, and why it stopped is all you need to
 * decide whether to go and look.
 */
export function describe(s) {
  const name = s.name || s.project || String(s.id || '').slice(0, 8);
  const reason = s.waitingFor || 'needs you';
  const where = s.project && s.project !== name ? ` · ${s.project}` : '';
  return {
    title: `${name} needs you`,
    body: `${reason}${where}`,
    tag: `cctv:${s.id}`,
  };
}
