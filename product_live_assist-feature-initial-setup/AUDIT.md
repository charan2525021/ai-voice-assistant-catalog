# Architecture Audit — evidence-based

Findings from stress-testing the whole system against a **real multi-screen, login-gated product**
(Swag Labs: catalog → item detail → cart → checkout). Everything below was measured, not assumed.

---

## 1. "Will the Brain work correctly?" — it does **now**; it would not have before

**Measured before the fix** (6 realistic phrasings against the sample product): the flow matcher hit
**1 of 6**. Only exact doc wording matched. Worse than a miss, one paraphrase routed to the **wrong**
flow.

Root cause: retrieval was pure lexical (TF-IDF). It can only match shared words, and real prospects
don't reuse your documentation's vocabulary.

**Fixed:** hybrid retrieval — semantic embeddings (`text-embedding-3-small`, 0.7) blended with lexical
(0.3) and trust-boosted. Embeddings are built at ingest and cached in the store; if the endpoint is
unavailable the system degrades gracefully to lexical.

| Query | Lexical | Semantic |
|---|---|---|
| "add a product to the shopping cart" | ✅ | ✅ |
| "how do I **chuck something in my basket**" | ❌ | ✅ |
| "can I see the **cheapest items first**" | ❌ | ✅ |
| "what a product **actually includes**" | ❌ **wrong flow** | ✅ correct flow |
| "how would my team order swag" | ❌ | ❌ *(correctly — not a single flow)* |

**Verdict: the Brain works correctly now** for grounding, flow routing, and refusing to invent.
Remaining caveats are in §3.

---

## 2. Bugs found and fixed while testing multi-screen

Each of these was invisible until run against a real product:

| # | Bug | Impact | Fix |
|---|---|---|---|
| 1 | **Auth lifecycle broken.** Explorer/Verifier called `goto(startUrl)` to "reset" — which on an authenticated product lands back on the **login page**, discarding the session. The agent then tried to type a password and was (correctly) blocked by its own safety rule. | Mapper could learn **nothing** behind a login | `gotoStart()` — navigate *and* re-authenticate; used everywhere a reset happens |
| 2 | **`<select>` accessible name was the concatenated option list** (`"Name (A to Z)\nName (Z to A)\n…"`), unmatchable on replay | Every dropdown journey failed verification | Controls now derive names from `<label>`/`aria-label`/`name`/`data-test`, never `innerText` |
| 3 | **Recorder and resolver disagreed on "name."** Snapshot fell back to `data-test`, but `getByRole` matches only the *accessible* name | Unlabelled controls unreplayable | Resolver gained attribute fallbacks (`[data-test]`, `[name]`, `[id]`, `[aria-label]`) |
| 4 | **No dropdown action at all** | Sorting/filtering journeys impossible | First-class `select` action across explorer, verifier, graph |
| 5 | **`reverify` repaired journeys but never re-published them** | A repaired journey stayed invisible to the live agent — it *looked* like a retrieval failure | `publishFlows()` now runs after both `learn` and `reverify` |
| 6 | **SPA navigation invisible** — Cartographer only followed `<a href>` | Whole sections of modern apps unmapped | Two-pass survey: URL nav + click-nav (click, record, return) |
| 7 | **Every screen titled the same** ("Swag Labs" ×6) | Planner had no idea what screens were | Labels derived from URL path |
| 8 | **Context pruning blanked screenshot base64** | 400 `invalid_base64`, explorer silently did nothing | Replace stale image blocks with text (same bug class previously fixed in the agent) |

**Result on the real product:** 6 screens mapped behind login, and an **8-step multi-screen journey
verified** end-to-end. Notably, the **Verifier rejected two bad journeys** — that is the gate doing
its job, and it is how bugs 2–4 were discovered at all.

---

## 3. Both P0s — FIXED ✅

### ✅ P0-1 — Verified determinism is now used at demo time
Verified journeys are executed by **replaying the stored program**, not by re-deriving the path with
the model. `LiveBox.runProgram()` runs the durable selectors; the model is used only to narrate, and
falls back to improvising if a step fails.

