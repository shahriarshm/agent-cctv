import './helpers/env.js'; // must come first — see the file's comment
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseYaml, stringifyYaml } from '../src/yaml.js';

/* ── writing the subset ──────────────────────────────────────────────────── */

const ROUND_TRIP = [
  [
    'the documented view shape',
    {
      name: 'Frontend work',
      order: 20,
      mode: 'focus',
      groupBy: 'branch',
      match: {
        project: ['web-*', 'design-system'],
        branch: 'feat/*',
        exclude: { cwd: '*/scratch/*' },
      },
    },
  ],
  ['a bare name', { name: 'x' }],
  ['an empty document', {}],
  ['booleans and numbers', { a: true, b: false, c: 0, d: -3 }],
];

for (const [label, value] of ROUND_TRIP) {
  test(`round-trips ${label}`, () => {
    const text = stringifyYaml(value);
    assert.deepEqual(parseYaml(text).value, value, `via:\n${text}`);
  });
}

/** Each of these must survive being written and read back verbatim. */
for (const raw of ['*glob', 'a # b', 'key: value', '123', 'true', '', '  padded  ', 'feat/*', '-x']) {
  test(`quotes ${JSON.stringify(raw)} so it survives the round trip`, () => {
    const text = stringifyYaml({ v: raw });
    assert.equal(parseYaml(text).value.v, raw, `via: ${text.trim()}`);
  });
}

test('a list of scalars is written inline', () => {
  assert.match(stringifyYaml({ v: ['a', 'b'] }), /v: \[a, b\]/);
});

test('refuses what the subset cannot represent', () => {
  assert.throws(() => stringifyYaml({ a: [[1]] }), TypeError);
  assert.throws(() => stringifyYaml({ a: () => {} }), TypeError);
  assert.throws(() => stringifyYaml({ a: [{ b: 1 }] }), TypeError);
  // `key:` with nothing under it is what the parser refuses, and there is no
  // inline {} in this subset to fall back on.
  assert.throws(() => stringifyYaml({ match: {} }), TypeError);
});

/* ── writing a view ──────────────────────────────────────────────────────── */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { slugify, writeView, loadViews } from '../src/views.js';

/**
 * A views directory inside a private parent.
 *
 * The parent matters: the traversal tests assert that nothing appeared beside
 * the views directory, and os.tmpdir() is shared with every other test file
 * running in parallel — counting entries there measures the suite, not the code.
 */
function emptyDir() {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cctv-write-')), 'views');
  fs.mkdirSync(dir);
  return dir;
}

test('slugify reduces a name to something safe to be a filename', () => {
  assert.equal(slugify('Needs me'), 'needs-me');
  assert.equal(slugify('Frontend  Work!!'), 'frontend-work');
  assert.equal(slugify('2 fast'), '2-fast');
  assert.equal(slugify('   '), '');
  assert.equal(slugify('---'), '');
  assert.equal(slugify('../../etc/passwd'), 'etc-passwd');
});

/** Nothing may ever land outside the views directory, whatever the name says. */
for (const name of ['../../etc/passwd', 'a/b', '.', '..', '', '   ', '///']) {
  test(`refuses to write ${JSON.stringify(name)} outside the directory`, () => {
    const dir = emptyDir();
    const parent = path.dirname(dir);
    const before = fs.readdirSync(parent).length;
    let threw = null;
    try {
      writeView({ name, view: {} }, dir);
    } catch (err) {
      threw = err;
    }
    // Either it refused outright, or — for a name that slugs to something
    // harmless like `etc-passwd` — it wrote inside the directory and nowhere else.
    if (threw) assert.equal(threw.status, 400, threw.message);
    assert.equal(fs.readdirSync(parent).length, before, 'nothing may appear beside the views dir');
    for (const f of fs.readdirSync(dir)) {
      assert.match(f, /^[a-z0-9][a-z0-9-]*\.yaml$/, `wrote a suspicious filename: ${f}`);
    }
  });
}

test('writes a view that loads back as the same view', () => {
  const dir = emptyDir();
  const { id, file } = writeView(
    {
      name: 'Frontend work',
      view: {
        mode: 'focus',
        groupBy: 'branch',
        match: { project: ['web-*', 'api'], exclude: { cwd: '*/scratch/*' } },
      },
    },
    dir
  );
  assert.equal(id, 'frontend-work');
  assert.equal(path.basename(file), 'frontend-work.yaml');

  const { views, errors } = loadViews(dir);
  assert.deepEqual(errors, []);
  assert.equal(views.length, 1);
  assert.equal(views[0].name, 'Frontend work');
  assert.equal(views[0].mode, 'focus');
  assert.equal(views[0].groupBy, 'branch');
  assert.deepEqual(views[0].match, { project: ['web-*', 'api'], exclude: { cwd: '*/scratch/*' } });
});

