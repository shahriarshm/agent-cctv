# View Presets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user define named views of the wall as files in `~/.agent-cctv/views/`, each with a match language richer than the three header selects, and switch between them from the header.

**Architecture:** The server reads, parses and validates the view files and serves them at `GET /api/views`; the browser evaluates the match against the sessions it already holds, so switching views is instant and the four readouts recount against the view. The glob compiler and match predicate live in one pure module, `public/match.js`, imported by both ends — the same trick `public/notify.js` already uses to stay testable under `node:test`.

**Tech Stack:** Node ≥18, ESM, zero runtime dependencies. Tests are `node --test`. No build step — `public/` is served as-is.

**Spec:** `docs/superpowers/specs/2026-08-05-view-presets-design.md`

## Global Constraints

- **Zero runtime dependencies.** No npm packages, ever. This is why the YAML parser is hand-written.
- Node ≥18, ESM (`import`/`export`), no build step, no TypeScript.
- **Never write to the views directory.** No seeding, no "save as", no auto-created example files.
- **A machine with no view files must behave exactly as it does today**, including no new header chrome.
- Unknown keys and unknown values are load errors naming the file and line — never a silent ignore.
- Everything under `/api/` is token-gated. `/api/views` is no exception: a view file names projects and branches.
- `test/spa-guard.test.js` scans every `public/*.js`: no `innerHTML` assignment from anything but the listed static icon sources, no `insertAdjacentHTML`, no raw NUL bytes. New browser modules must render with `textContent`.
- Run the full suite with `npm test` before every commit.

## File Structure

**Create:**
- `src/yaml.js` — the strict YAML subset parser. Returns `{value, lines}`; throws `YamlError` carrying a line number.
- `src/views.js` — find, read, parse, validate and normalize view files; watch the directory.
- `public/match.js` — pure glob compiler and match predicate. No DOM, no imports. Shared by browser and server.
- `public/views.js` — the picker: builds the select, tracks the current view, exposes `inView(session)`.
- `test/views.test.js` — parser, matcher, loader, and the route.

**Modify:**
- `src/paths.js` — `VIEWS_DIR`.
- `src/server.js` — the `/api/views` route, the watcher, the `views` broadcast.
- `public/app.js` — population gate, counts, alert gate, empty copy, boot.
- `public/index.html` — the picker markup.
- `public/styles.css` — the warning affordance.
- `bin/cctv.js` — the `views` command, doctor's line, help text.
- `README.md` — the format and the directory.

---

### Task 1: The strict YAML subset parser

A parser that positively recognises a small grammar and refuses everything else with a line number. The refusals are the point: a parser that guesses would eventually read `branch: "feat/*" # temporary` as a pattern containing a comment and put the wrong sessions on the wall while looking completely confident.

**Files:**
- Create: `src/yaml.js`
- Test: `test/views.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `parseYaml(text) -> {value: object, lines: Map<string, number>}` — `lines` maps a dotted key path (`match.exclude.cwd`) to its 1-based line number, so semantic errors found later can still name a line.
  - `class YamlError extends Error` with a `.line` number. Its `message` is prefixed `line N: `.

- [ ] **Step 1: Write the failing tests**

Create `test/views.test.js`:

```js
import './helpers/env.js'; // must come first — see the file's comment
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseYaml, YamlError } from '../src/yaml.js';

/* ── the YAML subset ─────────────────────────────────────────────────────── */

test('parses the documented view shape', () => {
  const { value } = parseYaml(`
# a comment
name: Frontend work
order: 20
groupBy: branch

match:
  project: [web-*, design-system]
  branch: "feat/*"
  exclude:
    cwd: "*/scratch/*"
`);
  assert.deepEqual(value, {
    name: 'Frontend work',
    order: 20,
    groupBy: 'branch',
    match: {
      project: ['web-*', 'design-system'],
      branch: 'feat/*',
      exclude: { cwd: '*/scratch/*' },
    },
  });
});

test('a comment after a quoted value is a comment, not part of the value', () => {
  const { value } = parseYaml('branch: "feat/*" # temporary\nname: x # trailing');
  assert.equal(value.branch, 'feat/*');
  assert.equal(value.name, 'x');
});

test('a hash inside a value or without leading space is not a comment', () => {
  const { value } = parseYaml('project: web#1\nname: "a # b"');
  assert.equal(value.project, 'web#1');
  assert.equal(value.name, 'a # b');
});

test('block lists parse', () => {
  const { value } = parseYaml('match:\n  project:\n    - web-app\n    - api\n');
  assert.deepEqual(value.match.project, ['web-app', 'api']);
});

test('scalars keep their types', () => {
  const { value } = parseYaml('a: 12\nb: -3\nc: true\nd: false\ne: hello there\nf: "7"');
  assert.deepEqual(value, { a: 12, b: -3, c: true, d: false, e: 'hello there', f: '7' });
});

test('records the line of every key', () => {
  const { lines } = parseYaml('name: x\nmatch:\n  branch: main\n  exclude:\n    cwd: /tmp\n');
  assert.equal(lines.get('name'), 1);
  assert.equal(lines.get('match'), 2);
  assert.equal(lines.get('match.branch'), 3);
  assert.equal(lines.get('match.exclude.cwd'), 5);
});

test('an unquoted * is refused, because YAML would read it as an alias', () => {
  const err = assert.throws(() => parseYaml('name: x\ncwd: */scratch/*\n'), YamlError);
  assert.equal(err.line, 2);
  assert.match(err.message, /quote it/);
});