Proven live: `[agent] DETERMINISTIC REPLAY of "Add a product to the shopping cart" → ok (1 steps, 0 model calls)`

Two further bugs surfaced while making this work — both would have kept verified flows permanently
unreachable:

1. **Intent gating hid flows.** Flow matching only ran for `show_me`/`buying_signal` intents. But
   *"can you chuck something in my basket?"* classifies as a **question** (it ends in "?"), so no flow
   — and therefore no program — ever reached the agent. Flow matching now runs for every intent except
   objections; the semantic threshold, not the intent, guards against a wrong match.
2. **The semantic threshold was miscalibrated.** A flat `0.42` cutoff rejected a valid match scoring
   `0.398`. Measured against real data: genuine matches land **0.40–0.62 and dominate the runner-up by
   ~1.9×**, while an unrelated query ("what is your refund policy") tops out at **0.18**. Replaced with
   a floor + dominance rule (accept on strong absolute score **or** clear dominance), all tunable by env.

### ✅ P0-2 — Postconditions are now differential
The proof text must be **absent before** the journey runs and **present after**. State is reset by
clearing cookies + localStorage/sessionStorage and re-authenticating — because "fresh browser" ≠
"clean data". The Explorer also self-corrects: if it proposes a proof that was already on screen at
the start, the proposal is rejected and it must pick a better one.

**This immediately exposed 4 of 6 previously-"verified" journeys as false passes:**

| Journey | Bogus proof | Why it proved nothing |
|---|---|---|
| Open a product's details page | `"Sauce Labs Backpack"` | That product name is on the **catalog** page too — passed without navigating |
| Sort the catalog (×2) | `"Price (low to high)"`, `"Name (A to Z)"` | Those are **dropdown option labels**, present on page load regardless of sorting |

After relearning with self-correction, the survivors use genuinely differential proofs
(`"Remove"`, `"Back to products"`). **Fewer journeys, but trustworthy ones** — which is the point of a
verification gate.

> **Known limit:** text-presence assertions cannot verify **ordering**, so "sort the catalog" is not
> provable this way (sorting changes order, not content). It needs an order-aware assertion.

---

## 3b. P1 / P2 — ALL FIXED ✅

| Item | Fix |
|---|---|
| Observer enumerated **every flow** into its prompt (breaks ~50) | `searchFlowsSemantic()` — retrieve top-4 relevant flows instead |
| Brain loaded **once at startup** | `reloadIfChanged()` on each new session — `brain:ingest` / `map:learn` land without a restart |
| `sessions.json` had **no locking** | Serialised write chain + atomic temp-file rename, and `logSession` re-reads from disk to merge another process's records |
| Agent conversation grew **unbounded** | Transcript capped (`AGENT_MAX_MESSAGES`, default 24), never cutting a `tool_result` away from its `tool_call` |
| **No Observer↔Agent mutex** | `LiveBox.exclusive()` — agent actions, verified replays and rescue snapshots all serialise on one lock |
| Explorer budget **14 steps** | Raised to 26 / 5 min, env-tunable (`EXPLORER_MAX_STEPS`, `EXPLORER_MAX_MS`) |
| Screen budget wasted on **near-duplicates** | `urlTemplate()` collapses `/item/1`, `/item/2`, uuids and hashes → `/item/:id`; dedupes both the queue and the record step |
| **Entity extraction naive** | Tool schema now demands the *type* ("Task"), explicitly not the typed value |
| **Composition not derived** | `deriveComposition()` detects when one verified journey is an ordered prefix of another and links `requiresJourney` + a precondition — the graph can now plan multi-journey goals |
| **Broken journeys accumulated** | `pruneJourneys()` drops superseded/duplicate journeys, keeps unreplaced broken ones as the repair backlog |
| **No telemetry** | `telemetry.ts` records every model call (purpose, latency, tokens, images) → `GET /api/telemetry` |

### Measured, not estimated
A full demo turn (paraphrase → semantic flow match → deterministic replay → narration):

