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
