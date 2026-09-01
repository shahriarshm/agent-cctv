# agent-cctv: self-hosted team deployment — design

**Date:** 2026-08-05
**Status:** approved, ready for implementation planning
**Scope:** Release 1 (network edge, config, lifecycle). Release 2 is named at the end but specced separately.

## Problem

`agent-cctv` today is a single-user, single-machine tool: `npx agent-cctv`, bound to
`127.0.0.1`, with a random per-run URL token, storing nothing. That is the right shape for
one developer watching their own agents, and it must not regress.

We also want a company to install it on a server and use it as a team observability tool.
The topology is confirmed: **the coding agents run on the same server as agent-cctv** — CI
runners, cloud dev boxes, an agent fleet. There is no remote fleet of laptops shipping
events inward.

That confirmation is what makes this small. The reader — sources, tailer, store, liveness,
history — needs no change at all, because it is still reading `~/.claude` and `~/.codex` on
the machine it runs on. What changes is the network edge, credential lifetime, and process
lifecycle.

## Goals

1. A company can run agent-cctv on a shared server, reachable by a team, authenticated.
2. `npx agent-cctv` for an individual behaves exactly as it does today.
3. No new runtime dependencies. The tool stays zero-dependency, MIT, Node ≥18.
4. Fix the security defects that a non-loopback deployment would turn from papercuts into
   holes — some of which are worth fixing for individuals regardless.

## Non-goals, and why

These are refused, not deferred. Each would be a permanent maintenance obligation
disproportionate to a 5.2k-line tool.

- **User accounts / RBAC.** Nobody at this size builds them; Dozzle offers a file provider
  or forward-auth, and Prometheus shipped "put a proxy in front" for a decade. Identity is
  also useless in-app here: there are no write actions and no per-user scoping, so there is
  nothing to do with a username except print it.
- **In-app TLS / ACME.** Certificate acquisition and renewal in a zero-dependency tool is a
  layer we would own forever. The reverse proxy already does it.
- **Any persistence layer.** See "Persistence" below.
- **A remote-collector protocol.** The moment agents live on other machines this becomes a
  different product. Hold the same-box premise.
- **Any control action** — no "kill session", no "answer this permission prompt".
  Read-only is exactly what makes a shared token proportionate. A single write endpoint
  inverts the threat model and would force the accounts question back open.

  *Superseded 2026-08-09 by the remote-approvals design:* answering a permission
  prompt from the wall now exists, but behind a second credential class (the
  `cctv-act` pairing cookie) rather than by reopening the accounts question —
  the shared view token still cannot act, which is what this bullet was
  protecting.

## Trust model

Stated plainly, because the docs must state it plainly:

> Everyone who can reach agent-cctv can read every session's full transcript, including
> source code. There is no per-user filtering.

This is deliberate. It is an observability wall; seeing the whole wall is the point. It is
also the honest boundary — the daemon's uid can read every transcript on the box anyway, so
a per-user filter would be cosmetic access control that someone would eventually mistake
for a security boundary.

The guidance for operators is therefore: **scope access to people who could already `ssh`
to this box.** A company needing genuine team isolation runs two instances with different
roots — zero code.

Authentication is a static shared token. The human is authenticated by the company's own
reverse proxy (SSO, oauth2-proxy, Cloudflare Access, whatever they already run); agent-cctv
checks the token; the proxy's access logs provide "who viewed when" for free.

## Persistence

Unchanged: agent-cctv stores nothing. The justification survives the company case precisely
because the topology guarantees the durable store — the agents' own JSONL logs — is on the
same box.

Two consequences to document rather than engineer around:

- The history window is bounded by **Claude Code's own cleanup** (`cleanupPeriodDays`,
  default ~30 days). A company wanting a longer window changes that setting in Claude Code,
  not in agent-cctv.
- A company wanting real retention or analytics points its existing log shipper (Vector,
  Filebeat) at `~/.claude/projects/**/*.jsonl`. It is JSONL on disk; agent-cctv does not
  need to be in that path.

## Architecture: no modes