```
calls: 2   images: 2   inTokens: 4255   outTokens: 77
costUsd: 0.00472   avgMs: 2958
```

**~$0.005 per demo turn**, and the *actions themselves cost zero model calls* because they were a
deterministic replay. This is real data behind the cost thesis in `VISION_PLAN.md`.

### Also fixed: stale stores degraded silently
Two of three product stores had **no embeddings** (written before semantic retrieval) and would have
silently run in lexical-only mode — the exact failure that misses most real phrasings. Stores now
**self-heal on load**: a store with docs but no index builds one and says so.

---

## 4. What's genuinely left (not plumbing — strategy)

1. **Coverage.** Only 2–4 verified journeys per product. A real demo needs 10–30. This is now the binding constraint on usefulness, and it's mostly about **content in** (docs, more proposed jobs) rather than architecture.
2. **No eval harness.** Every bug in this audit was found by hand. A regression suite over recorded demos would have caught them faster and would protect the fixes.
3. **M2 (human demonstration capture) still unbuilt** — per `MAPPER_PLAN.md` it's the highest-value mapper input: one recorded human demo beats many autonomous attempts.
4. **Order-aware assertions** — sorting/filtering journeys remain unverifiable by text presence.
5. **Storage** — JSON files are fine for one tenant; multi-tenant needs the `pgvector` schema that's already scaffolded but unused.

---

## 4. What is solid

- **Verification-gated graph** — the core idea works, and empirically caught every selector bug.
- **Durable role/name selectors** — journeys replay across sessions; the fallback chain now handles unlabelled controls.
- **Structural safety** — the destructive/never-touch interlock blocked password entry even when the agent *wanted* it (which surfaced the auth bug rather than silently doing something unsafe).
- **Product-agnostic switching** — `PRODUCT=<name>` swapped an entire product (content, graph, learning history) with zero code changes, proven across three different products.
- **Tiered Intent Rescue** — 1 vision call per 6 signals; silent during productive use.

---

## 5. Round 3 — eval harness, coverage, graph traversal (all built)

### ① Eval harness (`src/eval/`, `npm run eval [-- --full]`)
Three layers: **routing** (does real phrasing reach the right flow?), **grounding** (are unknown
questions refused?), **journey replay** (`--full`). Cases are **derived from the graph** so every
product gets coverage for free, plus hand-written cases in `content/<product>/evals.json`. Exits
non-zero, so it can gate a commit.

**It earned its keep on the first run**, catching four defects that manual testing had missed:

1. **Embedding pollution.** Flow vectors embedded *every* step equally, so a wandering 7-step journey that clicks "Add to cart" 4× absorbed the real add-to-cart flow's vocabulary — three flows collapsed to 0.43/0.42/0.41, destroying separation. Fixed by weighting: goal ×3 + intents, and only first/last step for action vocabulary.
2. **Threshold miscalibrated for single-domain products.** Within one product all flows share vocabulary, so scores legitimately cluster; the 1.4× dominance rule rejected correct top-1 matches. The FLOOR is the real discriminator (unrelated query = 0.18), so dominance dropped to 1.02.
3. **Vector similarity encodes topic, not action.** "chuck something in my basket" (0.428) lost to "view items in my basket" (0.432) — a 0.004 coin flip between opposite intents. Added a coarse **verb-class** signal (create / view / modify / remove / organise / transact) that boosts agreement and penalises clashes.
4. **FLAKY ROUTING from silent degradation.** Identical queries alternated between correct and *no* match. Cause: `embed()` had no retry, and the endpoint was returning **HTTP 429** — one turn embedded the same query **twice** (docs + flows), so ~36 requests in seconds tripped the rate limit, silently falling back to lexical. Fixed with a query-embedding **LRU cache** (halves calls), `Retry-After`-aware 429 backoff, and a loud warning instead of a silent downgrade.

> This is the argument for the harness in one paragraph: none of the four were visible in a single
> manual run, and #4 only appears when you run the same thing repeatedly.

