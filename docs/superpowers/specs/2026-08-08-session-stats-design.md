# Cost and usage stats in the details drawer

## What and why

The drawer already shows two usage rows — live context and summed output —
because that is all any source bothered to keep. But every agent on the wall
writes down more than that: the full billed-token splits (uncached input,
cache reads, cache writes) are sitting in the same transcripts and databases
we already read. This feature surfaces them, prices them, and adds the small
derived numbers that make a session legible at a glance: what it cost, how
fast it is burning, how well its cache is working, how long it has run.

Everything lands in the existing pipe. Sources sum, the store and server pass
`usage` through untouched exactly as they do today, and the browser turns
tokens into dollars at render time. No new endpoint, no server-side pricing —
a dollar figure computed at the edge is visibly an estimate; one stamped into
an API response starts to look like accounting.

## The usage object grows

Each source's `usage` patch gains cumulative fields beside the existing ones:

```js
usage: {
  context, contextWindow,      // unchanged: the live context, not a sum
  output, outputPartial,       // unchanged: summed output
  input: null,                 // cumulative uncached billed input tokens
  cacheRead: null,             // cumulative cache-read tokens
  cacheWrite: null,            // cumulative cache-write tokens
  cacheWrite1h: 0,             // the 1h-TTL portion of cacheWrite (Claude only)
  cost: null,                  // dollars the agent itself recorded (OpenCode only)
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
  `cache_read_input_tokens`, `cache_creation_input_tokens` — and keep the
  `cache_creation.ephemeral_1h_input_tokens` portion separately, because 1h
  cache writes bill at 2× base where 5m writes bill at 1.25×. **Sidechains
  count toward the sums.** Today `collectUsage` skips them entirely, which is
  right for context (a subagent's context is its own) and wrong for money (a
  subagent's requests are billed to the same wallet). Sidechain entries add to
  the cumulative sums and never touch `context`.
- **Codex**: `total_token_usage` is already a running total. Uncached input is
  `input_tokens - cached_input_tokens`, `cacheRead` is the cached portion,
  `cacheWrite` stays null — OpenAI does not bill cache writes. Exact regardless
  of where we joined the rollout, same as output today.
- **Gemini**: same per-message-id dedup the output sum uses. Uncached input is
  `input - cached` per message; both sum. Partial when joined mid-file.
- **OpenCode**: the session row carries `tokens_input`, `tokens_cache_read`,
  `tokens_cache_write`, and — alone on the wall — a `cost` column OpenCode
  computes itself. All four join `SESSION_COLS` and `patchFromRow`. Its own
  cost wins over our estimate: the agent's own accounting beats a lookup table.
- **Hermes**: `input_tokens`, `cache_read_tokens`, `cache_write_tokens` join
  `SESSION_COLS`. Cumulative and exact, like the output columns today.

Both sqlite adapters get the new columns through a schema probe, not a hope:
on open, `PRAGMA table_info` decides which of the wanted columns exist, and
the query selects only those. An older OpenCode or Hermes schema degrades to
fewer stats; it must never become a poll that throws every two seconds — the
retry-not-crash rule already paid for this lesson.

Known limit, stated rather than papered over: OpenCode and Hermes subagent
sessions are filtered at the query, so their tokens stay on child rows the
wall never reads. A parent tile's cost there is the parent's alone. Claude is
the only source whose sums include subagent work, because it is the only one
that writes subagent requests into the parent's transcript.

## Pricing (`public/pricing.js`)

A hand-maintained table, zero dependencies, works offline:

- Rates in dollars per million tokens: `input`, `cacheRead`, `cacheWrite5m`,
  `cacheWrite1h`, `output`. Keyed by model-id prefix; longest matching prefix
  wins, so `claude-sonnet-4-5-20250929` finds `claude-sonnet-4-5`.
- A `PRICES_AS_OF` date ships in the file and the drawer's cost row carries
  "est." — the two honesty markers for a table that goes stale by design.
  Current list prices get verified against vendor pages at implementation
  time, not recalled from memory.
- `estimateCost(model, usage)` returns dollars or `null`. Unknown model, or a
  usage object with no billed sums, means no cost row — never a guess.
- Lives in `public/` because only the browser reads it. If `cctv status` ever
  wants cost, it imports from `public/` the way `src/views.js` imports
  `match.js` — but that is not this feature.

## Drawer rows

Added to `renderInspectorMeta`, each omitted when its inputs are missing, like
every existing row:

- `cost` — `$4.12 est.`; OpenCode's own figure drops the "est.". Partial sums
  append `(since watching)`, the same phrase the output row already uses.
- `tokens` — `1.2M in · 58M cache read · 3.4M cache write · 89k out`, compact
  notation from `format.js`.
- `cache` — `96% of input read from cache`, computed as
  `cacheRead / (input + cacheRead)`. Omitted when either side is unknown.
- `burn` — `$1.80/hr` over wall-clock from `startedAt` to now (or `endedAt`
  for an archived session). Omitted when cost is unknown **or sums are
  partial** — a rate built on a partial sum is precise-looking and wrong.
- `age` — `2h 14m`, started → last activity. Distinct from the status row's
  duration, which times the current state, not the session.
- `work` gains `· ~1.3k out/turn` when output and turns are both known.

All numbers land via `textContent`; the spa-guard suite keeps it that way.

## Testing

- Adapter sums in `agents.test.js` / `unit.test.js`: Claude sidechain
  inclusion (sums move, context does not), the 5m/1h cache-write split, Codex
  uncached arithmetic, Gemini per-id dedup, OpenCode/Hermes new columns, and
  the schema probe against a fixture db missing them.
- `pricing.js` is DOM-free, tested like `format.js` and `match.js`: longest-
  prefix matching, unknown model → null, the 1h cache-write surcharge, the
  OpenCode own-cost precedence.
- Drawer row formatting (cache %, burn, age, out/turn) as pure functions with
  direct tests; `renderInspectorMeta` stays thin.

The README's description of the drawer changes in the same commit that changes
the drawer.