test('a written file says where it came from and stays hand-editable', () => {
  const dir = emptyDir();
  const { file } = writeView({ name: 'X', view: {} }, dir);
  const body = fs.readFileSync(file, 'utf8');
  assert.match(body, /^# Written by the agent-cctv dashboard/);
  assert.match(body, /name: X/);
  // Defaults are not written out: a saved file says only what it means.
  assert.doesNotMatch(body, /order:/);
  assert.doesNotMatch(body, /mode:/);
  assert.doesNotMatch(body, /groupBy:/);
  assert.doesNotMatch(body, /match:/);
});

test('an existing view is not overwritten unless asked', () => {
  const dir = emptyDir();
  writeView({ name: 'Dup', view: { groupBy: 'project' } }, dir);
  const err = refusedWrite(() => writeView({ name: 'Dup', view: {} }, dir));
  assert.equal(err.status, 409);
  assert.match(err.message, /already exists/);

  writeView({ name: 'Dup', view: { groupBy: 'agent' }, replace: true }, dir);
  assert.equal(loadViews(dir).views[0].groupBy, 'agent');
});

test('a view that would not load cannot be written', () => {
  const dir = emptyDir();
  const err = refusedWrite(() => writeView({ name: 'Bad', view: { match: { repo: 'x' } } }, dir));
  assert.equal(err.status, 400);
  assert.match(err.message, /unknown match field/);
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing may be written when validation fails');
});

function refusedWrite(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail('expected a refusal, nothing was thrown');
}

/* ── the write route ─────────────────────────────────────────────────────── */

import { createServer } from '../src/server.js';
import { Store } from '../src/store.js';

const TOKEN = 'w'.repeat(32);

async function serve(viewsDir) {
  const server = createServer({ store: new Store(), withSource: false, token: TOKEN, viewsDir });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    post: (body, headers = {}) =>
      fetch(`http://127.0.0.1:${port}/api/views?token=${TOKEN}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
    get: () => fetch(`http://127.0.0.1:${port}/api/views?token=${TOKEN}`).then((r) => r.json()),
    bare: (body) =>
      fetch(`http://127.0.0.1:${port}/api/views`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    close: () => new Promise((r) => server.close(r)),
  };
}

test('POST /api/views requires a token', async () => {
  const s = await serve(emptyDir());
  try {
    assert.equal((await s.bare({ name: 'X' })).status, 401);
  } finally {
    await s.close();
  }
});

test('POST /api/views writes a view and serves it back', async () => {
  const dir = emptyDir();
  const s = await serve(dir);
  try {
    const res = await s.post({ name: 'Needs me', view: { match: { state: 'attention' } } });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { id: 'needs-me' });

    const catalog = await s.get();
    assert.deepEqual(catalog.views.map((v) => v.id), ['needs-me']);
    assert.deepEqual(catalog.errors, []);
  } finally {
    await s.close();
  }
});

test('POST /api/views refuses a duplicate unless told to replace', async () => {
  const dir = emptyDir();
  const s = await serve(dir);
  try {
    assert.equal((await s.post({ name: 'Dup' })).status, 201);
    const dup = await s.post({ name: 'Dup' });
    assert.equal(dup.status, 409);
    assert.match((await dup.json()).error, /already exists/);
    assert.equal((await s.post({ name: 'Dup', replace: true })).status, 201);
  } finally {
    await s.close();
  }
});

test('POST /api/views refuses a nameless view and an invalid one', async () => {
  const s = await serve(emptyDir());
  try {
    assert.equal((await s.post({ name: '   ' })).status, 400);
    assert.equal((await s.post({ name: 'X', view: { match: { repo: 'y' } } })).status, 400);
    assert.equal((await s.post({ name: 'X', view: { mode: 'sideways' } })).status, 400);
  } finally {
    await s.close();
  }
});

/* ── the extracted formatters ────────────────────────────────────────────── */

import { plain, since, tokens, took, shortPath } from '../public/format.js';
import { foldTools } from '../public/timeline.js';

test('plain strips markdown down to the words', () => {
  assert.equal(plain('# Heading'), 'Heading');
  assert.equal(plain('**bold** and *em*'), 'bold and em');
  assert.equal(plain('use `npm test` now'), 'use npm test now');
  assert.equal(plain('```js\nconst x = 1\n```'), '⟨code⟩');
  assert.equal(plain('- one\n- two'), '· one · two');
  assert.equal(plain('see [the docs](http://x)'), 'see the docs');
  assert.equal(plain(''), '');
  assert.equal(plain(null), '');
});

test('since drops seconds past a minute, because flicker means nothing', () => {
  const now = Date.now();
  assert.equal(since(now - 45_000), '45s');
  assert.equal(since(now - 3 * 60_000), '3m');
  assert.equal(since(now - (2 * 60 + 5) * 60_000), '2h 5m');
  assert.equal(since(0), '');
});

test('tokens abbreviates the way the tiles read', () => {
  assert.equal(tokens(0), '0');
  assert.equal(tokens(999), '999');
  assert.equal(tokens(1000), '1k');
  assert.equal(tokens(222_000), '222k');
  assert.equal(tokens(1_200_000), '1.2M');
  assert.equal(tokens(12_000_000), '12M');
});

test('took stays quiet about sub-second calls', () => {
  assert.equal(took(null), '');
  assert.equal(took(40), '');
  assert.equal(took(1500), '1.5s');
  assert.equal(took(95_000), '1m 35s');
});

test('shortPath collapses a home directory', () => {
  assert.equal(shortPath('/Users/me/code/x'), '~/code/x');
  assert.equal(shortPath('/home/me/code/x'), '~/code/x');
  assert.equal(shortPath(''), '');
});

test('foldTools makes a tool call one row, and leaves an orphan result alone', () => {
  const folded = foldTools([
    { id: 'a', kind: 'tool_start', ts: 1, tool: { id: 't1', phase: 'start' }, detail: 'npm test' },
    { id: 'b', kind: 'tool_end', ts: 2, tool: { id: 't1', phase: 'end', durationMs: 1200 } },
    { id: 'c', kind: 'tool_end', ts: 3, tool: { id: 't9', phase: 'end' } },
  ]);
  assert.equal(folded.length, 2, 'the pair is one row');
  // The row keeps the call's identity and time, and takes the result's outcome.
  assert.equal(folded[0].id, 'a');
  assert.equal(folded[0].ts, 1);
  assert.equal(folded[0].detail, 'npm test', 'a result with no detail keeps the call’s');
  assert.equal(folded[0].tool.durationMs, 1200);
  assert.equal(folded[1].id, 'c', 'a result with no start still gets a row');
});