### ② Coverage — the flywheel is closed
The Planner now receives **real demo demand** (`kbGaps` + `frictionPoints` from logged sessions),
**already-learned** goals (so it doesn't repeat), and **failed jobs** to retry — and is told to prefer
multi-screen journeys. Verified journeys went **3 → 6**, all verified, all replaying.

### ③ Graph traversal + real taxonomy
- **`taxonomy.ts`** groups journeys into buyer-facing capability areas instead of emitting one "capability" per journey. 6 journeys → **3 real areas** ("Cart management & shopping", "Product browsing", "Checkout initiation"). Its parser is deliberately tolerant: the model reliably produces the *grouping* but not the exact punctuation, so it keys off the trailing task numbers.
- **`graphview.ts`** finally makes the graph a *graph at query time*: on a flow match it walks `requiresJourney` edges for the prerequisite chain and capability membership for siblings, and injects them into the turn. Verified live: "I want to pay for these and finish the order" → flow *Start checkout*, capability *Checkout initiation*, prerequisite *View items and prices in the shopping cart* (with its meaning) — which the agent then used in its narration.

**Live end-to-end:** 6-step deterministic replay, 0 model calls for the actions, and it correctly
**asked for confirmation before the irreversible "Finish"**.

---

## 6. Round 4 — minimality, order proofs, end-to-end

### ✅ Minimal-path synthesis (`mapper/minimize.ts`)
Delta-debugging: drop a step, **re-verify**, keep the shorter path only if it still passes. Nothing is
shortened on a guess. Wired into `learn` after verification.

**It immediately exposed a flaw in naive minimisation.** It shrank *"Add a product to the cart from its
details page"* 2 → 1 steps by deleting the details-page step — still passing, because the proof
(`"Remove"`) describes the END STATE, not the INTENT. The result was an exact duplicate of another
journey and no longer the thing its own name promises. Fixed with a **semantic guard**: never shrink a
journey into a path another journey already covers. Verified the guard holds
(`skipped a trim that would duplicate another journey`).

> Lesson worth keeping: a postcondition proves the outcome, not the route. Minimising against a weak
> proof will happily destroy the distinction between two flows.

### ✅ Order-aware assertions — sorting is now verifiable
Text presence can't verify ordering, so `proof: "order_changed"` compares a **list signature** (the
ordered first-lines of the largest uniform list) before and after. The Explorer can now choose that
proof kind, and sorting journeys verify:
`✓ list order changed as expected (Price (low to high))`.

Finding along the way: the injected list script contained `split('\n')` inside a **TS template
literal**, where the escape becomes a real newline and breaks the JS — silently swallowed by
`.catch(() => "")` as an empty list. Now uses `String.fromCharCode(10)` and the catch **logs**.
(Third instance of the same class: a `.catch()` masking a real defect.)

### Two routing bugs the harness caught
1. **Ordering intent is a superlative, not a verb.** "can I see the cheapest items first" reads as `view`, so it was *penalised* against the sorting flow. Added superlative cues (cheapest / highest / newest / low-to-high / first) to the `organise` class.
2. **Word collision.** `"Select a product catalog sort order"` contains **"order"**, which the `transact` class matched first — classifying the *sorting* flow as a purchase action and inverting its rank. `transact` no longer matches bare "order".

Also: auto-derived eval cases now accept **any flow with the same postcondition** (two journeys can
reach the same proven state by different routes), and hand-written cases support `expectFlowOneOf` —
pinning one answer gets brittle as coverage grows.

### End-to-end state
- **9 journeys, 9/9 verified** (from 3), **25/25 retrieval evals**, stable across repeat runs.
- Capability taxonomy: **Cart management (3) · Product browsing (2) · Checkout (4)**; 5 prerequisite links.
- Live 4-turn demo: captured a 40-person procurement persona, **proactively** sorted cheapest-first from
  that context, ran **3 deterministic replays (0 model calls for actions)**, navigated catalog → cart →
  checkout, **declined to submit the purchase without approval**, and refused to invent an SAP
  integration (flagging it instead).
- **Measured cost: $0.039 for the whole 4-turn qualified demo** (13 calls, ~2.8 s each).
