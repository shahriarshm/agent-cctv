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

/**
 * The same subset, written back out.
 *
 * Round-tripping is a test rather than an aspiration: everything this emits,
 * parseYaml() reads, and the pair is checked against each other. Quoting is
 * deliberately eager — a string is bare only when it cannot be mistaken for
 * anything else — because the failure it prevents is silent. A glob starting
 * with a star, written bare, reads back as a YAML alias; the parser is right to
 * refuse it, and better never to write it in the first place.
 */
export function stringifyYaml(value, indent = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('the top level of a document must be a map');
  }
  const pad = ' '.repeat(indent);
  let out = '';
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      out += `${pad}${key}: ${inlineList(v)}\n`;
    } else if (v && typeof v === 'object') {
      // `key:` with nothing under it is exactly what the parser refuses, and
      // the subset has no inline `{}` to fall back on. Callers drop empty maps
      // before they get here — writeView()'s strip() does — so this is a bug
      // rather than a case to paper over.
      if (!Object.keys(v).length) {
        throw new TypeError(`"${key}" is an empty map, which this subset cannot write`);
      }
      out += `${pad}${key}:\n${stringifyYaml(v, indent + 2)}`;
    } else {
      out += `${pad}${key}: ${scalarText(v)}\n`;
    }
  }
  return out;
}

function inlineList(items) {
  return `[${items.map((v) => {
    if (v && typeof v === 'object') {
      throw new TypeError('a list may only hold scalars in this subset');
    }
    return scalarText(v);
  }).join(', ')}]`;
}

function scalarText(v) {
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new TypeError('only whole numbers can be written');
    return String(v);
  }
  if (v === null) return 'null';
  if (typeof v !== 'string') throw new TypeError(`cannot write a ${typeof v}`);
  if (!needsQuote(v)) return v;
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Bare only when it cannot be mistaken for anything else. */
function needsQuote(s) {
  return (
    s === '' ||
    s !== s.trim() ||
    /^[*&!|>%@`#-]/.test(s) ||
    /[:#]/.test(s) ||
    /^(true|false|null|~)$/.test(s) ||
    /^-?\d+$/.test(s) ||
    /^[[{]/.test(s)
  );
}
