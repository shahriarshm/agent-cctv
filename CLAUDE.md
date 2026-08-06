# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm test                                          # whole suite (node --test, 183 tests)
node --test test/views.test.js                    # one file
node --test --test-name-pattern "mode defaults"   # one test, by name

node bin/cctv.js --no-open        # run the dashboard without opening a browser
node bin/cctv.js doctor           # what it can read on this machine
node bin/cctv.js views            # which view presets loaded, and what failed to parse
node bin/cctv.js status           # live sessions, from the terminal
```

There is no build step, no linter, and no runtime dependencies — `public/*.js` is
served to the browser exactly as written. Node ≥18, ESM throughout.

Point the reader at fixtures instead of a real home directory with
`AGENT_CCTV_HOME`, `AGENT_CCTV_CLAUDE_DIR`, `AGENT_CCTV_CODEX_DIR`,
`AGENT_CCTV_VIEWS_DIR`. `src/paths.js` reads these at module load, which is why
`test/helpers/env.js` must be the **first** import in any test that touches
`src/` — ESM evaluates imports in source order.

## Architecture

Data flows one way: **source adapters → store → server (SSE) → browser**.

### Sources (`src/sources/<agent>/`)

A source is an EventEmitter that emits `update` with `{sessionId, patch, events, bootstrap}`
and nothing else. It never touches the store directly. Each also exports:

- `capabilities()` — what it can read on this machine, including `authoritative`
  (does this agent have a real status file?) and `urgency` (can it tell you a
  session is *blocked*, not merely idle?). Surfaced at `/api/health` and in `doctor`.
- `patchFromMeta(meta, file)` — transcript facts → a session patch. Shared with
  `src/history.js`, so a session read back from disk months later is described by
  the same code that described it live.

`src/tail.js` (`JsonlTailer`) owns everything hard about following an append-only
JSONL log: per-file byte offsets, a line split across two reads, joining mid-file
without choking on the leading fragment, truncate-and-replace detection. A source
subclasses it and fills in four hooks — `sessionIdFor`, `initState`, `toEvents`,
`collectMeta`. Transcripts run to tens of MB; nothing here may ever read one whole.

Claude Code and Codex are **not** symmetric, and the asymmetry is load-bearing:
Claude Code has `~/.claude/sessions/<pid>.json` (pid, cwd, `busy|idle|waiting`
plus a `waitingFor` reason), so its states are authoritative and liveness is a
real `kill(pid, 0)`. Codex has no registry — no pid, no status, and no approval
event in a rollout — so a Codex tile can never raise the wall's urgent signal.
That is missing information, not missing wiring; don't "fix" it by inferring one.

### Store (`src/store.js`)

Merges patches, keeps a `Ring(400)` of events per session, derives urgency, and
retires tiles. Two rules that are easy to break:

- **Authority is per source, not global** (`shouldInfer`). A session is inferred
  only if no source ever gave it a state *and* its own source is non-authoritative.
  Asking one global question would let a healthy Claude registry suppress
  inference for Codex sessions it knows nothing about.
- **Never infer over an explicit state.** Guessing would also stamp the wrong
  transition time, which is what the tile's duration counter reads.

Emissions are debounced 60 ms (`markDirty`) — a single transcript write produces a
dozen events.

### Server (`src/server.js`)

One file: SSE broadcast, JSON API, static serving. `createServer({withSource: false})`
gives a server with no filesystem sources attached, which is how the tests drive it.

The dashboard streams source code out of transcripts, so loopback is not the
security boundary. Everything under `/api/` (except `/api/health`) plus `/ingest`
requires a token, compared with `timingSafeEqual`. `Host` and `Origin` are checked
against an allowlist. A token arriving by query or header is swapped for an
HttpOnly cookie once, so it stops appearing in the SSE URL and can be scrubbed
from the address bar. **`/api/views` (POST) is the only endpoint that writes
anything a person reads back** — see `writeView()`.

### Views

`public/match.js` is the view predicate, and `src/views.js` imports it *from
`public/`* — deliberately. The browser evaluates patterns and the server validates
them; one implementation means they cannot drift. `public/` is also the only
directory the browser can reach, which is why the shared file lives there rather
than in `src/`.

`src/yaml.js` is a hand-written strict subset (comments, `key: value`, quoted
strings, flat lists, nested maps) that refuses anything else *by line number*.
Zero dependencies is the reason it exists; a parser that quietly misreads
`branch: "feat/*" # temporary` would put the wrong sessions on a wall while
looking confident. `stringifyYaml` round-trips through it.

### Frontend (`public/`)

`app.js` is the wall; `views.js`, `modes.js`, `timeline.js`, `format.js`,
`notify.js`, `match.js`, `icons.js` are its modules. Two invariants worth knowing
before editing:

- **Tiles are patched, never rebuilt.** Reordering uses CSS `order`, and focus
  mode *moves* the wall's own tile node. Rebuilding would reset each tile's
  activity strip and drop keyboard focus.
- **`textContent` only.** `test/spa-guard.test.js` scans every `public/*.js` and
  fails on `innerHTML` assigned from anything but the static icon markup in its
  allowlist, on `insertAdjacentHTML`, and on raw NUL bytes. Transcript content is
  repository content; on a shared server, rendering it as HTML is stored XSS
  behind the SSO gate.

- **The header sheds by region, in order.** `.bar` is `nowrap` and so is every
  region inside it; the tiers in `styles.css` move whole regions into the sheet
  rather than hiding individual controls, and nothing moves in the DOM —
  `.bar-shelf` is `display: contents` when wide and a pinned panel when narrow.
  Two things here look like tidiness and are not. Letting a region wrap makes it
  take a second line the instant its contents do not fit, which is cheaper for
  the layout engine than shrinking them, so the chips' ellipsis never fires and
  one set filter puts the whole bar on two rows. And hiding a single control
  inside a region does not reduce that region's minimum width, which is what the
  tier is actually reducing.

Logic worth testing is kept DOM-free so `node --test` can reach it — `notify.js`
(when an alert may fire and what it may say), `match.js`, `format.js`.

### History (`src/history.js`)

Read-through, not storage. Listing costs two 16 KB reads per file (head for cwd
and title, tail for the freshest facts), so a 16 MB transcript lists as cheaply as
a 4 KB one. Opening one replays it through the same tailer and a throwaway
`Store`, then discards it. Nothing is copied into `~/.agent-cctv`.

## Constraints

- **Zero runtime dependencies.** Non-negotiable; it is why `yaml.js` and the
  tailer exist at all.
- **Pure observer.** Nothing writes to `~/.claude` or `~/.codex` except
  `src/install.js`, which edits `settings.json` on an explicit `agent-cctv install`
  (backs up first, writes atomically, only removes entries it added, refuses a
  file it can't parse). The paths it reads are undocumented Claude Code / Codex
  internals — keep every reference behind a source adapter and capability-checked.
- **Do not feed `~/.agent-cctv/config.json` into `src/config.js`'s precedence
  chain.** It is a runtime echo written on every start, not operator config; one
  `--host 0.0.0.0` would otherwise stick forever. `resolve()` takes it as a
  parameter purely so `test/config.test.js` can prove it has no effect.
- Lists that must stay in step by hand: `MODES` and `GROUP_BY` in `src/views.js`
  ↔ `MODES` and `GROUPS` in `public/app.js`. The header's own two — `MODES`
  against the mode buttons, and `STATES` in `public/match.js` against the
  readouts' `data-filter` — are checked by `test/header-markup.test.js`, which
  also refuses an icon-only button with no `aria-label`.
- `--sheet-tier` in `public/styles.css` is read back by `app.js` to decide when
  to close the sheet on a resize, but a media query cannot use a custom
  property, so the literal in `@media (max-width: …)` beside it has to match by
  hand. A mismatch gives you a sheet that will not close when the window widens.
- `node:fetch` silently rewrites the `Host` header, so any allowlist test written
  with it is meaningless — `test/server.test.js` uses raw `node:http` for those.

## Working style in this repo

Features go through `docs/superpowers/specs/<date>-<name>-design.md`, then
`docs/superpowers/plans/<date>-<name>.md`, then a `feat/<name>` branch merged with
a summarizing merge commit. Commits are `feat:` / `fix:` / `docs:` / `refactor:`
with a lowercase subject and a body explaining the *reasoning*, not the diff.

Comments here explain why a decision was made and what breaks without it, often
citing the bug that motivated it. Match that register — a comment restating the
code is worse than none. The README is written in the same voice and is part of
the product; a behaviour change that contradicts it means the README changes in
the same commit.
