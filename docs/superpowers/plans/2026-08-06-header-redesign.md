# Header Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the agent-cctv masthead lay out on a single row at every width from 1920 down to 360, with icons carrying the labels and a bottom sheet holding what does not fit on a phone.

**Architecture:** The masthead becomes six named flex regions. Each picker becomes a "chip" — an icon plus its value, shown only when the value is not the picker's default — with the real `<select>` laid transparently on top so the native control still does the work. Below fixed breakpoints, CSS repositions whole regions into a bottom sheet; no element ever moves in the DOM and there is no layout JavaScript.

**Tech Stack:** Vanilla ESM, no build step, no runtime dependencies. `node --test` for the suite. Node ≥18.

**Design spec:** [`docs/superpowers/specs/2026-08-06-header-redesign-design.md`](../specs/2026-08-06-header-redesign-design.md)

## Global Constraints

- **Zero runtime dependencies.** Do not add a package, a build step, or a polyfill.
- **`public/*.js` is served to the browser exactly as written.** No transpilation. ESM only.
- **`textContent` only for anything that came off a transcript.** `test/spa-guard.test.js` scans every `public/*.js` and fails on `innerHTML` assigned from anything but the exact strings in its `STATIC_ICON_SOURCES` allowlist.
- **`STATIC_ICON_SOURCES` must not be edited by this work.** The one `innerHTML` this plan adds must be written so its right-hand side is literally `meta.icon`, which is already on the list. See Task 4, Step 5.
- **Do not touch anything under `src/`.** This change does not reach the server.
- **Do not touch `public/icons.js`, `public/match.js`, `public/modes.js`, `public/timeline.js`, `public/format.js`, `public/notify.js`.**
- **Do not touch the archive's `going back` select** (`#archive-days`). It keeps the `.pick` class, and the `.pick` CSS rules stay in the stylesheet for it.
- **`#masthead` keeps its id and its `data-mode` attribute.** `public/app.js:848` sets `data-mode` to `archive` or `wall`, and `.wall-only` descendants are dimmed and made inert by it.
- **Every element id referenced by JavaScript keeps its id**, unless a task says otherwise: `stat-all`, `stat-live`, `stat-busy`, `stat-attention`, `pick-view`, `pick-view-label`, `view-warn`, `pick-source`, `pick-project`, `pick-group`, `pick-group-label`, `archive-toggle`, `bell`, `theme`, `clock`, `link`.
- **Commit style:** `feat:` / `fix:` / `docs:` / `refactor:`, lowercase subject, body explaining the reasoning rather than the diff.
- **Comments explain why a decision was made and what breaks without it.** A comment restating the code is worse than none.
- **Run the full suite (`npm test`) before every commit.** It must be green at the end of every task.

### Design tokens available (already defined in `public/styles.css`)

Spacing `--s1: 4px` `--s2: 8px` `--s3: 12px` `--s4: 16px` `--s5: 24px` `--s6: 32px`.
Type `--t-eyebrow: 10px` `--t-meta: 11px` `--t-ui: 12px` `--t-prose: 13px` `--t-title: 15px` `--t-stat: 18px` — five sizes and no others.
Surfaces `--panel` `--panel-2` `--panel-hi` `--edge` `--edge-soft`.
Ink `--ink` `--ink-2` `--ink-3`.
Signals `--tally` / `--tally-ink` (needs a human), `--rolling` / `--rolling-ink` (working), `--ember` / `--ember-ink` (config problem), `--glow`.
Shape `--radius: 4px` `--radius-sm: 3px`.

Every one of these has a light-theme value too. Use the tokens; never a literal colour.

---

## File Structure

| File | Change | Responsibility after this work |
| --- | --- | --- |
| `public/index.html` | Modify (masthead replaced, sheet added) | The bar's six regions, every chrome icon as inline `<svg>`, the sheet's shell |
| `public/styles.css` | Modify (masthead block rewritten) | Region layout, chip and segmented-toggle styling, the three breakpoint tiers, sheet positioning |
| `public/app.js` | Modify (header wiring only) | `paintChip`, `paintAgentMark`, `paintMode`, sheet open/close; existing filter/mode/theme logic unchanged |
| `public/views.js` | Modify (2 lines) | Sets `data-chip` on view options so the view chip can show a clean name |
| `test/header-markup.test.js` | Create | DOM-free guards: readout filters ⊆ `STATES`, `MODES` ↔ mode buttons, every icon-only control is named |
| `README.md` | Modify | Prose describing the header controls |
| `CLAUDE.md` | Modify (one bullet) | The "lists that must stay in step by hand" note |

Nothing else changes. In particular `test/spa-guard.test.js` is **read** by this work but never edited.

---

## Task 1: Pin the readouts down before touching them

The state readouts are the one part of the header that must survive the rewrite semantically intact — each button's `data-filter` has to stay a value `public/match.js` knows how to evaluate, because a view file and the header's own filter are read by the same predicate. CLAUDE.md currently lists that pairing under *"Lists that must stay in step by hand"*. Make it machine-checked **first**, so it is guarding the rewrite rather than describing it.

This test passes against the current markup. That is the point: it is a characterization test taken before the change, not after.

**Files:**
- Create: `test/header-markup.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `test/header-markup.test.js` with a `readHtml()` helper and a `buttons()` helper that later tasks add cases to. Exact signatures given in Step 1.

- [ ] **Step 1: Write the failing test**

Create `test/header-markup.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STATES } from '../public/match.js';

/*
  index.html and the modules that drive it hold several lists that have to agree
  and that nothing else checks: the state a readout filters by must be one
  match.js can evaluate, and the modes app.js knows must be the modes the header
  offers. Both used to be kept in step by hand, and both are the kind of thing
  that breaks silently — a wrong data-filter does not throw, it just quietly
  matches nothing on the wall.

  These are text scans rather than a DOM parse on purpose: pulling in a parser
  would be the project's first runtime-adjacent dependency, and the markup this
  guards is hand-written and small.
*/

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function readHtml() {
  return fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
}

function readScript(name) {
  return fs.readFileSync(path.join(ROOT, 'public', name), 'utf8');
}

/** Every <button …> open tag in the document, as raw text. */
function buttons(html) {
  return [...html.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
}

/** The value of `attr` on a raw open tag, or null. */
function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : null;
}

test('every state readout filters by something match.js can evaluate', () => {
  const html = readHtml();
  const filters = buttons(html)
    .filter((tag) => tag.includes('class="readout"'))
    .map((tag) => attr(tag, 'data-filter'));

  assert.ok(filters.length >= 4, `expected at least 4 readouts, found ${filters.length}`);

  for (const f of filters) {
    assert.ok(
      f === 'all' || Object.hasOwn(STATES, f),
      `readout data-filter="${f}" is neither "all" nor a key of STATES in public/match.js`
    );
  }
});
```

Note: `readScript` is unused in this task and used in Task 5. Leave it in — Task 5's test needs it and adding it now keeps that task to one concern.

- [ ] **Step 2: Run the test**

Run: `node --test test/header-markup.test.js`
Expected: **PASS**, 1 test. It is describing behaviour that already holds.

To prove it is actually checking something, temporarily change one readout's `data-filter` in `public/index.html` from `live` to `alive`, re-run, and confirm it FAILS with `readout data-filter="alive" is neither "all" nor a key of STATES`. Then undo that edit.

- [ ] **Step 3: Run the whole suite**

Run: `npm test`
Expected: PASS, 184 tests (183 + the new one).

- [ ] **Step 4: Commit**

```bash
git add test/header-markup.test.js
git commit -m "test: guard the readout filters against match.js

CLAUDE.md lists the header's own state filters and STATES in match.js as
a pair that has to stay in step by hand. A wrong data-filter does not
throw; it quietly matches nothing on the wall, which on a monitoring
dashboard reads as \"no sessions\" rather than as a bug.

Taken before the header rewrite rather than after, so it is guarding the
change instead of describing it."
```

---

## Task 2: Six named regions

Replace the five undifferentiated `.zone` divs with regions that can be addressed individually, and shed the clock and the wordmark's text at the first breakpoint. Every control keeps its current markup and every id survives — this task only changes what the controls are *grouped into* and adds the identity glyph.

**Critical:** `.bar` keeps `flex-wrap: wrap` in this task. Switching to `nowrap` before the sheet exists (Task 7) would leave narrow widths overflowing sideways, which is exactly the bug the old `styles.css` comment warns about. The flip to `nowrap` happens in Task 7 and nowhere earlier.

**Files:**
- Modify: `public/index.html:30-111` (the whole `<header>`)
- Modify: `public/styles.css:190-536` (the masthead block)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the class names `.bar`, `.bar-id`, `.bar-states`, `.bar-filters`, `.bar-controls`, `.bar-actions`, `.bar-status`, and the shared icon class `.i`. Tasks 3–7 all attach to these.

- [ ] **Step 1: Replace the header markup**

In `public/index.html`, replace the entire `<header class="masthead" …>…</header>` block (lines 30–111) with:

```html
    <!--
      Six regions, hairline-separated: who this is, what the wall says, which
      sessions and how they are drawn, what you can narrow that to, what you can
      do to it, and the state of the machine itself.

      Left to right is the order the README already uses to explain the thing —
      the view is the population, and the filters narrow within it. It is also
      the order they stack in when the middle three drop into the sheet, which
      is why they are grouped rather than merely adjacent.
    -->
    <header class="bar" id="masthead" data-mode="wall">
      <div class="bar-id">
        <svg class="i mark" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3.5 8.5h17v9.5h-17z" />
          <circle cx="12" cy="13.25" r="2.75" />
          <path d="M8.5 8.5 10 5.5h4l1.5 3" />
        </svg>
        <span class="wordmark">agent<span>·</span>cctv</span>
      </div>

      <!-- Counts and state filter are the same three concepts, so they are one
           control: it reports the number and it is how you narrow to it. -->
      <div class="bar-states">
        <div class="readouts" role="group" aria-label="Filter by state">
          <button class="readout" data-filter="all" data-kind="all" type="button" aria-pressed="true">
            <b id="stat-all">0</b><span>all</span>
          </button>
          <button class="readout" data-filter="live" data-kind="live" type="button" aria-pressed="false">
            <b id="stat-live">0</b><span>live</span>
          </button>
          <button class="readout" data-filter="busy" data-kind="busy" type="button" aria-pressed="false">
            <b id="stat-busy">0</b><span>working</span>
          </button>
          <button
            class="readout"
            data-filter="attention"
            data-kind="attention"
            type="button"
            aria-pressed="false"
            data-hot="false"
          >
            <b id="stat-attention">0</b><span>need you</span>
          </button>
        </div>
      </div>

      <!--
        Everything that leaves the bar on a narrow screen, in one wrapper.

        The wrapper is `display: contents` at wide widths, so it has no box and
        the three regions lay out as direct children of .bar exactly as if it
        were not here. Below the sheet breakpoint it becomes the sheet itself.
        It exists so the tiers have one thing to reposition instead of three
        things to keep from colliding.
      -->
      <div class="bar-shelf" id="bar-shelf">
        <!-- Which sessions are on the wall, and how they are drawn. -->
        <div class="bar-controls wall-only">
          <label class="pick" id="pick-view-label">
            <span>view</span>
            <select id="pick-view"></select>
          </label>
          <span class="view-warn" id="view-warn" role="status" hidden></span>
          <label class="pick">
            <span>mode</span>
            <select id="pick-mode">
              <option value="wall">wall</option>
              <option value="focus">focus</option>
              <option value="tail">tail</option>
            </select>
          </label>
        </div>

        <!-- Narrowing within that. Three controls that sit on their default
             nearly all the time, which is what Task 4 is about. -->
        <div class="bar-filters wall-only">
          <label class="pick">
            <span>agent</span>
            <select id="pick-source"><option value="all">all</option></select>
          </label>
          <label class="pick">
            <span>project</span>
            <select id="pick-project"><option value="all">all</option></select>
          </label>
          <label class="pick" id="pick-group-label">
            <span>group by</span>
            <select id="pick-group">
              <option value="none">nothing</option>
              <option value="project">project</option>
              <option value="agent">agent</option>
              <option value="state">state</option>
              <option value="branch">branch</option>
            </select>
          </label>
        </div>

        <div class="bar-actions">
          <button class="chip" id="archive-toggle" type="button" aria-pressed="false">History</button>
          <button class="bell" id="bell" type="button" data-state="off" aria-pressed="false">
            <span id="bell-label">Alerts</span>
          </button>
          <button class="theme" id="theme" type="button">
            <span id="theme-icon"></span><span id="theme-label">Auto</span>
          </button>
        </div>
      </div>

      <div class="bar-status">
        <div class="clock" id="clock">--:--:--</div>
        <div class="link-state" id="link" data-up="false">connecting</div>
      </div>
    </header>
