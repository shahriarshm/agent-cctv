/*
  The two ways of drawing the wall that are not a grid.

  A mode decides how sessions are drawn; the view decides which sessions there
  are, and the header's filters still narrow within that. Neither of these owns
  any session state — they are handed the sessions the wall has already decided
  are visible, in the order it already sorted them.
*/

import { el, clockTime } from './format.js';
import { createTimeline, buildEntry } from './timeline.js';

/* ── focus ───────────────────────────────────────────────────────────────── */

/**
 * One session big, the rest as a clickable rail.
 *
 * The focused tile is the wall's own tile node, moved rather than rebuilt, so
 * its activity strip keeps the history it has been accumulating — the same
 * reason the wall reorders with CSS instead of touching the DOM.
 *
 * @param {{slot: Element, rail: Element, timeline: Element, tileFor: (id: string) => Element,
 *          fetchSession: (id: string) => Promise<any>}} deps
 */
export function createFocus({ slot, rail, timeline, tileFor, fetchSession }) {
  const feed = createTimeline(timeline);
  /** What the user clicked. Null means "whatever is most urgent right now". */
  let pinned = null;
  /** What is actually on screen, so a repaint does not refetch the same session. */
  let showing = null;
  let empty = null;

  /** The pinned session if it is still here, else the top of the wall's own order. */
  function choose(sessions) {
    if (pinned && sessions.some((s) => s.id === pinned)) return pinned;
    return sessions.length ? sessions[0].id : null;
  }

  function clearEmpty() {
    empty?.remove();
    empty = null;
  }

  function showEmpty(head, body) {
    if (empty?.dataset.head === head) return;
    clearEmpty();
    empty = el('div', 'focus-empty');
    empty.dataset.head = head;
    empty.append(el('h2', null, head), el('p', null, body));
    slot.append(empty);
  }

  return {
    /** @param {any[]} sessions visible sessions, already in the wall's rank order */
    show(sessions, emptyCopy) {
      const id = choose(sessions);

      if (!id) {
        slot.replaceChildren();
        rail.replaceChildren();
        feed.clear();
        showing = null;
        const [head, body] = emptyCopy;
        showEmpty(head, body);
        return;
      }
      clearEmpty();

      if (id !== showing) {
        showing = id;
        feed.clear();
        // Backfilled once, then fed live — exactly how the inspector works.
        fetchSession(id).then((detail) => {
          // A slow response for a session we have since moved off must not
          // overwrite the timeline of the one now on screen.
          if (detail && showing === id) feed.render(detail.events || []);
        });
      }

      const main = tileFor(id);
      if (main && slot.firstElementChild !== main) slot.replaceChildren(main);

      // Everything else, in the order the wall already sorted them.
      const others = sessions.filter((s) => s.id !== id);
      others.forEach((s, i) => {
        const tile = tileFor(s.id);
        if (!tile) return;
        tile.style.order = '';
        if (rail.children[i] !== tile) rail.insertBefore(tile, rail.children[i] || null);
      });
      while (rail.childElementCount > others.length) rail.removeChild(rail.lastElementChild);
    },

    /** A click on a rail tile promotes that session. */
    pin(id) {
      pinned = id;
    },

    /** Which session is on screen, so the wall knows whose events to forward. */
    focused() {
      return showing;
    },

    activity(ev) {
      if (ev.sessionId === showing) feed.prepend(ev);
    },

    hide() {
      // Tiles are handed back to the wall by the wall itself on relayout; only
      // this module's own leftovers are cleared.
      feed.clear();
      clearEmpty();
      showing = null;
    },
  };
}

/* ── tail ────────────────────────────────────────────────────────────────── */

/** Beyond this the pane is a memory leak with a scrollbar. */
const MAX_ROWS = 500;

/**
 * Every session in the view, as one stream. Newest first and no auto-scroll,
 * matching the inspector: the newest line is at the top and stays where you can
 * read it, rather than a pane that jumps while your eye is on it.
 */
export function createTail(node) {
  let empty = null;

  function clearEmpty() {
    empty?.remove();
    empty = null;
  }

  function row(ev, name) {
    const entry = buildEntry(ev);
    // Which session this is — the one thing a merged stream must say that a
    // single session's timeline never has to.
    const who = el('span', 'tail-who', name || '');
    who.title = name || '';
    entry.querySelector('.label')?.prepend(who);
    return entry;
  }

  function trim() {
    while (node.childElementCount > MAX_ROWS) node.removeChild(node.lastElementChild);
  }

  return {
    /** Backfill from what the snapshot already carries, oldest first so the
        newest ends up on top. */
    show(sessions) {
      const rows = [];
      for (const s of sessions) {
        for (const ev of s.events || []) rows.push([ev, s.name]);
      }
      rows.sort((a, b) => a[0].ts - b[0].ts);
      node.replaceChildren();
      clearEmpty();
      for (const [ev, name] of rows) node.prepend(row(ev, name));
      trim();
      if (!node.childElementCount) {
        empty = el('div', 'tail-empty', 'Quiet. Nothing has happened in this view yet.');
        node.append(empty);
      }
    },

    activity(ev, name) {
      clearEmpty();
      if (node.querySelector(`[data-id="${CSS.escape(ev.id)}"]`)) return;
      node.prepend(row(ev, name));
      trim();
    },

    clear() {
      node.replaceChildren();
      clearEmpty();
    },
  };
}

/** Exposed for the tail's time column, which shares the timeline's formatting. */
export { clockTime };