There is no `--server` flag and no mode concept. A mode is something users must learn and a
second code path that rots. All behavior falls out of config resolved in the order
**flags → environment → config file → defaults**:

- **Token** — `AGENT_CCTV_TOKEN` if set (stable across restarts), else a random per-run
  token, which is today's behavior.
- **Host allowlist** — `localhost`, `127.0.0.1`, `::1` always; plus the hostname of
  `AGENT_CCTV_PUBLIC_URL` when set.
- **Bind address** — `AGENT_CCTV_HOST` / `--host`, default `127.0.0.1`.

An individual runs `npx agent-cctv` and gets exactly what they get today. A company sets
two environment variables and a systemd unit. Nothing branches on a mode.

Note that in the expected deployment agent-cctv **still binds loopback**: the reverse proxy
runs on the same box, since the agents do. A non-loopback bind is only needed when the proxy
is on a separate machine, and then it should bind a private interface.

## Components

### New: `src/config.js`

Small module owning resolution and validation. Exists so `bin/cctv.js` does not grow a
validation limb.

```
resolve({ flags, env, file }) -> {
  port, host, token, publicUrl, publicHost, openBrowser, secureCookie
}
```

`validate()` throws a `ConfigError` carrying a human message for each refusal below.
`secureCookie` is true when `publicUrl` uses https.

### Changed: `src/server.js`

1. **`/ingest` moves behind the auth gate.** Today it is handled at line 120, before the
   `authed` check at line 142, so it is unauthenticated. `src/hook.js:87` already sends
   `x-cctv-token`, so nothing breaks.
2. **`hostAllowed` / `originAllowed` take an allowlist** rather than hardcoding localhost.
   Same shape, configurable contents.
3. **Cookie auth** (see flow below).
4. **`/api/health` trimmed** to `{ok, capabilities}`. It is the one unauthenticated
   endpoint and currently also returns pid and a live session count. `capabilities` stays
   deliberately readable — operators should be able to alert on registry degradation
   without a credential.

### Changed: `src/paths.js`

Read `AGENT_CCTV_TOKEN`, `AGENT_CCTV_PUBLIC_URL`, `AGENT_CCTV_HOST`, alongside the existing
`AGENT_CCTV_PORT`, `AGENT_CCTV_HOME`, `AGENT_CCTV_CLAUDE_DIR`, `AGENT_CCTV_CODEX_DIR`.

### Changed: `bin/cctv.js`

Consume resolved config; render `ConfigError` messages; keep the existing startup banner
and capability dots.

### Changed: `public/app.js`

Replace the raw NUL byte at line 982 (`current.join('\0') !== wanted.join('\0')`, written as
a literal NUL) with the `'\0'` escape. Identical behavior. The reason is that the raw byte
makes the whole file classify as binary — `file` reports `data` — so `grep` skips it
silently. That is a hazard on its own and it would silently defeat the SPA guard test below.

### New: `deploy/`

- `agent-cctv.service` — systemd `Type=simple`, `User=` the agent account, `--no-open`,
  environment via `EnvironmentFile`. No daemonization, pidfiles, or log rotation is written:
  that is systemd's job.
- `Caddyfile.example` — TLS + forward-auth in about six lines.
- `nginx-oauth2-proxy.conf.example` — the other common shape.

### Changed: `README.md`

A "Running it for a team" section: the trust model verbatim, the two environment variables,
a pointer to `deploy/`, the retention answer, and the operational warnings under Risks.

## Auth flow

1. Request arrives. `Host` must be in the allowlist. `Origin`, when present, must be too.
2. `/api/*` **and `/ingest`** require the token, accepted from `?token=`, the
   `x-cctv-token` header, or the `cctv` cookie.
3. On the first successful query-string or header auth, respond with
   `Set-Cookie: cctv=<token>; HttpOnly; SameSite=Strict; Path=/`, adding `Secure` only when
   `publicUrl` is https.

Step 3 exists because `EventSource` cannot set headers, so the SPA currently puts the token
in the query string of every `/api/stream` request (`public/app.js:8-9`), where it would
land in every corporate proxy access log. After the first request the browser sends the
cookie automatically and the token leaves the URL.

