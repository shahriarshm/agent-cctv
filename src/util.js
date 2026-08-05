import crypto from 'node:crypto';
import path from 'node:path';

export function uid() {
  return Date.now().toString(36) + '-' + crypto.randomBytes(5).toString('hex');
}

/**
 * Agents write markdown; tiles show plain text. This has to run while newlines
 * are still intact — heading and bullet markers are only recognisable at the
 * start of a line, and `truncate` collapses whitespace.
 */
export function stripMarkdown(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/```[\s\S]*?```/g, ' ⟨code⟩ ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '· ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1$2')
    .replace(/\[([^\]]+)\]\(([^)]*)\)/g, '$1');
}

/** Markdown-free and collapsed to one line — for anything shown on a tile. */
export function prose(str, n = 400) {
  return truncate(stripMarkdown(str), n);
}

export function truncate(str, n = 160) {
  if (typeof str !== 'string') return '';
  const flat = str.replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat;
}

/** Last path segment, but keep one parent for common generic names. */
export function projectName(cwd) {
  if (!cwd) return 'unknown';
  const base = path.basename(cwd);
  if (['src', 'app', 'web', 'server', 'packages', 'apps'].includes(base)) {
    return path.join(path.basename(path.dirname(cwd)), base);
  }
  return base;
}

/** Bounded array that drops the oldest entries. */
export class Ring {
  constructor(limit = 200) {
    this.limit = limit;
    this.items = [];
  }
  push(item) {
    this.items.push(item);
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit);
    return item;
  }
  toArray() {
    return this.items;
  }
}

export function safeJson(str, fallback = null) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}
