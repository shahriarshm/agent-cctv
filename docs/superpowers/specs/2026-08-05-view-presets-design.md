# agent-cctv: view presets — design

**Date:** 2026-08-05
**Status:** approved, ready for implementation planning
**Scope:** File-defined views over the wall: a presets directory, a match language, a picker,
and alert scoping. One release, no follow-on staged.

## Problem

The wall filters by three dropdowns — state, agent, project — and remembers whichever
combination you left it on. That is enough for one person watching one machine, and it is
the wrong shape for the two cases the tool has grown into.

The first is a person with more sessions than fit a glance, who wants named ways of looking
at them: *what needs me*, *the frontend repos*, *everything on this branch*. Today they set
three dropdowns by hand every time, and the settings are global, so having two ways of
looking means having neither.

The second is the shared server. A team on one box has one wall showing everybody's
sessions, and no way to say "this screen is the platform team's". The header's selects
can't express it either: `project` is one exact value, and there is no way to say
*these four repos*, *this branch pattern*, or *everything except scratch checkouts*.

A view fixes both by being a file: a named, shareable, diffable definition of a population
of sessions, plus how to arrange them.

## Goals

1. Multiple named views, defined as files, switchable from the header.
2. A match language that says things the three selects cannot: sets, globs, exclusions.
3. Views are read, never written — the same posture the tool has toward every other file.
4. Zero new runtime dependencies. Still MIT, still Node ≥18.
5. **A machine with no view files behaves exactly as it does today**, including no new
   header chrome.

## Non-goals, and why

- **A view editor in the UI.** Views are text. An editing surface is a second
  representation of the format that has to stay in sync with it forever, and it buys
  nothing a `$EDITOR` and a hot reload don't.
- **Writing view files at all**, including a "save current view as…" button and seeding
  examples on first run. `agent-cctv` writes nothing outside `~/.agent-cctv`, and inside it
  only its own config; keeping views strictly read-only means a view file is always exactly
  what a human put there. Discoverability is handled from the terminal instead.
- **Per-view layout, density, or auto-rotation between views.** A wallboard "channel" is a
  real idea and this design deliberately leaves room for it (`match` is the only key that
  defines population; everything else is presentation), but nothing here needs it yet.
- **Regex matching.** Globs cover `web-*` and `feat/*`, which is what people will type. A
  regex engine in a config file is a larger surface, and a worse error message.
- **Server-side view evaluation.** Rejected on architecture grounds — see below.
- **Scoping History by view.** See "Reach".

## The file format

A view is one file in the presets directory. Its **id is its filename without the
extension**; `frontend.yaml` is the view `frontend`.

```yaml
# ~/.agent-cctv/views/frontend.yaml
name: Frontend work        # label in the picker; defaults to the filename
order: 20                  # optional picker order; default 100, ties break by name
groupBy: branch            # seeds the group-by select; still changeable by hand

match:                     # the population — everything this view puts on the wall
  project: [web-*, design-system]
  branch: "feat/*"
  agent: claude-code
  exclude:
    cwd: "*/scratch/*"
```

Top-level keys are `name`, `order`, `groupBy`, `match`, and nothing else. `match` defines
*which sessions exist* for this view; every other key is presentation. Unknown keys at any
level are a load error, not a silent ignore — a typo'd `groupby` that quietly does nothing
is a worse experience than a refusal that names the line.

### Match semantics

- **Fields:** `agent`, `project`, `cwd`, `branch`, `model`, `name`, `state`. `name` here is
  the *session's* displayed label; the top-level `name` is the view's own. They are
  different scopes and never interact.
- A field takes a single string or a list of strings. **A list is OR; separate fields AND.**
- Values are **globs** — `*` for any run of characters, `?` for one — matched
  case-insensitively against the **whole** string. So `project: web-*` matches `web-app`,
  and matching a path segment needs its own stars: `cwd: "*/web/*"`.
