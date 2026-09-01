# agent-cctv

A live wall of what every coding agent on your machine is doing —
Claude Code, Codex CLI, Gemini CLI, OpenCode and Hermes, side by side.

```
npx agent-cctv
```

That's the whole setup. No install step, no config, no restarting your sessions —
it reads Claude Code's own state directly, so sessions you started an hour ago
show up the moment the dashboard opens.

macOS and Linux. On Windows, run it inside WSL — the state files it reads and
the pid liveness check are Unix-shaped, and nothing here has been tested
natively.

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

Alongside them the header filters by **agent** and by **project**. Both populate
themselves from what is actually on the wall, with counts, and fall back to "all"
if their value disappears.

They are chips rather than labelled dropdowns, and a chip only spends width when
it is doing something: on "all" it is a dimmed icon, and the moment you set it it
shows the value and lights up. Filtering to one agent puts that agent's own mark
on the chip — the same mark its tiles carry. Underneath, each one is still an
ordinary `<select>`, so the keyboard, the screen reader and your phone's native
picker all work the way they always did.

**Group by** splits the wall into labelled sections — by project, agent, state,
or git branch — each with its own count and a note of how many feeds inside
need you. Groups are ordered by their most urgent member, so the section
holding a blocked session is always the one at the top. Tiles are moved rather
than rebuilt, so their activity strips keep their history across a regroup.

### On a small screen

The header is one row at every width, and it gives things up in a fixed order as
it narrows: first the clock and the wordmark, then the words beside the counts,
then the pickers and the buttons. What is left on a phone is what you opened the
page for — how many sessions are running, how many need you, and whether the feed
is still alive. Everything else is one tap away behind the controls button, which
opens a sheet from the bottom where the controls get their labels back and enough
room for a thumb.

Two things never abbreviate. The counts keep their glyphs, because a row of bare
numbers tells you nothing and colour alone is not a distinction everyone can see.
And a lamp that has gone to **signal lost** or **no credential** keeps its words
at every width, because that is the one moment the lamp is worth reading.

### Views

The header's own filters are enough for one machine and not enough for a wall you
keep open. A **view** is a named population of sessions, written as a file in
`~/.agent-cctv/views/`. Its id is its filename; `.yaml`, `.yml` and `.json` all
load.

```yaml
# ~/.agent-cctv/views/frontend.yaml
name: Frontend work        # label in the picker; defaults to the filename
order: 20                  # optional picker order; default 100, ties break by name
mode: focus                # wall (default), focus, or tail
groupBy: branch            # seeds the group-by select; still changeable by hand

match:                     # the population — everything this view puts on the wall
  project: [web-*, design-system]
  branch: "feat/*"
  agent: claude-code
  exclude:
    cwd: "*/scratch/*"
```

You can match on `agent`, `project`, `cwd`, `branch`, `model`, `name` and
`state`. A list of values is OR and separate fields are AND, so the view above is
*those two projects, on a feature branch, run by Claude Code*. Patterns are globs
— `*` for any run, `?` for one — matched case-insensitively against the whole
string, so `web-*` matches `web-app` but not `my-web-app`, and matching part of a
path needs its own stars. `exclude` takes the same fields and wins over
everything. A session that doesn't carry the field at all never matches a pattern
on it: `branch: "feat/*"` leaves out a session with no branch rather than
treating absence as a wildcard. `state` is the one field that isn't a glob —
it takes `busy`, `waiting`, `idle`, `ended`, or the two the header already thinks
in, `live` and `attention`.

**The view is the population; the header narrows within it.** The four counts and
the agent and project chips all recount against the view, so the figure on a
button is still exactly what clicking it leaves on the wall.

Alerts follow the view — in a Frontend view you are not interrupted for a backend
session going blocked. They follow the *view*, though, not the state filter:
sitting on "working" still tells you when a session leaves it for blocked, which
is the only thing the alert exists for. History deliberately does not follow the
view. The archive is where you go to find a session you remember, and hiding two
thirds of it because of a dropdown three feet away is a trap.

