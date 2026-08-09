# agent-cctv: remote approvals — design

**Date:** 2026-08-09
**Status:** approved, ready for implementation planning
**Scope:** one release. A pending-approval surface on the wall, an opt-in Claude Code
`PermissionRequest` hook that routes permission decisions through it, and the pairing
mechanism that keeps the Allow button off the watch link.

## Problem

The wall already tells you a session is `waiting` and why (`waitingFor`, from the Claude
Code registry). What it cannot do is anything about it. The operator who started
agent-cctv, opened a tunnel, and left the house is watching a tile that says *waiting on
permission* with no move available except going home. The prompt itself renders in the
session's own terminal and reads its answer from that TTY; no external mechanism can
answer a prompt that is already on screen.

Claude Code does, however, have a documented extension point *upstream* of the prompt:
hooks. A `PermissionRequest` hook runs when the permission system needs a decision, may
answer `allow` or `deny`, and — critically — falls through to the ordinary terminal
prompt when it stays silent. That is a control channel made of documented interfaces,
and agent-cctv already owns hook installation (`src/install.js`: atomic, backed up,
removes only entries it added) and hook→server transport (`src/hook.js` →
`POST /ingest`, authenticated from the `~/.agent-cctv/config.json` runtime echo).

The feature is therefore *not* "answer the terminal prompt remotely." It is: while the
operator has explicitly armed remote approvals, a permission decision is offered on the
wall **and** at the terminal simultaneously, whichever answers first wins, and every
failure lands back on the terminal prompt exactly as today.

## What the spike established

Verified empirically against Claude Code **2.1.226** on 2026-08-09 (a scratch project,
logging hooks, driving the TUI under a pty). These are load-bearing facts, not doc
citations, because the hooks documentation describes this event thinly:

1. `PermissionRequest` fires **only when a permission decision is actually needed.** An
   allowlisted command (`permissions.allow` → `Bash(touch:*)`) runs without firing it.
   In `-p`/headless mode, where prompts auto-deny, it does not fire at all.
2. The input envelope carries `session_id`, `transcript_path`, `cwd`, `prompt_id`,
   `permission_mode`, `tool_name`, full `tool_input`, and `permission_suggestions`.
   There is **no `tool_use_id`** in this build — nothing external can key a pending.
3. A hook that exits 0 with no output falls through to the normal terminal prompt.
   This is also the documented contract ("staying silent doesn't approve it").
4. `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`
   executes the tool, and the TUI attributes it: *⎿ Allowed by PermissionRequest hook*.
5. **The terminal prompt renders while the hook is still running.** Both surfaces are
   live concurrently; the hook's late answer resolves the on-screen dialog. Remote
   approval never locks the local operator out, and armed mode costs a person at the
   keyboard nothing.
6. Paths under `~/.claude` are treated as sensitive and prompt even when allowlisted —
   such prompts fire the hook too, which is correct: the wall sees whatever would ask.

## Goals

1. From a phone on the tunnel URL, see exactly what a Claude Code session wants to do
   and answer Allow or Deny — with the terminal prompt as the always-available fallback
   and the automatic result of every failure mode.
2. **Watching never grants acting.** The view token/cookie cannot approve anything;
   sharing a watch link shares eyes, not hands.
3. A run without `install --approvals`, or with approvals disarmed, is byte-identical
   to today. The pure-observer constraint bends in exactly one place — one additional
   settings.json hook entry, installed by the same opt-in machinery as the existing ones.
4. Zero runtime dependencies survive. The fail-safe rests only on documented hook
   semantics (exit 0, no output), never on undocumented timeout behavior.
5. The wall stays honest about scope: only Claude Code can do this, and the
   `capabilities()` / `doctor` surface says so the same way it reports `authoritative`
   and `urgency` today.

## Non-goals

- **Answering `AskUserQuestion` or sending prompts.** No documented mechanism exists
  for either. The one hack available — denying the tool call with the "answer" embedded
  in the reason — forges an interaction the model did not have, and is rejected. If
  Claude Code ever ships a control API, that is a new design.