- **`state` is enumerated, not globbed.** Accepted: `busy`, `waiting`, `idle`, `ended`, plus
  `live` (anything not ended) and `attention` (urgent, or waiting). Anything else is a load
  error with a line number, rather than a pattern that silently matches nothing.
- **A session that lacks the field never matches it.** `branch: "feat/*"` excludes a session
  with no branch at all, rather than treating absence as a wildcard.
- **`exclude` takes the same field map and wins.** A session matching any exclude rule is
  out of the view regardless of what the include rules said.

### YAML, and what it costs

`.json`, `.yaml` and `.yml` all load. JSON is free — `JSON.parse` is already there. YAML is
not, and the tool has no dependencies and is keeping it that way, so YAML means a parser we
own.

It is therefore a **strict subset**, and its strictness is the design:

- Supported: `#` comments, `key: scalar`, quoted strings, inline lists `[a, b]`, block
  lists, nested maps, booleans and integers.
- Rejected — with the file, the line, and what it found: anchors and aliases, `|` and `>`
  block scalars, multi-document `---`, tabs for indentation, and anything else it does not
  positively recognise.

A parser that guesses at YAML it half-understands would eventually read
`branch: "feat/*" # temporary` as a branch pattern containing a comment, put the wrong
sessions on the wall, and look completely confident doing it. Refusing to parse what it
does not fully understand is the same argument the tool already makes for not printing a
dollar figure it would have to guess at.

## Where views live

`$AGENT_CCTV_HOME/views/`, which is `~/.agent-cctv/views/` for a normal run and
`/var/lib/agent-cctv/views/` under the shipped systemd unit — where one directory of views
is shared by everyone on the box, which is the right default for that deployment.
`AGENT_CCTV_VIEWS_DIR` overrides it.

Only files directly in that directory are read; there is no recursion. A directory that
does not exist is not an error and is not created.

**Nothing is ever written there.** Discoverability is a terminal affair instead:

- `agent-cctv views` — lists the views that loaded, the directory it looked in, and every
  parse error in full. With an empty or missing directory it prints a starter preset to
  paste, and the path to paste it into.
- `agent-cctv doctor` — one more line: the views directory, whether it exists, how many
  views loaded, how many failed.
- The README documents the format.

## Architecture

**The server reads; the browser matches.**

The server owns the filesystem side: locate the directory, read each file, parse it,
validate every key and value, and normalize to plain JSON. It serves the result at
`GET /api/views` as `{views: [...], errors: [...]}`, behind the same token gate as every
other `/api/` route, since a view file names projects and branches.

The browser owns evaluation. Every session is already in the client — the wall holds the
full snapshot and patches it over SSE — so matching locally makes switching views instant
with no refetch, and lets the four readouts be recounted against the view.

The alternative, filtering server-side per connection, was rejected: it needs per-client
view state on a stream that is currently one broadcast to everyone, it makes switching a
round trip, and it puts the tool in the position of serving an "all" count that does not
mean all.

**One matcher, not two.** The glob compiler and the match predicate live in
`public/match.js` — pure, DOM-free, no imports — and are imported both by the browser and
by `src/views.js`, which uses them at load time to validate. This mirrors `public/notify.js`,
which is already pure and DOM-free so that the decisions worth getting right are testable
under `node:test` while the browser-only parts stay in `app.js`.

**Hot reload.** `fs.watch` on the views directory, debounced, re-reads everything and
broadcasts a `views` SSE event carrying the same payload as the route. Save a file and the
picker updates without a reload. The watcher follows `registry.js`'s pattern: watch, and on
any event re-poll rather than trusting the event's filename.

## The picker

A `view:` select at the head of the wall-only controls, before `agent`.

- **Everything** is built in, always first, and is not a file. It matches everything, which
  is the current behaviour exactly.
- **With no view files loaded, the picker is not rendered at all.** Someone who never
  creates a view sees the header they see today.
