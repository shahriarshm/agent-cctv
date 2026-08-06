# agent-cctv: public tunnels — design

**Date:** 2026-08-06
**Status:** approved, ready for implementation planning
**Scope:** one release. `--tunnel`, its refusals, its child-process lifecycle, and the one
place in the UI that says you are publishing.

## Problem

`AGENT_CCTV_PUBLIC_URL` already covers the case where you own a hostname and run a reverse
proxy in front of a loopback bind. It adds that host to the allowlist, flips the cookie to
`Secure`, and refuses to start without a token. That is the *permanent, planned* shape, and
it works.

What it cannot cover is the shape people actually reach for: **make this visible for ten
minutes.** A Cloudflare quick tunnel or a free ngrok session hands you a random hostname that
does not exist until the tunnel is up, so there is nothing to put in `AGENT_CCTV_PUBLIC_URL`
before starting. Chicken, egg. Today the only answer is to start the server, start a tunnel,
read the hostname off the tunnel's own output, kill the server, and restart it with the
hostname — at which point a quick tunnel restart hands you a different one.

Both halves of the request are the same feature: publish the wall, whether for ten minutes or
for good. The difference is whether the hostname is throwaway or yours, and that difference
turns out to be one flag.

## Goals

1. `agent-cctv --tunnel cloudflare` produces a public https link in one command, with no
   Cloudflare account.
2. The permanent case — a named tunnel, a reserved domain — works through the same flag,
   without agent-cctv learning either provider's config file format.
3. Zero runtime dependencies survive. We spawn a binary the operator already installed. No
   provider SDK is linked, ever.
4. The loopback default does not move an inch. A run without `--tunnel` is byte-identical to
   today.
5. Publishing is always a deliberate, informed act. Nobody discovers after the fact that
   their transcripts were on the internet.

## Non-goals

- **Installing or updating provider binaries.** If `cloudflared` is not on `PATH` we say how
  to get it and exit. Downloading and executing a binary on the user's behalf is a different
  trust decision than the one they made by installing this.
- **Modelling provider config.** No `config.yml` generation, no `ngrok.yml` parsing, no
  `--tunnel-name` / `--tunnel-domain`. `--tunnel-args` is the seam, and it is the only seam.
  Those schemas change and we would own the drift forever.
- **Auto-respawn.** See Decisions.
- **Rate limiting or lockout on the token.** See Decisions.
- **TLS, ACME, accounts, RBAC.** Unchanged refusals from the self-hosted deployment design.

## Trust model delta

The self-hosted spec states it and this one restates it, because a tunnel changes who
"everyone" is:

> Everyone who can reach agent-cctv can read every session's full transcript, including
> source code. There is no per-user filtering.

A reverse proxy narrows *reach* to whoever passes your SSO. A tunnel does the opposite: it
widens reach from "processes on this machine" to "the internet, minus one shared secret."
The secret is 128 bits of CSPRNG hex and is not the weak part. The weak part is that the
link is a bearer credential which survives being pasted into a channel, a screenshot, or a
bug report.

Everything in the guardrails section follows from that one sentence, and nothing else does.

## Decisions

Each of these was contested during design. The reasoning is recorded because the conclusion
is not obvious from the code that results.

### The hostname arrives late, so the server gets a tunnel slot — not a mutable allowlist

`createServer` builds its allowlist once, into a closure-captured `Set` (`src/server.js:101`),
checked per request at `:193`. Mutating that Set at runtime would work, but it is the wrong
shape: entries would accumulate across tunnel restarts, and nothing would stop a bug from
evicting loopback from its own allowlist — a failure the existing comment at `:98-100`
already warns about in a different form.

Instead the server gets **one slot**: `server.setTunnel({host, provider, url, since})` or
`setTunnel(null)`. `hostAllowed` becomes `allowed.has(h) || h === tunnelHost`. A slot cannot
accumulate, cannot evict loopback, and is cleared with a single `null`.

The slot is normalised the way the constructor normalises its list — trim, lowercase, strip
brackets — and **not** through `hostname()`, whose port-stripping would reduce a bare `::1`
to the empty string.

This does not weaken the DNS-rebinding protection the allowlist exists for. The only value
that ever enters the slot is a hostname scraped from a child process we spawned ourselves, or
one the operator typed into `--public-url`.

