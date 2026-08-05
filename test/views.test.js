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
