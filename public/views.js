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
  // A picker holding one built-in view is chrome that says nothing. Someone who
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
    wanted = select.value;
    resolve();
    notify(current);
  });
  paint([]);
}
