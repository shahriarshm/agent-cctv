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

/** Dollar figures the drawer repeats from an agent's own accounting. */
export function money(usd) {
  if (!(usd > 0)) return '';
  return usd < 0.005 ? '<$0.01' : '$' + usd.toFixed(2);
}

export function costLine(u) {
  if (!u) return '';
  const m = money(u.cost);
  return m && u.costEstimated ? m + ' est.' : m;
}

/**
 * The billed-token splits, only the parts this agent actually records — a null
 * is "not written down", and printing 0 for it would read as a fact.
 */
export function tokenBreakdown(u) {
  if (!u) return '';
  const parts = [];
  if (u.input != null) parts.push(tokens(u.input) + ' in');
  if (u.cacheRead != null) parts.push(tokens(u.cacheRead) + ' cache read');
  if (u.cacheWrite != null) parts.push(tokens(u.cacheWrite) + ' cache write');
  if (u.output != null) parts.push(tokens(u.output) + ' out');
  if (!parts.length) return '';
  return parts.join(' · ') + (u.outputPartial ? ' (since watching)' : '');
}

/**
 * How much of what the model read came from cache — the prompt-churn gauge.
 *
 * Cache writes belong in the denominator: they are exactly the tokens that
 * were read fresh, and on Anthropic-style accounting they carry nearly all of
 * it — `input` is only the sliver neither read nor written, a few tokens per
 * request. Without them every session rounded to 100% and churn was invisible.
 * A null cacheWrite (Gemini, Codex) means the agent folds everything uncached
 * into `input` already, so it counts as zero rather than poisoning the sum.
 */
export function cacheHitRate(u) {
  if (!u || u.cacheRead == null || u.input == null) return '';
  const denom = u.input + u.cacheRead + (u.cacheWrite || 0);
  if (!denom) return '';
  return Math.round((u.cacheRead / denom) * 100) + '% read from cache';
}

/**
 * Dollars per hour when the agent priced itself, output pace otherwise.
 * Quiet under five minutes — dividing by a tiny denominator prints a huge
 * rate that is really just startup noise — and quiet on partial sums, which
 * would make the rate precise-looking and wrong.
 */
export function burnRate(u, startedAt, endedAt, now = Date.now()) {
  if (!u || u.outputPartial || !startedAt) return '';
  const hours = ((endedAt || now) - startedAt) / 3_600_000;
  if (hours < 5 / 60) return '';
  if (u.cost > 0) return money(u.cost / hours) + '/hr';
  if (u.output > 0) return '~' + tokens(Math.round(u.output / (hours * 60))) + ' out tok/min';
  return '';
}

/** The session's age. Unlike since(), an archive can be days wide. */
export function span(ms) {
  if (ms == null || ms < 0) return '';
  const m = Math.floor(ms / 60_000);
  if (m < 1) return '<1m';
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 48) return h + 'h ' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}

export function outPerTurn(u, turns) {
  if (!u || !(u.output > 0) || !turns) return '';
  return '~' + tokens(Math.round(u.output / turns)) + ' out/turn';
}

/** How long a tool took. Sub-second calls don't get one — a read that finished in
    40ms is not news, and printing it on every row buries the one that took 90s. */
export function took(ms) {
  if (ms == null || ms < 1000) return '';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  const s = Math.round(ms / 1000);
  return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
}
