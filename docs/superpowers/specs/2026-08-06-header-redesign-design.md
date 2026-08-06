# agent-cctv: a header that fits — design

**Date:** 2026-08-06
**Status:** approved
**Scope:** The dashboard masthead only. One row at every width, icons carrying the labels, and a
bottom sheet for what does not fit on a phone. Nothing about the wall, the tiles, the inspector or
the modes themselves changes.

## Problem

The masthead holds fourteen controls in one wrapping flex row: a wordmark, four state readouts,
five labelled `<select>` pickers, three labelled buttons, a clock and a link lamp. Laid out flat
that needs roughly 1,760px, so on anything narrower it wraps — two rows on a laptop, and on a phone
the label-and-select pairs alone stack four or five deep and eat a third of the viewport before a
single tile is drawn.

The wrapping is deliberate. `styles.css` says so:

> tying the wrap to a fixed media query left a band of window sizes where the header was too wide to
> fit and too wide to wrap, and the whole page scrolled sideways. A second header row is a far
> better failure than that.

That reasoning was right, and it is the right fix for the wrong problem. The header wraps because it
is too wide, and it is too wide because it spends pixels on words that are not telling you anything.
Four of the five pickers sit on their default value nearly all the time; `AGENT: all` and
`PROJECT: all` together cost about 370px to say nothing.

This is a monitoring wall. Vertical space is the product. A header that takes 300px of a 667px phone
to show controls the user answered "glance only" about is the wrong trade.

## Goals

1. One row, no wrapping, at every width from 1920 down to 360.
2. On a phone the bar shows the glance and nothing else: the four counts, the connection lamp, and
   one button that opens everything else.
3. Icons carry the labels, and every icon keeps its word until there is no room for it.
4. No control becomes unreachable at any width.
5. No layout JavaScript. No resize observers, no measuring, no moving nodes between containers.
6. Still zero runtime dependencies; still `textContent` for anything that came off a transcript.

## Non-goals

- **Custom dropdowns.** Every picker stays a native `<select>`. A hand-rolled listbox is several
  hundred lines of keyboard and screen-reader handling to reimplement something the platform
  already does better, and it would break the iOS wheel picker on the device this redesign is for.
- **Touching the wall, tiles, inspector, focus or tail.** Their layout problems, if any, are their
  own.
- **The archive's `going back` select.** It lives on a different screen and keeps `.pick`.
  Converting it is cosmetic churn.
- **New filters or new controls.** This is the same fourteen controls, laid out honestly.
- **A hamburger holding the whole header.** Controls may go behind a tap; readouts may not. The
  four counts and the connection lamp are visible at every width, because a monitoring dashboard
  whose status is behind a tap is not a monitoring dashboard.

## The central idea: a chip costs width only when it is doing something

Each picker becomes a chip: an icon, and the current value *when the value is not the default*.

```
at rest — agent: all, project: all, group by: nothing

┌────────────────────────────────────────────────────────────────┐
│ ◉ │ 12 all  8 live  3 working  1 need you │ ▤ Everything ✦ ▤ ⊞ │
└────────────────────────────────────────────────────────────────┘
                                                          ^^^^^^
                                          dim, icon-only, ~34px each

narrowed to one project on Claude Code

┌────────────────────────────────────────────────────────────────┐
│ ◉ │ 12 all  8 live  3 working  1 need you │ ▤ Everything       │
│   │ ◈ claude-code │ ▤ agent-cctv │ ⊞                           │
└────────────────────────────────────────────────────────────────┘
      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^
      lit: border and ink step up, value shown
```

A chip on its default value is icon-only and takes `--ink-3`. Set it and it shows the value, takes
`--ink`, and its border steps to `--ink-3`. The width the bar spends on filtering is proportional to
how much filtering is on, which at rest — the overwhelmingly common case — is almost none. That is
what buys the single row: at rest the bar lands near 1,030px.

The view chip is the exception: it always shows its name, because which view you are watching is
never "nothing" and is the single most consequential thing in the header.

When the agent chip holds a real agent rather than `all`, its icon is **that agent's mark** from
`icons.js`.

That is the one place this change touches `innerHTML`, and `test/spa-guard.test.js` matches its
allowlist against the **exact right-hand side text**, not against a parsed expression. So it must be
written as two statements:

```js
const meta = sourceMeta(select.value);
iconEl.innerHTML = meta.icon;   // `meta.icon` is already allowlisted
```

Writing `iconEl.innerHTML = sourceMeta(select.value).icon` is a new string and fails the guard.
Splitting it is not a workaround — the guard's job is to keep that list short and readable, and
reusing an approved form rather than growing the list is the behaviour it is asking for.

