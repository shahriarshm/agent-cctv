/*
  The small formatters the wall, the inspector and the timeline all share.

  Lifted out of app.js when focus mode needed a second copy of the timeline:
  pure functions in their own file are testable under node:test, and having one
  copy of "how long ago was that" is how the tile and the timeline keep agreeing.
*/

export function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

export function shortPath(p) {
  if (!p) return '';
  return p.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

/** Agents write markdown; a tile shows plain text. Strip the syntax, keep the words. */
export function plain(s) {
  if (!s) return '';
  return s
    .replace(/```[\s\S]*?```/g, ' ⟨code⟩ ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)\*([^*\n]+)\*/g, '$1$2')
    .replace(/^\s*[-*]\s+/gm, '· ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * How long it has been in this state.
 *
 * Seconds are dropped past a minute on purpose. On an instrument whose attention
 * currency is motion, a dozen tiles each rewriting "4m 32s" → "4m 33s" every
 * second is constant peripheral flicker that means nothing — and it trains you to
 * ignore exactly the kind of movement the wall uses to say something is wrong.
 * Past a minute the text changes once a minute, and motion is meaningful again.
 */
export function since(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm';
}

export function clockTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

export function tokens(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1e6) return Math.round(n / 1000) + 'k';
  return (n / 1e6).toFixed(n < 1e7 ? 1 : 0) + 'M';
}

/** How long a tool took. Sub-second calls don't get one — a read that finished in
    40ms is not news, and printing it on every row buries the one that took 90s. */
export function took(ms) {
  if (ms == null || ms < 1000) return '';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  const s = Math.round(ms / 1000);
  return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
}