- **Any control for Codex, Gemini, OpenCode, Hermes.** No hook, no registry, no channel.
  Their tiles keep the universal waiting/urgency treatment and never grow buttons.
- **Free-text deny reasons from the phone.** The deny reason is model-visible context;
  it stays a fixed template string. (The operator who wants to say more has a keyboard
  at the other end of the conversation.)
- **Delivery of alerts to a closed browser.** Web Push means VAPID, payload encryption,
  and a service worker — a big bite for another day. v1 assumes the wall is open in a
  tab; `notify.js` decides when that tab may alert.
- **Persisted approval state or audit log.** Nothing about a pending or a decision is
  ever written to disk. See Decisions.
- **Auto-arming.** Arming is a deliberate act by a paired device, every time.

## Trust model delta

The tunnels spec widened *reach*; this spec widens *power*. One sentence governs it:

> An Approve button behind the watch credential turns read exposure into code execution
> on the operator's machine.

So the act privilege is a second credential with a lifecycle, not a second use of the
first one. The view token still only watches. Acting requires a pairing that (a) can
only be attempted by someone who already passes view auth, (b) is minted on demand at
the terminal, expires in minutes, dies on first use or five failures, and (c) produces a
device secret that lives in server memory only — a restart is a full revocation of every
paired device and the armed state. The kill switch is `ctrl-c`.

## Decisions

### Gate on `PermissionRequest`, not `PreToolUse`

The obvious design intercepts `PreToolUse` with a matcher over state-changing tools.
It was rejected for three reasons the spike made concrete. First, a `PreToolUse` hook
cannot know whether the allowlist would auto-approve the call, so every gated call would
detour through the portal even when nobody needed to be asked — the arming toggle would
have to carry that whole cost. Second, the matcher list (`Bash|Edit|Write|...`) is ours
to maintain forever and silently misses `mcp__*` tools, which can be as state-changing
as Bash. Third, `PermissionRequest` *is* the permission system asking — allowlisted
calls never fire it, MCP tools fire it when they would prompt, and gate-worthiness stays
the permission system's job. Matcher: `*`.

The event is new and thinly documented; everything we rely on is pinned by the spike
facts above and re-verified by the manual test procedure at the bottom of this spec.
`install --approvals` refuses on a Claude Code older than **2.1.226** (the verified
floor) — behavior of older builds given an unknown hook event in settings.json is
untested, and a settings file that breaks an old CLI is not a risk worth taking for
an opt-in feature.

### The fail-safe is the hook's own deadline, on documented semantics only

The docs say what exit 0 with no output means. They do **not** say what a timed-out
hook means — "Seconds before canceling" is the entire contract. So the settings entry's
`timeout` (300 s) is a backstop against a hung process, never the mechanism: the hook
enforces its **own deadline of 270 s** and exits 0 with no output before Claude Code's
timer can ever fire. Every path out of the hook — server unreachable, not armed,
deadline, killed because the local operator answered first, server restart mid-poll —
is exit 0, no output, terminal prompt.

This is why the approvals hook is a **new script beside `src/hook.js`, not an extension
of it**. The enrichment hook's non-negotiables (never block, never write stdout, 400 ms
hard bail) are the exact opposite of a blocking decision hook's job. Sharing code
between them invites one inheriting the other's rules. `src/install.js` currently
stamps `timeout: 5` on every entry it writes; the approvals entry carries its own.

### A pending approval is the hook's open request — there is no stored state

The hook's POST *is* the pending. The server holds the response open; the decision
endpoint resolves that specific held response; when the socket closes, the pending
ceases to exist and an expiry event goes out over SSE. Nothing is written anywhere,
ever. Four whole classes of bug fall out structurally:

- **Replay** — nothing stored, nothing to replay; a decision is consumed by the one
  in-flight response it resolves.
- **Stale approval hitting a later same-name call** — a pending is one invocation's
  socket, never "session + tool name."