```

Four things changed and nothing else: `#pick-view-label` lost its `hidden` attribute (it has been unconditionally shown since the Save flow landed — `public/views.js:62` sets `label.hidden = false` on every paint, so the attribute was already dead markup), the view and mode pair now sits *before* the filters rather than after, the controls are grouped into regions and a shelf, and the identity glyph is new. Every id, every `data-` attribute and every `aria-` attribute is carried over verbatim.

- [ ] **Step 2: Replace the masthead stylesheet block**

In `public/styles.css`, replace everything from the `/* ── masthead ── */` banner comment through the `.masthead[data-mode='archive'] .wall-only` rule (lines 190–536) with:

```css
/* ── the bar ──────────────────────────────────────────────────────────────

   Six regions, hairline-separated. The middle three are wrapped in a shelf that
   has no box of its own at wide widths and becomes the bottom sheet at narrow
   ones — which is the whole responsive mechanism. Nothing here moves in the
   DOM; a region is repositioned, never re-parented.                         */

.bar {
  display: flex;
  /* Still wrapping. The regions can shed independently but the sheet that
     catches them does not exist yet; nowrap without it would put the header
     into horizontal overflow at narrow widths, which is worse than a second
     row. Switched to nowrap in the same change that adds the sheet. */
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s4);
  /* after the `gap` shorthand, which would otherwise reset it */
  row-gap: var(--s2);
  padding: var(--s2) var(--s4);
  border-bottom: 1px solid var(--edge);
  background: var(--panel);
  position: sticky;
  top: 0;
  z-index: 20;
}

/*
  No box of its own. The three regions inside lay out as direct flex children of
  .bar exactly as if this element were not here, which is what lets one wrapper
  own the narrow-width behaviour without owning the wide-width layout.
*/
.bar-shelf {
  display: contents;
}

.bar-id,
.bar-states,
.bar-filters,
.bar-controls,
.bar-actions,
.bar-status {
  display: flex;
  align-items: center;
  gap: var(--s3);
  /* A flex item defaults to min-width: auto and refuses to shrink below its
     content. That is half the reason the old header could not fit: every
     region held the row open at its natural width. */
  min-width: 0;
}

/* The two picker regions are the ones that grow when you filter, so they are
   the ones allowed to give the space back. */
.bar-filters,
.bar-controls {
  flex-shrink: 1;
}

.bar-states,
.bar-status {
  flex-shrink: 0;
}

/* Push the machine's own state to the far end. */
.bar-status {
  margin-left: auto;
}

/*
  Hairlines between regions, listed rather than written as `.bar > * + *`.
  The shelf is `display: contents`, so it generates no box for a sibling
  combinator to land on, and whether it generates pseudo-elements at all is
  something browsers have disagreed about. Naming the five is duller and works.
*/
.bar-states::before,
.bar-controls::before,
.bar-filters::before,
.bar-actions::before,
.bar-status::before {
  content: '';
  align-self: stretch;
  width: 1px;
  background: var(--edge);
  margin-right: var(--s1);
}

.i {
  width: 14px;
  height: 14px;
  flex: none;
  display: block;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.mark {
  width: 17px;
  height: 17px;
  color: var(--ink-2);
}

.wordmark {
  font-size: var(--t-meta);
  font-weight: 700;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: var(--ink);
  white-space: nowrap;
}

.wordmark span {
  color: var(--tally);
}

/* The counts and the state filter used to be two separate trios of the same three
   words, three hundred pixels apart, one of them dead. They are one control now:
   it tells you the number and it is the way you narrow to it. "Needs you" is the
   only one allowed to shout, and only when it has something to shout about. */
.readouts {
  display: flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--edge);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
}

.readout {
  appearance: none;
  border: 0;
  background: transparent;
  font: inherit;
  cursor: pointer;
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 2px;
  color: var(--ink-3);
}

.readout b {
  font-size: var(--t-stat);
  font-weight: 600;
  line-height: 1;
  color: var(--ink-2);
}

.readout span {
  font-size: var(--t-eyebrow);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  /* "need you" is the only two-word label here. Left to wrap it breaks the
     baseline it shares with the other three counts and makes its button
     taller than its neighbours. */
  white-space: nowrap;
}

.readout:hover b,
.readout:hover span {
  color: var(--ink);
}

/* A background step alone is a tenth of a stop in dark mode and invisible. The
   underline is what actually says "this is the one you are looking at". */
.readout[aria-pressed='true'] {
  background: var(--panel-hi);
  box-shadow: inset 0 -2px 0 var(--ink);
}

.readout[aria-pressed='true'] b,
.readout[aria-pressed='true'] span {
  color: var(--ink);
}

.readout[data-kind='busy'] b {
  color: var(--rolling-ink);
}

.readout[data-kind='attention'][data-hot='true'] b,
.readout[data-kind='attention'][data-hot='true'] span {
  color: var(--tally-ink);
}

.readout[data-kind='attention'][data-hot='true'] b {
  font-weight: 700;
}

/* Kept for the archive's own "going back" select, which lives on a different
   screen and has room for a word. */
.pick {
  display: flex;
  align-items: center;
  gap: var(--s2);
  font-size: var(--t-eyebrow);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ink-3);
  min-width: 0;
}

.pick > span {
  white-space: nowrap;
}

.pick select {
  appearance: none;
  background: var(--panel-2);
  border: 1px solid var(--edge);
  border-radius: var(--radius-sm);
  color: var(--ink);
  font: inherit;
  font-size: var(--t-meta);
  letter-spacing: 0.02em;
  text-transform: none;
  padding: 5px 24px 5px var(--s2);
  cursor: pointer;
  max-width: 190px;
  background-image: linear-gradient(45deg, transparent 50%, currentColor 50%),
    linear-gradient(135deg, currentColor 50%, transparent 50%);
  background-position: calc(100% - 13px) 53%, calc(100% - 9px) 53%;
  background-size: 4px 4px, 4px 4px;
  background-repeat: no-repeat;
}

.pick select:hover {
  border-color: var(--ink-3);
}

.pick select option {
  background: var(--panel);
  color: var(--ink);
}

/* A view file that would not parse. Ember, not red: red on this wall means a
   session is blocked on you, and a config typo is the machine's problem. */
.view-warn {
  font-size: var(--t-eyebrow);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ember-ink);
  border: 1px solid var(--ember);
  border-radius: var(--radius-sm);
  padding: 3px var(--s2);
  cursor: help;
  white-space: nowrap;
}

.bell,
.chip {
  appearance: none;
  display: flex;
  align-items: center;
  gap: var(--s2);
  border: 1px solid var(--edge);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  color: var(--ink-2);
  font: inherit;
  font-size: var(--t-meta);
  letter-spacing: 0.04em;
  padding: 5px 10px;
  cursor: pointer;
  white-space: nowrap;
}

.chip:hover,
.bell:hover:not([aria-disabled='true']) {
  color: var(--ink);
  border-color: var(--ink-3);
}

.chip[aria-pressed='true'] {
  background: var(--ink);
  border-color: var(--ink);
  color: var(--panel);
}

/* Armed-alerts indicator. Neither amber nor tally: those already mean "rolling"
   and "needs a human", and this is about the wall, not about a session. */
.bell::before {
  content: '';
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: transparent;
  box-shadow: inset 0 0 0 1.5px var(--ink-3);
  flex: none;
}

.bell[data-state='on'] {
  color: var(--ink);
  border-color: var(--ink-3);
}

.bell[data-state='on']::before {
  background: var(--ink);
  box-shadow: var(--glow) rgba(160, 200, 255, 0.6);
}

.bell[aria-disabled='true'] {
  cursor: not-allowed;
  color: var(--ink-3);
  border-style: dashed;
}

/* Cycles auto → light → dark. The glyph is the current *resolved* look, so the
   button always shows what you are getting, not what you asked for. */
.theme {
  appearance: none;
  display: flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--edge);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  color: var(--ink-2);
  font: inherit;
  font-size: var(--t-meta);
  letter-spacing: 0.04em;
  padding: 5px 9px;
  cursor: pointer;
  white-space: nowrap;
}

.theme:hover {
  color: var(--ink);
  border-color: var(--ink-3);
}

.theme svg {
  width: 13px;
  height: 13px;
  display: block;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.clock {
  color: var(--ink-2);
  font-size: var(--t-ui);
  letter-spacing: 0.04em;
}

.link-state {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--t-meta);
  letter-spacing: 0.06em;
  color: var(--ink-3);
  white-space: nowrap;
}

.link-state::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ink-3);
  flex: none;
}

.link-state[data-up='true'] {
  color: var(--ink-2);
}

.link-state[data-up='true']::before {
  background: var(--rolling);
  box-shadow: var(--glow) rgba(255, 171, 46, 0.55);
}

/* A monitoring instrument that keeps showing you a confident picture after its
   feed died is worse than one that shows you nothing. When the stream drops, the
   wall greys out and says so — every lamp on it is now a memory. */
.link-state[data-stale='true'] {
  color: var(--tally-ink);
  border: 1px solid var(--tally);
  border-radius: var(--radius-sm);
  padding: 3px var(--s2);
  font-weight: 600;
}

.link-state[data-stale='true']::before {
  background: var(--tally);
  animation: tally 1.2s ease-in-out infinite;
}

body[data-stale='true'] .wall,
body[data-stale='true'] .archive {
  filter: grayscale(0.8);
  opacity: 0.5;
  transition: opacity 0.3s ease, filter 0.3s ease;
}

/* Wall-only controls, while the archive is open. Saying so beats leaving live
   controls sitting there doing nothing. */
.bar[data-mode='archive'] .wall-only {
  opacity: 0.4;
  pointer-events: none;
}

/* ── tier 1: the clock and the wordmark's text ─────────────────────────────

   First to go, because neither is telling you anything you cannot get
   elsewhere: the OS has a clock, and you know which page you are on.
   Breakpoint values throughout this file are fitted against real renders in
   the last commit of this change, not derived.                             */

@media (max-width: 1100px) {
  .clock {
    display: none;
  }
  .wordmark {
    display: none;
  }
}
```