`Secure` is conditional because an unconditional `Secure` cookie is never returned over
plain http, which would break every loopback and non-TLS deployment. `SameSite=Strict`
together with the `Origin` check covers CSRF. `src/hook.js` continues to use the header and
is unaffected.

The cookie value is the token itself rather than a session identifier mapped in memory. With
a single shared static secret those have identical blast radius, and the stateless version
survives restarts without a session table.

## Refusal rules

Each exits non-zero before binding, with a specific message naming the offending setting.

| Condition | Rationale |
|---|---|
| Non-loopback bind and no token | The one combination that silently serves source code to a network. |
| `--no-token` together with a non-loopback bind | Same, stated explicitly rather than inferred. |
| `AGENT_CCTV_PUBLIC_URL` not a parseable absolute URL | A typo would otherwise produce an allowlist entry that never matches, presenting as an unexplained 403. |
| `AGENT_CCTV_TOKEN` shorter than 16 characters | The shared secret is the entire security model on a team-reachable port. Accepting `hunter2` silently is the worst available failure. |

Missing capabilities continue to degrade with a warning and a running process — unchanged.

## Testing

These go in a new `test/server.test.js`, picked up by the existing
`node --test "test/*.test.js"` script. `test/unit.test.js` is already 722 lines and these
are all edge/transport concerns rather than unit concerns.

- `/ingest` rejects a POST with no token — a permanent regression guard on the defect found
  during design.
- `/ingest` accepts a POST carrying `x-cctv-token`, proving `src/hook.js` still works.
- The host allowlist accepts the configured public hostname and rejects an unlisted one.
- The origin allowlist behaves the same, and a request with no `Origin` is still allowed.
- Each of the four refusal rules exits non-zero with its message.
- The cookie is set on first query-string auth, and a subsequent request carrying only the
  cookie is authorized.
- `Secure` is present when `publicUrl` is https and absent when it is http.
- `/api/health` returns no pid and no session count.
- **SPA guard:** every `innerHTML` / `insertAdjacentHTML` / `outerHTML` assignment in
  `public/*.js` must have a right-hand side drawn from the static icon constants — the rule,
  not a fixed count, so the test does not need editing whenever a line moves. At the time of
  writing that is five assignments in `public/app.js` (lines 233, 436, 640, 904, 1114),
  sourced from `SOURCES` and `THEME_ICON`; the test should fail on any assignment it cannot
  attribute to those. It must read the file with `fs.readFileSync` and scan in JS — not
  shell out to `grep` — because a binary-classified file makes `grep` exit silently and the
  guard would pass while checking nothing. The NUL fix above removes that specific trap, and
  reading in JS means reintroducing one cannot re-disarm the test.

The SPA guard matters more after this change than before: today the SPA renders all session
data through `textContent`, so a slip is self-XSS on localhost. On a team server, a
malicious repository — whose content reaches transcripts — would pop every viewer's browser
from behind the SSO gate. That discipline becomes a security boundary and needs a test
holding it.

## Risks and operational warnings

- **Docker is the wrong primary artifact.** Without `--pid=host`, `kill(pid, 0)` returns
  `ESRCH` for every host pid, so every Claude session reads as dead — it destroys the one
  authoritative liveness signal the tool has. Bind-mount uid mismatch and the cross-namespace
  `ps` walk in `src/liveness.js` compound it. npm + systemd is primary; Docker is documented
  as "requires `--pid=host` and a matching uid", or not at all.
- **Never run as root.** This process serves file contents over HTTP; root turns any path
  bug into a full-disk read. Run as **the same account the agents run as** — not merely one
  sharing its group. `src/paths.js` resolves `CLAUDE_DIR` from `os.homedir()`, so a
  different account looks in the wrong home entirely, finds nothing, and exits. (Corrected
  during implementation: this section originally said "or a user sharing its group", which
  does not work until multi-root support lands in release 2.)