for (const [label, src, line] of [
  ['tabs', 'match:\n\tbranch: main\n', 2],
  ['block scalars', 'name: |\n  text\n', 1],
  ['multi-document', 'name: a\n---\nname: b\n', 2],
  ['anchors', 'name: &anchor x\n', 1],
  ['inline maps', 'match: {branch: main}\n', 1],
  ['unterminated quotes', 'name: "unclosed\n', 1],
  ['a line that is not a key', 'just some words\n', 1],
  ['a key with no space after the colon', 'name:value\n', 1],
  ['duplicate keys', 'name: a\nname: b\n', 2],
  ['a key with nothing under it', 'name: a\nmatch:\n', 2],
  ['a list item with no key above it', '- one\n', 1],
  ['inconsistent indentation', 'match:\n    branch: a\n  cwd: b\n', 3],
]) {
  test(`refuses ${label}, naming the line`, () => {
    const err = assert.throws(() => parseYaml(src), YamlError);
    assert.equal(err.line, line, `expected line ${line}, got: ${err.message}`);
  });
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/shahriar/PV/fun/agent-cctv && node --test test/views.test.js`
Expected: FAIL — `Cannot find module '.../src/yaml.js'`.

- [ ] **Step 3: Write the parser**

Create `src/yaml.js`:

```js
/*
  A deliberately small YAML.

  agent-cctv has no dependencies and is keeping it that way, so YAML support is a
  parser we own. It therefore recognises one shallow grammar — comments, `key:
  value`, quoted strings, inline and block lists, nested maps — and refuses
  everything else by name and line number.

  The refusals are the design. A parser that guessed at the YAML it only half
  understood would eventually read `branch: "feat/*" # temporary` as a branch
  pattern containing a comment, put the wrong sessions on the wall, and look
  entirely confident doing it. Refusing what it does not fully understand is the
  same argument this tool already makes for not printing a dollar figure it would
  have to estimate.
*/

export class YamlError extends Error {
  constructor(message, line) {
    super(`line ${line}: ${message}`);
    this.name = 'YamlError';
    this.line = line;
  }
}

/**
 * @returns {{value: object, lines: Map<string, number>}} `lines` maps a dotted
 * key path to the line it was written on, so a semantic error found later —
 * an unknown field, an impossible state — can still point at a line.
 */
export function parseYaml(text) {
  const lines = new Map();
  const rows = String(text).split(/\r?\n/);
  const root = {};
  /*
    Outermost frame first, current frame last. `indent: null` marks a container
    opened by a bare `key:` whose depth and kind — map or list — are not known
    until its first child line turns up.
  */
  const stack = [{ indent: 0, node: root, path: '' }];

  for (let i = 0; i < rows.length; i++) {
    const no = i + 1;
    const row = rows[i];
    if (/^ *\t/.test(row)) throw new YamlError('tabs cannot indent a line — use spaces', no);

    const uncommented = stripComment(row);
    if (!uncommented.trim()) continue;

    const indent = uncommented.length - uncommented.trimStart().length;
    const body = uncommented.trim();
    if (body === '---' || body === '...') {
      throw new YamlError('multi-document files are not supported', no);
    }

    let top = stack[stack.length - 1];

    // The first child of a bare `key:` decides both its depth and its kind.
    if (top.indent === null) {
      if (indent <= stack[stack.length - 2].indent) {
        throw new YamlError(`"${top.key}:" has nothing indented under it`, top.line);
      }
      top.node = body.startsWith('-') ? [] : {};
      top.parent[top.key] = top.node;
      top.indent = indent;
    }

    while (stack.length > 1 && indent < top.indent) {
      stack.pop();
      top = stack[stack.length - 1];
    }
    if (indent > top.indent) throw new YamlError('inconsistent indentation', no);

    if (body === '-' || body.startsWith('- ')) {
      if (!Array.isArray(top.node)) throw new YamlError('a list item needs a key above it', no);
      const item = body.slice(1).trim();
      if (!item) throw new YamlError('a list item needs its value on the same line', no);
      top.node.push(scalar(item, no));
      continue;
    }
    if (Array.isArray(top.node)) throw new YamlError('expected a list item ("- value") here', no);

    const m = /^([A-Za-z][A-Za-z0-9_-]*)\s*:(?:\s(.*))?$/.exec(body);
    if (!m) throw new YamlError(`expected "key: value", found ${JSON.stringify(body)}`, no);

    const key = m[1];
    const rest = (m[2] || '').trim();
    if (Object.prototype.hasOwnProperty.call(top.node, key)) {
      throw new YamlError(`duplicate key "${key}"`, no);
    }
    const path = top.path ? `${top.path}.${key}` : key;
    lines.set(path, no);

    if (rest === '') {
      stack.push({ indent: null, node: null, path, parent: top.node, key, line: no });
    } else {
      top.node[key] = scalar(rest, no);
    }
  }

  const last = stack[stack.length - 1];
  if (last.indent === null) {
    throw new YamlError(`"${last.key}:" has nothing indented under it`, last.line);
  }
  return { value: root, lines };
}

/** A `#` starts a comment only at the start of a line or after whitespace, and
 *  never inside quotes — so `web#1` and `"a # b"` both survive intact. */
function stripComment(row) {
  let quote = null;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(row[i - 1]))) {
      return row.slice(0, i);
    }
  }
  return row;
}

function scalar(s, no) {
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) throw new YamlError('an inline list must close on the same line', no);
    const inner = s.slice(1, -1).trim();
    return inner ? splitInline(inner, no).map((v) => scalar(v, no)) : [];
  }
  if (s.startsWith('{')) {
    throw new YamlError('inline maps are not supported — use an indented block', no);
  }
  if (s.startsWith('|') || s.startsWith('>')) {
    throw new YamlError('block scalars (| and >) are not supported', no);
  }
  if (s.startsWith('&')) throw new YamlError('anchors are not supported', no);
  if (s.startsWith('*')) {
    // The common case this catches is a glob: `cwd: */scratch/*`, which YAML
    // reads as an alias to an anchor that does not exist.
    throw new YamlError(`a value starting with * is a YAML alias — quote it: "${s}"`, no);
  }
  for (const q of ['"', "'"]) {
    if (s.startsWith(q)) {
      if (s.length < 2 || !s.endsWith(q)) throw new YamlError('unterminated quoted string', no);
      return s.slice(1, -1);
    }
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}