- [ ] **Step 3: Delete the two obsolete rules further down the file**

The old masthead had a spacer element and two responsive rules that referenced it. Both are now dead.

In `public/styles.css`, find the `@media (max-width: 1100px)` block near the bottom (around line 1444, in the `responsive & motion` section) and delete it entirely — spacer and all:

```css
@media (max-width: 1100px) {
  /* .masthead wraps at every width now, so only the spacer is breakpoint-bound:
     once the header has wrapped there is nothing left to push apart. */
  .masthead-spacer {
    display: none;
  }
}
```

Then in the `@media (max-width: 700px)` block just below it, delete the three masthead rules, leaving the wall rules:

```css
@media (max-width: 700px) {
  .wall,
  .group-grid {
    grid-template-columns: 1fr;
  }
  .wall {
    padding: var(--s3);
  }
}
```

(The `.masthead`, `.zone + .zone::before` and `.clock` rules that were in that block are gone: the first two name classes that no longer exist, and the clock now sheds at 1100.)

- [ ] **Step 4: Update the one JavaScript reference to the old class**

`public/app.js:848` reads:

```js
  document.getElementById('masthead').dataset.mode = on ? 'archive' : 'wall';
```

It targets by id, not class, so it needs no change. Confirm by running:

```bash
grep -n "masthead\|\.zone\|masthead-spacer" public/*.js public/*.css public/*.html
```

Expected: hits only on `id="masthead"` in `index.html`, `getElementById('masthead')` in `app.js`, and `.bar[data-mode='archive']` in `styles.css`. If `.zone` or `masthead-spacer` appears anywhere, remove that reference.

- [ ] **Step 5: Run the suite**

Run: `npm test`
Expected: PASS, 184 tests. Nothing in the suite reads the header's structure yet except Task 1's readout guard, which is unaffected.

- [ ] **Step 6: Verify in the browser**

```bash
node bin/cctv.js --no-open
```

Open `http://127.0.0.1:4321` (the port is printed on start; use whatever it says). Check:
- At a wide window: one row, regions separated by hairlines, the camera glyph and `AGENT·CCTV` at the left, the clock and lamp pushed to the right.
- Narrow the window below 1100: the clock and the wordmark text vanish, the glyph stays.
- Narrow further: the header still wraps to a second row rather than overflowing sideways. **This is expected at this stage.**
- Open History: the filter and control regions dim and stop responding.

- [ ] **Step 7: Commit**

```bash
git add public/index.html public/styles.css
git commit -m "refactor: give the masthead six addressable regions

The header was five undifferentiated .zone divs, so the only responsive
lever it had was wrap-or-do-not-wrap for the whole row. Naming the
regions is what makes it possible to shed them one at a time, in an
order chosen rather than whatever the flex algorithm arrives at.

The order is the design: filters first, because at rest they are saying
nothing; then view and mode; then the actions. Regions to the left
survive to narrower windows than regions to their right.

Still wrapping. Nowrap without somewhere for the shed regions to go
would put the bar into horizontal overflow, which is the failure the
previous comment here was written about."
```

---

## Task 3: Glyphs on the counts, and words that clip rather than vanish

The counts are the one thing that stays in the bar at every width, so they are the one thing that has to survive losing its words. Give each a glyph, and make the words clip to screen readers rather than disappear.

**Files:**
- Modify: `public/index.html` (the four `.readout` buttons)
- Modify: `public/styles.css` (the readout rules, plus a tier-2 media block)

**Interfaces:**
- Consumes: `.i`, `.bar-states`, `.readout` from Task 2.
- Produces: the `.clips` utility class, reused by Task 6 for the action buttons' labels.

- [ ] **Step 1: Add a glyph to each readout**

In `public/index.html`, replace the four readout buttons inside `.readouts` with:

```html
          <button class="readout" data-filter="all" data-kind="all" type="button" aria-pressed="true">
            <svg class="i" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="4" y="4" width="7" height="7" rx="1" />
              <rect x="13" y="4" width="7" height="7" rx="1" />
              <rect x="4" y="13" width="7" height="7" rx="1" />
              <rect x="13" y="13" width="7" height="7" rx="1" />
            </svg>
            <b id="stat-all">0</b><span class="clips">all</span>
          </button>
          <button class="readout" data-filter="live" data-kind="live" type="button" aria-pressed="false">
            <svg class="i" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="2.75" fill="currentColor" stroke="none" />
              <path d="M6.2 6.2a8.2 8.2 0 0 0 0 11.6M17.8 17.8a8.2 8.2 0 0 0 0-11.6" />
            </svg>
            <b id="stat-live">0</b><span class="clips">live</span>
          </button>
          <button class="readout" data-filter="busy" data-kind="busy" type="button" aria-pressed="false">
            <svg class="i" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5" />
            </svg>
            <b id="stat-busy">0</b><span class="clips">working</span>
          </button>
          <button
            class="readout"
            data-filter="attention"
            data-kind="attention"
            type="button"
            aria-pressed="false"
            data-hot="false"
          >
            <svg class="i" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M18 10a6 6 0 1 0-12 0c0 4.5-2 5.5-2 5.5h16s-2-1-2-5.5" />
              <path d="M10.3 19a2.2 2.2 0 0 0 3.4 0" />
            </svg>
            <b id="stat-attention">0</b><span class="clips">working</span>
          </button>
```

**Careful:** the last button's word is `need you`, not `working`. Write it as `<span class="clips">need you</span>`. (The block above deliberately contains that mistake so you check it — fix it before moving on.)

The `live` glyph's inner `<circle>` carries `fill="currentColor" stroke="none"` as presentation attributes. `.i { fill: none }` targets the `<svg>` element, so the circle's own attributes win for the circle. Do not add a `.i *` selector — it would flatten this.

- [ ] **Step 2: Style the glyph and add the clipping utility**

In `public/styles.css`, immediately after the `.readout` rule, add:

```css
/* Colour is already carrying "working" and "needs you", but colour alone is
   not a distinction a colourblind or greyscale reader gets. Once the words
   clip at the next tier down, the glyph is the only thing left telling these
   four counts apart, so it is not decoration. */
.readout .i {
  width: 13px;
  height: 13px;
  align-self: center;
  opacity: 0.75;
}

.readout[aria-pressed='true'] .i {
  opacity: 1;
}

.readout[data-kind='busy'] .i {
  color: var(--rolling-ink);
}

.readout[data-kind='attention'][data-hot='true'] .i {
  color: var(--tally-ink);
}
```

Then, at the very end of the `.bar` section (just before the tier-1 media block added in Task 2), add the clipping utility:

```css
/*
  A label that has run out of room. Clipped rather than `display: none`,
  because the accessible name of the "working" button has to stay "3 working"
  and not "3" — a screen-reader user reading a bare number off a monitoring
  dashboard has been told nothing at all.

  Same technique as .sr-only; a separate class because this one is applied
  conditionally by a media query rather than always.
*/
.clips {
  overflow: hidden;
}
```

- [ ] **Step 3: Add the narrowest tier — the count words clip, and so does the healthy lamp's**

Append to `public/styles.css`, after the tier-1 block:

```css
/* ── the narrowest tier: words on things that are not only words ───────────

   The glyph and the number carry the counts from here down; the words stay in
   the accessibility tree. The lamp gives up its word too — but only while it
   is healthy.                                                              */

@media (max-width: 640px) {
  .readout .clips,
  .link-state[data-up='true']:not([data-stale='true']) .clips {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
  .readout {
    gap: 5px;
    padding: 3px 7px;
  }
}
```

The lamp's own markup has to change for that selector to have anything to hold. In `public/index.html`, the link element's text is written by JavaScript; wrap it so the word is addressable:

```html
        <div class="link-state" id="link" data-up="false"><span class="clips">connecting</span></div>
```

and in `public/app.js`, every `link.textContent = …` becomes a write to that span. There are several; find them with:

```bash
grep -n "link.textContent\|link.dataset" public/app.js
```

Add a helper beside the first of them and route every assignment through it:

```js
const linkWord = link.querySelector('.clips');

/*
  A lamp reading "live" next to a green dot is the dot saying it twice, and on a
  phone that word is competing with the thing the page exists to show. A lamp
  reading "signal lost" is the only moment the lamp is worth reading, so that
  one keeps its word at every width — see the media query in styles.css, which
  clips the word only while data-up is true and data-stale is not.
*/
function setLink(word, title) {
  linkWord.textContent = word;
  link.title = title || word;
}
```

Replace each `link.textContent = 'x'` with `setLink('x')`, and the `no credential` case — which already sets an explaining `link.title` — with `setLink('no credential', 'Reopen the link your operator gave you — it carries the token this page needs.')`, deleting the separate `link.title` assignment there.

**`signal lost` and `no credential` must keep their words at every width.** `signal lost` sets `data-stale`, and `no credential` leaves `data-up` false, so the selector above excludes both. Verify it rather than assuming: Step 5 covers it.

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS, 184 tests.

- [ ] **Step 5: Verify in the browser**

