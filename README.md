# agent-cctv

A live wall of what every coding agent on your machine is doing —
Claude Code and Codex CLI, side by side.

```
npx agent-cctv
```

That's the whole setup. No install step, no config, no restarting your sessions —
it reads Claude Code's own state directly, so sessions you started an hour ago
show up the moment the dashboard opens.

## What you see

One tile per session, sorted so the ones that need you come first:

- **the tally** — the bar across the top edge of the tile: amber for working,
  steel for standing by, red and pulsing for a session blocked on a permission
  prompt, which also turns the whole tile's frame red. It is a bar rather than a
  lamp so it still reads from across the room. Red is used for nothing else —
  a failed tool call is the machine's problem, and shows in ember.
- **what it's doing right now** — the running tool and its actual argument
  (`▸ Bash npm test`, `▸ Edit nav.config.ts`), not just "running a tool".
- **what it's saying** — the agent's latest message, in plain prose.
- **the activity strip** — one tick per event along the bottom, newest at the
  right. Colour is the kind of work (reads dim, writes amber, shell and failures
  ember, network steel). You can read a session's rhythm without reading a word:
  a wall of amber means heavy editing, a flat dim line means it's stuck reading,
  a tall ember tick means something failed.
- **its task list** — the todos the agent is working through, and how far it got.
- **the agent mark** — which product the session belongs to, so a mixed wall
  stays readable.

- **how full its context is** — `ctx 222k`, and a percentage where the agent
  records its own window. It turns amber past three quarters, because a session
  near its window is about to compact.

Click any tile for the full timeline: every prompt, thought and tool call, with
subagent work marked in its own lane. A tool call is one row, not two — it
appears when the call starts, in amber while it is in flight, and is completed in
place with its outcome and how long it took once the result lands.

### Filtering and grouping

The four counts in the header — **all / live / working / needs you** — are also
the state filter: each one reports a number and is the way you narrow to it, so
the figure on a button is always exactly what clicking it leaves on the wall.

Alongside them the header filters by **agent** and by **project**. Both selects
populate themselves from what is actually on the wall, with counts, and fall back
to "all" if their value disappears.

**Group by** splits the wall into labelled sections — by project, agent, state,
or git branch — each with its own count and a note of how many feeds inside
need you. Groups are ordered by their most urgent member, so the section
holding a blocked session is always the one at the top. Tiles are moved rather
than rebuilt, so their activity strips keep their history across a regroup.

### History

**History** in the header opens the archive: every session that has already left
the wall, newest first, grouped by day, going back a day / a week / a month / three
months. Click one and it opens in the same inspector as a live session — the full
timeline, its tasks, its token numbers.

This does not persist anything, and it is not a longer retention window. The
agents' own logs are already the durable store, on disk, with your source code in
exactly one place; the archive is a read of what is already there. Listing costs
two 16 KB reads per file — the head, where a session declares its cwd and title,
and the tail, where the freshest facts are — so a 16 MB transcript lists as
cheaply as a 4 KB one. A session you never click is never opened, and a session
you do open is replayed through the same tailer and normalization it had when it
was live, then discarded.

The wall itself is unchanged: still live-only, still retiring a tile half an hour
after its session ends.

### Light and dark

The button next to Alerts cycles **Auto → Light → Dark**. Auto follows your
system and switches with it live; either override is remembered with the rest of
your view settings.

Light mode is not the dark theme inverted. The room stays a neutral grey — a
grading suite with the lights on is still a calibrated room, and a white surround
would put the brightest surface on screen in competition with the tiles you are
meant to be reading. What changes is what carries attention: dark mode has glow,
light mode has ink, so every signal colour has two values — a saturated one for
bars, lamps and ticks, and a darker one for text, because amber on white is
1.8:1 and unreadable. Every text pair in both themes clears WCAG AA.

### If the stream drops