In-flight requests need no special handling. `Host` is checked once when a request arrives,
and an SSE stream that arrived through a tunnel is a TCP connection *through that tunnel's
process* — it dies when the child does, without our help.

### No respawn on tunnel death

The tempting design is retry-with-backoff. It is wrong here, and specifically wrong for quick
tunnels: **a re-spawned quick tunnel comes back on a different hostname.** The link the
operator already sent someone is dead the moment the child exits, and no amount of retrying
brings it back — retrying only produces a second link nobody has, while forcing exactly the
allowlist churn the slot design above exists to avoid. Operators running a *named* tunnel,
where the hostname is stable, are running it under a supervisor already.

So: on child exit, print loudly, `setTunnel(null)`, and keep serving loopback. The wall does
not die because a tunnel did. Restarting is `--tunnel` again, by hand, with eyes open.

The one thing this buys for free: once teardown is a single function, `--tunnel-ttl` is a
`setTimeout` into it.

### `Secure` becomes a per-request predicate

Today `secureCookie` is decided once at construction from whether `AGENT_CCTV_PUBLIC_URL` is
https (`src/config.js:61`, `src/server.js:207`). With a tunnel, https (through the tunnel) and
plain http (loopback) requests hit the same server in the same run, so one global boolean is
wrong in one direction or the other.

The rule becomes: **`Secure` iff this request's `Host` is a hostname we know is https-only** —
the tunnel slot's host (both providers terminate TLS at their edge and never forward plain
http), or `publicHost` when it came from an https URL. Not `X-Forwarded-Proto`, which we would
have to trust from anyone.

There is no lockout or fixation risk in this, for reasons already true of the existing cookie:
it carries no `Domain` attribute (`src/server.js:206`), so it is host-only and the `localhost`
jar and the `xyz.trycloudflare.com` jar cannot see each other; and `cookieTokens()`
(`src/server.js:162-177`) already checks *every* `cctv=` pair rather than the first, which is
what a sibling tenant on a shared suffix would have to exploit. Both `trycloudflare.com` and
`ngrok-free.app` are on the Public Suffix List regardless. And since the cookie value *is* the
token, a planted cookie only authenticates if it already is the secret.

### No fresh token, no higher token floor, no rate limiting

Three rejected hardening measures, each for a specific reason:

- **Forcing a fresh token when `--tunnel` is used** would log out every browser holding the
  cookie — the cookie *is* the token. That breaks precisely the stable-domain deployment that
  `--tunnel-args` exists to serve.
- **Demanding 32+ characters on a tunnel** treats length as a proxy for entropy. The auto-minted
  token is already 32 hex characters, and a second threshold only complicates the refusal
  messages without measurably changing what an attacker can do against 128 bits.
- **Rate limiting** cannot work in this topology: behind a tunnel every TCP peer is the local
  tunnel client, so per-IP limiting is impossible without trusting a provider header, and a
  global limiter is a denial-of-service lever pointed at the operator — anyone can spam bad
  tokens and lock out the person the tunnel was opened for.

### `/api/health` gets `provider` and `since`; the URL and the SPA chip do not come from there

`/api/health` is the one unauthenticated endpoint (`src/server.js:227-232`). "Is this box
publishing?" is a legitimate unauthenticated operator alert, in the same class as the
registry-degradation alert that endpoint was built for, so it gains
`tunnel: {provider, since} | null`.

It does **not** carry the URL, and it is not where the dashboard's chip comes from. The SPA is
already authenticated and already holds an SSE stream, so `tunnel` goes in the snapshot and is
broadcast as its own event, exactly as `views` changes are (`src/server.js:130-133`). Nothing a
logged-in user sees depends on an endpoint that requires no credential.

### `--public-url` is the escape valve on every path

The single largest risk in this feature is that **we are scraping output that is not a
contract.** ngrok's log schema and cloudflared's startup banner are internals; a provider
release that rewords either turns `--tunnel` into a silent hang.

Two structural mitigations rather than a promise to keep up:

1. When `--public-url` is set, **we do not scrape at all.** We spawn the child, take the
   hostname from the flag, and supervise. This is not a workaround bolted on for breakage — it
   is the *only* way the named-cloudflared-tunnel case can work, because a named tunnel prints
   no URL anywhere. Its hostname lives in the operator's Cloudflare DNS, not in the process
   output. Any design that scraped unconditionally would have hung on every "permanent" run.