With the server running, at a window wider than 640: four counts, each with a glyph, a number and a word, and the lamp reading `live`. Narrow past 640: the count words go, the glyphs and numbers stay, the group of four gets noticeably tighter, and the lamp is a lone dot.

Then confirm the accessible names survived. In the devtools console:

```js
[...document.querySelectorAll('.readout')].map((b) => b.textContent.trim())
```

Expected at any width: `["0 all", "0 live", "0 working", "0 need you"]` — with whatever the live numbers are. If any entry is a bare number, the word was removed rather than clipped and Step 3 is wrong.

Now the case the whole lamp rule exists for. Narrow the window to 390 and **stop the server** (Ctrl-C in the terminal running it). Expect: the wall greys out, and the lamp shows the word `signal lost` — not a bare dot. Restart the server; the lamp goes back to a lone dot at that width.

Then test the other unhealthy state: with the server running, open the dashboard at 390 in a private window with no token in the URL and no cookie. The lamp must read `no credential`, with its word, and its tooltip must explain what to do.

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/styles.css public/app.js
git commit -m "feat: glyphs on the counts, and words that clip instead of vanish

The counts and the lamp are the two things that stay in the bar at every
width, so they are the two that have to survive losing their words.

Colour already separates working from needs-you, but colour alone is not
a distinction a greyscale or colourblind reader gets, and on a phone the
glyph is the only thing left. The words clip rather than display:none so
the button's accessible name stays \"3 working\" — a screen reader
announcing a bare number off a monitoring dashboard has said nothing.

The lamp gives up its word only while it is healthy. \"live\" beside a
green dot is the dot saying it twice. \"signal lost\" and \"no credential\"
keep their words at every width, because that is the entire reason the
lamp is there: an instrument still showing a confident picture after its
feed died is worse than one showing nothing."
```

---

## Task 4: Pickers become chips

The width saving that makes the single row possible. A picker shows its value only when the value is not its default; the rest of the time it is a dimmed icon. The `<select>` stays, laid transparently over the chip.

**Files:**
- Modify: `public/index.html` (`.bar-filters` and `.bar-controls` contents)
- Modify: `public/styles.css` (add `.chip-pick` rules)
- Modify: `public/app.js` (`refreshFilterOptions`, new `paintChips`, change handlers, `applyView`)
- Modify: `public/views.js` (2 lines)

**Interfaces:**
- Consumes: `.bar-filters`, `.bar-controls`, `.i` from Task 2.
- Produces:
  - `paintChips(): void` in `app.js` — repaints all four chips from their selects' current values. Call it after anything that changes a select's value or option set.
  - Markup contract: a `.chip-pick` contains `.chip-icon`, `.chip-value` and exactly one `<select>`; it carries `data-set="true"|"false"` and `data-label="<Word>"`.
  - Option contract: an `<option>` may carry `data-chip="<clean label>"`. When absent, `textContent` is used.

- [ ] **Step 1: Replace the two picker regions' markup**

In `public/index.html`, replace the contents of `.bar-filters` and `.bar-controls` (leave the `<div>` open/close tags and their classes alone) with:

```html
      <div class="bar-filters wall-only">
        <label class="chip-pick" data-label="Agent" data-set="false">
          <span class="chip-icon">
            <svg class="i chip-default" viewBox="0 0 24 24" aria-hidden="true">
              <path d="m12 4 1.9 4.9L18.8 10.8l-4.9 1.9L12 17.6l-1.9-4.9L5.2 10.8l4.9-1.9Z" />
            </svg>
            <span class="chip-mark" id="chip-mark-source"></span>
          </span>
          <span class="chip-value"></span>
          <select id="pick-source" aria-label="Filter by agent">
            <option value="all">all</option>
          </select>
        </label>

        <label class="chip-pick" data-label="Project" data-set="false">
          <span class="chip-icon">
            <svg class="i" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3.5 7.5a2 2 0 0 1 2-2h3.2l2 2.5h7.8a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />
            </svg>
          </span>
          <span class="chip-value"></span>
          <select id="pick-project" aria-label="Filter by project">
            <option value="all">all</option>
          </select>
        </label>

        <label class="chip-pick" id="pick-group-label" data-label="Group by" data-set="false">
          <span class="chip-icon">
            <svg class="i" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 5.5h6M4 9.5h6M14 5.5h6M14 9.5h6M4 15h16M4 19h16" />
            </svg>
          </span>
          <span class="chip-value"></span>
          <select id="pick-group" aria-label="Group the wall by">
            <option value="none" data-chip="ungrouped">nothing</option>
            <option value="project" data-chip="by project">project</option>
            <option value="agent" data-chip="by agent">agent</option>
            <option value="state" data-chip="by state">state</option>
            <option value="branch" data-chip="by branch">branch</option>
          </select>
        </label>
      </div>

      <div class="bar-controls wall-only">
        <label class="chip-pick" id="pick-view-label" data-label="View" data-always="true" data-set="true">
          <span class="chip-icon">
            <svg class="i" viewBox="0 0 24 24" aria-hidden="true">
              <path d="m12 3.5 8.5 4.2-8.5 4.3-8.5-4.3Z" />
              <path d="m3.5 12 8.5 4.3 8.5-4.3" />
              <path d="m3.5 16.2 8.5 4.3 8.5-4.3" />
            </svg>
          </span>
          <span class="chip-value"></span>
          <select id="pick-view" aria-label="Which view"></select>
        </label>
        <span class="view-warn" id="view-warn" role="status" hidden></span>
        <label class="pick">
          <span>mode</span>
          <select id="pick-mode">
            <option value="wall">wall</option>
            <option value="focus">focus</option>
            <option value="tail">tail</option>
          </select>
        </label>
      </div>
```

The mode picker is deliberately left as-is; Task 5 replaces it.

`data-always="true"` on the view chip is what keeps it showing its name even though every other chip hides its value at the default. Which view you are watching is never "nothing".

- [ ] **Step 2: Style the chip**

In `public/styles.css`, add after the `.pick select option` rule:

```css
/*
  A picker that costs width only when it is doing something.

  "Agent: all" and "project: all" together were about 370px of header saying
  nothing at all, and that was most of why the row could not fit. A chip on its
  default value is an icon; set it, and it shows the value and lights up. The
  width the bar spends on filtering is now proportional to how much filtering
  is actually on.

  The <select> is the real control, laid over the chip at zero opacity, so the
  native picker, the keyboard, the screen reader and the iOS wheel all keep
  working. There is no listbox here to reimplement.
*/
.chip-pick {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 4px 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--ink-3);
  font-size: var(--t-meta);
  letter-spacing: 0.02em;
  cursor: pointer;
}

.chip-pick:hover {
  color: var(--ink-2);
  border-color: var(--edge);
}

/* :focus-within and not :focus, because the thing that actually takes focus is
   the invisible select on top. Without this the chip is a keyboard black hole:
   focusable, and with no way to see that it is focused. */
.chip-pick:focus-within {
  border-color: var(--ink-3);
  color: var(--ink);
  outline: 2px solid var(--steel);
  outline-offset: 1px;
}

.chip-pick[data-set='true'] {
  background: var(--panel-2);
  border-color: var(--edge);
  color: var(--ink);
}

.chip-icon {
  display: flex;
  flex: none;
}

.chip-mark {
  display: none;
  width: 13px;
  height: 13px;
}

.chip-mark svg {
  width: 100%;
  height: 100%;
  display: block;
  fill: currentColor;
}

/* An agent chip holding a real agent shows that agent's own mark instead of the
   generic one — the same marks the tiles use, so the chip and the tiles it
   filters to are visibly the same thing. */
.chip-pick[data-set='true'] .chip-mark:not(:empty) {
  display: block;
}

.chip-pick[data-set='true'] .chip-mark:not(:empty) + .chip-default,
.chip-pick[data-set='true'] .chip-default:has(+ .chip-mark:not(:empty)) {
  display: none;
}