function splitInline(s, no) {
  if (s.includes('[') || s.includes('{')) {
    throw new YamlError('nested inline collections are not supported', no);
  }
  const out = [];
  let cur = '';
  let quote = null;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ',') {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (quote) throw new YamlError('unterminated quoted string', no);
  if (cur.trim()) out.push(cur.trim());
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/views.test.js`
Expected: PASS, all of them. If the `inconsistent indentation` case reports the wrong line, check the dedent loop — it must pop *before* comparing, and a line deeper than its parent with no opening `key:` is an error, not a new container.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS. `spa-guard` scans `public/` only, so nothing there changes yet.

- [ ] **Step 6: Commit**

```bash
git add src/yaml.js test/views.test.js
git commit -m "feat: a strict YAML subset parser that refuses what it cannot read"
```

---

### Task 2: The match predicate

One implementation of what a view *means*, pure and DOM-free, imported by the browser to evaluate and by the loader to validate. It lives in `public/` because only files under `public/` are reachable by the browser, and `src/` importing from it is the cheaper direction than keeping two copies in sync.

**Files:**
- Create: `public/match.js`
- Test: `test/views.test.js` (append)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `FIELDS: Record<string, (session) => string|null>` — the matchable fields and how to read each off a serialized session.
  - `STATES: Record<string, (session) => boolean>` — `busy`, `waiting`, `idle`, `ended`, `live`, `attention`.
  - `glob(pattern) -> (value: string) => boolean` — anchored, case-insensitive.
  - `compile(match) -> (session) => boolean` — the whole predicate, exclude included.

- [ ] **Step 1: Write the failing tests**

Append to `test/views.test.js`:

```js
/* ── the matcher ─────────────────────────────────────────────────────────── */

import { compile, glob } from '../public/match.js';

/** A serialized session, as store.js serialize() produces it. */
function session(over = {}) {
  return {
    id: 'x',
    source: 'claude-code',
    name: 'web-app',
    project: 'web-app',
    cwd: '/Users/me/code/web-app',
    gitBranch: 'main',
    model: 'claude-opus-5',
    state: 'busy',
    urgent: false,
    ...over,
  };
}

test('a glob is anchored and case-insensitive', () => {
  assert.equal(glob('web-*')('web-app'), true);
  assert.equal(glob('web-*')('WEB-APP'), true);
  assert.equal(glob('web-*')('my-web-app'), false, 'must not match a prefix');
  assert.equal(glob('*/scratch/*')('/Users/me/scratch/x'), true);
  assert.equal(glob('a?c')('abc'), true);
  assert.equal(glob('a?c')('ac'), false);
});

test('a glob does not let regex metacharacters through', () => {
  assert.equal(glob('a.c')('abc'), false);
  assert.equal(glob('a.c')('a.c'), true);
  assert.equal(glob('a+')('aaa'), false);
});

test('an empty match takes everything', () => {
  assert.equal(compile({})(session()), true);
  assert.equal(compile(undefined)(session()), true);
});

test('a list is OR, separate fields are AND', () => {
  const m = compile({ project: ['web-*', 'api'], branch: 'main' });
  assert.equal(m(session()), true);
  assert.equal(m(session({ project: 'api' })), true);
  assert.equal(m(session({ project: 'docs' })), false);
  assert.equal(m(session({ branch: 'feat/x' })), false, 'fields must AND');
});

test('exclude beats include', () => {
  const m = compile({ project: 'web-*', exclude: { cwd: '*/scratch/*' } });
  assert.equal(m(session()), true);
  assert.equal(m(session({ cwd: '/Users/me/scratch/web-app' })), false);
});

test('a session missing the field never matches it', () => {
  const m = compile({ branch: 'feat/*' });
  assert.equal(m(session({ gitBranch: null })), false);
  assert.equal(m(session({ gitBranch: '' })), false);
});

test('a session missing the field is not excluded by an exclude on it', () => {
  const m = compile({ exclude: { branch: 'feat/*' } });
  assert.equal(m(session({ gitBranch: null })), true);
});

test('state matches the store states and the two aliases', () => {
  assert.equal(compile({ state: 'busy' })(session({ state: 'busy' })), true);
  assert.equal(compile({ state: 'busy' })(session({ state: 'idle' })), false);
  assert.equal(compile({ state: 'live' })(session({ state: 'idle' })), true);
  assert.equal(compile({ state: 'live' })(session({ state: 'ended' })), false);
  assert.equal(compile({ state: 'attention' })(session({ state: 'waiting' })), true);
  assert.equal(compile({ state: 'attention' })(session({ state: 'busy', urgent: true })), true);
  assert.equal(compile({ state: 'attention' })(session({ state: 'idle' })), false);
  assert.equal(compile({ state: ['busy', 'idle'] })(session({ state: 'idle' })), true);
});

test('agent matches the source id', () => {
  assert.equal(compile({ agent: 'codex' })(session({ source: 'codex' })), true);
  assert.equal(compile({ agent: 'codex' })(session()), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/views.test.js`
Expected: FAIL — `Cannot find module '.../public/match.js'`.

- [ ] **Step 3: Write the matcher**

Create `public/match.js`:

```js
/*
  What a view means, as a pure function.

  Pure and DOM-free for the same reason notify.js is: the decision worth getting
  right is testable under node:test. It lives in public/ because that is the only
  directory the browser can reach, and src/views.js imports it from here so that
  a pattern is validated by the very code that will later evaluate it — one
  implementation, not two that drift.
*/

/** The fields a view may match on, and how to read each off a serialized session. */
export const FIELDS = {
  agent: (s) => s.source,
  project: (s) => s.project,
  cwd: (s) => s.cwd,
  branch: (s) => s.gitBranch,
  model: (s) => s.model,
  name: (s) => s.name,
};

/**
 * `state` is enumerated rather than globbed, so a typo is refused where the file
 * is read instead of quietly matching nothing on the wall. `live` and
 * `attention` are the two the header already thinks in.
 */
export const STATES = {
  busy: (s) => s.state === 'busy',
  waiting: (s) => s.state === 'waiting',
  idle: (s) => s.state === 'idle',
  ended: (s) => s.state === 'ended',
  live: (s) => s.state !== 'ended',
  attention: (s) => !!s.urgent || s.state === 'waiting',
};

/** A glob — `*` for any run, `?` for one — anchored to the whole string. */
export function glob(pattern) {
  const source = String(pattern).replace(/[\\^$.|?*+()[\]{}]/g, (ch) =>
    ch === '*' ? '.*' : ch === '?' ? '.' : '\\' + ch
  );
  const re = new RegExp(`^${source}$`, 'i');
  return (value) => re.test(value);
}

/**
 * Compile a view's `match` into one predicate.
 *
 * A list of values is OR, separate fields are AND, and `exclude` wins over
 * everything. A session that does not carry the field at all never matches a
 * pattern on it — absence is not a wildcard, in either direction.
 */
export function compile(match) {
  const include = rules(match || {});
  const exclude = rules((match && match.exclude) || {});
  return (s) => include.every((fn) => fn(s)) && !exclude.some((fn) => fn(s));
}

function rules(spec) {
  const out = [];
  for (const [field, value] of Object.entries(spec)) {
    if (field === 'exclude') continue;
    const values = Array.isArray(value) ? value : [value];
    if (field === 'state') {
      const tests = values.map((v) => STATES[v]).filter(Boolean);
      out.push((s) => tests.some((t) => t(s)));
      continue;
    }
    const read = FIELDS[field];
    if (!read) continue; // validated at load; ignored here rather than thrown at paint time
    const tests = values.map(glob);
    out.push((s) => {
      const v = read(s);
      return typeof v === 'string' && v !== '' && tests.some((t) => t(v));
    });
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/views.test.js`
Expected: PASS.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS — including `spa-guard`, which now also scans `public/match.js`.

- [ ] **Step 6: Commit**

```bash
git add public/match.js test/views.test.js
git commit -m "feat: the view match predicate, shared by both ends"
```

---

### Task 3: Loading and validating view files

**Files:**
- Create: `src/views.js`
- Modify: `src/paths.js`
- Test: `test/views.test.js` (append)

**Interfaces:**
- Consumes: `parseYaml`, `YamlError` (Task 1); `FIELDS`, `STATES` (Task 2).
- Produces:
  - `VIEWS_DIR: string` from `src/paths.js`.
  - `loadViews(dir?) -> {dir: string, views: View[], errors: {file, line, message}[]}` — never throws.
  - `View = {id, name, order, groupBy: string|null, match: object}`, sorted by `order` then `name`.
  - `watchViews(onChange, dir?) -> () => void` — debounced; returns a stop function.

- [ ] **Step 1: Write the failing tests**

Append to `test/views.test.js`:

```js
/* ── loading ─────────────────────────────────────────────────────────────── */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadViews } from '../src/views.js';

function viewsDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cctv-views-'));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

test('a missing directory is no views and no error', () => {
  const r = loadViews(path.join(os.tmpdir(), 'cctv-does-not-exist-' + process.pid));
  assert.deepEqual(r.views, []);
  assert.deepEqual(r.errors, []);
});

test('loads yaml and json, ignores everything else', () => {
  const dir = viewsDir({
    'frontend.yaml': 'name: Frontend\nmatch:\n  project: web-*\n',
    'backend.yml': 'name: Backend\n',
    'ops.json': '{"name": "Ops", "match": {"branch": "main"}}',
    'notes.txt': 'ignored',
    'README.md': 'ignored',
  });
  const { views, errors } = loadViews(dir);
  assert.deepEqual(errors, []);
  assert.deepEqual(views.map((v) => v.id).sort(), ['backend', 'frontend', 'ops']);
});

test('the id is the filename and the name defaults to it', () => {
  const { views } = loadViews(viewsDir({ 'needs-me.yaml': 'match:\n  state: attention\n' }));
  assert.equal(views[0].id, 'needs-me');
  assert.equal(views[0].name, 'needs-me');
  assert.equal(views[0].order, 100);
  assert.equal(views[0].groupBy, null);
});

test('views sort by order, then by name', () => {
  const { views } = loadViews(
    viewsDir({
      'c.yaml': 'name: C\n',
      'a.yaml': 'name: A\norder: 50\n',
      'b.yaml': 'name: B\norder: 50\n',
    })
  );
  assert.deepEqual(views.map((v) => v.name), ['A', 'B', 'C']);
});

test('one broken file does not stop the others, and is reported with its line', () => {
  const dir = viewsDir({
    'good.yaml': 'name: Good\n',
    'bad.yaml': 'name: Bad\ngroupby: project\n',
  });
  const { views, errors } = loadViews(dir);
  assert.deepEqual(views.map((v) => v.id), ['good']);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].file, 'bad.yaml');
  assert.equal(errors[0].line, 2);
  assert.match(errors[0].message, /unknown key "groupby"/);
});

test('two files claiming one id is an error naming both', () => {
  const { errors } = loadViews(viewsDir({ 'x.yaml': 'name: A\n', 'x.json': '{"name":"B"}' }));
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /duplicate view id "x"/);
  assert.match(errors[0].message, /x\.json|x\.yaml/);
});

for (const [label, body, pattern] of [
  ['an unknown match field', 'match:\n  repo: web\n', /unknown match field "repo"/],
  ['an impossible state', 'match:\n  state: workingish\n', /is not a state/],
  ['a bad groupBy', 'groupBy: repo\n', /"groupBy" must be one of/],
  ['a non-integer order', 'order: high\n', /"order" must be a whole number/],
  ['an empty name', 'name: ""\n', /"name" must be a non-empty string/],
  ['a non-string pattern', 'match:\n  project: 12\n', /takes strings/],
  ['a nested exclude', 'match:\n  exclude:\n    exclude:\n      cwd: /tmp\n', /cannot be nested/],
]) {
  test(`refuses ${label}`, () => {
    const { views, errors } = loadViews(viewsDir({ 'v.yaml': body }));
    assert.deepEqual(views, []);
    assert.equal(errors.length, 1, `expected one error, got ${JSON.stringify(errors)}`);
    assert.match(errors[0].message, pattern);
  });
}

test('malformed json is reported, not thrown', () => {
  const { views, errors } = loadViews(viewsDir({ 'v.json': '{"name": ' }));
  assert.deepEqual(views, []);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].file, 'v.json');
});

