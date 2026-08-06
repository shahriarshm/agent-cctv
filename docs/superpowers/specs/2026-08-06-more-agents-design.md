# More agents on the wall: Gemini CLI, OpenCode, Hermes

## What and why

The wall watches Claude Code and Codex. Three more agents run on real machines
and keep real session records on disk, so they belong on the wall: Gemini CLI,
OpenCode, and Hermes. Copilot CLI and Cursor CLI were considered and deferred —
neither leaves session data on this machine to build against, and an adapter
written from documentation alone is an adapter nobody has ever seen work.

Everything lands behind the existing source-adapter contract: a `capabilities()`
export, a `patchFromMeta()` shared with history, and a Source class that emits
`update` with `{sessionId, patch, events, bootstrap}` and touches nothing else.

All three are `authoritative: false, urgency: false`. None of them writes down
a pid or a pending approval, so their tiles can say what a session is doing but
never raise the wall's urgent signal — the same honesty rule as Codex. That is
missing information, not missing wiring. (Verified: OpenCode's `permission`
table is a remembered-allowlist keyed on project/action/resource, not a pending
queue.)

## Gemini CLI — the tailer one

`~/.gemini/tmp/<project-slug>/chats/session-*.jsonl` is per-session JSONL, so
this is a `JsonlTailer` subclass shaped like Codex's rollout tailer. The format,
read off real files:

- Line 1 is a header: `{sessionId, projectHash, startTime, lastUpdated, kind}`.
- `{"$set":{"messages":[...]}}` is a full snapshot → bootstrap.
- A bare `{id, timestamp, type, content}` object is an appended message → an
  event. The same id reappears as streaming rewrites it, so events dedupe by
  message id (`state.seen`), first sight wins.
- `{"$set":{"lastUpdated"}}` is a heartbeat → bumps activity, emits nothing.

The session id comes from the header (the filename carries only 8 hex chars),
read from the first few hundred bytes and cached per file. `cwd` comes from the
sibling `.project_root` file — one line, the real project path — read once per
project dir and cached. Snapshot lines run to hundreds of KB; nothing may
assume short lines.

## SqlitePoller — the new shared base

OpenCode and Hermes both keep sessions in sqlite, so `src/sqlite-poll.js` owns
the mechanics the way `tail.js` does for JSONL, and nothing agent-specific:

- **Opening.** `node:sqlite`, read-only, lazily imported in a try/catch. On a
  Node without it the source reports unavailable with the reason in
  `capabilities()`; doctor explains, the rest of the wall runs. Read-only
  matters twice: it is the pure-observer rule, and it means we can never hold a
  write lock against the live agent. A read-only open of a WAL database can
  fail when the agent is not running to maintain the `-shm` file; that is "no
  data right now", not an error.
- **Polling, not watching.** WAL writes do not reliably fire fs events on the
  main db file. ~2 s cadence; the handle stays open between polls; a poll that
  throws (db deleted, schema migrated under us) closes the handle and retries
  next tick rather than crashing the wall.
- **Cursoring.** The subclass supplies queries keyed on a high-water mark
  (`time_updated`, max message rowid); the base keeps the cursor. The first
  poll emits recent sessions with `bootstrap: true` so old history fires no
  notifications.

## OpenCode

`~/.local/share/opencode/opencode.db`. Sessions from the `session` table:
`directory` → cwd, `title`, `model`, `agent`, token columns → usage,
`time_archived` → the tile retires. Child sessions (`parent_id` set) are
subagents, not tiles. New `message`/`part` rows since the cursor become events.
No explicit state is emitted; the store's inference (busy while events flow,
idle after silence) is the truth available.

## Hermes

`~/.hermes/state.db`, `sessions` filtered to `source = 'cli'` — Hermes also
logs gateway chat sessions, and this is a coding-agent wall. Rich patch: `cwd`,
`git_branch`, `title`, `model`, token counts, and `ended_at`/`end_reason` — a
real terminal state, so a finished Hermes session retires promptly instead of
waiting out the silence sweep. New `messages` rows become events (role user →
prompt, assistant → text/thinking/tool starts, tool rows → tool ends).

## History

`src/history.js` stops hardcoding two file tailers. File-backed sources keep
the two-16 KB-reads listing and tailer replay. Sqlite sources contribute the
same two operations from queries: list = one indexed read over recent sessions,
open = that session's rows replayed through the same event mapper and a
throwaway Store. Read-through stays the rule; nothing is copied into
`~/.agent-cctv`.

## Wiring

- `src/paths.js`: `GEMINI_DIR`, `OPENCODE_DIR`, `HERMES_DIR`, env-overridable
  (`AGENT_CCTV_GEMINI_DIR` / `AGENT_CCTV_OPENCODE_DIR` / `AGENT_CCTV_HERMES_DIR`).
- `src/server.js`: three more entries in the sources array and the
  capabilities map.
- `bin/cctv.js`: doctor rows (with the node:sqlite reason when that is the
  blocker), the "no agent data found" gate, and `status` learn the new sources.
- `public/icons.js`: `opencode` and `hermes` entries (`gemini` already exists).
- README: supported-agents section, same commit as the behaviour.

## Testing

Fixtures, not home directories. Gemini: synthesized JSONL modeled on the real
format. Sqlite: databases created by the tests themselves through `node:sqlite`
with the same schema subset the adapters read, skipped on Nodes without it.
No test reads a real `~/.gemini`, `~/.local/share/opencode`, or `~/.hermes`.
