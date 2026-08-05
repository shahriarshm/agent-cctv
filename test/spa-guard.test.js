import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

/*
  Read and scan in JavaScript rather than shelling out to grep: a file
  containing a NUL byte classifies as binary and grep skips it silently, so a
  grep-based guard passes while checking nothing. That is exactly what happened
  to public/app.js before this test existed.
*/

/** Right-hand sides that are static icon markup, never session data. */
const STATIC_ICON_SOURCES = [
  'meta.icon',
  'sourceMeta(key).icon',
  'sourceMeta(s.source).icon',
  '`<svg viewBox="0 0 24 24" aria-hidden="true">${THEME_ICON[pref]}</svg>`',
];

function scripts() {
  return fs
    .readdirSync(PUBLIC)
    .filter((f) => f.endsWith('.js'))
    .map((f) => [f, fs.readFileSync(path.join(PUBLIC, f), 'utf8')]);
}

test('no served script contains a NUL byte', () => {
  for (const [name, src] of scripts()) {
    assert.ok(!src.includes('\u0000'), `${name} contains a raw NUL byte; write it as \\0`);
  }
});

test('innerHTML is only ever assigned static icon markup', () => {
  const assignment = /\.(?:innerHTML|outerHTML)\s*=\s*([^;\n]+)/g;
  for (const [name, src] of scripts()) {
    for (const m of src.matchAll(assignment)) {
      const rhs = m[1].trim();
      assert.ok(
        STATIC_ICON_SOURCES.includes(rhs),
        `${name}: innerHTML assigned from ${rhs}\n` +
          `Session data must be rendered with textContent. Transcripts contain\n` +
          `repository content, and on a shared server this is stored XSS behind\n` +
          `the SSO gate. If this really is static markup, add it to\n` +
          `STATIC_ICON_SOURCES in ${path.basename(import.meta.url)}.`
      );
    }
  }
});

test('insertAdjacentHTML is never used', () => {
  for (const [name, src] of scripts()) {
    assert.ok(!src.includes('insertAdjacentHTML'), `${name} uses insertAdjacentHTML`);
  }
});