The wall greys out and the header says **signal lost** until it reconnects. A
monitoring instrument that keeps showing you glowing lamps and counting clocks
after its feed died is worse than one that shows you nothing, so what you are
looking at is unmistakably a freeze frame rather than a live picture.

### Context and tokens

Each tile carries `ctx 222k` — how full that session's context is right now. It
predicts a compaction, which is the one token number that changes what you do.
Where the agent records its own context window you get a percentage too, and the
figure turns amber past three quarters and ember past nine tenths.

The arithmetic is worth stating, because the obvious version is wrong:

- **Context is read, not summed.** Every request resends the whole conversation,
  so `input + cache_read + cache_creation` on the newest request *is* the context.
  Adding that up across requests gives tens of millions and means nothing. Read
  from the last message, the number is exact no matter where the tail started.
- **Output is summed**, because it genuinely is incremental — and the inspector
  says "(since watching)" when the transcript was joined mid-file, rather than
  passing a partial sum off as a total.
- **Subagent requests are skipped.** A sidechain carries its own separate
  context; letting one land would make a full session look like it had emptied.
- **The two agents count differently.** Codex's `input_tokens` already includes
  its cached portion and it keeps its own running total, so its numbers are
  exact and need no summing. Each source does its own arithmetic.

There is no dollar figure. It would need a per-model price table that goes stale
silently, and it is meaningless on a subscription — a wrong number that looks
authoritative is worse than no number.

### Alerts

**Alerts** in the header asks the browser to notify you when a session goes from
working to blocked on a permission prompt — the wall's one urgent signal,
delivered when you aren't looking at the wall. It fires on that transition only,
never on a repaint, and the notification is withdrawn if you answer the prompt in
the terminal. Off by default; the toggle is a button because browsers only grant
notification permission from inside a click.

The alert says which session, where, and why it stopped — never the running
command or the agent's own words. A notification is rendered on the lock screen
and kept in the OS notification centre, which is a worse place for your source
code than a dashboard behind loopback and a token.

## Commands

```
agent-cctv                Start the dashboard
agent-cctv status         List live sessions in the terminal
agent-cctv doctor         Check what it can read on this machine
agent-cctv install        Optional: add Claude Code hooks
agent-cctv uninstall      Remove those hooks
```

Options: `--port <n>`, `--host <addr>`, `--no-open`, `--no-token`.

## How it works

Claude Code already writes everything needed, so agent-cctv is a pure observer —
it never writes to Claude's state and never sits in the path of your agents.

| Source | What it gives |
| --- | --- |
| `~/.claude/sessions/<pid>.json` | The live registry Claude Code maintains: pid, cwd, session id, and `status` ∈ `busy \| idle \| waiting` with a `waitingFor` reason. This is authoritative — the dashboard never guesses a state it can read here. |
| `~/.claude/projects/**/<session>.jsonl` | The activity stream. Tailed by byte offset, so a 40 MB transcript costs one small read per change. |
| `~/.claude/tasks/<session>/*.json` | The session's task list. |
| `~/.codex/sessions/**/rollout-*.jsonl` | Codex CLI activity — prompts, messages, reasoning, tool calls, turn boundaries. Same byte-offset tail. |
| `~/.codex/session_index.jsonl` | Codex thread names, so a Codex tile has a title instead of a uuid. |

Liveness is a real `kill(pid, 0)` against the registry's pid, with the recorded
process start time checked once to catch pid reuse. A session that isn't in the
registry isn't running — no timeout heuristics involved.

Events keep a `{file, uuid}` pointer back to the transcript line they came from
rather than a copy, so your source code stays in exactly one place on disk.

### The optional hooks

`agent-cctv install` adds Claude Code hooks that POST events to the dashboard.
**You almost certainly don't need this.** It exists for two cases: a Claude Code
build without the session registry, and wanting tool events a beat sooner than a
filesystem watch delivers them. The cost is a Node process spawn on every tool
call, which is why it's opt-in.