You don't have to write that file by hand. Set the header the way you want it —
filters, grouping, mode — then pick **＋ Save current as…** at the bottom of the
view chip's list, give it a name, and the dashboard writes the file for you. What
comes out is an ordinary view file: hand-editable, diffable, indistinguishable
from one you typed.

Saving composes rather than replaces. Narrow a view that already has an
`exclude:` block down to one project, save it, and the new view keeps the
exclusion and adds the project. What it cannot keep is anything the header has no
way to say — the globs and lists come from the file, so a view saved from the
header holds exact values. That is the one lossy edge, and it is why the file
stays the place the interesting matching lives.

This is the only thing agent-cctv writes that you will read back, and it only
happens when you click Save. It writes `<name>.yaml` into the views directory and
can write nothing else: the name is reduced to a slug that has to match
`[a-z0-9-]`, the resolved path is checked to be inside that directory, and the
view is validated by the same code that loads one — a view that wouldn't load
can't be written. An existing name asks before replacing.

`agent-cctv views` prints what loaded, where it looked, and anything that failed
to parse. Edit a file and the wall picks it up on save; a file that doesn't parse
is named, with its line, and the other views carry on without it.

The YAML is a deliberately small subset — comments, `key: value`, quoted strings,
lists and nested maps — and it refuses anything else by line number rather than
guessing. agent-cctv has no dependencies, so this is a parser we own, and one
that quietly misreads `branch: "feat/*" # temporary` would put the wrong sessions
on the wall while looking entirely confident. (Two consequences worth knowing:
`cwd: */scratch/*` is a YAML alias, so globs that start with `*` need quoting —
the parser tells you so. And inside double quotes the only escapes are `\"` and
`\\`; anything else is refused by name, rather than read as the backslash it
isn't.)

`AGENT_CCTV_VIEWS_DIR` moves the directory. On the team deployment below it
follows `AGENT_CCTV_HOME` to `/var/lib/agent-cctv/views`, where one set of views
is shared by everyone on the box — which is the right default there, since a view
is a file you can commit and hand to the person next to you. Which view *you* are
on is per-browser and is never written to disk, so two people watching the same
wall sit on different ones. `?view=frontend` opens straight into one, which is
what a kiosk screen needs.

### Modes

**Mode** in the header is how the wall is drawn, as opposed to which sessions are
on it. A view can carry one, so switching to a view puts you in its mode. It is a
three-way toggle rather than a dropdown — each option is a picture of the layout
it gives you, and a word beside the picture would only have said it twice.

**wall** is the grid, and the default. **focus** is the spot monitor: one session
takes the room with its live timeline underneath, and every other session sits in
a rail beside it — still readable, still one click from being promoted. It starts
on whatever is most urgent, so a blocked session puts itself in front of you, and
if the session you were watching ends, focus moves rather than leaving you with a
dead panel. Grouping means nothing here, so the group-by control goes away rather
than sitting there doing nothing.

**tail** is the whole room as one log: every event from every session in the view,
newest at the top, each line saying which session it came from. It is `tail -f`
for the wall — the mode for when you want to know that *something* is happening
rather than what any one session is doing. It doesn't auto-scroll, for the same
reason the inspector doesn't: a pane that jumps while you're reading it is worse
than one you have to scroll yourself.

### History

**History** — the clock-and-arrow button in the header — opens the archive: every session that has already left
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

The button next to Alerts cycles **Auto → Light → Dark**, and its glyph says
which of the three you are on: a half-lit circle for Auto, a sun, a moon. Auto
follows your system and switches with it live; either override is remembered with
the rest of your view settings. The button carries no word — hover it, or ask a
screen reader, and it tells you the setting and what clicking will do next.

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
- **Subagent requests are skipped for context, counted in the sums.** A
  sidechain carries its own separate context; letting one land would make a
  full session look like it had emptied. But its tokens are the session's work,
  so the billed totals keep them.
- **Each agent counts differently.** Codex's `input_tokens` already includes
  its cached portion and it keeps its own running total; OpenCode and Hermes
  hand over running totals from their databases. Each source does its own
  arithmetic.

A dollar figure appears only when the agent itself keeps one — OpenCode prices
its sessions and Hermes records an estimate and, when it has one, a measured
figure (labelled `est.` when it is the estimate). The wall never computes cost
from a price table of its own: that table goes stale silently, and it is
meaningless on a subscription — a wrong number that looks authoritative is
worse than no number. The inspector also derives what the sums support: the
billed-token breakdown, how much of the input came from cache, the burn rate,
and the session's age.

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
agent-cctv views          List the view presets it can see
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
| `~/.gemini/tmp/*/chats/session-*.jsonl` | Gemini CLI activity — prompts, thoughts, tool calls. Same byte-offset tail; the cwd comes from the `.project_root` file beside each log. |
| `~/.local/share/opencode/opencode.db` | OpenCode sessions, messages and tool calls, polled read-only out of its sqlite database. |
| `~/.hermes/state.db` | Hermes CLI sessions — cwd, git branch, title, and a real `ended_at`. Same read-only sqlite poll. |

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

### Putting it on the internet

Two shapes, one flag. Both need a tunnel binary you already have — agent-cctv
spawns it, reads the public URL out of its output, and stops it when you stop.

**For ten minutes.** A Cloudflare quick tunnel needs no account, no DNS and no
proxy:

```sh
agent-cctv --tunnel cloudflare
```

It asks you to type `yes` first, prints the public link, and closes the tunnel
when you ctrl-c. `--tunnel ngrok` does the same through ngrok. `--tunnel-cmd
'<command>'` does it through anything else that prints an https URL — bore,
localtunnel, localhost.run. And `--tunnel-ttl 30m` closes it for you, so a wall
you published over lunch is not still public on Thursday.

**For good.** Point `--tunnel-args` at a named tunnel or a reserved domain, and
set `AGENT_CCTV_PUBLIC_URL` to the hostname you own:

```sh
AGENT_CCTV_PUBLIC_URL=https://cctv.example.com \
  agent-cctv --yes --tunnel cloudflare --tunnel-args "run my-wall"
```

That variable is required here, not optional: a named cloudflared tunnel prints
no URL anywhere — its hostname lives in your Cloudflare DNS — so it is the only
way agent-cctv can learn which hostname to allow. See
[`deploy/agent-cctv-tunnel.service.example`](deploy/agent-cctv-tunnel.service.example).

Either way the trust model above does not change, and through a tunnel it is
worth reading twice. On loopback, "everyone who can reach it" means you.
Published, it means anyone holding the link — and that link is a bearer
credential, which survives being pasted into a channel, a screenshot or a bug
report. agent-cctv refuses to publish without a token, refuses to publish from
a script without `--yes`, and prints the address and the tokened link on
separate lines so the wrong one is harder to copy. It cannot un-send a URL.

If you need to know *which person* read the wall, put Cloudflare Access or your
own SSO in front of a hostname you own. The token only ever says "somebody".

While a tunnel is up the dashboard shows a `public` badge with the hostname, in
the top right. If the tunnel drops, that link is dead — a re-opened quick tunnel
comes back on a *different* hostname — and agent-cctv says so and keeps serving
locally rather than trying to reconnect a link nobody can use.

### Approving from your phone

You left the house, the wall is open on your phone, and a Claude Code session
hits a permission prompt. Opt in, and the prompt appears on that session's tile
with the **whole** command — never an ellipsis with an Allow button next to it —
and Allow/Deny buttons that answer it. The terminal prompt stays on screen the
entire time; whichever side answers first wins, and every failure — wall down,
nobody paired, five minutes of silence — ends at that terminal prompt exactly
as if this feature did not exist.

One sentence governs the design:

> An Approve button behind the watch credential turns read exposure into code
> execution on the operator's machine.

So acting is a second credential, not a second use of the first. The watch
link still only watches. To put buttons on a device:

```sh
agent-cctv install --approvals   # once — adds the PermissionRequest hook
agent-cctv pair                  # prints a six-digit code in the terminal
```

Enter the code on the device (tap the shield in the header). It is one-time,
dies after five minutes or five wrong guesses, and can only be attempted by
someone who already holds the watch link. Then arm the shield. Armed means
permission prompts also go to the wall; it switches itself off after four
hours, and disarming (or the wall restarting) instantly releases anything
pending back to the terminal. Restarting the wall also unpairs every device —
that is the kill switch, and it is one ctrl-c away.

What the card shows is the security boundary, so it refuses to be polite:
the full command or file diff in a scrolling block, the byte size, and any
invisible characters spelled out — a command hiding behind a U+202E bidi
override renders as `⟨U+202E⟩`, not as the innocuous string it was disguised
as. Deny sends the model a fixed template line, never your own words.

The honest limits: Claude Code ≥ 2.1.226 only — Codex, Gemini, OpenCode and
Hermes have no mechanism for this, so their tiles never grow buttons — and
alerts need the wall open in a tab; there is no push to a closed browser.

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
  which means an update moved something and the wall is about to go stale. The
  same endpoint reports `tunnel` — its provider and start time, never its URL —
  so you can alert on a box that is publishing when it should not be.
- **An orphaned tunnel fails closed.** If agent-cctv is killed outright, the
  provider binary can survive it and keep forwarding. Nothing reaps it, because
  nothing needs to: a restarted agent-cctv without `--tunnel` has no tunnel
  hostname to allow, so every request arriving through the orphan gets a 403.
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

## The other agents, and what each one costs

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

**Gemini CLI** is the same bargain from a different log: per-project JSONL under
`~/.gemini/tmp/`, no registry, no approval record, so state is inferred from
activity. Its one nicety is the `.project_root` file beside each log, which
makes the tile's cwd exact rather than parsed out of a message.

**OpenCode and Hermes keep sessions in sqlite**, so those two adapters poll
their databases read-only (~2 s) instead of tailing a file — WAL commits do not
reliably touch the database file, so watching it would miss them. This needs
`node:sqlite`, which shipped unflagged in Node 22.13; on an older Node the two
adapters report themselves unavailable in `doctor` and the rest of the wall
runs normally. Neither records a pending approval — OpenCode's `permission`
table is a remembered allowlist, not a queue of prompts — so no urgent light
here either. Hermes stands slightly apart: its sessions table records a real
`ended_at` with a reason, so a finished Hermes session retires promptly instead
of waiting out the silence sweep, and its cwd, git branch and title come from
columns rather than parsing.

## Adding other agents

A source is anything that emits `{sessionId, patch, events}`. The store and UI
know nothing about either source beyond that normalized shape. The awkward part —
following an append-only JSONL log by byte offset, stitching partial lines,
starting mid-file, surviving truncation — is in `src/tail.js` and shared; a
source subclasses `JsonlTailer` and says only what its files are called and what
its lines mean. `src/sources/claude-code/`, `src/sources/codex/` and
`src/sources/gemini/` are each a couple hundred lines of mapping table on top
of it. Agents that keep sessions in sqlite instead get the same treatment from
`src/sqlite-poll.js` — read-only open, capability gate, retry-not-crash — with
`src/sources/opencode/` and `src/sources/hermes/` supplying only the queries
and the row-to-event mapping.

Event kinds are deliberately few: `prompt`, `assistant_text`, `thinking`,
`tool_start`, `tool_end`, `turn_end`, `queued`, `session_start`, `session_end`.
Anything product-specific belongs in `meta`, not in a new kind — Codex's turn
boundaries become a state in `meta`, not a `turn_start` event.

If your agent keeps session records on disk, an adapter is a welcome pull
request — the five under `src/sources/` are the template, and each is small
enough to read in one sitting.

## A caveat worth knowing

`~/.claude/sessions`, the transcript entry types, and `~/.claude/tasks` are
undocumented Claude Code internals (verified against 2.1.252). A Claude Code
update could move them. `agent-cctv doctor` tells you what it can currently
read, and the dashboard degrades to transcript-only inference rather than
silently showing stale states.

## Credits

Agent marks are from [simple-icons](https://github.com/simple-icons/simple-icons)
(CC0 1.0, public domain), inlined in `public/icons.js` so the dashboard works
offline. Codex, OpenCode and Hermes have neutral placeholders — simple-icons
publishes no mark for any of them.

## Development

```
npm test
```

MIT.