- **Allow racing the deadline** — the hook exits, the socket closes, `req.on('close')`
  expires the pending and broadcasts it; a tap that loses the race gets 409, and the
  terminal prompt (already on screen — spike fact 5) is the only decision channel left.
- **Two paired devices disagreeing** — pending→decided is one transition in
  single-threaded Node. First tap wins; the second gets 409 with the outcome, so the
  phone says "already allowed" rather than erroring vaguely.

One consequence: parallel tool calls mean several concurrent pendings per session, so
the tile renders a **queue** of cards, not a slot.

A local process minting fake pendings would need the token (`config.json` is 0600), and
a fake pending has no waiting hook behind it — approving it executes nothing. Same-user
malware already owns the account; the file mode handles other users. Token auth is
enough for the pending endpoint.

### Armed is a memory bit that everyone can see and disarming drains

The hook asks one question before blocking: is remote approval armed? Disarmed — the
overwhelmingly common state — gets an instant "no" and the hook exits silently; the
detour costs one loopback round-trip only on calls that were already about to prompt.

Armed state: server memory only, settable only by paired devices, **included in the SSE
snapshot and broadcast on change** so no portal can display a stale answer (a restarted
server reconnects every SSE client, and the fresh snapshot says disarmed). Arm,
disarm, and auto-disarm print in the server's terminal. Auto-disarm after **4 hours**;
re-arming from the phone is one tap, and a forgotten toggle must not quietly re-route
next week's sessions. Disarming — manual or automatic — immediately resolves every held
long-poll with no-decision, so hooks exit and terminal prompts stand alone again, and
while disarmed the pending endpoint answers instantly rather than holding.

Spike fact 5 defuses the worst armed-state footgun: the terminal prompt is live the
whole time a pending is held, so armed-with-nobody-watching stalls nothing that was not
already stalled — an unanswered permission prompt waits today too.

### Pairing: a code with a lifecycle, not a code with entropy

A standing 6-digit code printed at startup would be brute-forceable overnight through a
quick tunnel by exactly the principal the view/act split exists to contain: someone
holding the watch link. The defense is lifecycle, with entropy as seasoning:

- The pairing endpoint sits **behind view auth** — only watch-link holders can attempt
  it at all, and the open internet cannot.
- `agent-cctv pair` (a CLI subcommand hitting loopback with the token) mints the code
  on demand and prints it in the terminal — the same physical screen the tunnel URL is
  copied from, which is the possession proof. TTL **5 minutes**, **one-time** (consumed
  on first success), dead after **5 failed attempts** with a loud line in the terminal.
  Comparison via the existing timing-safe helper.
- Success mints a random per-device secret held in server memory beside the armed bit,
  delivered as a second cookie. Restart revokes everything; that is a feature.

Six digits, five attempts, one-time: ~5×10⁻⁶ escalation odds per issued code. Fine.

### The act cookie is not the view cookie, and never travels like one

Name `cctv-act`; `HttpOnly; SameSite=Strict; Path=/`; `Secure` decided per request by
the existing `secureFor` predicate (host-scoped cookie jars make the tunnel hostname
and loopback strangers already, and quick-tunnel hostnames are fresh per run); Max-Age
**7 days** where the view cookie gets 30 — it is execute power on a stealable phone,
and server memory is the real authority, so a long-lived cookie buys an attacker
nothing past the next restart anyway. No `__Host-` prefix (breaks loopback http).

Unlike the view token, the pairing secret is **never** accepted via query or header —
cookie only, set only by the pairing flow. There must be no path on which it can appear
in a URL, a log line, or an SSE address.

### Act endpoints check the act cookie themselves, on top of the generic gate

The decision and arm endpoints live under `/api/`, so the generic token gate still
applies — then they additionally require a valid `cctv-act` cookie. Routing them
through the generic gate alone would be the single-token design this spec exists to
refuse. CSRF is covered by what is already there, provided nothing is loosened:
`SameSite=Strict` keeps cross-site pages from sending the cookie, the Origin allowlist
rejects cross-origin browser POSTs, the Host allowlist kills DNS rebinding, and a
non-browser caller needs the secret itself. The `!origin → allow` branch stays — the
hook and curl need it, and no browser sends a cookie-bearing POST without an Origin.

