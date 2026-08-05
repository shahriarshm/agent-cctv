/*
  A timeline of events, rendered into whichever node you hand it.

  This was the inspector's, inline in app.js, until focus mode needed the same
  thing in a second place. The fold-and-render rules below are subtle enough
  that two copies would have drifted within a release — a tool call is one row
  that completes in place, and both the batch path and the live path have to
  agree about that or a busy turn renders twice.
*/

import { el, clockTime, plain, took } from './format.js';

/**
 * One row per tool call, not two.
 *
 * A tool emits `tool_start` and later `tool_end`, and the pair carries the same
 * `tool.id` *and the same detail string* — so a busy turn rendered as stacks of
 * near-identical rows with the whole command printed twice, once under "Running
 * Bash" and again under "Bash done". They are one thing that happened, so they are
 * one row: it appears when the call starts, and is completed in place — label,
 * outcome, duration — when the result lands.
 *
 * A `tool_end` with no matching start still gets its own row. Codex emits some of
 * those with no start at all, and inventing a call we never saw would be worse
 * than showing the result on its own.
 */
export function foldTools(events) {
  const out = [];
  const open = new Map();
  for (const ev of events) {
    const id = ev.tool?.id;
    if (ev.kind === 'tool_end' && id != null && open.has(id)) {
      const at = open.get(id);
      open.delete(id);
      out[at] = mergeToolPair(out[at], ev);
      continue;
    }
    if (ev.kind === 'tool_start' && id != null) open.set(id, out.length);
    out.push(ev);
  }
  return out;
}

/** The row keeps the start's identity and position — it is the call, and the call
    happened when it began — and takes everything it learned from the result. */
function mergeToolPair(start, end) {
  return { ...end, id: start.id, ts: start.ts, detail: end.detail || start.detail };
}

/**
 * The row for one event. Built once and repainted in place, because a tool call's
 * row has to survive its own completion — see `foldTools`.
 */
export function buildEntry(ev) {
  const entry = el('div', 'entry');
  entry.dataset.lane = ev.lane || 'main';
  entry.dataset.id = ev.id;
  entry.dataset.time = clockTime(ev.ts);
  const time = el('time', null, clockTime(ev.ts));
  time.dateTime = new Date(ev.ts).toISOString();
  const col = el('div');
  const head = el('div', 'label');
  col.append(head, el('div', 'detail'));
  entry.append(time, col);
  entry._refs = { label: head, detail: col.lastElementChild };
  paintEntry(entry, ev);
  return entry;
}

export function paintEntry(entry, ev) {
  const { label, detail } = entry._refs;
  entry.dataset.kind = ev.kind;
  entry.dataset.error = String(ev.tool?.ok === false);
  if (ev.tool?.id) entry.dataset.tool = ev.tool.id;
  // 'start' means still in flight, which is what earns the amber label.
  entry.dataset.phase = ev.tool?.phase || '';

  label.replaceChildren(document.createTextNode(ev.label));
  const t = took(ev.tool?.durationMs);
  if (t) label.append(el('span', 'took', t));

  const prose = ev.kind === 'assistant_text' || ev.kind === 'thinking' || ev.kind === 'prompt';
  detail.hidden = !ev.detail;
  detail.textContent = ev.detail ? (prose ? plain(ev.detail) : ev.detail) : '';
}

/**
 * @param {Element} node where the rows go
 * @returns {{render: (events: any[]) => void, prepend: (ev: any) => void, clear: () => void}}
 */
export function createTimeline(node) {
  /** The row this result belongs to, if its call is still on screen. */
  function openCall(ev) {
    const id = ev.tool?.id;
    if (ev.kind !== 'tool_end' || id == null) return null;
    return node.querySelector(`.entry[data-phase="start"][data-tool="${CSS.escape(String(id))}"]`);
  }

  return {
    /**
     * A tool call and its result land in the same second, so a busy turn renders as a
     * column of six identical timestamps. Only the first of a run is printed at full
     * strength; the repeats stay in place for alignment but fade back, which is what
     * lets you see where a turn actually began.
     */
    render(events) {
      node.replaceChildren();
      let above = null;
      // Folded before the slice, so a call is never cut off from its own result.
      for (const ev of foldTools(events).slice(-120).reverse()) {
        const entry = buildEntry(ev);
        if (above && above.dataset.time === entry.dataset.time) entry.dataset.repeat = 'true';
        node.append(entry);
        above = entry;
      }
    },

    /** Newest first, so a live event goes on top rather than triggering a refetch. */
    prepend(ev) {
      // A result completes the row its call already made rather than adding a second
      // one — the live path has to fold exactly like `render` does.
      const running = openCall(ev);
      if (running) {
        // The row keeps its own id and position; only what the result taught us
        // changes. A result with no detail of its own keeps the call's.
        return paintEntry(running, {
          ...ev,
          id: running.dataset.id,
          detail: ev.detail || running._refs.detail.textContent,
        });
      }

      if (node.querySelector(`[data-id="${CSS.escape(ev.id)}"]`)) return;
      const entry = buildEntry(ev);
      const below = node.firstElementChild;
      // The newest event is never the repeat; the one it lands on top of becomes one.
      if (below && below.dataset.time === entry.dataset.time) below.dataset.repeat = 'true';
      node.prepend(entry);
      while (node.childElementCount > 200) node.removeChild(node.lastElementChild);
    },

    clear() {
      node.replaceChildren();
    },
  };
}
