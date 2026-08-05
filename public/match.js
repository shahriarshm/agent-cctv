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