### The approval card is a security surface, not a status display

The person tapping Allow authorizes arbitrary execution on the strength of what the
card shows. Requirements, all testable:

- The **full, untruncated** command / tool input in a scrollable block. An ellipsized
  one-liner with a button beside it is the rubber stamp, and is forbidden.
- For `Edit`/`Write`: the path and the full new content or diff.
- Session identity — project, cwd, tool name, `permission_mode` — plus the pending's
  age and a countdown to its deadline.
- Invisible characters made visible: bidi overrides (U+202E can render `rm -rf /` as
  something innocuous) and C0 controls are escaped to a visible form, and the raw byte
  length is shown — "4 KB that renders as two lines" is itself a warning the user
  should see.
- `textContent` only, as everywhere (`test/spa-guard.test.js` enforces it); transcript
  content remains untrusted repository content.

Unpaired devices render the same card read-only with a "pair to act" hint — seeing
what is pending is view-grade information; answering is act-grade.

### Rejected alternatives, written down so nobody "simplifies" into them

- **Native `type: "http"` hooks** (Claude Code POSTs hook input to a URL itself).
  Seemingly this exact feature without a subprocess — but header auth only interpolates
  env vars, our token is per-run in `config.json`, the port can move, and a frozen
  URL+token in settings.json is strictly worse than a command hook that reads the
  runtime echo at invocation time.
- **Stored pendings / decision queue.** Every risk in the socket-bound section comes
  back, plus disk state in a tool whose observer contract is that it keeps none.
- **One token for view and act.** A shared watch link is remote code execution.
- **TTY injection (tmux send-keys) or resuming sessions headlessly.** Unsupported,
  fragile, and forks a live conversation respectively.
- **Answering `AskUserQuestion` via deny-reason.** Forges an interaction; rejected
  above as a non-goal.

## Components

### New: `src/approve-hook.js`

The blocking decision hook. Reads the `PermissionRequest` envelope from stdin, reads
`~/.agent-cctv/config.json` for port + token, POSTs
`{sessionId, toolName, toolInput, cwd, permissionMode, suggestions}` to
`/api/approvals/pending`, and waits. Responses: `{armed: false}` → exit 0 silently;
a decision → print the `hookSpecificOutput` JSON and exit 0; anything else — connect
failure, non-2xx, malformed body, 270 s self-deadline, SIGTERM/EPIPE because the local
operator answered the terminal first — exit 0 with no output. It never writes stderr
in normal operation (hook stderr surfaces in the TUI) and never reads the transcript.

### Changed: `src/install.js`

`install --approvals` adds the `PermissionRequest` entry (matcher `*`, its own
`timeout: 300`) alongside the existing enrichment entries; plain `install` does not.
It refuses when `claude --version` cannot be read or is below 2.1.226, with the reason.
`uninstall` removes both kinds of entry; the existing only-remove-ours marker covers
the new one unchanged.

### Changed: `src/server.js`

- `POST /api/approvals/pending` — token auth (same class as `/ingest`). Disarmed:
  responds `{armed: false}` immediately. Armed: registers the pending in a
  `Map<id, {res, meta}>`, broadcasts `approval-pending`, and holds the response until
  a decision, disarm, or socket close (which broadcasts `approval-expired`). The
  server never times a pending out itself — the hook's deadline owns that — and no
  keep-alive is needed: the hook connects to loopback directly, so there is no
  intermediary that could reap an idle connection.
- `POST /api/approvals/:id/decision` `{behavior: "allow"|"deny"}` — generic gate
  **plus** act cookie. Resolves the held response with the hook output JSON (deny
  carries the fixed template reason). Gone already → 409 with what happened to it.