### How a chip works

```html
<label class="chip-pick" data-set="false">
  <svg class="chip-icon" viewBox="0 0 24 24" aria-hidden="true">…</svg>
  <span class="chip-value"></span>
  <select id="pick-project" aria-label="Filter by project">…</select>
</label>
```

The `<select>` is laid over the chip at `position: absolute; inset: 0; opacity: 0`, so the real
control is still the native one. Click, keyboard, screen reader and the platform's own picker UI all
work untouched. `.chip-pick:focus-within` draws the focus ring on the chip. `.chip-value` is written
with `textContent` from `select.value` on every change; `data-set` flips to `"true"` when the value
is not the picker's default, and CSS does the rest.

This keeps `＋ Save current as…`, the `SAVE_AS` sentinel, `filters`, `saveFilters()` and
`applyFilters()` exactly as they are. `public/views.js` needs no logic change — only a repaint call
so the chip's value text follows the select.

**What this costs:** at rest, the words "agent" and "project" are no longer on screen. Their `title`
and `aria-label` carry them, and the moment either is set the value itself says which is which. This
is a deliberate trade of resting legibility for a header that fits.

## Shedding order

One row, `flex-wrap: nowrap`, and a fixed order of what goes as the window narrows. Highest sheds
first, so what remains is always the more important thing.

| # | What sheds | Where it goes | At |
| --- | --- | --- | --- |
| 1 | the clock | gone (the OS has one) | 1360 |
| 2 | the wordmark's text | gone; the mark glyph stays | 1360 |
| 3 | the count words | clipped to screen readers; glyph + number remain | 1200 |
| 4 | the healthy lamp's word | a `title`; the dot stays | 1200 |
| 5 | the picker and action regions | the sheet; the trigger appears | 980 |

These are fitted numbers, measured rather than derived — see *Fitting*, below. Two things about
them differ from the first draft of this table, and both are improvements the measuring found.

The widths are larger than estimated: the bar needs 1270px with nothing filtered, so the clock and
wordmark have to go at 1360 rather than 1100.

More interestingly, **the words now shed before the controls do.** The draft sent the pickers to the
sheet at 820 and only clipped the count words at 640. Fitted, it is the other way round: the count
words go at 1200 and the sheet does not appear until 980. That ordering is better on its own terms —
clipping a word costs a label that colour and a glyph are already carrying, while the sheet costs a
tap — and it is only visible once the real widths are on the table.

Things shed by **region**, never by individual control, because a region is what CSS can reposition
wholesale. That is what splits the pickers into two: `.bar-filters` holds the three that sit on
their default nearly always, and `.bar-controls` holds the two you actually reach for — which view
you are watching, and how it is drawn. They still shed together, but the split is what lets the bar
put the filters last in the sheet and the view chip first, where a thumb reaches.

**One sheet breakpoint, not two.** An earlier draft of this table had the filters going at 860 and
the view, mode and actions at 640 — two separate moves into the sheet. That cannot be built the way
the rest of this design requires. A region shed at the wider breakpoint has to be pinned to the
viewport while its neighbours stay in the bar, and once a second region joins it the two have to
stack against each other with no known heights. Every arrangement that solves the stacking puts the
regions inside a shared positioned parent — and `display: contents` cannot lift a child back out of
a positioned ancestor, so the ones still meant to be in the bar can no longer get there.

Stacking them by hand would mean a magic offset for the sheet's own chrome height, which is the
kind of number that is correct until someone changes a font size. One breakpoint, one wrapper, one
fixed panel.

The cost, at the fitted widths, is the band from 640 to 980: the bar there holds four counts, a lamp
and a button in a window with room for more, because the moment anything leaves the bar everything
does. A tablet in portrait lands in it; the same tablet in landscape does not. The alternative is a
header held together by a measured constant.

Below the last breakpoint the bar is exactly the glance that was asked for — and the sheet
breakpoint is one number, defined once as a `--sheet-tier` custom property that the open/close
script reads back, so CSS and JavaScript cannot disagree about where the sheet begins:

```
390px
┌──────────────────────────────┐
│ ⊞12  ◉8  ▶3  ▲1     ● │ ⚌   │  ~40px tall, was ~300
├──────────────────────────────┤
│ ┌──────────────────────────┐ │
│ │ agent-cctv      ▲ blocked│ │
│ └──────────────────────────┘ │
```

The breakpoints above are estimates from measuring the current controls. They are to be **set
against real screenshots** at 1920, 1440, 1280, 900, 700 and 390 during implementation, not trusted
from arithmetic. The shedding *order* is the design decision; the exact pixel is a fitting exercise.