.chip-value {
  min-width: 0;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* A chip on its default has nothing worth the pixels. Hidden rather than
   emptied so the element keeps its place and the chip does not resize by a
   pixel on every repaint. */
.chip-pick[data-set='false'] .chip-value {
  display: none;
}

.chip-pick select {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  border: 0;
  padding: 0;
  margin: 0;
  appearance: none;
  cursor: pointer;
  /* iOS zooms the whole page when a form control under 16px takes focus. The
     select is invisible, but the zoom is not. */
  font-size: 16px;
}
```

The `.chip-default` / `.chip-mark` swap is written twice — once with `+` and once with `:has()` — because only the second is correct and `:has()` has been baseline since 2023. Delete the first selector (`.chip-mark:not(:empty) + .chip-default`); `.chip-default` comes *before* `.chip-mark` in the markup, so a sibling combinator pointing that way never matches. Keep only:

```css
.chip-pick[data-set='true'] .chip-default:has(+ .chip-mark:not(:empty)) {
  display: none;
}
```

- [ ] **Step 3: Give the built options a clean label**

In `public/app.js`, inside `refreshFilterOptions`'s `build` helper (around line 874), the options are labelled with a count — `all (12)`, `agent-cctv (4)`. A chip wants the name without the tally. Add a `data-chip` alongside.

Change the option-creating branch from:

```js
      select.replaceChildren();
      for (const v of wanted) {
        const label = v === 'all' ? `all (${values.length})` : `${labelFor(v)} (${counts.get(v)})`;
        const opt = el('option', null, label);
        opt.value = v;
        select.append(opt);
      }
```

to:

```js
      select.replaceChildren();
      for (const v of wanted) {
        const label = v === 'all' ? `all (${values.length})` : `${labelFor(v)} (${counts.get(v)})`;
        const opt = el('option', null, label);
        opt.value = v;
        // The chip shows the name without the tally: the count belongs in the
        // open list, where you are choosing, not on the closed chip, where you
        // are reading what is set.
        opt.dataset.chip = v === 'all' ? 'all' : labelFor(v);
        select.append(opt);
      }
```

- [ ] **Step 4: Add `paintChips`**

In `public/app.js`, immediately after the `refreshFilterOptions` function (after its closing brace, before the `sourceSel.addEventListener` on line 901), add:

```js
/*
  A chip earns its width by being set. Anything that changes a select's value or
  rebuilds its options has to come back through here, or the chip goes on
  showing the last thing it was told.
*/
const CHIP_DEFAULT = { 'pick-source': 'all', 'pick-project': 'all', 'pick-group': 'none' };

function paintChip(select) {
  const chip = select.closest('.chip-pick');
  if (!chip) return;
  const opt = select.selectedOptions[0];
  const value = opt ? opt.dataset.chip || opt.textContent : '';
  chip.querySelector('.chip-value').textContent = value;
  const dflt = CHIP_DEFAULT[select.id];
  chip.dataset.set = String(chip.dataset.always === 'true' || (dflt !== undefined && select.value !== dflt));
  chip.title = `${chip.dataset.label}: ${value}`;
}

/*
  The agent marks are the tiles' own, so a chip filtered to Claude Code and the
  tiles it leaves on the wall carry the same glyph.

  Written as two statements rather than one because test/spa-guard.test.js
  matches its allowlist against the literal right-hand side, and `meta.icon` is
  what is on it. Reusing an approved form beats growing that list — a short
  list is the whole point of it.
*/
function paintAgentMark() {
  const holder = document.getElementById('chip-mark-source');
  if (sourceSel.value === 'all') {
    holder.replaceChildren();
    return;
  }
  const meta = sourceMeta(sourceSel.value);
  holder.innerHTML = meta.icon;
}

function paintChips() {
  for (const sel of [sourceSel, projectSel, groupSel, viewSel]) paintChip(sel);
  paintAgentMark();
}
```

`groupSel` and `viewSel` are not in scope at that point in the file. Add the two lookups next to `sourceSel` and `projectSel` at line 858:

```js
const sourceSel = document.getElementById('pick-source');
const projectSel = document.getElementById('pick-project');
const groupSel = document.getElementById('pick-group');
const viewSel = document.getElementById('pick-view');
```

and **delete** the now-duplicated `const groupSel = document.getElementById('pick-group');` at line 962, keeping the two lines under it:

```js
groupSel.value = filters.groupBy;
groupSel.addEventListener('change', () => {
  filters.groupBy = groupSel.value;
  applyFilters();
});
```

- [ ] **Step 5: Call it from the four places that change a select**

In `public/app.js`:

1. At the end of `refreshFilterOptions` (after the two `build(...)` calls, line 898), add:

```js
  paintChips();
```

2. In the `sourceSel` change handler:

```js
sourceSel.addEventListener('change', () => {
  filters.source = sourceSel.value;
  paintChips();
  applyFilters();
});
```

3. In the `projectSel` change handler:

```js
projectSel.addEventListener('change', () => {
  filters.project = projectSel.value;
  paintChips();
  applyFilters();
});
```

4. In the `groupSel` change handler:

```js
groupSel.addEventListener('change', () => {
  filters.groupBy = groupSel.value;
  paintChips();
  applyFilters();
});
```

5. In `applyView` (line 1206), after `refreshFilterOptions();` — which already calls `paintChips()` — nothing more is needed. But `applyView` sets `groupSel.value` *before* that call, so confirm the order in the final function is:

```js
function applyView(view, { seedGroup = true } = {}) {
  filters.view = wantedViewId();
  if (seedGroup && view.groupBy) {
    filters.groupBy = view.groupBy;
    groupSel.value = view.groupBy;
  }
  if (seedGroup && view.mode) setMode(view.mode);
  tailDirty = true;
  saveFilters();
  refreshFilterOptions();
  layout();
  paintStats();
}
```

If `refreshFilterOptions()` comes after the `groupSel.value` assignment — it does — the chip is repainted with the new value and there is nothing to add.

6. At the bottom of the file, after `mountViews({...})` on line 1278, add:

```js
paintChips();
```

so the chips are painted once at startup, before the first catalog arrives.

- [ ] **Step 6: Give the view options a clean label**

In `public/views.js`, in `paint()` (around line 68), the option loop reads:

```js
    for (const v of catalog) {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = v.name;
      select.append(opt);
    }
```

Add one line so the chip has a clean name to show — the view's name is already clean, but being explicit means `paintChip` never has to know which selects annotate and which do not:

```js
    for (const v of catalog) {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = v.name;
      // The chip reads data-chip when it is there. Set it even though the name
      // needs no cleaning, so there is one rule rather than two.
      opt.dataset.chip = v.name;
      select.append(opt);
    }
```

- [ ] **Step 7: Run the suite**

Run: `npm test`
Expected: PASS, 184 tests. `test/spa-guard.test.js` must pass **without any edit to `STATIC_ICON_SOURCES`** — that is this task's real assertion. If it fails with `innerHTML assigned from sourceMeta(...).icon`, Step 4's two-statement form was collapsed into one; restore it.

- [ ] **Step 8: Verify in the browser**

With the server running and at least one session on the wall:

- At rest, the three filter chips are dimmed icons with no text; the view chip shows `Everything`.
- Pick an agent: the chip lights up, shows the agent's name, and its icon becomes that agent's own mark.
- Set it back to `all`: the mark goes, the sparkle returns, the chip dims.
- Pick a project with a long name: the chip ellipsises rather than widening the header.
- Tab to a chip: it takes a visible focus ring. Press Space or Enter: the native list opens. Arrow to a value and press Enter: the wall filters and the chip updates.
- Hover a chip: the tooltip reads `Agent: all`, `Project: agent-cctv` and so on.
- Choose `＋ Save current as…` from the view chip: the dialog opens, and cancelling leaves the chip on the view you were already on.

- [ ] **Step 9: Commit**

```bash
git add public/index.html public/styles.css public/app.js public/views.js
git commit -m "feat: a picker costs width only when it is filtering

Laid out flat the header needed ~1760px, which is why it wrapped. Icons
alone claw back ~250 of that, and would not have been enough.

The actual waste was that four of the five pickers sit on their default
nearly all the time: \"agent: all\" and \"project: all\" together were about
370px of header saying nothing. So a picker now shows its value only
when the value is not the default, and is a dimmed icon otherwise. At
rest the row lands near 1030px; it grows only when you have asked it to.

The select is still the real control, laid over the chip at zero
opacity, so the native list, the keyboard, the screen reader and the iOS
wheel picker all keep working and there is no listbox here to
reimplement. Its font-size is 16px because iOS zooms the page for
anything smaller taking focus, and an invisible control zooming the page
is still a zoomed page.

The agent chip borrows the tiles' own marks, so a chip filtered to
Claude Code and the tiles it leaves behind carry the same glyph."
```

---

## Task 5: Mode as a segmented toggle

Three options, all of them inherently visual, and narrower than a labelled select.

**Files:**
- Modify: `public/index.html` (replace `#pick-mode` inside `.bar-controls`)
- Modify: `public/styles.css` (add `.seg` rules)
- Modify: `public/app.js` (`setMode`, the change listener)
- Modify: `test/header-markup.test.js` (two new tests)

**Interfaces:**
- Consumes: `.bar-controls`, `.i` from Task 2; `readHtml`, `readScript`, `buttons`, `attr` from Task 1.
- Produces: `.seg` / `.seg-btn` markup contract — a `<div class="seg">` holding one `<button class="seg-btn" data-mode="…">` per entry of `MODES` in `public/app.js`, in the same order.

- [ ] **Step 1: Write the failing tests**

Append to `test/header-markup.test.js`:

```js
test('the mode toggle offers exactly the modes app.js knows, in order', () => {
  const html = readHtml();
  const app = readScript('app.js');

  const declared = app.match(/const MODES = \[([^\]]*)\]/);
  assert.ok(declared, 'could not find `const MODES = [...]` in public/app.js');
  const modes = [...declared[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

  const offered = buttons(html)
    .filter((tag) => tag.includes('class="seg-btn"'))
    .map((tag) => attr(tag, 'data-mode'));

  assert.deepEqual(
    offered,
    modes,
    'the header offers different modes, or a different order, than MODES in public/app.js'
  );
});

test('every icon-only control carries an accessible name', () => {
  const html = readHtml();
  /*
    A button whose entire visible content is an <svg> has no accessible name of
    its own — a screen reader announces "button" and nothing else. This is the
    failure a header made of icons is most able to introduce, and it is silent
    to everyone not using one, so it gets a guard rather than a promise.
  */
  for (const m of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    const [, rawAttrs, inner] = m;
    const tag = `<button${rawAttrs}>`;
    const withoutSvg = inner.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<!--[\s\S]*?-->/g, '');
    const hasText = /[^\s<>]/.test(withoutSvg.replace(/<[^>]*>/g, ''));
    if (hasText) continue;

    const name = attr(tag, 'aria-label');
    assert.ok(
      name && name.trim(),
      `icon-only button has no aria-label:\n  ${tag.replace(/\s+/g, ' ')}`
    );
  }
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/header-markup.test.js`
Expected: the mode test FAILS with `the header offers different modes, or a different order, than MODES in public/app.js` (it finds `[]` against `['wall','focus','tail']`). The icon-only test PASSES — there are no icon-only buttons yet, so it is vacuously true and will start biting in this task's Step 3.

- [ ] **Step 3: Replace the mode picker with the toggle**

In `public/index.html`, inside `.bar-controls`, replace the mode `<label class="pick">…</label>` with:

```html
        <div class="seg" role="group" aria-label="Display mode">
          <button class="seg-btn" data-mode="wall" type="button" aria-pressed="true" aria-label="Wall — every session as a tile" title="Wall — every session as a tile">
            <svg class="i" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="3.5" y="4.5" width="7.5" height="6.5" rx="1" />
              <rect x="13" y="4.5" width="7.5" height="6.5" rx="1" />
              <rect x="3.5" y="13" width="7.5" height="6.5" rx="1" />
              <rect x="13" y="13" width="7.5" height="6.5" rx="1" />
            </svg>
          </button>
          <button class="seg-btn" data-mode="focus" type="button" aria-pressed="false" aria-label="Focus — one session big, the rest as a rail" title="Focus — one session big, the rest as a rail">
            <svg class="i" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="3.5" y="4.5" width="11" height="15" rx="1" />
              <rect x="16.5" y="4.5" width="4" height="4" rx="1" />
              <rect x="16.5" y="10" width="4" height="4" rx="1" />
              <rect x="16.5" y="15.5" width="4" height="4" rx="1" />
            </svg>
          </button>
          <button class="seg-btn" data-mode="tail" type="button" aria-pressed="false" aria-label="Tail — the whole room as one stream" title="Tail — the whole room as one stream">
            <svg class="i" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 6.5h16M4 11h16M4 15.5h11M4 20h7" />
            </svg>
          </button>
        </div>
```

- [ ] **Step 4: Style it**

In `public/styles.css`, after the `.chip-pick select` rule, add:

```css
/*
  Three options, all of them a picture of a layout. A select would spend a word
  and a caret saying what the picture says, and would be wider.

  It borrows .readout's lit-and-underlined treatment on purpose: the mode
  toggle and the state filter are the same kind of control — pick one of a
  small set — and reading as one family beats inventing a second look.
*/
.seg {
  display: flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--edge);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  flex: none;
}

.seg-btn {
  appearance: none;
  border: 0;
  background: transparent;
  font: inherit;
  cursor: pointer;
  display: flex;
  align-items: center;
  padding: 5px 8px;
  border-radius: 2px;
  color: var(--ink-3);
}

.seg-btn:hover {
  color: var(--ink);
}

.seg-btn[aria-pressed='true'] {
  background: var(--panel-hi);
  box-shadow: inset 0 -2px 0 var(--ink);
  color: var(--ink);
}
```

- [ ] **Step 5: Wire it**

In `public/app.js`, replace the `modeSel` lookup at line 973:

```js
const modeSel = document.getElementById('pick-mode');
```

with:

```js
const modeBtns = [...document.querySelectorAll('.seg-btn')];
```

In `setMode`, replace the line:

```js
  modeSel.value = mode;
```

with:

```js
  for (const b of modeBtns) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
```

Replace `groupLabel`'s lookup at line 976 — the element is now the group chip and its id is unchanged, so it needs no edit. Confirm:

```js
const groupLabel = document.getElementById('pick-group-label');
```

still resolves (it is the `.chip-pick` added in Task 4).

Finally replace the change listener at line 1027:

```js
modeSel.addEventListener('change', () => setMode(modeSel.value, { fromUser: true }));
```

with:

```js
for (const btn of modeBtns) {
  btn.addEventListener('click', () => setMode(btn.dataset.mode, { fromUser: true }));
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/header-markup.test.js`
Expected: PASS, 3 tests.

Then prove the icon-only guard bites: temporarily delete `aria-label="Tail — the whole room as one stream"` from the tail button, re-run, and confirm it FAILS with `icon-only button has no aria-label`. Restore it.

- [ ] **Step 7: Run the whole suite**

Run: `npm test`
Expected: PASS, 186 tests.

- [ ] **Step 8: Verify in the browser**

- The three mode glyphs sit in a bordered group where the mode select was; the current one is lit and underlined.
- Clicking each switches the wall, exactly as the select did. Focus mode still promotes a session from the rail; tail still streams.
- The group-by chip disappears in focus and tail, and comes back in wall.
- Reload: the mode you left it in is restored and the right button is lit.
- Switch to a view whose file carries `mode: focus`: the toggle follows.

- [ ] **Step 9: Commit**

```bash
git add public/index.html public/styles.css public/app.js test/header-markup.test.js
git commit -m "feat: mode is a segmented toggle, not a dropdown

Three options, every one of them a picture of a layout. A select spent a
word and a caret saying what the picture says, and was wider than all
three glyphs together.

It borrows the state filter's lit-and-underlined treatment rather than
inventing a second look: pick-one-of-a-small-set is the same kind of
control in both places.

MODES in app.js and the buttons in index.html are now checked against
each other, which CLAUDE.md had listed as a pair kept in step by hand.
The icon-only-buttons guard lands with them, because this is the commit
that introduces the first ones."
```

---

## Task 6: The action buttons become icons

**Files:**
- Modify: `public/index.html` (`.bar-actions`)
- Modify: `public/styles.css` (`.bell` / `.chip` / `.theme` rules)
- Modify: `public/app.js` (`paintBell`, `applyTheme`)

**Interfaces:**
- Consumes: `.bar-actions`, `.i` from Task 2; `.clips` from Task 3.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Replace the actions markup**

In `public/index.html`, replace the contents of `.bar-actions` with:

```html
      <div class="bar-actions">
        <button class="act" id="archive-toggle" type="button" aria-pressed="false" aria-label="History — sessions that have already finished" title="History — sessions that have already finished">
          <svg class="i" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3.7 12a8.3 8.3 0 1 0 2.6-6" />
            <path d="M3.2 4v4.2h4.2" />
            <path d="M12 8.2V12l2.8 1.7" />
          </svg>
        </button>
        <button class="act bell" id="bell" type="button" data-state="off" aria-pressed="false" aria-label="Alerts">
          <svg class="i bell-glyph" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M18 10a6 6 0 1 0-12 0c0 4.5-2 5.5-2 5.5h16s-2-1-2-5.5" />
            <path d="M10.3 19a2.2 2.2 0 0 0 3.4 0" />
          </svg>
        </button>
        <button class="act theme" id="theme" type="button" aria-label="Theme">
          <span id="theme-icon"></span>
        </button>
      </div>
```

`#bell-label` and `#theme-label` are gone. Both are read by `app.js`; Steps 3 and 4 remove those reads.

- [ ] **Step 2: Style them**

In `public/styles.css`, replace the `.bell, .chip { … }` rule and everything down to the end of the `.theme:hover` rule with:

```css
/*
  The three things you can do to the wall, as opposed to the things you can
  narrow it to. Square icon buttons: at this size a word next to each cost more
  than three times what the glyph does and said the same thing.

  .chip is kept below for the dialogs, which still use it for Cancel and Save.
*/
.act {
  appearance: none;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--edge);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  color: var(--ink-2);
  font: inherit;
  padding: 6px;
  cursor: pointer;
  flex: none;
}

.act:hover:not([aria-disabled='true']) {
  color: var(--ink);
  border-color: var(--ink-3);
}

.act[aria-pressed='true'] {
  background: var(--ink);
  border-color: var(--ink);
  color: var(--panel);
}

/*
  Armed alerts. The bell fills rather than lighting a separate dot beside it —
  the dot existed because the button had a word next to it and something had to
  carry the state; the glyph can carry its own.
*/
.bell[data-state='on'] .bell-glyph {
  fill: currentColor;
  filter: drop-shadow(var(--glow) rgba(160, 200, 255, 0.6));
}

.bell[data-state='on'] {
  color: var(--ink);
  border-color: var(--ink-3);
}

.bell[aria-disabled='true'] {
  cursor: not-allowed;
  color: var(--ink-3);
  border-style: dashed;
}

/* Cycles auto → light → dark. The glyph is the current *resolved* look, so the
   button always shows what you are getting, not what you asked for. */
.theme svg {
  width: 14px;
  height: 14px;
  display: block;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* Still used by the save dialog and the archive's own controls. */
.chip {
  appearance: none;
  display: flex;
  align-items: center;
  gap: var(--s2);
  border: 1px solid var(--edge);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  color: var(--ink-2);
  font: inherit;
  font-size: var(--t-meta);
  letter-spacing: 0.04em;
  padding: 5px 10px;
  cursor: pointer;
  white-space: nowrap;
}

.chip:hover {
  color: var(--ink);
  border-color: var(--ink-3);
}

.chip[aria-pressed='true'] {
  background: var(--ink);
  border-color: var(--ink);
  color: var(--panel);
}
```

Note the `.bell::before` dot rule is deleted along with the rest — the glyph carries the state now. Do not leave it behind, or every bell gets a stray dot.

- [ ] **Step 3: Rewire the bell**

In `public/app.js`, delete line 916:

```js
const bellLabel = document.getElementById('bell-label');
```

and in `paintBell`, replace:

```js
  bellLabel.textContent = state === 'blocked' ? 'Alerts blocked' : 'Alerts';
```

with:

```js
  // The button is a glyph now, so its name is the only thing carrying the
  // state to a screen reader — and "blocked" is exactly the case where a
  // sighted user gets a dashed border and everyone else got nothing.
  bell.setAttribute('aria-label', state === 'blocked' ? 'Alerts blocked' : 'Alerts');
```

Everything else in `paintBell` — the `data-state`, the `aria-pressed`, the `aria-disabled`, the four `title` strings — is unchanged.

- [ ] **Step 4: Rewire the theme button**

In `public/app.js`, delete line 1083:

```js
const themeLabel = document.getElementById('theme-label');
```

and in `applyTheme`, replace:

```js
  themeLabel.textContent = THEME_LABEL[pref];
```

with:

```js
  themeBtn.setAttribute('aria-label', `Theme: ${THEME_LABEL[pref]}`);
```

`THEME_LABEL` stays — it is now used by the `aria-label` and by the `title` below it.

The `themeIcon.innerHTML = ...` line stays exactly as written. Its right-hand side is on the `spa-guard` allowlist verbatim; changing so much as a space breaks the suite.

- [ ] **Step 5: Run the suite**

Run: `npm test`
Expected: PASS, 186 tests. If `header-markup.test.js` fails with `icon-only button has no aria-label`, one of the three buttons in Step 1 lost its label.

- [ ] **Step 6: Verify in the browser**

- Three square icon buttons where History / Alerts / Theme were.
- History toggles the archive and shows its pressed (inverted) state while open.
- Clicking Alerts prompts for notification permission; granting it fills the bell and gives it a glow. Clicking again empties it.
- Deny notifications in site settings and reload: the bell is dashed, is still focusable, and its tooltip explains why.
- Theme cycles auto → light → dark, the glyph follows the resolved look, and both themes render every icon in the bar legibly.
- With devtools' accessibility pane, confirm the three buttons announce as `History — sessions that have already finished`, `Alerts`, `Theme: Auto`.

- [ ] **Step 7: Commit**

```bash
git add public/index.html public/styles.css public/app.js
git commit -m "feat: History, Alerts and Theme become icon buttons

At this size a word beside each glyph cost more than three times what
the glyph did and said the same thing.

The bell's armed state moves into the glyph itself, which fills when
alerts are on. The separate lit dot existed because the button had a
word next to it and something else had to carry the state; there is no
word now, and two indicators on one button is one too many.

Both buttons lost the span their label lived in, so their aria-label is
now the only thing carrying state to a screen reader — which is why
\"Alerts blocked\" moved there rather than being dropped. That case used
to give sighted users a dashed border and everyone else nothing."
```

---

## Task 7: The sheet, and one row for good

The last tier, and the flip to `nowrap`. `.bar-shelf` — the wrapper added in Task 2, which has had no effect on anything so far — becomes the sheet.

**Files:**
- Modify: `public/index.html` (sheet trigger, sheet chrome, scrim)
- Modify: `public/styles.css` (`nowrap`, `--sheet-tier`, the sheet)
- Modify: `public/app.js` (open/close, focus trap, Escape)

**Interfaces:**
- Consumes: `.bar-shelf`, `.bar-controls`, `.bar-filters`, `.bar-actions` from Task 2; `.chip-pick` from Task 4; `.seg` from Task 5; `.act` from Task 6.
- Produces: `body[data-sheet='open']` as the single source of truth for sheet state, and `--sheet-tier` as the single source of truth for where the sheet begins.

- [ ] **Step 1: Add the chrome, the trigger and the scrim**

In `public/index.html`, add the sheet's own heading and Done button as the **first children of `.bar-shelf`**, before `.bar-controls`. They belong inside the shelf, not beside it: the shelf is the sheet, and a heading positioned separately from the panel it titles would need a magic offset for the panel's height.

```html
      <div class="bar-shelf" id="bar-shelf" aria-labelledby="sheet-title">
        <!-- Only ever visible while the shelf is the sheet. At wide widths the
             shelf has no box, and neither do these. -->
        <div class="sheet-chrome">
          <h2 id="sheet-title">Controls</h2>
          <button class="chip" id="sheet-close" type="button">Done</button>
        </div>

        <!-- Which sessions are on the wall, and how they are drawn. -->
        <div class="bar-controls wall-only">
```

Then add the trigger as the **last child** of `<header class="bar">`, after `.bar-status`:

```html
      <button
        class="act sheet-open"
        id="sheet-open"
        type="button"
        aria-expanded="false"
        aria-controls="bar-shelf"
        aria-label="Controls"
        title="Controls"
      >
        <svg class="i" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16" />
          <circle cx="9" cy="7" r="2.2" />
          <circle cx="15" cy="12" r="2.2" />
          <circle cx="9" cy="17" r="2.2" />
        </svg>
      </button>
```

And the scrim immediately after the closing `</header>`:

```html
    <div class="sheet-scrim" id="sheet-scrim" hidden></div>
```

Note what is **not** here: `role="dialog"` and `aria-modal="true"` on the shelf. Above the breakpoint the shelf is not a dialog — it is three regions of a header — and a permanent dialog role would announce it as one to every screen-reader user on a desktop. Step 3 sets both attributes when the sheet opens and removes them when it closes.

- [ ] **Step 2: Flip to one row, and make the shelf the sheet**

In `public/styles.css`, in the `.bar` rule, replace:

```css
  /* Still wrapping. The regions can shed independently but the sheet that
     catches them does not exist yet; nowrap without it would put the header
     into horizontal overflow at narrow widths, which is worse than a second
     row. Switched to nowrap in the same change that adds the sheet. */
  flex-wrap: wrap;
```

with:

```css
  /*
    One row, at every width. The previous header wrapped because it had a hard
    minimum it could not get under — labels that refused to break, on controls
    that were always all present. Every tier below is a real reduction in that
    minimum, and the last one takes it down to four numbers, a lamp and a
    button. There is no longer a width at which the bar is both too wide to fit
    and unable to shed, which is the band that used to scroll sideways.
  */
  flex-wrap: nowrap;
```

Then append, after the narrowest-tier block:

```css
/* ── the sheet ─────────────────────────────────────────────────────────────

   .bar-shelf becomes the sheet. Above the breakpoint it is `display: contents`
   and the three regions inside it are ordinary flex children of the bar; below
   it, the shelf grows a box, pins itself to the bottom of the viewport and
   stacks them.

   That is the whole mechanism, and it is why nothing moves in the DOM: there is
   no second container to move things into. Widening the window past the
   breakpoint puts every region back with nothing to undo.                   */

:root {
  /*
    Where the sheet begins. Declared here because app.js reads it back — a media
    query cannot use a custom property, so the literal below has to match this
    value, but nothing outside this file has to know the number.
  */
  --sheet-tier: 820px;
}

.sheet-open,
.sheet-scrim,
.sheet-chrome {
  display: none;
}

@media (max-width: 820px) {
  .sheet-open {
    display: flex;
  }

  .sheet-scrim {
    display: block;
    position: fixed;
    inset: 0;
    background: var(--scrim);
    z-index: 28;
  }

  .bar-shelf {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0;
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 30;
    /* A phone in landscape has less height than the sheet wants. Scrolling the
       sheet beats a Done button below the fold. */
    max-height: 80vh;
    overflow-y: auto;
    padding: 0 var(--s4) calc(var(--s4) + env(safe-area-inset-bottom, 0px));
    background: var(--panel);
    border-top: 1px solid var(--edge);
    box-shadow: var(--drawer-shadow);
  }

  /* Written after the rule above so it wins on order as well as specificity.
     `hidden` on the shelf would not do: the shelf is the header's child and the
     header is very much on screen. */
  body:not([data-sheet='open']) .bar-shelf {
    display: none;
  }

  .sheet-chrome {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--s4) 0 var(--s3);
    /* The sheet scrolls; the way out of it should not scroll away. */
    position: sticky;
    top: 0;
    background: var(--panel);
  }

  .sheet-chrome h2 {
    margin: 0;
    font-size: var(--t-title);
    font-weight: 600;
    color: var(--ink);
  }

  /* Regions stack instead of running across. */
  .bar-controls,
  .bar-filters {
    flex-direction: column;
    align-items: stretch;
    gap: 0;
  }

  /* Hairlines separate regions in a row. In a column the row borders below are
     already doing that job, and a vertical rule at the top of each region is
     just a stray mark. */
  .bar-controls::before,
  .bar-filters::before,
  .bar-actions::before {
    display: none;
  }

  /* A chip in the sheet says which picker it is, and shows its value even at
     the default. Both were dropped for width, and here there is width. */
  .bar-shelf .chip-pick {
    justify-content: flex-start;
    min-height: 44px;
    padding: var(--s3) var(--s2);
    border-radius: 0;
    border-width: 0 0 1px 0;
    border-color: var(--edge-soft);
    background: none;
    font-size: var(--t-ui);
  }

  .bar-shelf .chip-pick::before {
    content: attr(data-label);
    color: var(--ink-3);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: var(--t-eyebrow);
    width: 88px;
    flex: none;
  }

  .bar-shelf .chip-pick[data-set='false'] .chip-value {
    display: block;
    color: var(--ink-3);
  }

  .bar-shelf .chip-value {
    max-width: none;
  }

  .bar-shelf .seg {
    align-self: flex-start;
    margin: var(--s3) 0;
  }

  .bar-shelf .seg-btn {
    padding: var(--s2) var(--s4);
  }

  /* Three actions across, thumb-sized. */
  .bar-actions {
    gap: var(--s2);
    padding: var(--s3) 0 0;
  }

  .bar-actions .act {
    flex: 1;
    padding: var(--s3);
  }
}
```

Two things to check as you write this, because both are silent when wrong:

- **`.bar-shelf` must not get `min-width: 0`, `flex-shrink` or any other flex-item property from the region list in Task 2.** It is not in that list, and it must not be added: at wide widths it is `display: contents` and has no box for those to apply to, and at narrow widths it is `position: fixed` and not a flex item at all.
- **The `820px` literal must equal `--sheet-tier`.** A media query cannot read a custom property, so this pair is the one hand-maintained number in the change. Task 8 changes both together.

- [ ] **Step 3: Wire the sheet open and closed**

In `public/app.js`, add after `applyTheme();`:

```js
/* ── the sheet ─────────────────────────────────────────────────────────── */

/*
  Below the breakpoint, .bar-shelf stops being a layout no-op and becomes a
  panel pinned to the bottom of the viewport. Nothing moves in the DOM, so this
  only has to own three things: open-ness, focus, and Escape — the same three
  the inspector drawer owns.
*/
const shelf = document.getElementById('bar-shelf');
const sheetOpenBtn = document.getElementById('sheet-open');
const sheetScrim = document.getElementById('sheet-scrim');

/*
  Read from CSS rather than repeated here. A breakpoint duplicated across two
  files is a pair that stays in step until the day it does not, and the failure
  is a sheet that cannot be closed by widening the window.
*/
const sheetTier = matchMedia(
  `(max-width: ${getComputedStyle(document.documentElement).getPropertyValue('--sheet-tier').trim() || '820px'})`
);

function setSheet(open) {
  document.body.dataset.sheet = open ? 'open' : 'shut';
  sheetOpenBtn.setAttribute('aria-expanded', String(open));
  sheetScrim.hidden = !open;
  document.body.dataset.locked = String(open);

  /*
    The dialog role is added and removed rather than sitting in the markup.
    Above the breakpoint the shelf is not a dialog, it is three regions of a
    header, and announcing it as one to every desktop screen-reader user would
    be a worse bug than the one this whole change is fixing.
  */
  if (open) {
    shelf.setAttribute('role', 'dialog');
    shelf.setAttribute('aria-modal', 'true');
    // The first control, not the heading: landing on the title means tabbing
    // past the chrome before reaching anything you can act on.
    shelf.querySelector('select, button')?.focus();
  } else {
    shelf.removeAttribute('role');
    shelf.removeAttribute('aria-modal');
    sheetOpenBtn.focus();
  }
}

sheetOpenBtn.addEventListener('click', () => setSheet(document.body.dataset.sheet !== 'open'));
sheetScrim.addEventListener('click', () => setSheet(false));
document.getElementById('sheet-close').addEventListener('click', () => setSheet(false));

/*
  Widening the window puts every region back in the bar on its own, but the
  scrim, the scroll lock and the open flag would all survive it — leaving a
  backdrop over a header that is working perfectly well.
*/
sheetTier.addEventListener('change', (e) => {
  if (!e.matches && document.body.dataset.sheet === 'open') setSheet(false);
});
```

Then call it once at startup. Put the call at the bottom of the file, next to the other one-time paints, **not** inline above — `setSheet(false)` moves focus to the trigger, and running that during module evaluation steals focus from the page on load:

```js
document.body.dataset.sheet = 'shut';
```

That is all the initial state needs: `aria-expanded` is already `false` in the markup, the scrim is already `hidden`, and there is no role to remove.

- [ ] **Step 3b: Teach the focus trap and Escape about the sheet**

`trapFocus` at `public/app.js:649` is hardcoded to the inspector. Generalise it rather than writing a second copy:

```js
function trapWithin(container, e) {
  const stops = container.querySelectorAll('button, [href], select, textarea, input, [tabindex]:not([tabindex="-1"])');
  if (!stops.length) return;
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/*
  Two modals, never both open — the sheet only exists at widths where the
  inspector covers the whole screen anyway. The inspector is checked first
  because it is the one on top when they do overlap.
*/
function trapFocus(e) {
  if (e.key !== 'Tab') return;
  if (inspector.dataset.open === 'true') trapWithin(inspector, e);
  else if (document.body.dataset.sheet === 'open') trapWithin(shelf, e);
}
```

`trapWithin` and `trapFocus` are declared where the old `trapFocus` was, but `shelf` is defined further down the file. Function declarations hoist and `const shelf` does not — however `trapFocus` only ever runs from an event handler, long after the module has finished evaluating, so the reference resolves. If that feels too subtle to leave unremarked, move the three `const` lookups for the sheet up beside `closeBtn` at line 602 instead; either is fine, but do not leave a comment claiming it is a hoisting trick, because it is not.

Then extend the Escape handler at `public/app.js:728`:

```js
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    // The sheet is above the inspector when both could be open, and
    // closeInspector() is a no-op when the drawer is shut, so ordering these
    // the other way round would close the wrong one.
    if (document.body.dataset.sheet === 'open') setSheet(false);
    else closeInspector();
  }
  trapFocus(e);
});
```

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS, 186 tests.

- [ ] **Step 5: Verify in the browser at every width**

With the server running, use devtools' device toolbar. At each width the bar must be **one row** with no horizontal scrollbar on `<body>`:

| Width | In the bar | In the sheet |
| --- | --- | --- |
| 1440 | everything | — (trigger hidden) |
| 1000 | no clock, no wordmark text | — (trigger hidden) |
| 800 | mark, counts with words, lamp, trigger | view, mode, agent, project, group by, actions |
| 500 | mark, counts as glyph+number, lamp dot, trigger | all of the above |

Then, at 500:
- Tap the trigger: the sheet rises, the wall dims behind it, and focus lands on the view select.
- Each chip shows its label on the left and its value on the right — including the ones sitting on their default, which are blank in the bar. Every row is at least 44px tall.
- The mode toggle and the three actions are there, the actions spread across the full width.
- Change a filter: the wall behind updates.
- Tab repeatedly: focus cycles inside the sheet and never reaches the wall behind it.
- Escape, Done, and a tap on the scrim each close it and return focus to the trigger.
- The page behind does not scroll while the sheet is open.
- Open History, then open the sheet: the view, mode and filter rows are dimmed and inert; the actions are not.

Finally the two that only fail on a real device or a rotation:
- Open the sheet, then widen the window past 820: the sheet closes on its own, no scrim is left over the header, and the page scrolls again.
- At 500 in landscape (say 740×360), open the sheet: it caps at 80% of the height, scrolls, and the `Controls` heading with its Done button stays pinned at the top of the panel.

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/styles.css public/app.js
git commit -m "feat: one row at every width, with a sheet for what does not fit

The header now sheds by region, in a fixed order, down to four counts, a
lamp and a button — which is what a phone was asked to show.

The regions never move in the DOM. .bar-shelf is display:contents at
wide widths — no box, three ordinary flex children — and becomes the
pinned panel below the breakpoint. That is the whole mechanism, and it
is why widening the window puts everything back with nothing to undo
and no resize handler to jitter. The alternative —
measuring the bar and moving the lowest-priority control into an
overflow menu until it fits — handles awkward intermediate widths better
and was rejected for putting a reflow loop in app.js that node --test
cannot reach.

The bar is nowrap from here. The band of widths that used to scroll
sideways existed because the row had a minimum it could not get under;
every tier is now a real reduction in that minimum."
```

---

## Task 8: Fit the breakpoints against real renders

Every breakpoint so far — 1100, 820, 640 — came from measuring the old controls on paper. Replace them with numbers taken from the thing itself.

**Files:**
- Modify: `public/styles.css` (three breakpoints, one of them written twice)

**Interfaces:**
- Consumes: everything.
- Produces: nothing.

- [ ] **Step 1: Get sessions onto the wall**

The header's width depends on what is in the pickers — a project called `agent-cctv` and one called `some-deeply-nested-monorepo-package` are different headers. Start the dashboard against real data:

```bash
node bin/cctv.js --no-open
```

If nothing is running, `node bin/cctv.js doctor` says what it can read. Failing that, point it at the repo's fixtures:

```bash
AGENT_CCTV_CLAUDE_DIR=test/fixtures/claude AGENT_CCTV_CODEX_DIR=test/fixtures/codex node bin/cctv.js --no-open
```

- [ ] **Step 2: Find each breakpoint by hand**

In devtools' device toolbar, drag the width down slowly from 1920 and write down the width at which each of these first becomes true:

1. The clock and the wordmark start crowding the pickers → **tier 1**, currently `1100px`.
2. The view chip, mode toggle and actions no longer sit comfortably beside the counts → **the sheet tier**, currently `820px`.
3. The count words start crowding the lamp → **the narrowest tier**, currently `640px`.

Do it twice: once with every filter at rest, and once with agent and project both set to their longest available values. **Use the wider of the two readings.** A breakpoint fitted to the resting header collapses late for anyone actually filtering, which is exactly when the header is widest and when they can least spare the row.

- [ ] **Step 3: Set the values**

Round each reading up to the nearest 20px and put it in the corresponding `@media (max-width: …)` in `public/styles.css`.

There are **four** edits for three numbers: the sheet tier appears twice, once as `--sheet-tier` in `:root` and once as the literal in its own `@media` query, because a media query cannot read a custom property. They must stay equal — `app.js` reads the custom property to decide when to close the sheet on a resize, so a mismatch gives you a sheet that will not close when the window is widened.

Update the comment above each tier if the new number tells a different story than the old one.

- [ ] **Step 4: Screenshot the result**

Capture the bar at 1920, 1440, 1280, 900, 700 and 390, in **both** themes — twelve renders. Confirm in every one:

- one row, no horizontal scrollbar on `<body>`;
- every glyph legible against its background (light theme is not the dark theme inverted; `--ink-3` on `--panel-2` is the pair to watch);
- the lamp visible and, when the stream is killed, `signal lost` still readable.

To check the last one, stop the server while the page is open. The wall should grey out and the lamp should read `signal lost` at 390 as well as at 1920.

- [ ] **Step 5: Run the suite**

Run: `npm test`
Expected: PASS, 186 tests.

- [ ] **Step 6: Commit**

```bash
git add public/styles.css
git commit -m "fix: set the header's breakpoints from real renders

The three tiers were carrying numbers derived from measuring the old
controls on paper. These are taken from the bar itself, at both themes
and with the filters both at rest and set to their longest values.

Fitted to the filtered header rather than the resting one on purpose: a
breakpoint tuned to the narrow case collapses late for anyone actually
filtering, which is the moment the header is widest and the moment they
are least able to spare the row."
```

---

## Task 9: The docs catch up

CLAUDE.md says a behaviour change that contradicts the README means the README changes in the same commit. Six sections describe controls that no longer look or work the way they are described.

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything.
- Produces: nothing.

- [ ] **Step 1: Read what is there now**

```bash
grep -n -i "header\|group by\|select\|button next to\|mode\|history\|alerts" README.md
```

The passages that need work, by current line number:

- **~44–58, Filtering and grouping** — "Alongside them the header filters by **agent** and by **project**. Both selects…" and "**Group by** splits the wall…". The selects are chips now, and they show their value only when set.
- **~105–115, saving a view** — "Set the header the way you want it — filters, grouping, mode — then pick **＋ Save current as…** at the bottom of the picker." Still true; check the picker is described as a chip.
- **~145–160, Modes** — "**Mode** in the header is how the wall is drawn". It is a three-way toggle now, not a picker.
- **~165–170, History** — "**History** in the header opens the archive". It is an icon button now.
- **~186–196, theme** — "The button next to Alerts cycles **Auto → Light → Dark**." Still literally true; the button has no word on it now.
- **~200, signal lost** — "The wall greys out and the header says **signal lost**." Still true at every width, and worth saying that it is one of the two things that never abbreviates.

- [ ] **Step 2: Rewrite those passages**

Match the README's existing voice: it explains why a thing is the way it is, in prose, and it is part of the product. Do not add a table of breakpoints — the README does not document CSS.

Add one new short section after **Filtering and grouping**, in that voice. Draft:

```markdown
### On a small screen

The header is one row at every width, and it gives things up in a fixed order as
it narrows: first the clock and the wordmark, then the words beside the counts,
then the filters, then the view and the mode. What is left on a phone is what
you opened the page for — how many sessions are running, how many need you, and
whether the feed is still alive. Everything else is one tap away behind the
controls button, which opens a sheet from the bottom.

Two things never abbreviate. The counts keep their glyphs, because a column of
bare numbers tells you nothing. And a lamp that has gone to **signal lost** or
**no credential** keeps its words, because that is the one moment the lamp is
worth reading.
```

- [ ] **Step 3: Correct the CLAUDE.md bullet**

In `CLAUDE.md`, under **Constraints**, this bullet is now wrong:

```markdown
- Lists that must stay in step by hand: `MODES` and `GROUP_BY` in `src/views.js`
  ↔ `MODES` and `GROUPS` in `public/app.js`; `STATES` in `public/match.js` ↔ the
  header's own filters.
```

Two of the three pairings it names are checked by `test/header-markup.test.js` now. Replace it with:

```markdown
- Lists that must stay in step by hand: `MODES` and `GROUP_BY` in `src/views.js`
  ↔ `MODES` and `GROUPS` in `public/app.js`. The header's own two — `MODES`
  against the mode buttons, and `STATES` in `public/match.js` against the
  readouts' `data-filter` — are checked by `test/header-markup.test.js`, which
  also refuses an icon-only button with no `aria-label`.
```

Also add a line to the **Frontend** section, after the two existing invariants, since the shedding order is exactly the kind of thing a future instance would undo by accident:

```markdown
- **The header sheds by region, in order.** `.bar` is `nowrap`; the tiers in
  `styles.css` move whole regions into the sheet rather than hiding individual
  controls, and nothing moves in the DOM. Hiding one control inside a region
  reintroduces the band of widths that used to scroll sideways, because the
  region's minimum width is what the tier is actually reducing.
```

- [ ] **Step 4: Verify the docs against the thing**

Read the changed README passages with the dashboard open beside them at 1440 and at 390. Every sentence should be checkable against the screen. Fix any that is not.

- [ ] **Step 5: Run the suite**

Run: `npm test`
Expected: PASS, 186 tests.

- [ ] **Step 6: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: the header, as it now behaves

Six README passages described selects that are chips, a mode picker that
is a toggle, and buttons that had words on them. The README is part of
the product and is written in the product's voice, so a behaviour change
that contradicts it is not finished until it does not.

The CLAUDE.md note about lists kept in step by hand was two-thirds
wrong: the header's own two pairings are checked by
test/header-markup.test.js now. The shedding order is added as a
frontend invariant, because it is the kind of thing a later change would
undo by hiding one control inside a region and reintroducing the widths
that used to scroll sideways."
```

---

## Finishing

After Task 9, the branch is complete. Use `superpowers:finishing-a-development-branch` to decide how to integrate. The repo's habit is a `feat/<name>` branch merged with a summarizing merge commit — this one is `feat/header-redesign`.

Before that, confirm:

```bash
npm test                    # 186 tests, green
git log --oneline main..    # nine commits, each with a reasoning body
grep -rn "masthead-spacer\|class=\"zone\"\|pick-mode\|bell-label\|theme-label" public/
```

The last command must return nothing: those are the five names this change removed, and a stray reference to any of them is a control that stopped working.