- `POST /api/approvals/armed` `{on: bool}` — generic gate plus act cookie. Flips the
  bit, broadcasts `armed`, starts/clears the 4 h auto-disarm timer, drains pendings on
  `off`, prints to the terminal.
- `POST /api/pair/new` — token auth, loopback CLI's entry point. Mints the code (TTL,
  one-time, attempt counter), returns it to be printed by `agent-cctv pair`.
- `POST /api/pair` `{code}` — behind view auth. Success sets `cctv-act` and registers
  the device secret; failure counts against the code.
- Snapshot and `/api/state` gain `approvals: {available, armed, pendings: [...]}`;
  pendings carry `{id, sessionId, toolName, toolInput, cwd, permissionMode, since,
  deadline}`. `/api/health` reports only that the approvals hook capability exists —
  the armed bit and pendings are authenticated-eyes information and stay out of the
  one unauthenticated endpoint.

### Changed: `src/sources/claude-code/index.js`

`capabilities()` gains `approvals` (hook installed and version floor met), surfaced by
`doctor` and `/api/health` beside `authoritative` and `urgency`.

### Changed: `bin/cctv.js`

The `pair` subcommand (POST loopback `/api/pair/new`, print the code and its TTL), and
`install` learns `--approvals` (a `BOOLEAN_FLAGS` entry — no value, so the second flag
list is untouched).

### Changed: `public/`

- `app.js` + a new `public/approvals.js`: the card queue on the session tile (patched,
  never rebuilt, like everything on a tile), the armed toggle, the pairing dialog.
  Formatting and invisible-character escaping live in DOM-free functions so
  `node --test` reaches them without a browser.
- `notify.js`: a pending approval is a new alert class with the urgency treatment;
  existing gating (when an alert may fire, what it may say) applies unchanged.
- The armed toggle and pairing control live inside an existing header region and shed
  with it — no new region, no new tier, per the header's shedding design. Buttons
  carry `aria-label`s; `test/header-markup.test.js` already refuses otherwise.

### Changed: `README.md`

An "Approving from your phone" section: the trust-model sentence verbatim, the pairing
walkthrough, what armed means, the terminal-always-wins guarantee, and the Claude
Code-only honesty. Behavior and README change in the same commit, per house rule.

## The flow, end to end

1. Operator, once: `agent-cctv install --approvals`. At the laptop, before leaving:
   `agent-cctv pair`, types the 6-digit code into the phone's already-open wall, taps
   the armed toggle.
2. A session hits a permission decision. The hook fires, finds armed, POSTs, and the
   server broadcasts `approval-pending`. The terminal prompt renders as always.
3. Every open wall shows the card on that session's tile; `notify.js` may alert; the
   phone (paired) shows Allow / Deny, another viewer (unpaired) sees the card
   read-only.
4. First answer wins: a tap resolves the held response and the hook prints the
   decision; or the local operator answers the terminal and the hook exits silently;
   or 270 s pass and the hook exits silently, leaving the terminal prompt.
5. The tile's event stream then shows the tool running or denied via the existing
   transcript tailing — no new wiring; the wall was already watching.

## Failure behaviour

| When | What happens |
|---|---|
| Server not running / unreachable | Hook exit 0 in milliseconds; terminal prompt as today. |
| Approvals disarmed | Instant `{armed: false}`; hook exit 0; terminal prompt as today. |
| Nobody answers anywhere | Hook self-deadline at 270 s, exit 0; the terminal prompt was rendered at second zero and simply remains. |
| Local operator answers first | Claude Code resolves the dialog; the hook is killed or its answer ignored; it exits cleanly on SIGTERM/EPIPE. |
| Tap races the deadline | Socket already closed → 409 with outcome; card already gone from every wall via `approval-expired`. |
| Second device taps | 409 with "already allowed/denied"; first tap stands. |
| Disarm (manual or 4 h auto) with pendings held | All held responses resolve no-decision; hooks exit 0; terminal prompts stand; broadcast + terminal line. |
| Server restarts | Sockets close → hooks exit 0 → terminal prompts stand. Pairings and armed state gone; snapshot tells every reconnecting wall the truth. |
| Tunnel dies mid-pending | Remote walls lose reach (existing tunnel behavior); the pending expires at deadline or is answered locally. Loopback serving continues. |
| Old Claude Code | `install --approvals` refused with the version floor and reason; nothing written. |