### Why this does not reintroduce the sideways-scroll bug

The band of widths that scrolled sideways existed because the row had a hard minimum — labels that
refused to wrap — and no way to get under it. Every step in the table above is a real reduction in
that minimum, and the last step reduces it to four numbers, a lamp and a button. There is no width
at which the bar is both too wide to fit and unable to shed.

Two belts on top of that brace: every bar region gets `min-width: 0` so it can actually shrink — a
flex item defaults to `min-width: auto` and refuses to go below its content, which is half of why
the row wraps today — and `.chip-value` gets a `max-width` with `text-overflow: ellipsis`, so one
session in a directory with a very long name cannot set the width of the header.

### Why no layout JavaScript

The controls **do not move in the DOM**. `.bar-filters`, `.bar-controls` and `.bar-actions` sit
inside one wrapper, `.bar-shelf`, which is `display: contents` above the sheet breakpoint — it has
no box of its own there, so the three regions lay out as direct flex children of the bar exactly as
if it were not present. Below the breakpoint the wrapper becomes the sheet: `position: fixed`,
pinned to the bottom, a flex column, shown when `body[data-sheet='open']`. Above the breakpoint the
sheet trigger is `display: none`.

The alternative — measuring the bar and moving the lowest-priority control into an overflow menu
until it fits — genuinely handles awkward intermediate widths that fixed tiers do not. It was
rejected because it puts a reflow loop in `app.js`, is the classic source of resize jitter, and
cannot be tested under `node --test` in a repo whose stated habit is keeping the logic worth testing
DOM-free.

## The controls, one by one

### State readouts — unchanged in behaviour, glyphed when narrow

Still four buttons, still `role="group" aria-label="Filter by state"`, still both the count and the
filter. Each gains a small glyph before its number: `all` a grid, `live` a filled dot, `working` a
part-drawn arc, `need you` a bell. Colour already distinguishes `working` (`--rolling-ink`) and a
hot `need you` (`--tally-ink`), but colour alone is not an accessible distinction, which is what the
glyphs are for.

When the words shed they are **clipped, not removed** — the same `clip-path: inset(50%)` treatment
`.sr-only` already uses — so the accessible name stays "3 working" and not "3".

### Mode — a segmented toggle

```
┌─────────────┐   wall  = a 2×2 grid of squares
│ ▦ │ ◧ │ ☰ │   focus = one large pane with a side rail
└─────────────┘   tail  = stacked horizontal lines
  ▔▔▔
```

`#pick-mode` becomes three buttons in a `role="group" aria-label="Display mode"`, each with
`aria-pressed`. The active one takes the lit background and inset underline that
`.readout[aria-pressed='true']` already uses, so the mode toggle and the state filter read as one
family rather than two inventions.

Three options, all of them inherently visual, is exactly the case a segmented control is for — and
it is narrower than a labelled select.

`setMode()`, the `MODES` list and everything in `modes.js` are untouched; only the element that
calls `setMode` changes. `groupLabel.hidden = mode !== 'wall'` becomes the group chip hiding, with
the same rule and the same reason.

### History, Alerts, Theme — icon buttons

`History` becomes a clock-with-arrow, `Alerts` a bell, `Theme` keeps its existing three-way
`auto` / `light` / `dark` glyph from `THEME_ICON` in `app.js`.

The bell's armed indicator survives as a change to the glyph itself — outline when off, filled with
the existing `--glow` when on — rather than as the separate `::before` dot, which was there because
the button had a word next to it and now does not. `blocked` and `unsupported` keep their dashed
border, their `aria-disabled` and their explaining `title`; that logic in `paintBell()` is
unchanged apart from writing a glyph state instead of a label.

### The lamp — unchanged

`connecting` / `live` / `signal lost` / `no credential` stay exactly as they are, including the
`data-stale` treatment that greys the wall. It is the one thing in the header that must never be
abbreviated away, because a monitoring instrument that keeps showing a confident picture after its
feed died is worse than one showing nothing.

At the narrowest tier the **healthy** lamp drops to its dot alone, with the word in a `title`. The
unhealthy ones — `signal lost` and `no credential` — keep their text at every width. Shedding a word
is only ever acceptable when the word was not telling you anything, and those two are the entire
reason the lamp exists.

## The sheet

Follows the `save-dialog` pattern already in `index.html`: a plain element plus a scrim, not a
`<dialog>`, for consistency with what is there.

- `role="dialog" aria-modal="true"`, labelled by its own heading.
- Opens from a sliders button in the bar; that button carries `aria-expanded`.
- Escape closes. The scrim closes. Focus moves to the first control on open and returns to the
  sliders button on close.