test('a loaded view compiles into a working predicate', () => {
  const { views } = loadViews(
    viewsDir({ 'f.yaml': 'match:\n  project: [web-*, api]\n  exclude:\n    branch: wip/*\n' })
  );
  const m = compile(views[0].match);
  assert.equal(m(session({ project: 'web-app' })), true);
  assert.equal(m(session({ project: 'docs' })), false);
  assert.equal(m(session({ project: 'api', gitBranch: 'wip/x' })), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/views.test.js`
Expected: FAIL — `Cannot find module '.../src/views.js'`.

- [ ] **Step 3: Add `VIEWS_DIR` to `src/paths.js`**

After the `SPOOL_FILE` line (`src/paths.js:11`), add:

```js
/**
 * Where view presets are read from — and only ever read. Under the shipped
 * systemd unit this lands in /var/lib/agent-cctv/views, where one directory of
 * views is shared by everyone on the box, which is the right default there.
 */
export const VIEWS_DIR = process.env.AGENT_CCTV_VIEWS_DIR || path.join(ROOT, 'views');
```

- [ ] **Step 4: Write the loader**

Create `src/views.js`:

```js
/*
  View presets: files that say which sessions belong on the wall.

  Read, never written — no seeding, no "save as", no example file dropped on
  first run. A view file is always exactly what a person put there.

  Nothing here throws. A directory that does not exist is not an error, and one
  malformed file must never take the wall down with it: what parses loads, what
  does not lands in `errors` with a file and a line.
*/

import fs from 'node:fs';
import path from 'node:path';
import { VIEWS_DIR } from './paths.js';
import { parseYaml } from './yaml.js';
import { FIELDS, STATES } from '../public/match.js';

const TOP_KEYS = ['name', 'order', 'groupBy', 'match'];
/** Must stay in step with GROUPS in public/app.js. */
const GROUP_BY = ['none', 'project', 'agent', 'state', 'branch'];
const EXTENSIONS = new Set(['.yaml', '.yml', '.json']);
const MATCH_FIELDS = [...Object.keys(FIELDS), 'state', 'exclude'];

class ViewError extends Error {
  constructor(message, line = null) {
    super(message);
    this.name = 'ViewError';
    this.line = line;
  }
}

export function loadViews(dir = VIEWS_DIR) {
  const views = [];
  const errors = [];

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { dir, views, errors };
  }

  const byId = new Map();
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!EXTENSIONS.has(ext)) continue;

    const id = path.basename(entry.name, path.extname(entry.name));
    if (byId.has(id)) {
      errors.push({
        file: entry.name,
        line: null,
        message: `duplicate view id "${id}" — ${byId.get(id)} already claims it`,
      });
      continue;
    }
    byId.set(id, entry.name);

    try {
      views.push(read(path.join(dir, entry.name), id, ext));
    } catch (err) {
      errors.push({ file: entry.name, line: err.line ?? null, message: err.message });
    }
  }

  views.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  return { dir, views, errors };
}

