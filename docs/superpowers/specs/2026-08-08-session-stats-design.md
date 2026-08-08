# Cost and usage stats in the details drawer

## What and why

The drawer already shows two usage rows — live context and summed output —
because that is all any source bothered to keep. But every agent on the wall
writes down more than that: the full billed-token splits (uncached input,
cache reads, cache writes) are sitting in the same transcripts and databases
we already read. This feature surfaces them and adds the small
derived numbers that make a session legible at a glance: what it cost, how
fast it is burning, how well its cache is working, how long it has run.

Cost is **reported, never computed**. OpenCode writes a `cost` column and
Hermes writes `estimated_cost_usd` / `actual_cost_usd`; those numbers are the
agent's own accounting and we repeat them. Claude Code, Codex and Gemini
write no dollar figure anywhere in their logs (verified against real
transcripts on this machine), so their tiles get no cost row — a wall that
priced them from its own lookup table would go stale the day a vendor moved
a price, and would print fiction for every subscription session where the
marginal dollar cost is zero. Missing information, not missing wiring.

Everything lands in the existing pipe. Sources sum, the store and server pass
`usage` through untouched exactly as they do today.

## The usage object grows

Each source's `usage` patch gains cumulative fields beside the existing ones:

```js
usage: {
  context, contextWindow,      // unchanged: the live context, not a sum
  output, outputPartial,       // unchanged: summed output
  input: null,                 // cumulative uncached billed input tokens
  cacheRead: null,             // cumulative cache-read tokens
  cacheWrite: null,            // cumulative cache-write tokens
  cost: null,                  // dollars the agent itself recorded
  costEstimated: false,        // the agent called its own figure an estimate
}
```

`null` means "this agent does not record that", and the drawer omits the row —
the same rule `context: null` follows for Hermes today.

`outputPartial` widens in meaning rather than gaining a sibling: for any given
source, every cumulative sum is partial together or exact together (they share
one `fromStart`), so one flag governs them all. The name stays; renaming it
across five adapters buys nothing.

## Per source

- **Claude Code** (`collectUsage`): sum each request's `input_tokens`,
  `cache_read_input_tokens`, `cache_creation_input_tokens`. **Sidechains
  count toward the sums.** Today `collectUsage` skips them entirely, which is
  right for context (a subagent's context is its own) and wrong for totals (a
  subagent's requests are the same session's work). Sidechain entries add to
  the cumulative sums and never touch `context`.
- **Codex**: `total_token_usage` is already a running total. Uncached input is
  `input_tokens - cached_input_tokens`, `cacheRead` is the cached portion,
  `cacheWrite` stays null — OpenAI does not bill cache writes. Exact regardless
  of where we joined the rollout, same as output today.
- **Gemini**: same per-message-id dedup the output sum uses. Uncached input is
  `input - cached` per message; both sum. Partial when joined mid-file.
- **OpenCode**: the session row carries `tokens_input`, `tokens_cache_read`,
  `tokens_cache_write`, and a `cost` column OpenCode computes itself. All
  four join `SESSION_COLS` and `patchFromRow`; `cost` passes through as the
  agent's own figure.
- **Hermes**: `input_tokens`, `cache_read_tokens`, `cache_write_tokens`, and
  the cost pair — `actual_cost_usd` when non-zero, else `estimated_cost_usd`
  with `costEstimated: true`, honouring Hermes's own actual-vs-estimated
  distinction. Cumulative and exact, like the output columns today.

Both sqlite adapters get the new columns through a schema probe, not a hope:
`presentColumns(db, table, wanted)` in `sqlite-poll.js` reads
`PRAGMA table_info` once per open and the query selects only columns that
exist — required columns stay in `SESSION_COLS`, the new ones live in an
`OPTIONAL_COLS` list, and `patchFromRow` reads them with `?? null`. An older
OpenCode or Hermes schema degrades to fewer stats; it must never become a
poll that throws every two seconds — the retry-not-crash rule already paid
for this lesson. `src/history.js` builds its queries from the same lists, so
the archive degrades the same way.

Known limit, stated rather than papered over: OpenCode and Hermes subagent
sessions are filtered at the query, so their tokens stay on child rows the
wall never reads. A parent tile's cost there is the parent's alone. Claude is
the only source whose sums include subagent work, because it is the only one
that writes subagent requests into the parent's transcript.

## Drawer rows

Added to `renderInspectorMeta`, each omitted when its inputs are missing, like
every existing row. The derivations live as pure functions in
`public/format.js`, DOM-free and tested directly:

- `cost` — `$4.12`, or `$4.12 est.` when the agent itself called the figure
  an estimate. Only ever agent-reported; no row for agents that record none.
- `tokens` — `1.2M in · 58M cache read · 3.4M cache write · 89k out`, compact
  notation from `tokens()`, segments omitted when null, `(since watching)`
  appended when the sums are partial.
- `cache` — `96% read from cache`, computed as
  `cacheRead / (input + cacheRead)`. Omitted when either side is unknown.
- `burn` — `$1.80/hr` over wall-clock from `startedAt` to now (or `endedAt`
  for an archived session) when the agent reports cost; otherwise
  `~2.1k out tok/min` from the output sum. Omitted when the sums are
  partial — a rate built on a partial sum is precise-looking and wrong.
- `age` — `2h 14m`, started → last activity. Distinct from the status row's
  duration, which times the current state, not the session.
- `work` gains `· ~1.3k out/turn` when output and turns are both known.

All numbers land via `textContent`; the spa-guard suite keeps it that way.

## Testing

- Adapter sums in `agents.test.js` / `unit.test.js`: Claude sidechain
  inclusion (sums move, context does not), Codex uncached arithmetic, Gemini
  per-id dedup, OpenCode/Hermes new columns and cost pass-through, and the
  schema probe against a fixture db missing the optional columns.
- Drawer row derivations (cost line, token breakdown, cache %, burn, age,
  out/turn) as pure functions in `format.js` with direct tests;
  `renderInspectorMeta` stays thin.

The README's description of the drawer changes in the same commit that changes
the drawer.