- Inside, chips relax into full-width labelled rows with 44px touch targets. The labels come back
  here — the reason they were dropped was width, and in the sheet there is width.
- The view-parse warning badge (`#view-warn`) rides with the view chip into the sheet, since it sits
  inside the same region.

## Architecture

Small, and almost all of it in two files.

**`public/index.html`** — the masthead is rewritten. Five undifferentiated `.zone` divs become six
named regions — `.bar-id`, `.bar-states`, `.bar-filters`, `.bar-controls`, `.bar-actions`,
`.bar-status` — plus the sheet trigger and the sheet. Every chrome icon is an **inline `<svg>`**
here rather than a string in a module. Static markup belongs in static markup, and it keeps all of
them except the agent mark out of `innerHTML`, so `test/spa-guard.test.js` needs no new allowlist
entry.

**`public/styles.css`** — the masthead block is rewritten. Icons are stroke-drawn on a 24 viewBox at
1.6 stroke in `currentColor`, matching the existing `.theme svg` rules so they tint with the theme
in both palettes. `.pick` survives for the archive.

**`public/app.js`** — the wiring changes shape, not substance. `paintBell()` writes a glyph state;
a new `paintChip(select)` writes `.chip-value` and `data-set`; the mode select's `change` listener
becomes a click listener on the segmented group; a dozen lines open and close the sheet, reusing the
inspector's focus-return pattern. No new module: this is header wiring, and header wiring already
lives here.

**`public/views.js`** — one call to repaint the view chip after `select.value` is set. No logic
change.

**`public/icons.js`, `match.js`, `modes.js`, `timeline.js`, `format.js`, `notify.js`, and everything
under `src/`** — untouched. This change does not reach the server.

## Failure modes

- **A value too long for its chip** — a project in a deeply nested directory — ellipsises at a
  `max-width`. It never sets the header's width, and the full value stays in the `title` and in the
  open select.
- **A window between two breakpoints** where the bar is tight: `min-width: 0` on the regions lets
  the chips compress and their values ellipsise before anything overflows. The bar never scrolls
  sideways and never wraps.
- **The sheet open when the window is widened** past its breakpoint — rotating a phone, or dragging
  a desktop window: the sheet's contents are the same elements the bar uses, so they simply lay back
  out in the bar. `body[data-sheet]` is cleared on the matching `matchMedia` change so the scrim
  cannot be left behind over a header that is working fine.
- **Notifications unsupported or blocked**: unchanged — dashed border, `aria-disabled`, and the
  `title` that says why, still focusable so a keyboard user can reach the explanation.
- **`prefers-reduced-motion`**: the sheet's slide is a transition, so the existing blanket rule at
  the bottom of `styles.css` already neutralises it. No new exception needed.
- **A view whose file will not parse**: the ember warning badge behaves as it does today, and
  reaches the sheet with the view chip rather than disappearing at narrow widths.

## Testing

`npm test` — 183 tests — must stay green, and `test/spa-guard.test.js` must pass **without changes
to `STATIC_ICON_SOURCES`**. That is the check that the inline-SVG decision was actually honoured.

Three new tests, all DOM-free, reading `public/index.html` as text:

1. **Every icon-only control is named.** Any `<button>` in `index.html` whose visible content is only
   an `<svg>` must carry a non-empty `aria-label`. This is the accessibility failure this redesign
   is most able to introduce, so it gets a guard rather than a promise.
2. **`MODES` in `public/app.js` matches the mode buttons in `index.html`**, in order.
3. **Every state readout's `data-filter` is either `all` or a key of `STATES` in `public/match.js`.**
   Not equality — `STATES` also holds `busy`, `waiting`, `idle` and `ended` for view files, and the
   header deliberately surfaces four of them.

CLAUDE.md currently lists both of those pairings under *"Lists that must stay in step by hand"*.
This change is what makes them machine-checked, so that line is corrected in the same commit.

Manual, since there is still no DOM harness and adding one for a header is disproportionate:
screenshots at 1920, 1440, 1280, 900, 700 and 390, in both themes, with the filters both at rest and
set; a keyboard pass from the wordmark to the lamp and through the sheet; and one pass with the
stream deliberately killed, to confirm `signal lost` still reads at the narrowest tier.

## Documentation

The README describes these controls in prose, and a behaviour change that contradicts it means the
README changes in the same commit. Affected: **Filtering and grouping** (the four counts, the two
selects), **Modes** (now a toggle, not a picker), **History**, **Alerts**, and the theme paragraph's
"The button next to Alerts". Each needs the new shape, and the small-screen behaviour needs saying
somewhere it did not need saying before.