## Testing

The rule mirrors tunnels: **no test spawns `claude`.** The hook and server are
exercised with fake envelopes and real sockets.

- `test/approve-hook.test.js` — the hook as a child process with a scripted stdin
  envelope against `createServer({withSource: false})`: armed long-poll resolves to
  the decision JSON on stdout; disarmed exits 0 silently and fast; unreachable server
  exits 0 silently and fast; self-deadline exits 0 (deadline overridden, not waited
  out); SIGTERM mid-poll exits cleanly; output is valid `hookSpecificOutput` JSON for
  allow and for deny with the template reason.
- `test/server.test.js` additions — pending lifecycle over raw `node:http` (the Host
  rule): decision resolves the held response; socket close broadcasts expiry; second
  decision 409s with outcome; disarm drains; armed flag appears in snapshot and
  broadcasts; act endpoints reject a valid view token with no act cookie; the pairing
  code is one-time, TTL-bound, dies after five failures, and success sets `cctv-act`
  with `HttpOnly`, `SameSite=Strict`, correct per-host `Secure`, and the shorter
  Max-Age; the act secret is never accepted via query or header.
- `test/install.test.js` additions — `--approvals` writes the entry with its own
  timeout; uninstall removes it; version refusal below the floor.
- Card logic — escaping of bidi/C0 characters, byte-length display, countdown math:
  DOM-free functions, tested directly. `test/spa-guard.test.js` and
  `test/header-markup.test.js` cover the rest by existing to be passed.
- **Manual end-to-end** (the spike, kept as procedure): scratch project outside
  `~/.claude`, `install --approvals` against it, drive a gated `touch` interactively;
  verify card, allow-from-wall, TUI attribution line, deadline fall-through, and
  local-answer-first.

## Risks and known limitations

- **`PermissionRequest` is new and thinly documented.** Everything load-bearing is
  pinned by spike facts against 2.1.226 and re-checkable via the manual procedure. A
  future Claude Code that changes the event degrades to: hook silent, terminal prompt,
  feature dark — the fail-safe *is* the failure mode. The version floor gates install,
  not runtime; a downgrade after install leaves a harmless unknown entry.
- **Concurrent prompt-and-hook is observed behavior, not documented contract** (spike
  fact 5). If a future build serializes them, armed mode starts costing the local
  operator waiting time — the auto-disarm and the loud armed banner bound the damage
  until we notice.
- ~~The deny reason's exact output field is unverified~~ **Verified during
  implementation** (2026-08-09, Claude Code 2.1.226, real interactive session):
  `decision: {behavior: "deny", message: "..."}` denies the call, the TUI
  prints *Denied by PermissionRequest hook*, and the model receives the
  template message verbatim.
- **Subagent tool calls fire hooks too.** A Task-spawned `Bash` that would prompt also
  detours while armed. Accepted: it would have prompted at the terminal anyway.
- **No alert reaches a closed browser.** v1 requires the wall open in a tab; that is a
  documented limitation, not a surprise, and Web Push is a possible follow-up.
- **A paired phone is a key.** Bounded by Max-Age, by memory-only pairings dying on
  restart, and by arming being separate from pairing. A stolen unlocked phone with a
  paired wall open is outside the model — as it is for the phone's email, bank, and
  SSH apps.
- **Shoulder-surfing the pairing code** during its 5-minute window from the terminal
  screen requires eyes on the laptop, which is the possession proof working as
  intended; the attempt counter stops guessing from the outside.
- **Approving is still judgment.** The card refuses to truncate and un-hides invisible
  characters, but a plausible-looking `curl | sh` approved from a phone at a bar is
  approved. The card's job is to never *cause* that mistake; it cannot prevent it.
