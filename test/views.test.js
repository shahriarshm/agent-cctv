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

/** assert.throws() returns undefined, so the error has to be caught to inspect. */
function refused(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail('expected a refusal, nothing was thrown');
}

test('an unquoted * is refused, because YAML would read it as an alias', () => {
  const err = refused(() => parseYaml('name: x\ncwd: */scratch/*\n'));
  assert.ok(err instanceof YamlError);
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
    const err = refused(() => parseYaml(src));
    assert.ok(err instanceof YamlError, `expected a YamlError, got ${err}`);
    assert.equal(err.line, line, `expected line ${line}, got: ${err.message}`);
  });
}

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
  assert.equal(m(session({ gitBranch: 'feat/x' })), false, 'fields must AND');
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