2. When we do scrape, it fails **loudly** after 30 seconds with the child's own output
   included in the error, never silently.

That reduces every future provider-format change from "the feature is dead" to "pass a flag
that already exists."

### Orphaned tunnels fail closed, so we do not reap them

If the parent is `SIGKILL`ed, the provider binary can survive and keep forwarding. We do not
build orphan-reaping, because the allowlist already handles it: a restarted agent-cctv without
`--tunnel` has no tunnel host in its slot, so every request arriving through the orphan gets
`403 bad host` at `src/server.js:193`. The orphan forwards traffic to a server that refuses it.

## Components

### New: `src/tunnel.js`

The whole feature's moving parts, in one file, with the pure bits separated from the process
bits so `node --test` can reach them without spawning anything.

```
PROVIDERS          — { cloudflare, ngrok }: argv builder + URL matcher per provider
parseTtl(str)      — "30m" | "2h" | "45s" -> ms, or throws
scrapeUrl(chunk)   — provider matcher applied to a chunk of child output -> url | null
class Tunnel       — EventEmitter: start(), stop(), 'url', 'exit'
```

`PROVIDERS` is deliberately a pair of small records rather than two classes:

- **cloudflare** → `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:<port>` plus
  pass-through args. The URL appears on **stderr**, inside an ASCII box, once the edge
  connection is up. Matcher: `https://[a-z0-9-]+\.trycloudflare\.com`. `--no-autoupdate` is
  not optional politeness — an autoupdate restart drops the tunnel mid-session.
- **ngrok** → `ngrok http <port> --log stdout --log-format json` plus pass-through args. The
  default TTY interface prints nothing parseable, which is why the log flags are forced.
  Matcher: the `url` field of the JSON line whose `msg` is `started tunnel`. The local agent
  API on `:4040` is deliberately not used — it is a second port that moves when two agents run.
- **custom** (`--tunnel-cmd`) → run as given. Best-effort match on the first `https://…` the
  child prints, with `--public-url` as the documented answer when that finds nothing.

`Tunnel` owns four things that are easy to get wrong:

- **ENOENT arrives as an async `'error'` event**, not a throw from `spawn()`. Unhandled, it
  takes the process down. It becomes "cloudflared is not installed" plus the install line.
- **Output must be drained for the child's whole life.** ngrok with JSON logging logs *every
  request through the tunnel*, and our SSE stream is a request that never ends. Detaching the
  `data` listener after the URL is found fills the 64 KB pipe and blocks the child. We keep
  reading, and keep the last 40 lines in a ring for the error message.
- **Provider binaries: no shell, not detached.** Same process group means a terminal ctrl-c
  reaches the child too, and `shutdown()` in `bin/cctv.js:189` kills it explicitly. Belt and
  braces, because an orphaned tunnel is the worst failure this feature has.
- **`--tunnel-cmd`: `shell: true` *and* `detached: true`.** Shell, because the string is
  operator-typed on their own machine — the same trust boundary as their prompt — and
  hand-splitting a shell command is how quoting bugs are born. Detached, because the shell's
  *grandchild* is what actually holds the tunnel and it survives `child.kill()`; we kill the
  process group with `process.kill(-pid, 'SIGTERM')`.

### Changed: `src/config.js`

`resolve()` gains `tunnel`, `tunnelArgs`, `tunnelCmd`, `tunnelTtlMs`, `assumeYes`, and takes
`tty` (default `process.stdout.isTTY`) so every refusal stays in `validate()` rather than
leaking into the CLI. New refusals, each exiting before the socket binds:

| Condition | Rationale |
|---|---|
| `--tunnel` with `--no-token` | Publishing source code to the internet with no credential at all. The one combination that must never be reachable by typo. |
| `--tunnel <unknown>` | A silent fallback to a default provider would publish through something the operator did not choose. |
| `--tunnel` together with `--tunnel-cmd` | Ambiguous. Refuse rather than pick. |
| `--tunnel-args` without `--tunnel` | Silently ignored arguments look like they took effect. It is refused with `--tunnel-cmd` too: that string already carries its own arguments, and two places to put them is one too many. |
| `--tunnel-ttl` not `<n>s\|m\|h` | A bare `30` is 30 of what? Ambiguity in a safety timer is worse than a refusal. |
| A tunnel requested on a non-TTY without `--yes` | A unit file, a CI job, or a background `&` can never start publishing without someone having written the word down. |