The installer backs up `settings.json` before its first change, writes
atomically, only ever removes entries it added, and refuses to touch a settings
file it can't parse.

## Privacy

The dashboard serves your transcripts, which contain your source code. So:

- it binds to `127.0.0.1` only,
- the URL carries a per-run token, required by every endpoint that returns
  session data,
- `Host` and `Origin` are checked, so another site in your browser can't reach
  it by DNS rebinding.

Nothing leaves your machine and nothing is written outside `~/.agent-cctv`.

## Running it for a team

agent-cctv works on a shared server — a CI box, a cloud dev machine, an agent
fleet — as long as the agents run on that same machine. There is no separate
mode: it is two environment variables and a systemd unit.

Install it globally and pin the version, the same way you'd pin Claude Code:

```sh
npm i -g agent-cctv@<version>
```

`npx agent-cctv`, the quick-start above, is fine for trying it on your own
machine — it fetches on demand. The shipped systemd unit does not use it: a
long-running service that re-fetches an unpinned package from the registry on
every restart is not something you want on a server, so it invokes the
installed `agent-cctv` binary directly.

```sh
AGENT_CCTV_TOKEN=$(openssl rand -hex 32)
AGENT_CCTV_PUBLIC_URL=https://cctv.corp.example
```

Everything you need is in [`deploy/`](deploy/): a systemd unit, an environment
file, and reverse-proxy examples for Caddy and nginx + oauth2-proxy.

### The trust model, stated plainly

**Everyone who can reach agent-cctv can read every session's full transcript,
including source code. There is no per-user filtering.**

That is deliberate. It is an observability wall; seeing the whole wall is the
point. It is also the honest boundary — the process can read every transcript on
the box anyway, so a per-user filter would be decoration that someone would
eventually mistake for a security control.

So: **scope access to people who could already `ssh` to this box.** If you need
real isolation between teams, run two instances over different directories.

agent-cctv authenticates with a single shared token and nothing else. Your
reverse proxy authenticates the *human* — SSO, oauth2-proxy, Cloudflare Access,
whatever you already run — and terminates TLS. agent-cctv ships no TLS and no
user accounts, and it never will: they are your proxy's job, and it already does
them better.

Keep the bind on `127.0.0.1`. The proxy is on the same box, because the agents
are. agent-cctv refuses to start if you bind a public interface without a token.
It also refuses to start if `AGENT_CCTV_PUBLIC_URL` is set and no token is
configured, even on a loopback bind — a public URL means a reverse proxy is
making this reachable beyond this machine, which is the same exposure as a
non-loopback bind.

### Retention

agent-cctv still stores nothing. The agents' own JSONL logs are the durable
record, and on this topology they are on the same disk.

- The history window is whatever Claude Code keeps — see `cleanupPeriodDays` in
  its settings, default about 30 days. Change it there, not here.
- For real retention or analytics, point the log shipper you already run (Vector,
  Filebeat) at `~/.claude/projects/**/*.jsonl`. agent-cctv does not need to be in
  that path.

### Operating it

- **Never run it as root.** It serves file contents over HTTP. Run it as the
  same account the agents use — `CLAUDE_DIR` resolves from that account's own
  home directory, so a different account, even one sharing its group, looks in
  the wrong home entirely and finds nothing. Liveness checks work fine
  unprivileged. Multi-user roots are a later release.
- **Pin your Claude Code version, and alert on degradation.** The internals it
  reads are undocumented. `GET /api/health` needs no token and returns
  `capabilities`; alert on `capabilities['claude-code'].registry === false`,
  which means an update moved something and the wall is about to go stale.
- **Docker is not supported as the primary path.** Without `--pid=host` the
  liveness check fails for every host pid and every session reads as dead —
  it destroys the one authoritative signal the tool has. Use npm + systemd.
- **Agents inside containers are out of scope.** Their state directory is
  invisible and their pids are in another namespace.