function read(file, id, ext) {
  const raw = fs.readFileSync(file, 'utf8');
  if (ext === '.json') {
    let doc;
    try {
      doc = JSON.parse(raw);
    } catch (err) {
      throw new ViewError(err.message);
    }
    return normalize(doc, id, new Map());
  }
  const { value, lines } = parseYaml(raw);
  return normalize(value, id, lines);
}

function normalize(doc, id, lines) {
  const fail = (message, keyPath) => {
    throw new ViewError(message, keyPath ? (lines.get(keyPath) ?? null) : null);
  };

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) fail('a view must be a map of keys');
  for (const key of Object.keys(doc)) {
    if (!TOP_KEYS.includes(key)) {
      fail(`unknown key "${key}" — expected one of ${TOP_KEYS.join(', ')}`, key);
    }
  }

  const name = doc.name === undefined ? id : doc.name;
  if (typeof name !== 'string' || !name.trim()) fail('"name" must be a non-empty string', 'name');

  const order = doc.order === undefined ? 100 : doc.order;
  if (!Number.isInteger(order)) fail('"order" must be a whole number', 'order');

  const groupBy = doc.groupBy === undefined ? null : doc.groupBy;
  if (groupBy !== null && !GROUP_BY.includes(groupBy)) {
    fail(`"groupBy" must be one of ${GROUP_BY.join(', ')}`, 'groupBy');
  }

  const match = doc.match === undefined ? {} : doc.match;
  checkMatch(match, 'match', fail, false);

  return { id, name: name.trim(), order, groupBy, match };
}

function checkMatch(match, keyPath, fail, inExclude) {
  if (!match || typeof match !== 'object' || Array.isArray(match)) {
    fail(`"${keyPath}" must be a map of fields`, keyPath);
  }
  for (const [field, value] of Object.entries(match)) {
    const here = `${keyPath}.${field}`;
    if (field === 'exclude') {
      if (inExclude) fail('"exclude" cannot be nested inside another exclude', here);
      checkMatch(value, here, fail, true);
      continue;
    }
    if (field !== 'state' && !FIELDS[field]) {
      fail(`unknown match field "${field}" — expected one of ${MATCH_FIELDS.join(', ')}`, here);
    }
    const values = Array.isArray(value) ? value : [value];
    if (!values.length) fail(`"${field}" needs at least one value`, here);
    for (const v of values) {
      if (typeof v !== 'string' || !v.trim()) {
        fail(`"${field}" takes strings, found ${JSON.stringify(v)}`, here);
      }
      if (field === 'state' && !STATES[v]) {
        fail(
          `"state: ${v}" is not a state — expected one of ${Object.keys(STATES).join(', ')}`,
          here
        );
      }
    }
  }
}

/**
 * Re-read on change, debounced.
 *
 * When the directory does not exist yet its parent is watched instead, so the
 * very first view file someone writes does not need a restart to be seen — which
 * is exactly the moment a person is deciding whether this feature works.
 */
export function watchViews(onChange, dir = VIEWS_DIR) {
  let watcher = null;
  let parent = null;
  let timer = null;

  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, 60);
    timer.unref?.();
  };

  const watchTarget = () => {
    try {
      watcher = fs.watch(dir, fire);
      watcher.unref?.();
      return true;
    } catch {
      return false;
    }
  };

  if (!watchTarget()) {
    try {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      parent = fs.watch(path.dirname(dir), () => {
        if (!watcher && watchTarget()) {
          try {
            parent.close();
          } catch {}
          parent = null;
        }
        fire();
      });
      parent.unref?.();
    } catch {}
  }

  return () => {
    clearTimeout(timer);
    for (const w of [watcher, parent]) {
      try {
        w?.close();
      } catch {}
    }
    watcher = parent = null;
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/views.test.js`
Expected: PASS.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/views.js src/paths.js test/views.test.js
git commit -m "feat: load, validate and watch view preset files"
```

---

### Task 4: Serve the views

**Files:**
- Modify: `src/server.js`
- Test: `test/views.test.js` (append)

**Interfaces:**
- Consumes: `loadViews`, `watchViews` (Task 3).
- Produces: `GET /api/views` → `{dir, views, errors}`, token-gated. An SSE `views` event carrying the same payload on any change. `server.views` for tests.

- [ ] **Step 1: Write the failing tests**

Append to `test/views.test.js`:

```js
/* ── the route ───────────────────────────────────────────────────────────── */

import { createServer } from '../src/server.js';
import { Store } from '../src/store.js';

const TOKEN = 'v'.repeat(32);

async function serve(opts = {}) {
  const server = createServer({ store: new Store(), withSource: false, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: (p) => `http://127.0.0.1:${port}${p}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

test('/api/views needs a token', async () => {
  const s = await serve({ token: TOKEN });
  try {
    assert.equal((await fetch(s.url('/api/views'))).status, 401);
    const res = await fetch(s.url(`/api/views?token=${TOKEN}`));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.views));
    assert.ok(Array.isArray(body.errors));
  } finally {
    await s.close();
  }
});

