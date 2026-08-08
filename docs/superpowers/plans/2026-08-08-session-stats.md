# Session Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The details drawer shows agent-reported cost, the full billed-token breakdown, cache hit rate, burn rate, session age and output-per-turn — for every source that records the underlying facts.

**Architecture:** Sources extend the `usage` object they already emit with cumulative billed-token sums and agent-reported cost; the store and server pass it through untouched; pure helpers in `public/format.js` derive the drawer rows. Cost is never computed by us — OpenCode and Hermes report their own dollars, the other three agents record none and get no cost row.

**Tech Stack:** Node ≥18.2 ESM, `node --test`, `node:sqlite` (lazy, Node ≥22.13), zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-08-session-stats-design.md`

## Global Constraints

- Zero runtime dependencies. No new packages, ever.
- Pure observer: nothing writes to any agent's directory.
- `public/*.js` is served to the browser as written — no build step, no TypeScript.
- Browser DOM writes are `textContent` only; `test/spa-guard.test.js` enforces it.
- Every test file that touches `src/` must import `./helpers/env.js` **first** (ESM evaluates imports in source order; `src/paths.js` reads env at module load). All files being edited already do this.
- Comments explain *why* and what breaks without them, never restate the code.
- Commits: `feat:` / `fix:` / `docs:` with lowercase subject and a reasoning body.
- Work happens on branch `feat/session-stats`, merged into `main` at the end with a summarizing merge commit.
- The extended `usage` shape (produced by Tasks 1–6, consumed by Tasks 7–8):

```js
{
  context: number|null,        // live context, read not summed (unchanged)
  contextWindow: number|null,  // unchanged
  output: number,              // summed output incl. reasoning (unchanged)
  outputPartial: boolean,      // now governs EVERY cumulative sum, not just output
  input: number|null,          // cumulative UNCACHED billed input tokens
  cacheRead: number|null,      // cumulative cache-read tokens
  cacheWrite: number|null,     // cumulative cache-write tokens (null = agent has no such number)
  cost: number|null,           // dollars the agent itself recorded, null otherwise
  costEstimated: boolean,      // the agent called its own figure an estimate (Hermes)
}
```

`null` always means "this agent does not record that" and the drawer omits the row.

---

### Task 0: Branch

- [ ] **Step 1: Create the working branch**

```bash
git checkout -b feat/session-stats
```

No commit; this is setup for every task below.

---

### Task 1: Claude Code — cumulative sums, sidechains included

**Files:**
- Modify: `src/sources/claude-code/transcript.js` (`initState` ~line 37, `collectUsage` ~line 76)
- Test: `test/unit.test.js` (token accounting section, ~line 472)

**Interfaces:**
- Produces: `meta.usage` in the Global Constraints shape. `input`/`cacheRead`/`cacheWrite` are sums over **all** requests including sidechains; `context` still comes only from the newest **main-chain** request; `cost` stays `null` (Claude Code records no dollar figure — verified against real transcripts).

- [ ] **Step 1: Update the two existing tests and add assertions for the new sums**

In `test/unit.test.js`, the test `'context is read from the newest request, never summed across them'` gains four assertions after the existing ones (fixture: a1 has input 3 / cacheRead 100 000 / cacheWrite 500 / out 200; a2 has input 2 / cacheRead 150 000 / cacheWrite 800 / out 300):

```js
  assert.equal(usage.input, 5, 'billed input IS summed — every request pays its uncached tokens');
  assert.equal(usage.cacheRead, 250_000);
  assert.equal(usage.cacheWrite, 1_300);
  assert.equal(usage.cost, null, 'claude code writes no dollar figure, so neither do we');
```

The test `'a subagent request never overwrites the main context number'` changes meaning for output: sidechain work is the session's work. Replace its last assertion and extend:

```js
  assert.equal(usage.context, 190_002);
  assert.equal(usage.output, 150, "the subagent's output is still this session's spend");
  assert.equal(usage.input, 3, 'sidechain input counts toward the billed sums');
  assert.equal(usage.cacheRead, 194_000);
```

- [ ] **Step 2: Run to verify the new assertions fail**

Run: `node --test test/unit.test.js`
Expected: FAIL — `usage.input` is `undefined`, and output is `100` not `150`.

- [ ] **Step 3: Implement**

In `src/sources/claude-code/transcript.js`, extend `initState()`:

```js
  initState() {
    return { tools: new Map(), outputSeen: 0, inputSeen: 0, cacheReadSeen: 0, cacheWriteSeen: 0, context: null };
  }
```

Replace `collectUsage` (keep the existing doc comment's first two paragraphs about context-vs-output arithmetic; replace the sidechain paragraph):

```js
/**
 * ... (existing context/output paragraphs stay) ...
 *
 * Subagents are counted in the sums and excluded from the context. A sidechain
 * request carries its own separate context — letting one land on `context`
 * would make a full session look like it had emptied — but its tokens are this
 * session's work all the same, and a total that quietly dropped subagent
 * requests would understate every session that delegated anything.
 */
