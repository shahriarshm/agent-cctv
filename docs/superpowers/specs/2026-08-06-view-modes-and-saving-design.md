# agent-cctv: view modes, and saving a view from the dashboard — design

**Date:** 2026-08-06
**Status:** approved (user directed "go YOLO and spec > plan > inline without stopping for questions")
**Scope:** Two display modes beyond the grid — focus and tail — and a GUI flow that writes the
current arrangement to a view file. Extends
[`2026-08-05-view-presets-design.md`](2026-08-05-view-presets-design.md).

## Problem

Views shipped as files, which was the right first cut: a view is text you can diff, commit and
hand to the person next to you. It left two things undone.

The first is that a view can only say *which* sessions and *how they are grouped*. It cannot say
how they are drawn. A wall of equal tiles is the right default and the wrong thing when you are
babysitting one long run, or when you want the whole room as a single running log.

The second is that creating a view means knowing the directory exists, knowing the format, and
leaving the dashboard. Everything a view captures — a filter, a project, a grouping — is already
sitting in the header as controls the user just finished setting. Making them retype it as YAML
is asking them to do the computer's job.

## What changes from the previous design

Two decisions are reversed. Both were right for the first release and are wrong now that the
feature has to be reachable by someone who has never read the README.

- **"Views are read and never written."** The dashboard now writes view files — but only into its
  own views directory, only with a `.yaml` extension, only under a slug it derives itself, and
  only when a person clicks Save. Nothing is ever written without an explicit click.
- **"With no view files, the picker is not rendered at all."** The picker is how you reach Save,
  so it is always present. With no views it holds `Everything` and `＋ Save current as…`.

The trust posture is stated again below, because a write endpoint is a real change to it.

## Goals

1. Three display modes — `wall`, `focus`, `tail` — selectable from the header and storable in a view.
2. Save the current arrangement as a named view without leaving the dashboard.
3. A saved view is an ordinary view file: hand-editable, diffable, indistinguishable from one
   typed by a person.
4. Saving never loses what a hand-written view already said.
5. Still zero runtime dependencies.

## Non-goals

- **Deleting or renaming views from the GUI.** `rm` is the delete key and `agent-cctv views` prints
  the path. A destructive endpoint buys very little and has to be got exactly right.
- **Editing a view's match rules in the GUI.** The header cannot express globs, lists or
  exclusions, and a form that could would be a second representation of the format. Save captures
  what the header knows; the file is where the rest lives.
- **More modes.** Three is the set. `wall` is the default, `focus` is one session, `tail` is all of
  them as one stream; a fourth would need a reason neither of those covers.
- **Auto-rotation between views.** Still deferred, still leaves room in the format.

## Display modes

A mode is how the wall is drawn. It is orthogonal to `match`, which is still what decides the
population, and to the header's state/agent/project narrowing, which still applies in every mode.

### `wall` — the grid

Exactly today's behaviour, and the default everywhere the key is absent. Grouping applies.

### `focus` — one big, the rest as thumbnails

The CCTV spot monitor. One session takes the main panel with its live timeline underneath; every
other session in the view sits in a rail beside it, still showing its tally and current tool, still
clickable to promote.

- **Which session is focused** is the first of: the one you clicked, the most urgent, then the most
  recently active — the wall's existing `rank()` order, which already puts blocked first.
- If the focused session leaves the wall, focus falls to the new top of that order rather than
  emptying the panel.
- The main panel is fed exactly like the inspector: one `GET /api/session/<id>` for the backfill,
  then streamed `activity` events prepended live.
- Grouping is meaningless here, so the group-by control is hidden rather than left inert.

### `tail` — the whole room as one stream

Every event from every session in the view, newest first, one line each: time, which session, and
the same description the timeline uses. `tail -f` for the wall.

- Newest first and no auto-scroll, matching the inspector — the thing you want is at the top and
  stays there, rather than a pane that jumps while you read it.
- Backfilled from the events the snapshot already carries, then appended from the `activity`
  stream. Capped at 500 rows, oldest dropped.
- No tiles, so no grouping and no empty-tile state; an empty tail says so in its own words.

Mode lives in the same per-browser preferences as the rest (`agent-cctv:view` in localStorage) and
is a top-level `mode:` key in a view file. Switching view seeds mode the same way it seeds
`groupBy`: on switching to the view, and never written back on its own.

## Saving from the dashboard

### The flow

The view picker gains a final option, after a separator:

```
Everything
Needs me
Frontend work
──────────────────
＋ Save current as…
```

Choosing it opens a small dialog: a name field, prefilled with a suggestion derived from what is
set; a plain-language line saying what will be captured; Save and Cancel. On save the file is
written, the watcher picks it up, and the picker switches to the new view. The picker reverts to
the previous selection if the dialog is cancelled — choosing `＋ Save current as…` must never be a
way to accidentally leave the view you were on.

### What gets captured, and how it composes

The saved `match` is **the current view's own match, with the header's narrowing laid over it**.
That composition is the point: a hand-written view with `project: [web-*, api]` and an
`exclude:` block, narrowed in the header to `project: api` and saved, produces a view that still
carries the exclusion and now says `project: api`. Nothing a person typed is silently dropped.

