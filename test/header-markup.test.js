import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STATES } from '../public/match.js';

/*
  index.html and the modules that drive it hold several lists that have to agree
  and that nothing else checks: the state a readout filters by must be one
  match.js can evaluate, and the modes app.js knows must be the modes the header
  offers. Both used to be kept in step by hand, and both are the kind of thing
  that breaks silently — a wrong data-filter does not throw, it just quietly
  matches nothing on the wall.

  These are text scans rather than a DOM parse on purpose: pulling in a parser
  would be the project's first runtime-adjacent dependency, and the markup this
  guards is hand-written and small.
*/

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function readHtml() {
  return fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
}

function readScript(name) {
  return fs.readFileSync(path.join(ROOT, 'public', name), 'utf8');
}

/** Every <button …> open tag in the document, as raw text. */
function buttons(html) {
  return [...html.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
}

/** The value of `attr` on a raw open tag, or null. */
function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : null;
}

test('every state readout filters by something match.js can evaluate', () => {
  const html = readHtml();
  const filters = buttons(html)
    .filter((tag) => tag.includes('class="readout"'))
    .map((tag) => attr(tag, 'data-filter'));

  assert.ok(filters.length >= 4, `expected at least 4 readouts, found ${filters.length}`);

  for (const f of filters) {
    assert.ok(
      f === 'all' || Object.hasOwn(STATES, f),
      `readout data-filter="${f}" is neither "all" nor a key of STATES in public/match.js`
    );
  }
});

test('the mode toggle offers exactly the modes app.js knows, in order', () => {
  const html = readHtml();
  const app = readScript('app.js');

  const declared = app.match(/const MODES = \[([^\]]*)\]/);
  assert.ok(declared, 'could not find `const MODES = [...]` in public/app.js');
  const modes = [...declared[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

  const offered = buttons(html)
    .filter((tag) => tag.includes('class="seg-btn"'))
    .map((tag) => attr(tag, 'data-mode'));

  assert.deepEqual(
    offered,
    modes,
    'the header offers different modes, or a different order, than MODES in public/app.js'
  );
});

test('every icon-only control carries an accessible name', () => {
  const html = readHtml();
  /*
    A button whose entire visible content is an <svg> has no accessible name of
    its own — a screen reader announces "button" and nothing else. This is the
    failure a header made of icons is most able to introduce, and it is silent
    to everyone not using one, so it gets a guard rather than a promise.
  */
  for (const m of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    const [, rawAttrs, inner] = m;
    const tag = `<button${rawAttrs}>`;
    const withoutSvg = inner.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<!--[\s\S]*?-->/g, '');
    const hasText = /[^\s<>]/.test(withoutSvg.replace(/<[^>]*>/g, ''));
    if (hasText) continue;

    const name = attr(tag, 'aria-label');
    assert.ok(name && name.trim(), `icon-only button has no aria-label:\n  ${tag.replace(/\s+/g, ' ')}`);
  }
});
