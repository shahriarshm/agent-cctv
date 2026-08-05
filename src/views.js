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
import { parseYaml, stringifyYaml } from './yaml.js';
import { FIELDS, STATES } from '../public/match.js';

const TOP_KEYS = ['name', 'order', 'mode', 'groupBy', 'match'];
/** Must stay in step with GROUPS in public/app.js. */
const GROUP_BY = ['none', 'project', 'agent', 'state', 'branch'];
/** How the wall is drawn. Must stay in step with MODES in public/app.js. */
const MODES = ['wall', 'focus', 'tail'];
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

  const mode = doc.mode === undefined ? 'wall' : doc.mode;
  if (!MODES.includes(mode)) fail(`"mode" must be one of ${MODES.join(', ')}`, 'mode');

  const match = doc.match === undefined ? {} : doc.match;
  checkMatch(match, 'match', fail, false);

  return { id, name: name.trim(), order, mode, groupBy, match };
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

/* ── writing ─────────────────────────────────────────────────────────────── */

/**
 * The one place this tool writes a file someone else will read.
 *
 * The earlier design said views were read and never written. That was right
 * until saving from the dashboard became the way most people would make their
 * first view — a feature nobody can reach is not a feature. What has not
 * changed is the blast radius: this writes `<slug>.yaml`, inside the views
 * directory, and can express nothing else. It is not a control action on a
 * session, and the argument for keeping those out still stands.
 */
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export class ViewWriteError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ViewWriteError';
    this.status = status;
  }
}

/** A display name reduced to something that can safely be a filename. */
export function slugify(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function writeView({ name, view = {}, replace = false }, dir = VIEWS_DIR) {
  const id = slugify(name);
  // The slug rule is the guard. The resolved-path check below is the second
  // one, on the assumption that this rule will eventually be edited by someone
  // who has not thought about `..` for as long as this comment took to write.
  if (!SLUG.test(id)) {
    throw new ViewWriteError('a view needs a name with letters or digits in it', 400);
  }

  const file = path.join(dir, `${id}.yaml`);
  if (path.dirname(path.resolve(file)) !== path.resolve(dir)) {
    throw new ViewWriteError('refusing to write outside the views directory', 400);
  }
  if (!replace && fs.existsSync(file)) {
    throw new ViewWriteError(`a view called "${id}" already exists`, 409);
  }

  // Validated by the loader's own rules, so a view that could not be read back
  // can never be written in the first place.
  let normalized;
  try {
    normalized = normalize({ ...view, name: String(name).trim() }, id, new Map());
  } catch (err) {
    throw new ViewWriteError(err.message, 400);
  }

  const body =
    '# Written by the agent-cctv dashboard. Edit it by hand — this is an\n' +
    '# ordinary view file, and the format is in the README.\n' +
    stringifyYaml(strip(normalized));

  fs.mkdirSync(dir, { recursive: true });
  // Atomic: a half-written view file is one the loader would report as broken,
  // and a watcher fires on the first byte.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
  return { id, file };
}

/** A saved file says only what it means — defaults are left out. */
function strip(v) {
  const out = { name: v.name };
  if (v.order !== 100) out.order = v.order;
  if (v.mode !== 'wall') out.mode = v.mode;
  if (v.groupBy) out.groupBy = v.groupBy;
  if (Object.keys(v.match || {}).length) out.match = v.match;
  return out;
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