| Header control | Saved as |
| --- | --- |
| state readout `all` | *(state omitted)* |
| state readout `live` / `working` / `needs you` | `state: live` / `busy` / `attention` |
| agent select | `agent: <id>`, omitted when `all` |
| project select | `project: <name>`, omitted when `all` |
| group by | `groupBy:`, omitted when `none` |
| mode | `mode:`, omitted when `wall` |

`order` is not captured; a saved view takes the default 100 and is ordered by name among its peers.
Theme and alerts are not captured — they are per-browser preferences, not properties of a view.

The lossiness is worth stating plainly, because it is permanent: **a saved view can only contain
what the header can express.** Globs, lists and exclusions come from the base view or from editing
the file. Saving `Everything` narrowed to one project gives you exactly that one project, not a
pattern.

### The endpoint

`POST /api/views` with `{name, view}` → `201 {id}`, behind the same token gate as everything else.

- The id is a slug derived from the name: lowercased, non-alphanumerics collapsed to `-`, trimmed.
  A name that slugs to nothing is a `400`.
- The slug is matched against `^[a-z0-9][a-z0-9-]*$` and rejected otherwise. It is never
  concatenated onto a path until it has passed, and the resolved path is checked to be inside the
  views directory — belt and braces against a slug rule that turns out to be wrong.
- The extension is always `.yaml`. The endpoint cannot write any other kind of file.
- An existing id is a `409` unless the request says `replace: true`, which the dialog asks about
  before sending.
- The body is validated by the same `normalize()` the loader uses, so a view that would not load
  cannot be written.
- The file is written atomically and carries a comment saying where it came from and that it is
  fine to edit by hand.

### The trust posture, restated

The self-hosted design argued that read-only is what makes a single shared token proportionate, and
that "a single write endpoint inverts the threat model". That argument was about **control actions
on sessions** — killing a session, answering a permission prompt — and it still holds; none of
those are being added.

This endpoint writes a config file in agent-cctv's own directory. Someone holding the token can
already read every transcript on the box, which is the greater power by a wide margin; what they
gain here is the ability to leave a badly-named view in a list. It is vandalism, not escalation.
The mitigations are the ones above: a fixed directory, a fixed extension, a slug that must match a
narrow pattern, a resolved-path check, validation through the loader's own rules, and a size cap.

## Architecture

The split is unchanged: the server owns the filesystem, the browser owns the drawing.

**New on the server.** `stringifyYaml()` joins `parseYaml()` in `src/yaml.js`, emitting the same
subset it can read — round-tripping is a test, not an aspiration. `writeView()` in `src/views.js`
does slug, validate, guard, write. The route is a dozen lines in `src/server.js`; the existing
watcher already turns the write into a `views` broadcast, so no other client needs telling.

**New in the browser.** `public/timeline.js` is extracted from `app.js` — `createTimeline(el)`
returning `{render, prepend, clear}` — because focus mode needs a second instance of exactly what
the inspector does, and the alternative is two copies of the fold-and-render logic. This is a pure
refactor of existing behaviour and lands on its own, before anything depends on it.
`public/modes.js` owns the focus panel and the tail stream; `public/views.js` grows the save dialog.
`app.js` keeps the wall and delegates.

`app.js` is over 1300 lines. Every new surface here goes in its own module rather than into it.

## Failure modes

- **A write that fails** — read-only directory, full disk, a views dir that is a file — returns the
  reason and the dialog shows it. The wall is untouched; nothing about a failed save changes what
  is on screen.
- **A save that names an existing view** is a `409` with the id, and the dialog offers to replace.
- **A slug collision after normalisation** ("Needs me" and "needs-me" both slug to `needs-me`) is
  the same `409` on the same path. There is no second collision rule to get wrong.
- **The focused session disappears** mid-run: focus moves to the top of the rank order, and the
  panel says so rather than showing a stale timeline.
- **Focus with an empty view** shows the view-aware empty state in the main panel and an empty rail.
- **Tail before any events** says the room is quiet rather than showing an empty box.

## Testing

- **`stringifyYaml`:** round-trips every construct the parser accepts; quotes what must be quoted
  (leading `*`, a `#`, a `:`, an all-digits string, `true`); refuses what it cannot represent.
- **`writeView`:** slug derivation, the `^[a-z0-9][a-z0-9-]*$` gate, traversal attempts
  (`../../etc/x`, `a/b`, `.`, empty), the overwrite rule with and without `replace`, and that what
  it writes loads back through `loadViews` as the same view.
- **The route:** token required; `201` writes a file; `409` on an existing id; `400` on a name that
  slugs to nothing and on a body that fails validation.
- **`mode` in the format:** accepted values, rejection with a line number, absence defaulting to
  `wall`.
- **`timeline.js`:** the extraction keeps the existing fold-and-render behaviour, tested against the
  same event fixtures the inspector uses today.
- **The browser halves** — focus, tail, the dialog — get the scripted manual pass the picker got,
  since there is still no DOM harness and adding one for this is disproportionate.