Note there is no refusal for `--tunnel` on a non-loopback bind or with a token from the
environment — both are legitimate, and both already carry a token by the rules above.

### Changed: `src/server.js`

1. `setTunnel(t | null)` on the server object: sets the slot, broadcasts a `tunnel` event,
   and is the single place the SPA and health read from.
2. `hostAllowed` / `originAllowed` consult the slot in addition to the Set.
3. `Secure` becomes the per-request predicate described above; the `secureCookie` constructor
   option stays, now meaning "`publicHost` is https" rather than "always."
4. `/api/health` gains `tunnel: {provider, since} | null`.
5. `/api/state` and the SSE `snapshot` frame gain `tunnel`. The store is not involved — it is
   about sessions, and a tunnel is not one. A small `snapshot()` helper inside `createServer`
   merges them.

### Changed: `bin/cctv.js`

The startup sequence, the banner, and **two pre-existing `parseArgs` bugs** that this feature
would otherwise walk straight into (`bin/cctv.js:37-40`):

- `a.slice(2).split('=')` destructures `[k, v]`, so `--tunnel-args=--log=stdout` silently
  becomes `--log`, discarding everything after the second `=`. Fix: split on the first `=`
  only, with `indexOf`.
- A value that begins with `-` is refused by the `!argv[i+1].startsWith('-')` guard, so
  `--tunnel-args '--region us'` loses its value and `--region` becomes a flag of its own. Fix:
  a `VALUE_FLAGS` set — the mirror of the existing `BOOLEAN_FLAGS` — whose members always
  consume the next token. Flags left without a value still hit the existing "requires a value"
  check.
- `yes` joins `BOOLEAN_FLAGS`, for exactly the reason its comment already gives.

### Changed: `public/`

One badge, in the region that already exists for machine state. `.bar-status` holds the clock
and the link indicator; the badge goes beside them, `hidden` unless a tunnel is up.

This is a deliberate refusal to add a header *region*. The header sheds by region in tiers
(`CLAUDE.md`, `public/styles.css:824+`), so a seventh region would mean a new shed tier, a new
hairline in the `::before` list, and a header-markup test update — to display something that is
absent in the normal case. Inside `.bar-status` it inherits the region's `flex-shrink: 0` and
its existing divider, and the hostname text uses the established `.clips` class so it drops to
an icon at narrow widths like every other label in the bar.

The badge is a `<div>`, not a `<button>` — it is a statement, not a control — so the
icon-only-button rule in `test/header-markup.test.js` does not apply, and the hostname is set
with `textContent` like everything else the SPA renders.

### New: `deploy/` + `README.md`

- `agent-cctv-tunnel.service.example` — the permanent shape: a named cloudflared tunnel under
  systemd, `--yes` visible in `ExecStart` (which is the point of requiring it), a stable
  `AGENT_CCTV_TOKEN`, and a note that Cloudflare Access in front is what turns a shared token
  into per-person auth.
- README: a "Putting it on the internet" section under the existing team section, carrying the
  trust-model paragraph verbatim, the two shapes (ten minutes / for good), and the warnings
  below.

## CLI surface

```
--tunnel <cloudflare|ngrok>   Publish through an installed tunnel binary
--tunnel-cmd '<command>'      Publish through any command that opens a tunnel
--tunnel-args '<args>'        Passed through to the provider binary verbatim (with --tunnel)
--tunnel-ttl <30m>            Close the tunnel after this long; the wall keeps running
--yes                         Skip the confirmation (required on a non-TTY)

AGENT_CCTV_TUNNEL             Same as --tunnel
AGENT_CCTV_TUNNEL_ARGS        Same as --tunnel-args
```

## Startup sequence

1. Resolve and validate config. Every refusal above exits here, before anything binds.
2. If a tunnel is requested and stdout is a TTY, print what is about to become public and read
   a line. Anything but `yes` exits 0 with "nothing was published." `--yes` skips this; a
   non-TTY without `--yes` was already refused in step 1.
3. Bind the server as it does today.
4. Spawn the tunnel against the actual bound port, targeting `127.0.0.1` (or the bound host
   when it is a specific interface — `0.0.0.0` and `::` mean loopback works).
5. Take the hostname from `--public-url` if set; otherwise wait up to 30 s for the child to
   print one.