- **Silent degradation is worse on a server.** A Claude Code auto-update moving the
  undocumented internals turns the wall stale for a whole team, none of whom ran `doctor`.
  Document: pin the Claude Code version, and alert on
  `capabilities['claude-code'].registry === false` from `/api/health`.
- **Unauthenticated `/ingest` is worse than it looks**, which is why it is release 1 and not
  release 2: `store.apply` creates a session for any unseen `sessionId`
  (`src/store.js:125-131`), each carrying a `Ring(400)`, so a POST loop is unbounded memory
  growth. Any local process can do this today.
- **Hook/daemon uid split.** `src/hook.js` reads the token from `~/.agent-cctv/config.json`
  (mode 0600). If the daemon runs as a different user than the agent, hooks cannot
  authenticate. Acceptable — hooks are opt-in and rarely needed — but document it.

## Known limitations at release

Carried forward deliberately. Each was found during implementation, judged not worth fixing
in release 1, and is recorded here because the working notes live outside git.

- **A stale bookmarked token shows the wrong error.** The SPA sets its auth-failure message
  only when the URL carries no token at all. A bookmark holding a token the operator has
  since rotated falls into the normal path and shows the generic "signal lost" wall instead
  of saying the credential is bad.
- **Hooks cannot find the token under the systemd deployment.** The unit redirects
  `AGENT_CCTV_HOME` to its `StateDirectory` (`/var/lib/agent-cctv`), so `src/hook.js`,
  which looks in `~/.agent-cctv`, will not find it unless the agent's shell exports the same
  variable. Hooks are opt-in; documented in the README.
- **A hand-rolled reverse proxy that rewrites `Host` to `localhost` upstream** would let a
  tokenless loopback deployment serve transcripts to the network. No refusal rule can detect
  this. The shipped Caddy and nginx examples forward the original host and so fail closed.
- **`resolve()` treats port `0` as falsy**, so an ephemeral port cannot be requested. Mirrors
  the pre-existing `resolvePort()` convention in `src/paths.js`.
- **`hostname()` does not validate what follows a closing bracket**, so a `Host` of
  `[X]garbage` reduces to `X`. Not exploitable — `req.headers.host` is read nowhere else —
  but worth tightening before any host-based routing is added.
- **The SPA innerHTML guard is a tripwire, not a proof.** Its scan misses
  `el.innerHTML += x` and `el['innerHTML'] = x`. Neither form exists today; catching them
  properly needs an AST parser, which is disproportionate here.
- **A wrapped masthead can show a stray divider** at the start of its second row. CSS has no
  "first in flex line" selector, so a real fix means restructuring the header.
- **`validate()` demands a token when `AGENT_CCTV_PUBLIC_URL` points at loopback**, which is
  stricter than necessary. A false positive in the safe direction.
- **SSE fan-out** is O(clients × events) (`src/server.js:81-91`) and a busy fleet is chatty.
  Fine at release-1 scale; measure before optimizing.
- **Containerized agents are out of scope.** If each agent runs in its own container its
  `~/.claude` is invisible and its pid is in another namespace. Say so in the docs rather
  than half-supporting it.

## Release 2, specced separately

Multi-user boxes, once release 1 has shipped. The codebase is already shaped for it:
`ClaudeCodeSource` takes `projectsRoot`/`sessionsDir` (`src/sources/claude-code/index.js:76`),
`CodexSource` takes `root`/`indexFile` (`src/sources/codex/index.js:55`), and
`history.js:146` already accepts `roots`. The work is a labelled roots config
(`[{label: "alice", home: "/home/alice"}]`), one source pair instantiated per root, an
`owner` field stamped on each patch, group-by-owner in the SPA, and per-root capabilities in
`doctor` and `/api/health`.

Owner attribution comes from the configured label, not the file's uid — a declaration in
config is stable and legible where a uid is neither.

The common company deployment — an agent fleet or CI runners under a single service
account — works with release 1 alone and no reader changes at all. That is why this is
sequenced second.

A possible third release, if asked for: a `/metrics` Prometheus endpoint exposing sessions
by state and blocked duration. Stateless, consistent with storing nothing, and it lets
companies alert through the stack they already run.