- **Your reverse proxy must forward the original `Host`.** A hand-rolled proxy
  that rewrites `Host` to `localhost` upstream would let a tokenless loopback
  deployment serve transcripts to the whole network — from agent-cctv's side
  that request is indistinguishable from one made on the box itself, and no
  refusal rule here can detect it. The shipped Caddy and nginx examples both
  forward the original host (`proxy_set_header Host $host` / Caddy's default),
  so they fail closed; a proxy config you write yourself needs to do the same.
- **Hooks and the daemon must share a user.** `agent-cctv start` writes the
  token to `~/.agent-cctv/config.json` (mode 0600); hooks (added by
  `agent-cctv install`) read it from there to authenticate to `/ingest`. If the
  dashboard runs as a different user than the agents, hooks cannot read that
  file and cannot authenticate. Hooks are optional; this only matters if you
  install them.

  The shipped systemd unit sharpens this: `ProtectSystem=strict` makes the
  account's home read-only, so the unit redirects state with
  `AGENT_CCTV_HOME=/var/lib/agent-cctv` (see `deploy/agent-cctv.service`).
  Hooks running from the agents' own shell still default to
  `~/.agent-cctv/config.json`, so under this unit they will not find the token
  there unless you also export `AGENT_CCTV_HOME=/var/lib/agent-cctv` for the
  agents' shell. This is a documented limitation of the systemd deployment,
  not a blocker — hooks are opt-in, and everything else works without them.

## Codex, and what a second agent costs

Codex CLI sessions appear on the same wall, from `~/.codex/sessions/`. They give
you what a Codex session is doing — the prompt, the running `exec` and its actual
shell command, the agent's messages, turn boundaries — and they group and filter
like everything else.

**They cannot tell you that Codex needs you.** Codex keeps no session registry:
no pid, no status file, and no approval event in a rollout. It records the
approval *policy* a turn ran under, never that a turn is sitting blocked on a
prompt. That is not a wiring gap — the information is not written down. So:

- Codex state is **explicit but not authoritative**. `task_started` and
  `task_complete` bracket every turn, so "working" and "idle" are read rather
  than guessed — but nothing proves the process is still alive.
- A Codex session that dies mid-turn looks busy until the silence sweep retires
  it, and one left open and idle is eventually marked no-signal. Claude sessions
  never need that guess, because `kill(pid, 0)` answers it.
- The red urgent light is Claude-only, and `capabilities` says so per source
  (`urgency: false`).

This is why authority is tracked per source rather than globally: a working
Claude registry must not suppress inference for a Codex session it knows nothing
about.

## Adding other agents

A source is anything that emits `{sessionId, patch, events}`. The store and UI
know nothing about either source beyond that normalized shape. The awkward part —
following an append-only JSONL log by byte offset, stitching partial lines,
starting mid-file, surviving truncation — is in `src/tail.js` and shared; a
source subclasses `JsonlTailer` and says only what its files are called and what
its lines mean. `src/sources/claude-code/` and `src/sources/codex/` are both
about 200 lines of mapping table on top of it.

Event kinds are deliberately few: `prompt`, `assistant_text`, `thinking`,
`tool_start`, `tool_end`, `turn_end`, `queued`, `session_start`, `session_end`.
Anything product-specific belongs in `meta`, not in a new kind — Codex's turn
boundaries become a state in `meta`, not a `turn_start` event.

## A caveat worth knowing

`~/.claude/sessions`, the transcript entry types, and `~/.claude/tasks` are
undocumented Claude Code internals (verified against 2.1.222). A Claude Code
update could move them. `agent-cctv doctor` tells you what it can currently
read, and the dashboard degrades to transcript-only inference rather than
silently showing stale states.

## Credits

Agent marks are from [simple-icons](https://github.com/simple-icons/simple-icons)
(CC0 1.0, public domain), inlined in `public/icons.js` so the dashboard works
offline. Codex has a neutral placeholder — simple-icons publishes no OpenAI mark.

## Development

```
npm test
```

MIT.