6. `setTunnel(...)`. The host is now allowed, the SPA's chip lights up, health reports it.
7. Print the banner: the public URL **without** the token on its own line, then the tokened
   link once, marked as something to send to one person rather than a channel.
8. Open a browser on the *local* URL as today. The public link is for someone else's device.

## Failure behaviour

| When | What happens |
|---|---|
| Binary not on `PATH` | Exit non-zero before publishing anything, naming the binary and its install command. |
| Child exits during startup, or 30 s passes with no URL | Kill the child, exit non-zero, print the last 40 lines the child produced. The operator asked to publish and it did not happen; a supervisor should see a failure. |
| Child exits after the URL was published | Print loudly, `setTunnel(null)`, keep serving loopback. There is a working wall and possibly someone watching it; killing it helps nobody. |
| `--tunnel-ttl` elapses | Same as above, minus the alarm: stop the child, clear the slot, print that the link is now dead. |
| ctrl-c / SIGTERM | Stop the child (process group for `--tunnel-cmd`), then the existing shutdown path. |

## Testing

New `test/tunnel.test.js`, plus additions to three existing files.

- `parseTtl` accepts `45s`, `30m`, `2h`; rejects `30`, `soon`, `-5m`.
- Each provider's argv is built with the right port, the forced logging flags, and
  pass-through args in a position that cannot shadow ours.
- `scrapeUrl` finds the URL in a real cloudflared banner fixture and a real ngrok JSON log
  line, and returns null for an unrelated line mentioning `https://`.
- A `Tunnel` over `--tunnel-cmd` driven by `node -e "console.log('https://x.example'); …"`:
  emits `url`, and `stop()` actually kills the process group (asserted by the child being gone,
  not by the promise resolving).
- ENOENT on a missing binary produces the install message rather than an unhandled `'error'`.
- A child that prints no URL fails at the timeout with its output in the message. The test
  overrides the 30 s timeout rather than waiting for it.
- `test/server.test.js`: `setTunnel` makes the tunnel `Host` allowed and `setTunnel(null)`
  makes it 403 again; the `Secure` attribute is present for a request carrying the tunnel host
  and absent for the same request carrying `localhost`; `/api/health` reports `provider` and
  `since` and **no `url`**; `/api/state` carries `tunnel`. These use raw `node:http` — `fetch`
  rewrites `Host` and would make the test meaningless (`CLAUDE.md`).
- `test/config.test.js`: one case per refusal in the table above, including the non-TTY case
  through the `tty` parameter.
- `test/cli.test.js`: `--tunnel-args=--log=stdout` keeps its whole value; `--tunnel-args
  '--region us'` keeps a value that begins with a dash; `--yes` is a boolean flag that does not
  eat the subcommand.

No test spawns `cloudflared` or `ngrok`. The provider records are data, and the process
machinery is exercised through `--tunnel-cmd` with `node` as the child.

## Risks and known limitations

- **Scraped output is not an API.** Mitigated structurally (`--public-url` on every path, loud
  30 s failure with the child's output) rather than by promising to track provider releases.
- **A quick-tunnel link is a bearer credential in a URL.** It survives screenshots and
  channels. The banner says so; nothing enforces it. This is the residual risk of the feature
  and the reason for the typed confirmation.
- **ngrok free tier shows a click-through interstitial** on first visit. The tokened link
  survives the click, but a recipient may report the link as broken. The banner warns.
- **ngrok v3 refuses to start without a configured authtoken**, even on the free tier. That
  surfaces as an early child exit; its stderr is printed rather than swallowed.
- **`--tunnel-ttl` is not a session timeout.** It closes the tunnel; a browser that already
  loaded the wall keeps its cookie and its SSE stream until the tunnel actually drops the
  connection. Anyone with the token can reconnect if a *new* tunnel is opened later.
- **`/api/health` tells an unauthenticated caller that a tunnel exists.** Through the tunnel,
  that caller already knew. Locally, any process could already read `~/.agent-cctv/config.json`.
  The URL is withheld anyway.
- **Cloudflare quick tunnels are rate-limited and best-effort** by Cloudflare's own
  documentation. They are not a production hosting mechanism, and the README says so where it
  describes the permanent shape.
- **A `--tunnel-cmd` whose tunnel is opened by a grandchild that ignores SIGTERM** will still
  orphan. The fail-closed allowlist property above is the backstop, not a claim that this
  cannot happen.