- Selection is remembered per browser, in the existing `agent-cctv:view` localStorage blob
  alongside the other view settings. It is not written to disk, so two people on a shared
  server can sit on different views.
- `?view=frontend` opens straight into a view, which is what a kiosk wallboard needs. An
  unknown id falls back to Everything.

### How a view and the header interact

The view is the **population**; the header **narrows within it**.

- The four readouts count within the view. A button's figure stays exactly what clicking it
  leaves on the wall, which is the invariant the header was built around.
- The `agent` and `project` selects populate from what the view left on the wall, and
  narrow further. They keep their existing behaviour of falling back to "all" when their
  value disappears.
- `groupBy` from the file **seeds** the select on switching to the view. Changing it by hand
  works and lasts for the session; it is never written back to the file.
- The empty state gets a view-aware line: a wall emptied by the view says so, and says which
  view, rather than reading as "no agents are running".

## Reach: what a view scopes

- **The wall:** yes. That is the feature.
- **Alerts:** yes, but scoped to the view's *population*, not the header's narrowing. This
  distinction is the whole point: sitting on the "working" filter must still notify you when
  a session leaves it for blocked — that transition is the one thing the alert exists for.
  So the gate is "is this session in the active view", and never "is this session currently
  on screen". `shouldNotify` keeps its edge-into-urgency rule untouched; the caller adds the
  membership check.
- **History:** no. The archive is where you go to find a specific past session you remember,
  and silently hiding two thirds of it because of a dropdown three feet away is a trap. It
  stays a full archive.

## Failure modes

- **A malformed view file never breaks the wall.** Every file is parsed independently; what
  parses loads, what doesn't lands in `errors` with file, line and message. The picker shows
  a small warning naming the failing files; `agent-cctv views` prints them in full.
- **An unreadable or missing views directory** is not an error. No views, no picker,
  today's behaviour.
- **The selected view disappears** — file deleted or renamed while open — falls back to
  Everything and announces it, rather than leaving a picker pointed at nothing.
- **Two files with the same id** (`frontend.yaml` and `frontend.json`) is a load error
  naming both, not a race won by whichever the directory listed first.
- **A view that matches nothing** is legal and shows the view-aware empty state. It is a
  perfectly reasonable thing for `state: attention` to be most of the time.

## Files

New:

- `src/yaml.js` — the strict YAML subset parser. Returns values or throws with a line.
- `src/views.js` — locate, read, parse, validate, normalize; the `errors` list.
- `public/match.js` — pure glob compiler and match predicate, shared by both ends.
- `public/views.js` — the picker: render, select, hot-reload, warnings.
- `test/views.test.js` — the parser, the matcher, loading, and the route.

Changed:

- `src/paths.js` — `VIEWS_DIR`, with its env override.
- `src/server.js` — the `/api/views` route, the watcher, the `views` broadcast.
- `public/app.js` — population gate in `visible()`, counts against the view, the alert
  membership check, view-aware empty copy.
- `public/index.html`, `public/styles.css` — the picker.
- `bin/cctv.js` — the `views` command, and doctor's extra line.
- `README.md` — the format, the directory, the semantics.

`app.js` is 1247 lines already, which is why the picker is its own module rather than more
of it.

## Testing

- **The YAML subset:** each supported construct, and — more importantly — each rejected one,
  asserting the error names the right line. Comments beside quoted values, since that is the
  case that would misparse most plausibly.
- **The matcher:** OR within a field, AND across fields, exclude beating include, a missing
  field never matching, the `state` aliases, case insensitivity, and globs anchoring to the
  whole string.
- **Loading:** a directory with one good file and one broken one loads the good one and
  reports the bad one; duplicate ids error; a missing directory yields no views and no error.
- **The route:** `/api/views` requires a token, and returns both keys.
- **The wall:** counts are computed against the view, and alert membership follows the view
  and not the state filter.