test('/api/views serves what the directory holds', async () => {
  const dir = viewsDir({ 'needs-me.yaml': 'name: Needs me\nmatch:\n  state: attention\n' });
  const s = await serve({ token: TOKEN, viewsDir: dir });
  try {
    const body = await (await fetch(s.url(`/api/views?token=${TOKEN}`))).json();
    assert.deepEqual(body.views.map((v) => v.name), ['Needs me']);
    assert.deepEqual(body.views[0].match, { state: 'attention' });
  } finally {
    await s.close();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/views.test.js`
Expected: FAIL — `/api/views` returns 404 (the static file handler), so the 200 assertion fails.

- [ ] **Step 3: Wire the route**

In `src/server.js`, add to the imports at the top:

```js
import { loadViews, watchViews } from './views.js';
```

Add `viewsDir = undefined` to the `createServer` options destructure (`src/server.js:89-95`), so it sits alongside `token` and `allowedHosts`:

```js
export function createServer({
  store = new Store(),
  token = null,
  withSource = true,
  allowedHosts = ['localhost', '127.0.0.1', '::1'],
  secureCookie = false,
  viewsDir = undefined,
} = {}) {
```

Immediately after the `store.on('removed', ...)` line (`src/server.js:120`), add:

```js
  /*
    Read once at startup and again on any change, then pushed. The browser does
    the matching — it already holds every session, so a view switch is instant
    and the four readouts can recount against the view without a round trip.
  */
  let views = loadViews(viewsDir);
  const stopViews = watchViews(() => {
    views = loadViews(viewsDir);
    broadcast('views', views);
  }, viewsDir);
```

Add the route immediately after the `/api/state` line (`src/server.js:226`):

```js
    if (route === '/api/views') return json(res, 200, views);
```

In the `server.on('close', ...)` handler (`src/server.js:308`), add `stopViews();` as its first statement.

Just before `return server;` (`src/server.js:321`), add:

```js
  server.views = () => views;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/views.test.js`
Expected: PASS.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS. Watch for a hung test run — if the process does not exit, `watchViews` failed to `unref` its watcher.

- [ ] **Step 6: Commit**

```bash
git add src/server.js test/views.test.js
git commit -m "feat: serve view presets at /api/views and push them on change"
```

---

### Task 5: The picker, and the wall

The browser half. The view is the **population**; the header narrows within it. The four readouts recount against the view, so a button's figure stays exactly what clicking it leaves on the wall.

**Files:**
- Create: `public/views.js`
- Modify: `public/index.html`, `public/styles.css`, `public/app.js`
- Test: manual (browser), plus `npm test` for the spa-guard scan

**Interfaces:**
- Consumes: `compile` (Task 2), `GET /api/views` and the SSE `views` event (Task 4).
- Produces, from `public/views.js`:
  - `mountViews({initialId, onSelect}) -> void` — wires the select; `onSelect(view)` fires on a user change only.
  - `setViews(payload) -> View` — new catalog from the server; returns the resolved current view. Fires `onSelect` only if the current view vanished.
  - `inView(session) -> boolean`
  - `currentView() -> View`

- [ ] **Step 1: Add the markup**

In `public/index.html`, inside the existing `<div class="zone wall-only">` (line 63), add as the **first** child, before the `agent` label:

```html
        <label class="pick" id="pick-view-label" hidden>
          <span>view</span>
          <select id="pick-view"></select>
        </label>
        <span class="view-warn" id="view-warn" role="status" hidden></span>
```

- [ ] **Step 2: Add the warning style**

In `public/styles.css`, after the `.pick select option` rule (ends line 367), add:

```css
/* A view file that would not parse. Ember, not red: red on this wall means a
   session is blocked on you, and a config typo is the machine's problem. */
.view-warn {
  font-size: var(--t-eyebrow);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ember-ink);
  border: 1px solid var(--ember);
  border-radius: var(--radius-sm);
  padding: 3px var(--s2);
  cursor: help;
  white-space: nowrap;
}
```

- [ ] **Step 3: Write the picker**

Create `public/views.js`:

```js
/*
  The view picker.

  A view is the population of the wall; the header's state, agent and project
  controls narrow within it. Which view you are on is a per-browser preference
  and is never written to disk — two people watching the same shared server sit
  on different views.
*/

import { compile } from './match.js';

/** Always first, never a file. Matches everything, which is the old behaviour. */
export const EVERYTHING = { id: 'all', name: 'Everything', order: -1, groupBy: null, match: {} };

const label = document.getElementById('pick-view-label');
const select = document.getElementById('pick-view');
const warn = document.getElementById('view-warn');

let catalog = [EVERYTHING];
let current = EVERYTHING;
let predicate = () => true;
let notify = () => {};

export function currentView() {
  return current;
}

export function inView(s) {
  return predicate(s);
}

function select_(view) {
  current = view;
  predicate = compile(view.match);
  select.value = view.id;
}

function paint(errors) {
  // A picker for one built-in view is chrome that says nothing. Someone who
  // never writes a view file sees the header they see today.
  label.hidden = catalog.length < 2;

  const wanted = catalog.map((v) => v.id).join('\0');
  if (select.dataset.ids !== wanted) {
    select.dataset.ids = wanted;
    select.replaceChildren();
    for (const v of catalog) {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = v.name;
      select.append(opt);
    }
  }
  select.value = current.id;

  warn.hidden = !errors.length;
  if (errors.length) {
    warn.textContent = `${errors.length} view file${errors.length > 1 ? 's' : ''} failed`;
    warn.title = errors
      .map((e) => `${e.file}${e.line ? `:${e.line}` : ''} — ${e.message}`)
      .join('\n');
  }
}

/**
 * Adopt a catalog from the server. Keeps the current selection if it survived;
 * a view deleted from under you falls back to Everything and says so, rather
 * than leaving the picker pointed at nothing.
 */
export function setViews(payload) {
  catalog = [EVERYTHING, ...(payload?.views || [])];
  const still = catalog.find((v) => v.id === current.id);
  const vanished = !still;
  select_(still || EVERYTHING);
  paint(payload?.errors || []);
  if (vanished) notify(current);
  return current;
}

export function mountViews({ initialId, onSelect }) {
  notify = onSelect;
  const wanted = catalog.find((v) => v.id === initialId);
  if (wanted) select_(wanted);
  select.addEventListener('change', () => {
    const next = catalog.find((v) => v.id === select.value) || EVERYTHING;
    select_(next);
    notify(next);
  });
  paint([]);
}
```

- [ ] **Step 4: Gate the wall on the view**

All of these are in `public/app.js`.

Add to the imports beside the `notify.js` import (line 51):

```js
import { mountViews, setViews, inView, currentView } from './views.js';
```

Beside the `token` const at the top (line 8), capture the view parameter before `establishSession()` scrubs the query string:

```js
/* Read now, because establishSession() replaces the URL with a bare path once
   the cookie is established. The selection persists in localStorage from there,
   so a reload of the scrubbed URL still lands on the same view. */
const viewParam = new URLSearchParams(location.search).get('view');
```

In `visible(s)` (line 164), make the view the first gate:

```js
function visible(s) {
  if (!inView(s)) return false;
  if (filters.source !== 'all' && s.source !== filters.source) return false;
```

In `paintStats()` (line 595), count within the view:

```js
  const all = [...sessions.values()].filter(inView);
```

In `refreshFilterOptions()` (line 1012), offer only what the view left on the wall:

```js
  const all = [...sessions.values()].filter(inView);
```

In `alertFor(prev, next)` (line 405), add the membership check after the dismiss and boot guards, before `shouldNotify`:

```js
function alertFor(prev, next) {
  if (!next.urgent) return dismissAlert(next.id);
  if (!booted) return;
  /* Scoped to the view's population, never to what is on screen: sitting on the
     "working" filter must still tell you when a session leaves it for blocked —
     that transition is the only thing this alert exists for. */
  if (!inView(next)) return;
  if (!shouldNotify(prev, next)) return;
```

In `emptyCopy()` (line 556), give a view-emptied wall its own line. Replace the `filters.state === 'all' && ...` block with:

```js
  if (filters.state === 'all' && filters.source === 'all' && filters.project === 'all') {
    const view = currentView();
    if (view.id !== 'all') {
      return [
        'Nothing in this view',
        `No session matches ${view.name} right now. Switch to Everything for the whole wall.`,
      ];
    }
    return [
      'No feeds',
      'Start a Claude Code or Codex session in any terminal and it appears here. Nothing to install, nothing to restart.',
    ];
  }
```

- [ ] **Step 5: Boot the picker and follow the stream**

In `public/app.js`, add above the final `layout();` (line 1246):

```js
/* ── views ─────────────────────────────────────────────────────────────── */

/** A view seeds the group-by select on *switching to it*, and only then —
    editing some other view file must not throw away a group-by you set by
    hand. Nothing here is ever written back to the file. */
function applyView(view, { seedGroup = true } = {}) {
  filters.view = view.id;
  if (seedGroup && view.groupBy) {
    filters.groupBy = view.groupBy;
    groupSel.value = view.groupBy;
  }
  saveFilters();
  refreshFilterOptions();
  layout();
  paintStats();
}

async function loadViewCatalog() {
  try {
    const res = await fetch(api('/api/views'), { credentials: 'same-origin' });
    if (!res.ok) return;
    applyView(setViews(await res.json()));
  } catch {}
}

mountViews({ initialId: viewParam || filters.view, onSelect: applyView });
```

Then, in `connect()`, add one more listener beside the others (after the `removed` listener, line 1243):

```js
  es.addEventListener('views', (e) => {
    const before = currentView().id;
    const view = setViews(JSON.parse(e.data));
    // Only a genuine switch — the selected view was deleted — re-seeds group-by.
    applyView(view, { seedGroup: view.id !== before });
  });
```

And change the last line of the file from `establishSession().then(connect);` to:

```js
establishSession().then(() => {
  loadViewCatalog();
  connect();
});
```

- [ ] **Step 6: Run the suite**

Run: `npm test`
Expected: PASS. `spa-guard` now scans `public/views.js` — it uses `textContent` and `document.createElement`, never `innerHTML`, so it should be clean. If it fails, fix the code rather than the guard's allowlist.

- [ ] **Step 7: Verify in a browser**

```bash
mkdir -p ~/.agent-cctv/views
cat > ~/.agent-cctv/views/needs-me.yaml <<'EOF'
name: Needs me
order: 10
match:
  state: attention
EOF
node bin/cctv.js
```

Check, in order:

1. The header now has a `view` select with **Everything** and **Needs me**.
2. Selecting **Needs me** empties the wall to blocked/waiting sessions only, and the four counts drop to match — `all` now equals what the view holds, not what the machine holds.
3. `rm ~/.agent-cctv/views/needs-me.yaml` — within a second the picker loses the entry and the wall returns to Everything, with no reload.
4. Write a broken file (`echo 'groupby: x' > ~/.agent-cctv/views/bad.yaml`) — an ember "1 view file failed" appears beside the picker, its tooltip names `bad.yaml:1`, and the wall keeps working.
5. `rm ~/.agent-cctv/views/*.yaml` — the picker disappears entirely and the header is exactly what it was before this feature.
6. With a view file present again, open `http://localhost:4599/?token=…&view=needs-me` — it opens on that view.

- [ ] **Step 8: Commit**

```bash
git add public/views.js public/app.js public/index.html public/styles.css
git commit -m "feat: a view picker that sets the wall's population"
```

---

### Task 6: `agent-cctv views`

Discoverability without writing anything: the terminal tells you where the directory is, what loaded, what broke, and — when there is nothing there — what to paste.

**Files:**
- Modify: `bin/cctv.js`
- Test: `test/cli.test.js` (append)

**Interfaces:**
- Consumes: `loadViews` (Task 3).
- Produces: the `views` subcommand; one extra `doctor` row.

- [ ] **Step 1: Write the failing test**

Read `test/cli.test.js` first to match how it invokes the binary, then append a test in that style. It should spawn `node bin/cctv.js views` with `AGENT_CCTV_HOME` pointed at a temp directory and assert that:

- with no directory, the output names the path it looked in and contains `agent-cctv/views`;
- with `needs-me.yaml` present, the output contains `needs-me`;
- with a broken file present, the output contains the filename and its line, and the exit code is still 0 (a broken view file is not a broken install).

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/cli.test.js`
Expected: FAIL — `Unknown command: views`.

- [ ] **Step 3: Implement the command**

In `bin/cctv.js`, add to the imports:

```js
import { loadViews } from '../src/views.js';
```

Add to `HELP`, under `Usage`, after the `status` line:

```
  agent-cctv views          List the view presets it can see
```

Add the command function after `cmdDoctor()`:

```js
const STARTER = `name: Needs me
order: 10
match:
  state: attention
`;

function cmdViews() {
  const { dir, views, errors } = loadViews();
  const home = (p) => p.replace(process.env.HOME, '~');
  console.log('');
  console.log(`  ${c.bold('views')} ${c.dim('· ' + home(dir))}`);
  console.log('');

  for (const v of views) {
    const bits = [];
    for (const [field, value] of Object.entries(v.match || {})) {
      if (field === 'exclude') continue;
      bits.push(`${field} ${[].concat(value).join(' | ')}`);
    }
    if (v.match?.exclude) bits.push(`not ${Object.keys(v.match.exclude).join(', ')}`);
    console.log(`  ${c.green('●')} ${c.bold(v.name)} ${c.dim(`(${v.id})`)}`);
    console.log(`    ${c.dim(bits.join('  ·  ') || 'everything')}`);
  }

  for (const e of errors) {
    console.log(`  ${c.red('✗')} ${c.bold(e.file)}${e.line ? c.dim(':' + e.line) : ''}`);
    console.log(`    ${c.red(e.message)}`);
  }

  if (!views.length && !errors.length) {
    console.log(c.dim('  No views yet. A view is a file; this one puts the blocked'));
    console.log(c.dim('  sessions on the wall and nothing else:'));
    console.log('');
    console.log(c.dim(`    mkdir -p ${home(dir)}`));
    console.log(c.dim(`    $EDITOR ${home(dir)}/needs-me.yaml`));
    console.log('');
    for (const line of STARTER.trimEnd().split('\n')) console.log(`    ${c.cyan(line)}`);
  }
  console.log('');
}
```

Add the dispatch beside the others (`bin/cctv.js:310`):

```js
} else if (cmd === 'views') {
  cmdViews();
```

- [ ] **Step 4: Add the doctor row**

In `cmdDoctor()`, after the `rows` array is printed and before the hooks line, add:

```js
  const v = loadViews();
  console.log(
    `  ${v.errors.length ? c.red('✗') : v.views.length ? c.green('✓') : c.dim('–')} ` +
      `~/.agent-cctv/views${' '.repeat(2)} ${c.dim(
        v.errors.length
          ? `${v.views.length} view(s), ${v.errors.length} failed — run: agent-cctv views`
          : v.views.length
            ? `${v.views.length} view(s)`
            : 'no view presets (optional)'
      )}`
  );
```

Check the column alignment against the rows above it — they pad the path to 22 characters, so adjust the `' '.repeat(2)` until the descriptions line up.

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Verify by hand**

```bash
rm -rf ~/.agent-cctv/views && node bin/cctv.js views    # prints the starter
mkdir -p ~/.agent-cctv/views && printf 'name: Needs me\nmatch:\n  state: attention\n' > ~/.agent-cctv/views/needs-me.yaml
node bin/cctv.js views                                   # lists it with its match
printf 'groupby: x\n' > ~/.agent-cctv/views/bad.yaml
node bin/cctv.js views                                   # lists both, names bad.yaml:1
node bin/cctv.js doctor                                  # the views row reports 1 failed
```

- [ ] **Step 7: Commit**

```bash
git add bin/cctv.js test/cli.test.js
git commit -m "feat: agent-cctv views, and a doctor row for the presets directory"
```

---

### Task 7: Document it

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Write the section**

Add a `### Views` subsection under `## What you see`, after `### Filtering and grouping` (README.md:59) and before `### History`. It must cover, in the README's existing voice — plain prose, an argument for each choice, no bullet-point feature lists where a sentence will do:

- A view is a file in `~/.agent-cctv/views/`; its id is its filename; `.yaml`, `.yml` and `.json` all load.
- The worked example from the spec, verbatim, as a fenced `yaml` block.
- The match semantics: list is OR, fields AND, globs anchored and case-insensitive, `state` enumerated (`busy`, `waiting`, `idle`, `ended`, `live`, `attention`), a missing field never matching, `exclude` winning.
- The view is the population and the header narrows within it, so the counts count within the view.
- Alerts follow the view; History does not, and why — the archive is where you go to find a session you remember.
- Views are read and never written: no UI editor, no save button, and `agent-cctv views` for what loaded and what broke.
- The YAML is a strict subset and refuses what it does not understand by line number, because the tool has no dependencies and a parser that guesses is worse than one that refuses.
- With no view files, nothing about the header changes.

Also add `agent-cctv views` to the `## Commands` block (README.md:142-148), and mention `AGENT_CCTV_VIEWS_DIR` beside the other environment variables where they are listed.

- [ ] **Step 2: Check it reads true**

Re-read the section against `src/views.js` and `public/match.js`. Every claim must be one the code actually keeps — particularly the field list, the state vocabulary, and the exclude precedence.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: view presets"
```

---

## Self-Review

**Spec coverage.** File format → Task 3 (`normalize`/`checkMatch`) and Task 1 (grammar). Match semantics → Task 2. Directory and `AGENT_CCTV_VIEWS_DIR` → Task 3. Discoverability (`views` command, doctor, README) → Tasks 6 and 7. Architecture, `/api/views`, hot reload → Task 4. Picker, Everything, hidden-when-empty, `?view=`, localStorage → Task 5. Header interaction and recounting → Task 5, steps 4-5. Alerts scoped to the population, History untouched → Task 5, step 4 (`alertFor` only; nothing in `loadArchive` changes). Failure modes: malformed file → Tasks 3 and 5; missing directory → Task 3; vanished selection → Task 5 `setViews`; duplicate ids → Task 3; view matching nothing → Task 5 `emptyCopy`.

**Known gap, accepted:** the browser half (Task 5) has no automated test — the project has no DOM harness, and adding one for this is disproportionate. Task 5 step 7 is a scripted manual pass instead, and the logic worth protecting (`compile`, the loader) is pure and covered.

**Type consistency.** `loadViews` returns `{dir, views, errors}` everywhere it appears — Tasks 3, 4, 6. A `View` is `{id, name, order, groupBy, match}` in Tasks 3, 4 and 5. `parseYaml` returns `{value, lines}` in Tasks 1 and 3. `compile(match)` takes the `match` object, not the view — Tasks 2, 3 and 5 all pass `view.match`. `inView`/`currentView` are used in `app.js` exactly as `public/views.js` exports them.
