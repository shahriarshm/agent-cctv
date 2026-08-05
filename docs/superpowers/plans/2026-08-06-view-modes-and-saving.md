# View Modes and Saving Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `focus` and `tail` display modes to the wall, and let someone save the current arrangement as a named view file without leaving the dashboard.

**Architecture:** Unchanged split — the server owns the filesystem, the browser owns the drawing. `stringifyYaml()` joins the parser so a written view round-trips through the same subset; `writeView()` does slug → validate → guard → atomic write behind `POST /api/views`; the existing watcher turns that write into a `views` broadcast with no extra wiring. In the browser, the timeline rendering is extracted so focus mode can have a second instance of it, and the new surfaces land in their own modules rather than in `app.js`.

**Tech Stack:** Node ≥18, ESM, zero runtime dependencies, `node --test`, no build step.

**Spec:** `docs/superpowers/specs/2026-08-06-view-modes-and-saving-design.md`

## Global Constraints

- **Zero runtime dependencies.** Unchanged.
- **The write endpoint may only ever write `<slug>.yaml` inside the views directory.** Slug matches `^[a-z0-9][a-z0-9-]*$`, the resolved path is re-checked to be inside the directory, and the body is validated by the loader's own `normalize()`.
- Nothing is written without an explicit click. No seeding, no autosave, no write on view switch.
- `test/spa-guard.test.js` scans every `public/*.js`: `textContent` only, no `innerHTML` from data, no `insertAdjacentHTML`, no NUL bytes.
- `public/app.js` is over 1300 lines. Every new surface goes in its own module.
- Run `npm test` before every commit.

**A note on this plan's form:** it is being executed inline, immediately, by its author. Steps give exact files, interfaces and test cases, and full code for the parts where getting it exactly right matters — the serializer, the write guard, the focus/tail layout. Mechanical edits are specified rather than pasted. A stranger picking this up later should read the spec first.

## File Structure

**Create:**
- `public/format.js` — the pure formatters lifted out of `app.js` (`plain`, `since`, `clockTime`, `tokens`, `took`, `shortPath`, `el`). Testable for the first time.
- `public/timeline.js` — `createTimeline(el)` → `{render, prepend, clear}`. The fold-and-render logic, one copy.
- `public/modes.js` — the focus panel and the tail stream.
- `test/modes.test.js` — serializer, writer, route, formatters.

**Modify:**
- `src/yaml.js` — `stringifyYaml`.
- `src/views.js` — `mode` in the format; `writeView`.
- `src/server.js` — `POST /api/views`.
- `public/views.js` — the save dialog and the picker's `＋ Save current as…` option.
- `public/app.js` — mode plumbing, delegation, imports from the new modules.
- `public/index.html`, `public/styles.css` — mode control, focus/tail containers, the dialog.
- `bin/cctv.js` — `views` prints a view's mode.
- `README.md` — modes, saving, and the corrected "writes nothing" claim.

---

### Task 1: `stringifyYaml`

**Files:** Modify `src/yaml.js`; create `test/modes.test.js`.

**Interfaces:**
- Produces: `stringifyYaml(value) -> string`. Emits only the subset `parseYaml` accepts. Throws `TypeError` on anything it cannot represent (functions, nested arrays, maps three deep).

- [ ] **Step 1: Write the failing tests** in `test/modes.test.js`

Round-trip is the core property — for each of these, `parseYaml(stringifyYaml(x)).value` must deep-equal `x`:

```js
{ name: 'Frontend work', order: 20, mode: 'focus', groupBy: 'branch',
  match: { project: ['web-*', 'design-system'], branch: 'feat/*', exclude: { cwd: '*/scratch/*' } } }
{ name: 'x' }
{ match: {} }
{ a: true, b: false, c: 0, d: -3 }
```

Plus explicit quoting cases — each of these values must survive:
`*glob`, `a # b`, `key: value`, `123`, `true`, `""`, `  padded  `, `feat/*`.

And rejection: `stringifyYaml({a: [[1]]})` and `stringifyYaml({a: () => {}})` throw `TypeError`.

- [ ] **Step 2: Run to verify they fail.** `node --test test/modes.test.js`

- [ ] **Step 3: Implement**, appended to `src/yaml.js`:

```js
/**
 * The same subset, written back out.
 *
 * Round-tripping is a test rather than an aspiration: everything this emits,
 * parseYaml() reads, and the pair is checked against each other. Quoting is
 * deliberately eager — a string is quoted unless it is plainly safe bare —
 * because the failure it prevents (a glob written as `cwd: */x`, read back as
 * a YAML alias) is silent.
 */
export function stringifyYaml(value, indent = 0) { … }

/** Bare only when it cannot be mistaken for anything else. */
function needsQuote(s) {
  return (
    s === '' ||
    s !== s.trim() ||
    /^[*&!|>%@`#-]/.test(s) ||
    /[:#]/.test(s) ||
    /^(true|false|null|~)$/.test(s) ||
    /^-?\d+$/.test(s)
  );
}
```

Scalars: `true`/`false` bare, integers bare, strings bare or double-quoted (escaping `\` and `"`). Arrays emit inline `[a, b]` when every item is a scalar. Objects emit `key: value` or `key:` plus an indented block. A nested array or a non-plain value throws `TypeError`.

- [ ] **Step 4: Run to verify they pass.** Then `npm test`.
- [ ] **Step 5: Commit.** `feat: write the YAML subset as well as read it`

---

### Task 2: `mode` in the view format

**Files:** Modify `src/views.js`; test in `test/views.test.js`.

**Interfaces:** `View` gains `mode: 'wall'|'focus'|'tail'`, defaulting to `'wall'`.

- [ ] **Step 1: Tests** — `mode: focus` loads; `mode: sideways` is refused naming the line and listing the three; an absent `mode` yields `'wall'`; `mode` appears in `TOP_KEYS` so it is no longer an unknown key.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement** — add `'mode'` to `TOP_KEYS`, a `const MODES = ['wall', 'focus', 'tail']`, and the same shape of check `groupBy` already uses. Return `mode` from `normalize()`.
- [ ] **Step 4: Run, then `npm test`.**
- [ ] **Step 5: Commit.** `feat: a view can say how the wall is drawn`

---

### Task 3: `writeView` and `POST /api/views`

**Files:** Modify `src/views.js`, `src/server.js`; test in `test/modes.test.js`.

**Interfaces:**
- `slugify(name) -> string` — lowercase, non-alphanumerics to `-`, collapsed, trimmed of `-`.
- `writeView({name, view, replace}, dir?) -> {id, file}` — throws `ViewWriteError` with a `.status` (400/409/500).
- `POST /api/views` → `201 {id}`.

- [ ] **Step 1: Tests**

`slugify`: `'Needs me'` → `needs-me`; `'Frontend  Work!!'` → `frontend-work`; `'  '` → `''`; `'2 fast'` → `2-fast`; `'---'` → `''`.

`writeView` rejects with 400: a name slugging to empty; `../../etc/passwd`; `a/b`; `.`; `..`. **Assert no file is created outside the directory** — snapshot the parent directory's listing before and after.

`writeView` rejects with 409 on an existing id, and succeeds when `replace: true`.

`writeView` rejects with 400 a `view` that fails `normalize()` (e.g. `match: {repo: 'x'}`).

Round-trip: write a view, then `loadViews(dir)` returns it with the same `name`, `mode`, `groupBy` and `match`.

Route: 401 without a token; 201 with; 409 on a repeat; 400 on a bad name; the written file appears in a subsequent `GET /api/views`.

- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement** in `src/views.js`:

```js
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function writeView({ name, view = {}, replace = false }, dir = VIEWS_DIR) {
  const id = slugify(name);
  // The slug rule is the guard. The resolved-path check below is the second
  // one, on the assumption that this rule will eventually be edited by someone
  // who has not thought about `..` for as long as this comment took to write.
  if (!SLUG.test(id)) throw new ViewWriteError('a view needs a name with letters or digits in it', 400);

  const file = path.join(dir, `${id}.yaml`);
  if (path.dirname(path.resolve(file)) !== path.resolve(dir)) {
    throw new ViewWriteError('refusing to write outside the views directory', 400);
  }
  if (!replace && fs.existsSync(file)) throw new ViewWriteError(`a view called "${id}" already exists`, 409);

  // Validated by the loader's own rules, so a view that could not be read back
  // can never be written in the first place.
  let normalized;
  try {
    normalized = normalize({ ...view, name: String(name).trim() }, id, new Map());
  } catch (err) {
    throw new ViewWriteError(err.message, 400);
  }

  const body =
    `# Written by the agent-cctv dashboard. Edit it by hand — this is an\n` +
    `# ordinary view file, and the format is in the README.\n` +
    stringifyYaml(strip(normalized));

  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
  return { id, file };
}
```

`strip(v)` drops `id`, drops `order` when 100, `groupBy` when null, `mode` when `'wall'`, and `match` when empty — so a saved file says only what it means.

Route in `src/server.js`, before the generic `/api/` gate's read-only routes:

```js
if (route === '/api/views' && req.method === 'POST') {
  if (!authed(req, url)) return json(res, 401, { error: 'token required' });
  let body;
  try { body = safeJson(await readBody(req, 64 * 1024)); }
  catch { return json(res, 413, { error: 'too large' }); }
  if (!body) return json(res, 400, { error: 'bad json' });
  try {
    const { id } = writeView(body, viewsDir);
    views = loadViews(viewsDir);   // don't wait for the watcher to catch up
    broadcast('views', views);
    return json(res, 201, { id });
  } catch (err) {
    return json(res, err.status || 500, { error: err.message });
  }
}
```

- [ ] **Step 4: Run, then `npm test`.**
- [ ] **Step 5: Commit.** `feat: write a view file from the dashboard`

---

### Task 4: Extract the formatters and the timeline

A pure refactor. No behaviour changes, and it lands on its own so that the diff for focus mode is only focus mode.

**Files:** Create `public/format.js`, `public/timeline.js`; modify `public/app.js`; test in `test/modes.test.js`.

**Interfaces:**
- `format.js`: `el(tag, className, text)`, `plain(s)`, `since(ts)`, `clockTime(ts)`, `tokens(n)`, `took(ms)`, `shortPath(p)`.
- `timeline.js`: `createTimeline(node)` → `{render(events), prepend(ev), clear()}`, plus `foldTools(events)` exported for tests.

- [ ] **Step 1: Tests** — the formatters have never been covered. `plain` strips fences, inline code, headings, bold, list markers and links; `since` gives `45s`, `3m`, `2h 5m` and drops seconds past a minute; `tokens` gives `999`, `1k`, `1.2M`; `took` and `shortPath` on `/Users/x/y` and `/home/x/y`. `foldTools` pairs a start with its end and leaves an unpaired start alone.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Move** the functions verbatim out of `app.js` into the two new modules, and import them back. `renderTimeline`/`prependEntry`/`buildEntry`/`paintEntry`/`foldTools`/`mergeToolPair`/`openCall` become the closure inside `createTimeline`, which takes the node instead of closing over `timelineEl`. The inspector becomes `const inspectorTimeline = createTimeline(timelineEl)`, and its two call sites become `.render(...)` and `.prepend(...)`.
- [ ] **Step 4: Run, `npm test`, and verify in a browser** that the inspector still renders a session's timeline and still folds a tool call into one row — this refactor's whole risk is a silent rendering change.
- [ ] **Step 5: Commit.** `refactor: lift the formatters and the timeline out of app.js`

---

### Task 5: Mode plumbing

**Files:** Modify `public/index.html`, `public/styles.css`, `public/app.js`, `public/views.js`.

- [ ] **Step 1: Markup** — a `mode` select beside `group by`, with `wall` / `focus` / `tail`. Containers for the two new modes: `<section class="focus" id="focus" hidden>` (a main panel and a rail) and `<section class="tail" id="tail" hidden>`.
- [ ] **Step 2: State** — `filters.mode` defaults to `'wall'`, persists with the rest, and is seeded from a view exactly like `groupBy` (on switch only). `applyView` carries it.
- [ ] **Step 3: Switching** — `setMode(mode)` sets `document.body.dataset.viewMode`, shows the right container, hides the others, and hides the group-by control outside `wall`. `masthead.dataset.mode` is untouched: it already means archive-vs-wall.
- [ ] **Step 4: Verify** in a browser that switching modes shows an empty focus/tail container and that `wall` is unchanged. Commit. `feat: a mode control, with wall unchanged`

---

### Task 6: Focus mode

**Files:** Create/extend `public/modes.js`; modify `public/app.js`, `public/styles.css`.

**Interfaces:** `createFocus({main, rail, api, onOpen})` → `{show(sessions), paint(session), activity(ev), hide()}`.

- [ ] **Step 1: Implement.** The focused id is `focus.id` if that session is still on the wall, else the first of the wall's existing `rank()` then `lastActivityAt` order. Promoting is a click on a rail tile. The main panel reuses the session's own tile node — moved, not rebuilt, so its activity strip keeps its history — with a `createTimeline` instance beneath it, backfilled once from `GET /api/session/<id>` and then fed by streamed `activity` events for that session.
- [ ] **Step 2: Empty states** — an empty view shows the same view-aware copy the wall shows; a focused session that vanishes moves focus and says so.
- [ ] **Step 3: Verify** in a browser: the biggest session shows its timeline live, clicking a rail tile promotes it, the blocked session is focused first, and removing the focused session moves focus rather than blanking the panel.
- [ ] **Step 4: Commit.** `feat: focus mode — one session big, the rest as thumbnails`

---

### Task 7: Tail mode

**Files:** Extend `public/modes.js`; modify `public/app.js`, `public/styles.css`.

**Interfaces:** `createTail(node)` → `{show(sessions), activity(ev, session), clear()}`.

- [ ] **Step 1: Implement.** One row per event: time, session name, description — the same `buildEntry` the timeline uses, with the session's name prepended. Newest first, prepended live, capped at 500 rows with the oldest dropped. Backfilled from the events already on each session in the snapshot, sorted by timestamp. Events from sessions outside the view are dropped, matching the alert rule.
- [ ] **Step 2: Empty state** — "quiet" copy when no events have arrived.
- [ ] **Step 3: Verify** in a browser that a running session's events appear at the top within a second, and that switching to a narrow view drops the other sessions' rows.
- [ ] **Step 4: Commit.** `feat: tail mode — the whole room as one stream`

---

### Task 8: The save dialog

**Files:** Modify `public/views.js`, `public/index.html`, `public/styles.css`.

- [ ] **Step 1: The picker option** — a `＋ Save current as…` option after a separator. Choosing it opens the dialog and **restores the previous selection immediately**, so cancelling cannot strand you on a view you did not pick.
- [ ] **Step 2: The dialog** — a name field prefilled from what is set (e.g. "Web-app working"), a line saying what will be captured, Save and Cancel. Escape and the scrim close it. Focus moves into the field on open and back to the picker on close.
- [ ] **Step 3: Composition** — the body's `match` is the current view's match with the header's narrowing laid over it, per the spec's table. `groupBy` and `mode` are included unless they are the defaults.
- [ ] **Step 4: The round trip** — `POST /api/views`; on 409 the dialog offers Replace and re-sends with `replace: true`; on any other error it shows the message and stays open. On 201 the broadcast arrives on its own and the picker switches to the new id.
- [ ] **Step 5: Verify** in a browser: save a view, see it appear in the picker and on disk with the expected YAML; save the same name again and get the replace prompt; cancel and confirm the selection did not move; save while a hand-written view with an `exclude` is selected and confirm the exclusion survived into the new file.
- [ ] **Step 6: Commit.** `feat: save the current arrangement as a named view`

---

### Task 9: Documentation

**Files:** Modify `README.md`, `bin/cctv.js`.

- [ ] **Step 1: `agent-cctv views`** prints a view's mode when it is not `wall`.
- [ ] **Step 2: README** — a Modes subsection; a Saving subsection; the `mode:` key in the format block; and the corrected claim. The README currently says views are "read and never written" and that "nothing is written outside `~/.agent-cctv`" — the second is still true, the first is not. Replace it with what is actually true: the dashboard writes a view file when you click Save, into its own directory, and never otherwise.
- [ ] **Step 3: Check every claim against the code**, the way the last README pass did — load the documented example verbatim through `agent-cctv views`.
- [ ] **Step 4: Commit.** `docs: view modes and saving`

---

## Self-Review

**Spec coverage.** Modes format → Task 2; focus → 6; tail → 7; mode control → 5. Save flow → 8; endpoint and guards → 3; serializer → 1. Composition rule → 8 step 3. Trust posture mitigations → 3 (slug gate, resolved-path check, loader validation, size cap, fixed extension). Failure modes → 3 (write failure, 409, slug collision) and 6/7 (vanishing focus, empty states). The refactor the spec calls for → 4.

**Ordering.** 1→3 and 4→6 are the only hard dependencies; 2 is independent; 5 must precede 6, 7 and 8. Each task ends green and committed.

**Known gaps, accepted.** The browser halves (5–8) have no automated coverage, for the same reason as before — no DOM harness, disproportionate to add — so each carries a scripted manual pass. Task 4 is the riskiest change in the plan despite being a refactor, because a silent rendering regression would not fail a test; its verification step targets exactly that.
