/*
  The view picker.

  A view is the population of the wall; the header's state, agent and project
  controls narrow within it. Which view you are on is a per-browser preference
  and is never written to disk — two people watching the same shared server sit
  on different views.
*/

import { compile } from './match.js';

/** Always first, never a file. Matches everything, which is the old behaviour. */
export const EVERYTHING = { id: 'all', name: 'Everything', order: -1, mode: 'wall', groupBy: null, match: {} };

/**
 * The picker's last entry. Not a view - choosing it opens the save dialog.
 * Underscores cannot appear in a slug, so this can never collide with a real id.
 */
const SAVE_AS = '__save_as__';

const label = document.getElementById('pick-view-label');
const select = document.getElementById('pick-view');
const warn = document.getElementById('view-warn');

let catalog = [EVERYTHING];
let current = EVERYTHING;
let predicate = () => true;
let notify = () => {};
/*
  The id you asked for, which is not always one that exists yet. The catalog
  arrives from the server a beat after the page does, so a view restored from
  localStorage or handed over in ?view= names something not yet loaded — and a
  view whose file is being saved by an editor that writes through a rename
  disappears for a moment. Holding the intent separately means neither drops you
  somewhere you did not choose: the wall falls back to Everything while the view
  is genuinely missing, and returns to it the moment it is there.
*/
let wanted = EVERYTHING.id;

export function currentView() {
  return current;
}

/** What the user asked for — the thing worth persisting. */
export function wantedViewId() {
  return wanted;
}

export function inView(s) {
  return predicate(s);
}

function resolve() {
  current = catalog.find((v) => v.id === wanted) || EVERYTHING;
  predicate = compile(current.match);
}

function paint(errors) {
  // Always shown now, because this is the only way to reach Save. The first
  // release hid it when there were no views; that was right when views could
  // only be made in an editor, and wrong the moment they could be made here.
  label.hidden = false;

  const ids = catalog.map((v) => v.id).join('\0');
  if (select.dataset.ids !== ids) {
    select.dataset.ids = ids;
    select.replaceChildren();
    for (const v of catalog) {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = v.name;
      // The chip reads data-chip when it is there. Set it even though the name
      // needs no cleaning, so there is one rule rather than two.
      opt.dataset.chip = v.name;
      select.append(opt);
    }
    const sep = document.createElement('option');
    sep.disabled = true;
    sep.textContent = '\u2500'.repeat(12);
    const save = document.createElement('option');
    save.value = SAVE_AS;
    save.textContent = '\uFF0B Save current as\u2026';
    select.append(sep, save);
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
  catalog = [EVERYTHING, ...((payload && payload.views) || [])];
  resolve();
  paint((payload && payload.errors) || []);
  return current;
}

export function mountViews({ initialId, onSelect }) {
  notify = onSelect;
  wanted = initialId || EVERYTHING.id;
  resolve();
  select.addEventListener('change', () => {
    if (select.value === SAVE_AS) {
      // Put the selection back before anything else happens: choosing "save"
      // must never be a way to accidentally leave the view you were on, and
      // cancelling has to land you exactly where you started.
      select.value = current.id;
      openSave();
      return;
    }
    wanted = select.value;
    resolve();
    notify(current);
  });
  paint([]);
}

/* ── saving ──────────────────────────────────────────────────────────────── */

const dialog = document.getElementById('save-dialog');
const saveScrim = document.getElementById('save-scrim');
const nameInput = document.getElementById('save-name');
const captures = document.getElementById('save-captures');
const errorEl = document.getElementById('save-error');

/** Set by app.js: reads the header, returns the view body to POST. */
let compose = () => ({ match: {} });
let post = async () => ({ ok: false, status: 0, error: 'not wired' });
/** True once the user has answered "replace it?" for the name in the field. */
let replacing = false;

export function wireSave({ composeView, postView }) {
  compose = composeView;
  post = postView;
}

function closeSave() {
  dialog.hidden = true;
  saveScrim.hidden = true;
  replacing = false;
  errorEl.hidden = true;
  select.focus();
}

function openSave() {
  const body = compose();
  errorEl.hidden = true;
  replacing = false;
  nameInput.value = suggestName(body);
  captures.textContent = describeCapture(body);
  dialog.hidden = false;
  saveScrim.hidden = false;
  nameInput.focus();
  nameInput.select();
}

/** A name you would probably have typed yourself, from what is actually set. */
function suggestName(body) {
  const m = body.match || {};
  const bits = [];
  if (m.project && !Array.isArray(m.project)) bits.push(m.project);
  if (m.agent && !Array.isArray(m.agent)) bits.push(m.agent);
  if (m.state) bits.push({ attention: 'needs me', busy: 'working', live: 'live' }[m.state] || m.state);
  if (body.mode && body.mode !== 'wall') bits.push(body.mode);
  const guess = bits.join(' ').trim();
  return guess ? guess[0].toUpperCase() + guess.slice(1) : 'My view';
}

/**
 * What the file will contain, in words.
 *
 * The one failure this dialog can have is saving something other than what the
 * user thinks they are saving, so it says so before they commit.
 */
function describeCapture(body) {
  const m = body.match || {};
  const bits = [];
  for (const [field, value] of Object.entries(m)) {
    if (field === 'exclude') continue;
    bits.push(`${field} ${[].concat(value).join(' or ')}`);
  }
  if (m.exclude) bits.push(`not ${Object.keys(m.exclude).join(', ')}`);
  if (body.groupBy) bits.push(`grouped by ${body.groupBy}`);
  if (body.mode && body.mode !== 'wall') bits.push(`${body.mode} mode`);
  return bits.length ? `Captures: ${bits.join(' · ')}.` : 'Captures: every session, as a plain wall.';
}

async function submit() {
  const name = nameInput.value.trim();
  if (!name) {
    errorEl.hidden = false;
    errorEl.textContent = 'Give it a name.';
    return;
  }
  const res = await post({ name, view: compose(), replace: replacing });
  if (res.ok) {
    // The catalog arrives on its own over the stream; just point at the new one.
    wanted = res.id;
    resolve();
    select.value = current.id;
    closeSave();
    return;
  }
  errorEl.hidden = false;
  if (res.status === 409) {
    replacing = true;
    errorEl.textContent = `A view called "${name}" already exists. Save again to replace it.`;
    return;
  }
  errorEl.textContent = res.error || 'Could not save that.';
}

document.getElementById('save-go').addEventListener('click', submit);
document.getElementById('save-cancel').addEventListener('click', closeSave);
saveScrim.addEventListener('click', closeSave);
nameInput.addEventListener('input', () => {
  // A different name is a different question; do not carry a "replace" answer
  // from the last one over to it.
  replacing = false;
  errorEl.hidden = true;
});
dialog.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSave();
  if (e.key === 'Enter') submit();
});