function collectUsage(meta, entry, state) {
  const u = entry.message?.usage;
  if (!u) return;
  state.inputSeen += u.input_tokens || 0;
  state.cacheReadSeen += u.cache_read_input_tokens || 0;
  state.cacheWriteSeen += u.cache_creation_input_tokens || 0;
  state.outputSeen += u.output_tokens || 0;
  if (!entry.isSidechain) {
    state.context =
      (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  }
  meta.usage = {
    context: state.context,
    // Claude does not record the model's window anywhere in the transcript, so
    // there is no honest denominator to show a percentage against.
    contextWindow: null,
    output: state.outputSeen,
    outputPartial: !state.fromStart,
    input: state.inputSeen,
    cacheRead: state.cacheReadSeen,
    cacheWrite: state.cacheWriteSeen,
    cost: null,
    costEstimated: false,
  };
}
```

(The `state.outputSeen = (state.outputSeen || 0) + …` guard goes away — `initState` now owns the zeros.)

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/unit.test.js`
Expected: PASS, including the untouched `outputPartial` test and the history test `'the same token arithmetic as a live tile'` (context arithmetic unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/sources/claude-code/transcript.js test/unit.test.js
git commit -m "feat: claude source sums billed tokens, sidechains included"
```

Body: sums exist for the drawer's token breakdown; a sidechain's tokens are the session's spend even though its context is its own.

---

### Task 2: Codex — uncached input from its own totals

**Files:**
- Modify: `src/sources/codex/rollout.js` (~line 80, the `token_count` branch)
- Test: `test/unit.test.js` (`'codex context comes from its own convention, not claude arithmetic'`, ~line 530)

**Interfaces:**
- Produces: same `usage` shape. Exact regardless of join point (`outputPartial: false`), `cacheWrite: null` (Codex records no cache-write number), `cost: null`.

- [ ] **Step 1: Extend the codex test**

Fixture totals are `input_tokens: 1_237_468, cached_input_tokens: 1_165_568`. Add after the existing assertions:

```js
  assert.equal(usage.input, 71_900, 'uncached input is a subtraction — codex folds the cached part in');
  assert.equal(usage.cacheRead, 1_165_568);
  assert.equal(usage.cacheWrite, null, 'codex records no cache-write number, so neither do we');
  assert.equal(usage.cost, null);
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/unit.test.js`
Expected: FAIL — `usage.input` is `undefined`.

- [ ] **Step 3: Implement**

In `src/sources/codex/rollout.js`, the `meta.usage` assignment becomes (comment addition included):

```js
      const total = p.info?.total_token_usage;
      const last = p.info?.last_token_usage;
      if (total || last) {
        meta.usage = {
          context: last?.input_tokens ?? null,
          contextWindow: p.info?.model_context_window || null,
          output: total?.output_tokens ?? 0,
          outputPartial: false,
          // Same convention in the totals as in the live context: input_tokens
          // includes the cached portion, so uncached is a subtraction.
          input: total ? Math.max(0, (total.input_tokens || 0) - (total.cached_input_tokens || 0)) : null,
          cacheRead: total ? total.cached_input_tokens || 0 : null,
          cacheWrite: null,
          cost: null,
          costEstimated: false,
        };
      }
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/unit.test.js`
Expected: PASS, including the `'no last_token_usage yet'` test (~line 670) — it has a `total`, so `input` computes from it; its assertions on `output`/`context` are untouched.

- [ ] **Step 5: Commit**

```bash
git add src/sources/codex/rollout.js test/unit.test.js
git commit -m "feat: codex source reports its billed-token splits"
```

---

### Task 3: Gemini — per-message billed sums

**Files:**
- Modify: `src/sources/gemini/chats.js` (`initState` ~line 73, usage block ~line 114)
- Test: `test/agents.test.js` (`'gemini usage: latest input is the context, output sums once per message'`, ~line 120)

**Interfaces:**
- Produces: same `usage` shape. Gemini's `cached` is a subset of `input`; both sum once per message id (streaming re-appends the same id). `cacheWrite: null`, `cost: null`.

- [ ] **Step 1: Extend the gemini test**

The `gm()` fixture helper takes `(id, input, output)` with `cached: 0` hardcoded. Give it a cached parameter and use it on the second message:

```js
  const gm = (id, input, output, cached = 0) => ({
    id,
    timestamp: '2026-08-06T10:00:10Z',
    type: 'gemini',
    content: [{ text: 'ok' }],
    tokens: { input, output, cached, thoughts: 10, tool: 0, total: input + output },
    model: 'gemini-3.5-flash',
  });
  const root = writeChat([header, gm('g1', 1000, 50), gm('g1', 1000, 50), gm('g2', 2000, 70, 500)]);
```

Add after the existing assertions:

```js
  assert.equal(usage.input, 1000 + 1500, 'uncached input sums once per message id — cached is a subset of input');
  assert.equal(usage.cacheRead, 500);
  assert.equal(usage.cacheWrite, null, 'gemini records no cache-write number');
  assert.equal(usage.cost, null);
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/agents.test.js`
Expected: FAIL — `usage.input` is `undefined`.

- [ ] **Step 3: Implement**

In `src/sources/gemini/chats.js`, `initState()` gains two counters:

```js
      usageCounted: new Set(), // message ids whose tokens are already summed
      outputSeen: 0,
      inputSeen: 0,
      cacheReadSeen: 0,
```

The usage block becomes:

```js
      const t = msg.tokens;
      if (t && typeof t.input === 'number' && !state.usageCounted.has(msg.id)) {
        state.usageCounted.add(msg.id);
        state.outputSeen += (t.output || 0) + (t.thoughts || 0);
        // `cached` is the portion of `input` served from cache, so uncached is
        // a subtraction here where the Claude source gets them pre-split.
        state.inputSeen += Math.max(0, (t.input || 0) - (t.cached || 0));
        state.cacheReadSeen += t.cached || 0;
        meta.usage = {
          context: t.input,
          contextWindow: null,
          output: state.outputSeen,
          outputPartial: !state.fromStart,
          input: state.inputSeen,
          cacheRead: state.cacheReadSeen,
          cacheWrite: null,
          cost: null,
          costEstimated: false,
        };
      }
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/agents.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sources/gemini/chats.js test/agents.test.js
git commit -m "feat: gemini source sums billed tokens per message id"
```

---

### Task 4: `presentColumns` — the schema probe

**Files:**
- Modify: `src/sqlite-poll.js` (new export after `loadSqlite`)
- Test: `test/agents.test.js` (new test near the sqlite fixtures, after `openDb` ~line 168)

**Interfaces:**
- Produces: `presentColumns(db, table, wanted: string[]): string[]` — the subset of `wanted` that exists on `table`, in `wanted` order. Consumed by Tasks 5 and 6.

- [ ] **Step 1: Write the failing test**

In `test/agents.test.js`, import alongside the existing sqlite import (`loadSqlite` is already imported near the top; extend that import) and add:

```js
test('presentColumns reports what the schema actually has', { skip: !sqlite }, () => {
  const { db } = openDb('probe', 'CREATE TABLE t (a TEXT, b INTEGER);');
  assert.deepEqual(presentColumns(db, 't', ['b', 'zzz', 'a']), ['b', 'a']);
  assert.deepEqual(presentColumns(db, 't', ['nope']), []);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/agents.test.js`
Expected: FAIL — `presentColumns` is not exported.

- [ ] **Step 3: Implement**

In `src/sqlite-poll.js`:

```js
/**
 * Which of `wanted` actually exist on `table`. These schemas belong to other
 * teams and grow columns over time; selecting one an older install lacks
 * would turn every poll into a throw, and the retry path would spin on it
 * forever instead of recovering. Ask first — a missing column is a missing
 * stat, never a dead source.
 */
export function presentColumns(db, table, wanted) {
  const have = new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((r) => r.name));
  return wanted.filter((c) => have.has(c));
}
```

(`table` is always a literal from our own adapters, never input.)

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/agents.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sqlite-poll.js test/agents.test.js
git commit -m "feat: sqlite schema probe for columns that may not exist yet"
```

---

### Task 5: OpenCode — token columns and its own cost

**Files:**
- Modify: `src/sources/opencode/index.js` (`patchFromRow` ~line 44, `SESSION_COLS` ~line 66, `poll()` session query ~line 294)
- Modify: `src/history.js` (opencode `load()` query, ~line 97)
- Test: `test/agents.test.js` (opencode DDL ~line 170, fixture insert ~line 181, main test ~line 219; one new test)

**Interfaces:**
- Consumes: `presentColumns` from Task 4.
- Produces: `sessionCols(db): string` exported from the adapter — `SESSION_COLS` plus whichever of `OPTIONAL_COLS` exist. `patchFromRow` fills `input`/`cacheRead`/`cacheWrite`/`cost` from `tokens_input`, `tokens_cache_read`, `tokens_cache_write`, `cost` via `?? null`.

- [ ] **Step 1: Update fixtures and write the failing tests**

In `test/agents.test.js`, extend the opencode DDL's session table and the main insert:

```js
const OPENCODE_DDL = `
  CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT,
    model TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER,
    tokens_output INTEGER DEFAULT 0, tokens_reasoning INTEGER DEFAULT 0,
    tokens_input INTEGER DEFAULT 0, tokens_cache_read INTEGER DEFAULT 0,
    tokens_cache_write INTEGER DEFAULT 0, cost REAL DEFAULT 0);
  ...message/part tables unchanged...
`;
```

```js
  db.prepare('INSERT INTO session (id, directory, title, model, agent, time_created, time_updated, tokens_output, tokens_reasoning, tokens_input, tokens_cache_read, tokens_cache_write, cost) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('ses_1', '/home/u/proj', 'Fix the tests', 'kimi-k3', 'build', NOW - 60e3, NOW - 1000, 500, 20, 251_806, 900_000, 12_000, 1.84);
```

In the main opencode test, after the existing usage assertions:

```js
  assert.equal(main.patch.usage.input, 251_806, "opencode's input column is the uncached portion");
  assert.equal(main.patch.usage.cacheRead, 900_000);
  assert.equal(main.patch.usage.cacheWrite, 12_000);
  assert.equal(main.patch.usage.cost, 1.84, "opencode prices its own sessions; we repeat, never compute");
  assert.equal(main.patch.usage.costEstimated, false);
```

New test after it — the degradation case:

```js
test('opencode: a schema without the token columns is fewer stats, not a dead source', { skip: !sqlite }, () => {
  const { file, db } = openDb('opencode-old', `
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT,
      model TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER,
      tokens_output INTEGER DEFAULT 0, tokens_reasoning INTEGER DEFAULT 0);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
  `);
  db.prepare('INSERT INTO session (id, directory, time_created, time_updated, tokens_output) VALUES (?,?,?,?,?)')
    .run('ses_old', '/home/u/p', NOW - 60e3, NOW - 1000, 42);
  const updates = collectSqlite(new OpencodeSource({ dbPath: file }), db);
  const u = updates.find((x) => x.sessionId === 'ses_old').patch.usage;
  assert.equal(u.output, 42, 'what the old schema does record still flows');
  assert.equal(u.input, null, 'what it does not is null, never zero — zero would read as a fact');
  assert.equal(u.cost, null);
});
```

- [ ] **Step 2: Run to verify failures**

Run: `node --test test/agents.test.js`
Expected: FAIL — `usage.input` is `undefined` in the main test; the old-schema test throws or reports `undefined`.

- [ ] **Step 3: Implement**

In `src/sources/opencode/index.js` — import `presentColumns` alongside `SqlitePoller, loadSqlite`; extend `patchFromRow`'s usage:

```js
  patch.usage = {
    context,
    contextWindow: null,
    // OpenCode maintains this running total itself, so it is exact no matter
    // when we started reading.
    output: (row.tokens_output || 0) + (row.tokens_reasoning || 0),
    outputPartial: false,
    input: row.tokens_input ?? null,
    cacheRead: row.tokens_cache_read ?? null,
    cacheWrite: row.tokens_cache_write ?? null,
    // OpenCode prices its own sessions. Zero means "never priced" — a real
    // $0.00 row would read as a fact about a session that has no such fact.
    cost: row.cost > 0 ? row.cost : null,
    costEstimated: false,
  };
```

Below `SESSION_COLS`:

```js
/** Columns newer OpenCode schemas have and older ones may not — probed, not assumed. */
export const OPTIONAL_COLS = ['tokens_input', 'tokens_cache_read', 'tokens_cache_write', 'cost'];

export function sessionCols(db) {
  return [SESSION_COLS, ...presentColumns(db, 'session', OPTIONAL_COLS)].join(', ');
}
```

In `poll()`, the sessions query becomes:

```js
    const sessions = db
      .prepare(`SELECT ${sessionCols(db)} FROM session WHERE parent_id IS NULL AND time_updated >= ?`)
      .all(this.sessionCursor);
```

In `src/history.js`, the opencode `load()` query:

```js
        .prepare(`SELECT ${opencode.sessionCols(db)} FROM session WHERE parent_id IS NULL AND id = ?`)
```

(The opencode `list()` query names its columns explicitly and needs none of the optional ones — leave it.)

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/agents.test.js && node --test test/unit.test.js`
Expected: PASS — including the existing archive test `'the same token arithmetic as a live tile'` (~agents.test.js:397), which now flows through `sessionCols`.

- [ ] **Step 5: Commit**

```bash
git add src/sources/opencode/index.js src/history.js test/agents.test.js
git commit -m "feat: opencode reports its token splits and its own cost"
```

Body: cost is repeated from the agent's own accounting, never computed here; the schema probe keeps an older opencode.db a degraded source instead of a dead one.

---

### Task 6: Hermes — token columns and the actual/estimated cost pair

**Files:**
- Modify: `src/sources/hermes/index.js` (`patchFromRow` ~line 43, `SESSION_COLS` ~line 65, `poll()` sessions query ~line 210)
- Modify: `src/history.js` (hermes `load()` query ~line 141; leave `list()` on `SESSION_COLS`)
- Test: `test/agents.test.js` (hermes DDL ~line 279, inserts ~line 290, main test ~line 310; one new cost-pair test)

**Interfaces:**
- Consumes: `presentColumns` from Task 4.
- Produces: `sessionCols(db)` export, same pattern as Task 5 but `table = 'sessions'`. Cost precedence: `actual_cost_usd` when > 0, else `estimated_cost_usd` with `costEstimated: true`, else `null`.

- [ ] **Step 1: Update fixtures and write the failing tests**

Extend the hermes DDL's sessions table with `input_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0, estimated_cost_usd REAL DEFAULT 0, actual_cost_usd REAL DEFAULT 0` and give the main fixture row `input_tokens 10_900, cache_read_tokens 13_824, cache_write_tokens 0, estimated_cost_usd 0.42, actual_cost_usd 0`.

Main test additions:

```js
  assert.equal(main.patch.usage.input, 10_900, 'hermes input is the uncached portion — real rows show cache reads exceeding it');
  assert.equal(main.patch.usage.cacheRead, 13_824);
  assert.equal(main.patch.usage.cacheWrite, 0);
  assert.equal(main.patch.usage.cost, 0.42, 'no actual figure, so the estimate — hermes says which is which');
  assert.equal(main.patch.usage.costEstimated, true);
```

New test for the precedence (uses `patchFromRow` directly — no db needed):

```js
test('hermes cost: the measured figure beats the estimate, and zero is no figure at all', () => {
  const row = { id: 'x', output_tokens: 10, reasoning_tokens: 0 };
  assert.equal(hermesPatch({ ...row, actual_cost_usd: 1.5, estimated_cost_usd: 0.4 }).usage.cost, 1.5);
  assert.equal(hermesPatch({ ...row, actual_cost_usd: 1.5, estimated_cost_usd: 0.4 }).usage.costEstimated, false);
  assert.equal(hermesPatch({ ...row, estimated_cost_usd: 0.4 }).usage.cost, 0.4);
  assert.equal(hermesPatch({ ...row, estimated_cost_usd: 0.4 }).usage.costEstimated, true);
  assert.equal(hermesPatch(row).usage.cost, null, 'zero cost columns mean "not priced", not free');
});
```

(`hermesPatch` = the test file's import alias for `hermes.patchFromRow`; match however the file already imports hermes exports, e.g. `patchFromRow as hermesPatch`.)

- [ ] **Step 2: Run to verify failures**

Run: `node --test test/agents.test.js`
Expected: FAIL — new fields `undefined`.

- [ ] **Step 3: Implement**

In `src/sources/hermes/index.js` — import `presentColumns`; `patchFromRow` usage becomes:

```js
  const actual = row.actual_cost_usd || 0;
  const estimated = row.estimated_cost_usd || 0;
  patch.usage = {
    // Hermes records cumulative input, which is not a context size, and
    // inventing one from it would be confidently wrong.
    context: null,
    contextWindow: null,
    output: (row.output_tokens || 0) + (row.reasoning_tokens || 0),
    outputPartial: false,
    // The uncached portion: real rows show cache reads exceeding input_tokens,
    // which an inclusive count could never do.
    input: row.input_tokens ?? null,
    cacheRead: row.cache_read_tokens ?? null,
    cacheWrite: row.cache_write_tokens ?? null,
    // Hermes keeps a measured figure and an estimate and says which is which;
    // repeat its distinction rather than flattening it.
    cost: actual > 0 ? actual : estimated > 0 ? estimated : null,
    costEstimated: !(actual > 0),
  };
```

Below `SESSION_COLS`:

```js
/** Columns newer Hermes schemas have and older ones may not — probed, not assumed. */
export const OPTIONAL_COLS = ['input_tokens', 'cache_read_tokens', 'cache_write_tokens', 'estimated_cost_usd', 'actual_cost_usd'];

export function sessionCols(db) {
  return [SESSION_COLS, ...presentColumns(db, 'sessions', OPTIONAL_COLS)].join(', ');
}
```

`poll()` sessions query and `src/history.js` hermes `load()` swap `${SESSION_COLS}` → `${sessionCols(db)}` / `${hermes.sessionCols(db)}`. The history `list()` keeps `SESSION_COLS` — it reads none of the optional columns.

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/agents.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sources/hermes/index.js src/history.js test/agents.test.js
git commit -m "feat: hermes reports its token splits and its own cost pair"
```

---

### Task 7: The drawer's derivations — pure functions in `format.js`

**Files:**
- Modify: `public/format.js`
- Test: `test/modes.test.js` (the `── the extracted formatters ──` section, ~line 253)

**Interfaces:**
- Consumes: the `usage` shape from Global Constraints.
- Produces (all return `''` when they have nothing honest to say — the drawer filters falsy):
  - `money(usd: number|null): string` — `'$1.84'`, `'<$0.01'`, `''`
  - `costLine(u): string` — `'$1.84'` / `'$0.42 est.'`
  - `tokenBreakdown(u): string` — `'71.9k in · 1.2M cache read · 89k out (since watching)'`
  - `cacheHitRate(u): string` — `'94% read from cache'`
  - `burnRate(u, startedAt, endedAt, now?): string` — `'$1.80/hr'` or `'~2.1k out tok/min'`
  - `span(ms: number|null): string` — `'<1m'`, `'34m'`, `'2h 14m'`, `'3d 7h'`
  - `outPerTurn(u, turns): string` — `'~2k out/turn'` (tokens() rounds to whole k below 1M)

- [ ] **Step 1: Write the failing tests**

Append to the formatters section of `test/modes.test.js` (extend the existing `format.js` import with the new names):

```js
test('money reads like a bill, and stays quiet about nothing', () => {
  assert.equal(money(1.8425178), '$1.84');
  assert.equal(money(12), '$12.00');
  assert.equal(money(0.003), '<$0.01');
  assert.equal(money(0), '');
  assert.equal(money(null), '');
});

test('costLine repeats the agent figure and keeps its own est. label', () => {
  assert.equal(costLine({ cost: 1.84, costEstimated: false }), '$1.84');
  assert.equal(costLine({ cost: 0.42, costEstimated: true }), '$0.42 est.');
  assert.equal(costLine({ cost: null }), '');
  assert.equal(costLine(null), '');
});

test('tokenBreakdown shows only what the agent recorded, and owns up to partial sums', () => {
  assert.equal(
    tokenBreakdown({ input: 71_900, cacheRead: 1_165_568, cacheWrite: null, output: 6_947, outputPartial: false }),
    '72k in · 1.2M cache read · 7k out'
  );
  assert.equal(
    tokenBreakdown({ input: 5, cacheRead: 250_000, cacheWrite: 1_300, output: 500, outputPartial: true }),
    '5 in · 250k cache read · 1k cache write · 500 out (since watching)'
  );
  assert.equal(tokenBreakdown({ output: 340, outputPartial: false, input: null, cacheRead: null, cacheWrite: null }), '340 out');
  assert.equal(tokenBreakdown(null), '');
});

test('cacheHitRate needs both sides of the fraction', () => {
  assert.equal(cacheHitRate({ input: 10_900, cacheRead: 13_824 }), '56% read from cache');
  assert.equal(cacheHitRate({ input: 100, cacheRead: 0 }), '0% read from cache');
  assert.equal(cacheHitRate({ input: null, cacheRead: 500 }), '');
  assert.equal(cacheHitRate({ input: 0, cacheRead: 0 }), '');
});

test('burnRate: dollars when the agent priced itself, pace otherwise, silence when too young or partial', () => {
  const HR = 3_600_000;
  const now = Date.now();
  assert.equal(burnRate({ cost: 3.6, output: 0, outputPartial: false }, now - 2 * HR, null, now), '$1.80/hr');
  assert.equal(burnRate({ cost: null, output: 120_000, outputPartial: false }, now - HR, null, now), '~2k out tok/min');
  assert.equal(burnRate({ cost: 3.6, output: 0, outputPartial: true }, now - 2 * HR, null, now), '', 'a rate built on a partial sum is precise-looking and wrong');
  assert.equal(burnRate({ cost: 3.6, output: 0, outputPartial: false }, now - 60_000, null, now), '', 'a minute-old session has no meaningful rate');
  assert.equal(burnRate({ cost: 9, output: 0, outputPartial: false }, now - 3 * HR, now - HR, now), '$4.50/hr', 'an archived session rates over its own life, not until now');
});

test('span is the session age, days included', () => {
  assert.equal(span(30_000), '<1m');
  assert.equal(span(34 * 60_000), '34m');
  assert.equal(span((2 * 60 + 14) * 60_000), '2h 14m');
  assert.equal(span((3 * 24 + 7) * 3_600_000), '3d 7h');
  assert.equal(span(null), '');
});

test('outPerTurn averages output over turns', () => {
  assert.equal(outPerTurn({ output: 26_000 }, 13), '~2k out/turn');
  assert.equal(outPerTurn({ output: 500 }, 0), '');
  assert.equal(outPerTurn(null, 5), '');
});
```

- [ ] **Step 2: Run to verify failures**

Run: `node --test test/modes.test.js`
Expected: FAIL — none of the new names are exported.

- [ ] **Step 3: Implement in `public/format.js`**

```js
/** Dollar figures the drawer repeats from an agent's own accounting. */
export function money(usd) {
  if (!(usd > 0)) return '';
  return usd < 0.005 ? '<$0.01' : '$' + usd.toFixed(2);
}

export function costLine(u) {
  if (!u) return '';
  const m = money(u.cost);
  return m && u.costEstimated ? m + ' est.' : m;
}

/**
 * The billed-token splits, only the parts this agent actually records — a null
 * is "not written down", and printing 0 for it would read as a fact.
 */
export function tokenBreakdown(u) {
  if (!u) return '';
  const parts = [];
  if (u.input != null) parts.push(tokens(u.input) + ' in');
  if (u.cacheRead != null) parts.push(tokens(u.cacheRead) + ' cache read');
  if (u.cacheWrite != null) parts.push(tokens(u.cacheWrite) + ' cache write');
  if (u.output != null) parts.push(tokens(u.output) + ' out');
  if (!parts.length) return '';
  return parts.join(' · ') + (u.outputPartial ? ' (since watching)' : '');
}

/** How much of what the model read came from cache — the prompt-churn gauge. */
export function cacheHitRate(u) {
  if (!u || u.cacheRead == null || u.input == null) return '';
  const denom = u.input + u.cacheRead;
  if (!denom) return '';
  return Math.round((u.cacheRead / denom) * 100) + '% read from cache';
}

/**
 * Dollars per hour when the agent priced itself, output pace otherwise.
 * Quiet under five minutes — dividing by a tiny denominator prints a huge
 * rate that is really just startup noise — and quiet on partial sums.
 */
export function burnRate(u, startedAt, endedAt, now = Date.now()) {
  if (!u || u.outputPartial || !startedAt) return '';
  const hours = ((endedAt || now) - startedAt) / 3_600_000;
  if (hours < 5 / 60) return '';
  if (u.cost > 0) return money(u.cost / hours) + '/hr';
  if (u.output > 0) return '~' + tokens(Math.round(u.output / (hours * 60))) + ' out tok/min';
  return '';
}

/** The session's age. Unlike since(), an archive can be days wide. */
export function span(ms) {
  if (ms == null || ms < 0) return '';
  const m = Math.floor(ms / 60_000);
  if (m < 1) return '<1m';
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 48) return h + 'h ' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}

export function outPerTurn(u, turns) {
  if (!u || !(u.output > 0) || !turns) return '';
  return '~' + tokens(Math.round(u.output / turns)) + ' out/turn';
}
```

Note on the tests' expectations: `tokens(71_900)` → `'72k'`, `tokens(6_947)` → `'7k'` (existing rounding), `tokens(2_000)` → `'2k'`.

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/modes.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add public/format.js test/modes.test.js
git commit -m "feat: the drawer's stat derivations, as testable formatters"
```

---

### Task 8: The drawer itself, and the README

**Files:**
- Modify: `public/app.js` (import ~line 61, `renderInspectorMeta` ~line 689, delete `outputUsage` ~line 724)
- Modify: `README.md` (tile bullet list ~line 30, "Context and tokens" section ~line 233)
- Test: full suite (spa-guard rescans `public/`, header-markup unaffected)

**Interfaces:**
- Consumes: every Task 7 helper; `s.usage`, `s.startedAt`, `s.endedAt` (historical only), `s.stats` from serialize — all already present in both the SSE snapshot and `/api/session/:id`.

- [ ] **Step 1: Rewire `renderInspectorMeta`**

Extend the format import:

```js
import { el, shortPath, plain, since, clockTime, tokens, costLine, tokenBreakdown, cacheHitRate, burnRate, span, outPerTurn } from './format.js';
```

In `renderInspectorMeta`, replace the `work`/`context`/`output` rows (the `output` row dies — `tokenBreakdown` subsumes it, output segment included):

```js
  const endedAt = s.historical ? s.endedAt : null;
  const perTurn = outPerTurn(s.usage, s.stats.turns);
  const rows = [
    // ... status through session rows unchanged ...
    ['age', s.startedAt ? span((endedAt || Date.now()) - s.startedAt) : ''],
    ['work', `${s.stats.tools} tools · ${s.stats.turns} turns · ${s.stats.errors} failed` + (perTurn ? ` · ${perTurn}` : '')],
    ['context', contextUsage(s.usage)],
    ['tokens', tokenBreakdown(s.usage)],
    ['cache', cacheHitRate(s.usage)],
    ['cost', costLine(s.usage)],
    ['burn', burnRate(s.usage, s.startedAt, endedAt)],
  ].filter(([, v]) => v);
```

Delete the `outputUsage` function (its "(since watching)" honesty note moves with the behaviour into `tokenBreakdown`). `contextUsage` stays — context is a gauge, not a sum, and keeps its own row.

- [ ] **Step 2: Update the README in the same change**

- Tile bullet list (~line 30): no change — tiles are untouched.
- "Context and tokens" (~line 233): the bullet `**Subagent requests are skipped.**` becomes a statement that they are skipped *for context* and counted in the billed sums; the bullet `**The two agents count differently.**` becomes "**Each agent counts differently.**" with a clause noting the sqlite agents hand over running totals.
- Replace the closing paragraph (`There is no dollar figure. …`) with the new rule, keeping the original reasoning as the justification:

```markdown
A dollar figure appears only when the agent itself keeps one — OpenCode prices
its sessions and Hermes records an estimate and, when it has one, a measured
figure (labelled `est.` when it is the estimate). The wall never computes cost
from a price table of its own: that table goes stale silently, and it is
meaningless on a subscription — a wrong number that looks authoritative is
worse than no number. The inspector also derives what the sums support: the
billed-token breakdown, how much of the input came from cache, the burn rate,
and the session's age.
```

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS — spa-guard confirms the new rows are `textContent`-only, header-markup is untouched by drawer rows.

- [ ] **Step 4: Smoke it against this machine's real data**

```bash
node bin/cctv.js --no-open --port 43117 &
sleep 2
curl -s "http://127.0.0.1:43117/api/health" | head -c 400
# Then, with the printed token: fetch one live session and check the usage keys flow:
# curl -s "http://127.0.0.1:43117/api/sessions" -H "x-cctv-token: <token>" | python3 -m json.tool | grep -A9 '"usage"'
kill %1
```

Expected: a Claude session's `usage` carries `input`, `cacheRead`, `cacheWrite` numbers and `cost: null`.

- [ ] **Step 5: Commit**

```bash
git add public/app.js README.md
git commit -m "feat: cost, token splits and pace in the details drawer"
```

Body: the cost row only repeats an agent's own figure; everything else is derived from sums the sources now keep, and every row goes quiet rather than guessing.

---

### Task 9: Suite, merge, done

- [ ] **Step 1: Full verification**

Run: `npm test`
Expected: all tests pass (261 pre-existing + the new ones). Also run `node bin/cctv.js doctor` — every source that reported readable before still does.

- [ ] **Step 2: Merge with a summarizing merge commit**

```bash
git checkout main
git merge --no-ff feat/session-stats -m "Merge feat/session-stats: what a session cost, told honestly

Sources now keep the billed-token sums their agents record — uncached
input, cache reads, cache writes — and the two agents that price their
own sessions (OpenCode, Hermes) hand their dollar figure over. The
drawer derives the rest: cache hit rate, burn rate, age, output per
turn. Cost is repeated, never computed; a price table of our own would
go stale silently and print fiction for subscription sessions.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 3: Confirm clean**

Run: `git status && npm test`
Expected: clean tree on `main`, suite green.
