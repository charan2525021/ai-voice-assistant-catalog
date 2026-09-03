# HANDOFF — read this first

You are picking up **Aidan**: a working AI sales engineer that runs live, interactive product demos.
It drives a real product in a browser, talks to the buyer, watches the shared screen, answers from a
product knowledge graph it built itself, and can be spoken to.

**Everything described here is built and verified running**, unless a line explicitly says otherwise.
Where something is unproven or fragile, it is labelled. Trust the labels — they were earned by
finding these things the hard way.

---

## 0. Read order

| # | Doc | What it gives you |
|---|---|---|
| 1 | **this file** | current architecture, component reference, the gotchas, commands |
| 2 | [`AUDIT.md`](AUDIT.md) | the *chronology* of what broke and why — best explanation of WHY the design is shaped this way |
| 3 | [`MAPPER_PLAN.md`](MAPPER_PLAN.md) | rationale for autonomous product mapping (why exhaustive crawling fails) |
| 4 | [`BRAIN_PLAN.md`](BRAIN_PLAN.md) | knowledge-layer design (B1–B4) |
| 5 | [`VISION_PLAN.md`](VISION_PLAN.md) | market gap + cost-benefit for proactive "Eyes" |
| 6 | [`content/README.md`](content/README.md) | how to add a product |
| 7 | [`server/src/mapper/README.md`](server/src/mapper/README.md) · [`voice/README.md`](voice/README.md) | subsystem usage |
| — | `../BUILD_PLAN.md` | ⚠️ **PARTLY STALE** — the original teardown. Its Sable analysis is still good; its *stack* section is wrong (it proposes Steel cloud browser + pgvector, neither of which is used). Prefer this file. |

---

## 1. What it does, end to end

```
Prospect (browser at :8787)
   │  types or 🎤 speaks
   ▼
Voice STT (:8089, Python)  ──transcript──►  Chat
   │
   ▼
Agent turn:
   1. Brain retrieval  → grounded facts (cited) + matched flow + persona/playbook + GRAPH walk
   2. Model decides    → narrate, and either run a VERIFIED flow or improvise step-by-step
   3. Actions execute  → local Chromium (streamed live to the prospect, who can take over)
   4. Capture          → needs, qualification, objections, unanswered questions
   ▼
Session logged → feeds the mapper's curriculum (the flywheel)

Separately, offline:  map:learn  →  autonomous product mapping → verified journeys → Brain flows
```

**Two things make this different from a chatbot with a browser:**
1. **Nothing enters the knowledge graph unless it replayed successfully from a clean state.** Verification is the core discipline; it has caught every selector bug and 4 false-passing journeys.
2. **Verified journeys execute as deterministic replay — 0 model calls for the actions.** The model only narrates.

---

## 2. Repo layout

> ⚠️ The project root path contains a **trailing space**: `/Users/avigodha/Downloads/Sable Product /`.
> Always quote paths.

```
aidan/
  server/                     Node + TypeScript (run via tsx, no build step)
    src/
      server.ts               Fastify + WebSocket gateway; session lifecycle; /api/telemetry
      config.ts               all config; loads ../../.env; PRODUCT selects the product
      livebox.ts              the browser: actions, snapshot, live stream, takeover, replay
      agent.ts                the demo turn loop (talk + act), capture tools
      brain.ts                model adapter (Anthropic | OpenAI-compatible) + retries + telemetry
      observer.ts             V1 "Intent Rescue" — watches the prospect, gated interjections
      telemetry.ts            per-call cost/latency accounting
      knowledge/              THE BRAIN
        store.ts              JSON store, hybrid retrieval, verb classes, self-heal
        embeddings.ts         semantic vectors + LRU query cache + 429 backoff
        retrieve.ts           per-turn router → context packet → system prompt
        graphview.ts          GRAPH TRAVERSAL at query time (prerequisites, siblings)
        memory.ts             per-session working memory → logged SessionRecord
        ingest.ts             product content → doc chunks (+ optional URL crawl)
        cli.ts                brain:ingest / map / signals / improve
      mapper/                 AUTONOMOUS PRODUCT MAPPING
        cartographer.ts       read-only surface map (URL nav + SPA click nav)
        planner.ts            curriculum: ranked JOBS (uses real demo demand)
        explorer.ts           attempts ONE job, records a durable-selector trace
        verifier.ts           replays from clean state, DIFFERENTIAL proof — the gate
        minimize.ts           delta-debug to the shortest still-verifying path
        semanticist.ts        what a journey MEANS (grounded in docs)
        taxonomy.ts           groups journeys into buyer-facing capability areas
        compose.ts            derives requiresJourney edges; prunes dead journeys
        graph.ts / types.ts   graph persistence + schema; publishes flows to the Brain
        cli.ts                map:learn / map:show / map:reverify
      eval/                   REGRESSION HARNESS (harness.ts, cli.ts) — `npm run eval`
    data/brain/<product>/     per-product store (git-ignorable output)
  voice/                      Python STT service (single speaker) — see voice/README.md
  web/index.html              zero-build UI: live view + chat + 🎤 + Tier-0 sensing
  content/<product>/          ALL product-specific input (see content/README.md)
  db/                         Postgres+pgvector schema — SCAFFOLDED, NOT USED
```

---

## 2b. Multi-product onboarding (added last)

**Many products live in one server at once.** A session names the product it wants; nothing reads a
global "current product" any more (that used to force a restart per product).

```bash
# CLI — same code path as the API, so they can't drift
npm run product:add -- --name "Acme CRM" --url https://app.acme.com [--user U --pass P] [--allow checkout] [--no-map]
npm run product:list
npm run product:onboard -- --id acme-crm [--jobs 5] [--screens 6]
npm run product:show -- --id acme-crm
```

```
POST /api/products              register + preflight + (auto) start mapping
POST /api/products/:id/preflight   re-check reachability / login
POST /api/products/:id/onboard     re-run the catalogue
GET  /api/products                 list with status + verified counts + live job log
GET  /api/products/:id             detail incl. graph summary and narration coverage
POST /api/session { product }      start a demo for THAT product
```

The UI has a **product picker** and an **Add product** form that polls the mapping job.

**Two phases, deliberately separate:**
- **Preflight** (seconds) — is the URL reachable, does it need a login, do the credentials work? If a
  password field is still visible after sign-in, mapping is **refused**. This kills the old failure
  mode where the mapper happily catalogued a *login page* and reported success.
- **Onboard** (minutes, background) — ingest docs → survey → plan → explore → verify → minimise →
  narrate → group → publish only VERIFIED journeys.

Per-product config lives in `content/<id>/product.json` (`name`, `startUrl`, `auth{mode,username,password}`,
`allowActions`, `onboarding{status,message,...}`) — **not** in `.env`. `PRODUCT` in `.env` is now only
the *default* selection for the UI and the single-product CLIs.

Verified: a brand-new product onboarded autonomously in **~150 s** — 3 screens, **3/3 journeys verified**
(incl. a 7-step checkout ending "Thank you for your order!"), every step narrated, 2 capability areas.

## 2c. Per-step narration (TTS-ready)

`JourneyStep.say` holds ONE short spoken line per step, written by the Semanticist during onboarding.
`LiveBox.runProgram(steps, onStep, delayMs)` fires `onStep` **before** each step, and the agent emits
that line — so a verified flow is *guided*, not executed in silence:

```
🗣 I open the shopping cart to review selected items before checkout.
🗣 I select Checkout to begin entering the order information.
🗣 I enter the first name required for checkout.        ← 7 lines, 7 steps
…
[agent] DETERMINISTIC REPLAY … ok (7 steps, 0 model calls)
```

Each line is a discrete utterance bound to a discrete action, which is exactly the shape TTS needs.
`NARRATION_STEP_DELAY_MS` paces steps so spoken audio has time to land.

## 2d. Admin console (super-admin surface) — `/admin.html`

The inspection and control surface. Everything the platform knows about a product is
visible here; nothing is a black box.

| Area | What you see / can do |
|---|---|
| **Link a product** | name, URL, **demo-account credentials**, allowed risky actions, voice, and all doc inputs (paste / file upload / URLs to crawl) — then one button starts mapping |
| **Live mapping** | the job log, streamed while it surveys → plans → explores → verifies → narrates |
| **Overview** | capability map (derived, not authored) + every screen discovered, with control counts |
| **Journeys** | each journey expandable to its exact steps, durable selectors, the spoken line per step, its proof text, reliability, and prerequisites. `verified` vs `broken` is explicit |
| **Documents** | add knowledge any time; see the files on disk, crawled URLs, and **the indexed chunks that answers are drawn from** |
| **Learning** | sessions, engagement, and the **questions it could not answer** (which become the next mapping curriculum) |
| Header | running spend + TTS cache hit-rate; `Run demo →` deep-links to `/?product=<id>` |

Supporting API (all product-scoped):
```
GET  /api/products/:id/inspect   everything stored: graph, docs, chunks, learning signals
POST /api/products/:id/docs      { files:[{name,text}], sources:[url] } → writes + re-ingests
POST /api/products/:id/voice     { provider, speaker, language, pace }
POST /api/products/:id/onboard   start / re-run journey mapping
POST /api/products/:id/preflight re-check access
```

## 2e. Interactive sign-in — Google SSO / 2FA / SAML

**We never need the password. We need the session.**

A form login can be automated; Google SSO cannot — and the agent is hard-blocked from
typing passwords anyway (correctly). So for those products the *human* signs in, inside
our own streamed browser:

```
POST /api/products/:id/auth/start   → opens a browser at the login page, returns authSessionId
GET  /ws/auth?authSessionId=…       → streams it; forwards the human's clicks/keys/scroll
GET  /api/auth/:authId/status       → where they got to + whether a password field is still visible
POST /api/auth/:authId/capture      → store the session (optionally adopt the landing URL)
POST /api/auth/:authId/cancel
POST /api/products/:id/auth/clear   → revoke a stored session
```

In the admin console: **🔐 Sign in interactively** opens a full-size window you can click and
type into. You complete Google/2FA yourself; then **"I'm signed in — grant access"** shows the
URL you landed on and which hosts the session covers, and asks you to confirm. On confirm we
store the browser's `storageState` and adopt the landing URL as the demo start point (SSO drops
you on a dashboard, which is a better entry than the login page).

`ProductAuth.mode` is now `none | login | **session**`. In session mode `LiveBox` boots every
browser — preflight, cartographer, explorer, verifier, demo — from that `storageState`, so
everything downstream is already authenticated and `loginIfNeeded()` short-circuits.

**Keyboard capture (this took two attempts):** a `window`-level `keydown` listener looked correct but
keys never reached the product — whether it fires depends on what the *admin page* happens to have
focused, and the user gets no feedback either way. The sign-in stage is now a real focusable element
(`tabindex=0`), focused when the window opens and re-focused on every click, with a live chip showing
**what has focus in the remote page** (`⌨ typing into input "Username"`). Also added:
`paste` (password managers paste rather than type, and long strings type unreliably over a socket →
`keyboard.insertText`), modifier **chords** (`Cmd+A`, `Ctrl+V` → `keyboard.press("Meta+A")`), and
`mousedown` preventDefault so clicking the product never steals the keyboard away.

**Security properties (deliberate):**
- The password goes from the user's keyboard straight into the product. It never enters this process.
- The agent's block on typing passwords is untouched — a *person* typed, not the agent.
- The captured session **is a live credential**. It is stored only in `content/<id>/product.json`,
  is stripped from every API response by `safeAuth()` (which returns `hasSession: true` and nothing
  more), and is revocable.
- Sign-in windows expire after `AUTH_SESSION_TTL_MS` (15 min) so abandoned browsers don't leak.

Verified: a session captured from one browser made a **later browser already signed in** with no
credentials (19 controls on the authenticated page, no password field), and preflight then reported
`ok=true, loggedIn=true`.

## 3. Run it

```bash
# terminal 1 — the app
cd server && npm install && npx playwright install chromium && npm run dev   # :8787

# terminal 2 — voice (optional)
cd .. && python3 -m venv .venv && ./.venv/bin/pip install -r voice/requirements.txt
./.venv/bin/python -m voice.server                                          # :8089
```

| Command (in `server/`) | Purpose |
|---|---|
| `npm run dev` / `start` | the demo app |
| `npm run typecheck` | tsc, no emit |
| `npm run eval` | **routing + grounding regressions (fast). Run this after ANY change.** |
| `npm run eval -- --full` | also replays every verified journey (slow, spins browsers) |
| `npm run brain:ingest` | load `content/<PRODUCT>/` → docs/flows/playbook/personas + embeddings |
| `npm run map:learn -- <maxJobs> <maxScreens>` | autonomously learn the product |
| `npm run map:show` | print the knowledge graph |
| `npm run map:reverify` | replay all journeys → drift detection + reliability |
| `npm run brain:signals` / `brain:improve` | learning signals / draft FAQs for KB gaps |

**Add a product:** `cp -r content/_template content/acme`, fill it in, set `PRODUCT=acme` in
`aidan/.env`, `npm run brain:ingest`, then `npm run map:learn`. One env var switches everything
(content, graph, learning history are all per-product).

---

## 4. Environment variables (complete)

`aidan/.env` — loaded by **both** Node (`config.ts`) and Python (`voice/config.py`).

**Model** — `MODEL_PROVIDER` (`anthropic`|`openai`) · `ANTHROPIC_API_KEY` · `ANTHROPIC_MODEL` ·
`OPENAI_BASE_URL` · `OPENAI_API_KEY` · `OPENAI_MODEL` · `MODEL_REASONING_EFFORT` (**must be `none`
on the llmapi gateway or function tools 400**) · `MODEL_VISION` · aliases `LLM_BASE_URL`, `GROQ_API_KEY`.

**Product** — `PRODUCT` (folder in `content/`) · `CONTENT_DIR` · `DEMO_NAME` · `DEMO_START_URL` ·
`DEMO_AUTH_MODE` (`none`|`login`) · `DEMO_USERNAME` · `DEMO_PASSWORD`. Precedence:
`.env` > `content/<PRODUCT>/product.json` > fallback.

**Retrieval tuning** — `EMBEDDINGS` (`off` to disable) · `EMBEDDINGS_MODEL` ·
`FLOW_MATCH_FLOOR` (0.30) · `FLOW_MATCH_STRONG` (0.45) · `FLOW_MATCH_DOMINANCE` (1.02).

**Limits** — `AGENT_MAX_MESSAGES` (24) · `EXPLORER_MAX_STEPS` (26) · `EXPLORER_MAX_MS` (300000).

**Telemetry** — `PRICE_IN_PER_M` · `PRICE_OUT_PER_M` · `IMAGE_TOKENS`.

**Voice (Python)** — `ASR_PROVIDER` (`mock`|`sarvam`) · `SARVAM_API_KEY` · `SARVAM_MODEL` ·
`SARVAM_MODE` · `SARVAM_LANGUAGE_CODE` · `VOICE_PORT` · audio tuning
(`SAMPLE_RATE`, `CHUNK_SIZE`, `BUFFER_CHUNKS`, `ENERGY_THRESHOLD`, `LOW_ENERGY_PACKET_TARGET`,
`MAX_UTTERANCE_SECONDS`).

⚠️ `aidan/.env` currently contains **live keys** (llmapi + Sarvam) that were shared in chat. **Rotate them.**

---

## 5. Data model

`server/data/brain/<product>/`:

| File | Contents |
|---|---|
| `docs.json` | `DocChunk[]` — text, source, title, `trust` (official/marketing/community), freshness, `embedding` |
| `flows.json` | `Flow[]` — what the **live agent** reads. Includes `program` (executable durable steps), `postcondition`, `proof`, `embedding`. **Only VERIFIED journeys are published here.** |
| `product-graph.json` | `ProductGraph` — `screens`, `journeys` (with steps/proof/status/reliability/`requiresJourney`), `capabilities`, `backlog` |
| `personas.json`, `playbook.json` | B3 selling knowledge (from content folder) |
| `sessions.json` | `SessionRecord[]` — transcript, needs, qualification, objections, `kbGaps`, `frictionPoints`, outcome. **Feeds the mapper curriculum.** |

**Journey step (durable selector):**
```json
{ "action": "click|fill|select|navigate|scroll", "role": "button", "name": "Add to cart",
  "value": "…", "submit": false, "url": "…" }
```
`role` + accessible `name` — **never** per-snapshot ids or CSS. This is why journeys replay across sessions.

---

## 6. Component contracts + per-component nuances

### `livebox.ts` — the browser
Local headless Chromium. Provides Hands (`clickElement`/`typeText`/`scroll` by snapshot id),
durable actions (`clickByRole`/`fillByRole`/`selectByRole`), Eyes (`snapshot()` → labelled elements +
screenshot), live view (periodic JPEG, ~2.5 fps), takeover (`userClick`/`userWheel`/`userKey`),
deterministic `runProgram()`, and `exclusive()` — a **mutex** the Agent and Observer must both use.

- **`gotoStart()`, never `goto(startUrl)`**, to reset: on an authenticated product `startUrl` is the *login page*, so a bare goto silently drops the session.
- **`resetState()`** clears cookies + localStorage + sessionStorage then re-auths. "Fresh browser" ≠ "clean data".
- **`pageSignature()` must include `document.activeElement` + input values + scrollY** — else focusing an input reads as "nothing happened" (false dead-click).
- **Element selector is plain `a`, not `a[href]`** — SPA anchors with JS handlers (e.g. a cart icon: a visible 40×40 `<a href=null>`) are otherwise invisible and whole journeys become unreachable.
- **Names for controls come from label/aria-label/name/data-test — never `innerText`** for `<select>` (innerText concatenates every option into an unmatchable name). Icon-only controls fall back to data-test/id/class/href-tail.
- **`resolve()` has attribute fallbacks** (`[data-test]`,`[name]`,`[id]`,`[aria-label]`) because the recorder may produce a *synthetic* name that `getByRole` cannot find. Recorder and resolver must agree on what "name" means.

### `knowledge/store.ts` — the Brain store
Hybrid retrieval: **0.7 semantic + 0.3 lexical**, trust-boosted. Also holds the **verb-class** signal and `selfHeal()`.

- **Flow embeddings are WEIGHTED**: goal ×3 + feature + intents + talkingPoints + only first/last step. Embedding *all* steps let a wandering journey absorb another flow's vocabulary and collapse separation.
- **Verb classes exist because embeddings encode topic, not action** — "put something in my basket" vs "view my basket" scored within 0.004. `transact` deliberately does **not** match bare "order" (it collided with "sort order"); `organise` includes superlatives ("cheapest", "low to high", "first") because ordering intent rarely uses the word "sort".
- **Threshold calibration (measured, don't re-guess):** genuine matches 0.40–0.62; unrelated ≈0.18; within one product scores legitimately cluster, so FLOOR is the discriminator and dominance is only a tie-breaker (1.02).
- `selfHeal()` builds a missing semantic index on load — stores written by an older pipeline would otherwise silently run lexical-only.
- Writes are **serialised + atomic** (temp file + rename); `logSession` re-reads from disk to merge concurrent records.

### `knowledge/embeddings.ts`
Retries, **`Retry-After`-aware 429 backoff**, and an **LRU query cache**.
- One turn embeds the same query twice (docs *and* flows). That doubled volume tripped HTTP 429, which **silently degraded to lexical and made routing FLAKY** (identical queries alternating correct/none). The cache halves calls; degradation now **warns loudly**.

### `knowledge/retrieve.ts` — per-turn router
Classifies intent, infers persona, retrieves facts, matches a flow, walks the graph, assembles the system prompt.
- **Flow matching runs for EVERY intent except objections.** Gating on `show_me` hid verified flows entirely — "can you chuck something in my basket?" classifies as a *question* (it ends in "?").

### `mapper/verifier.ts` — the gate
Replays in a fresh session and asserts **differentially**: proof must be **absent before, present after**.
- Absolute assertions false-passed 4 of 6 journeys (e.g. `"Sauce Labs Backpack"` is on the catalog page too).
- `proof: "order_changed"` compares `listSignature()` before/after — text presence cannot verify **ordering**.
- Returns `inconclusive` when the proof was already true (a weak proof, distinct from a broken replay).

### `mapper/minimize.ts`
Delta-debugging: drop a step, re-verify, keep only if it still passes.
- **Semantic guard is essential:** a postcondition proves the end state, not the intent, so naive minimisation deleted the details-page step from "add to cart *from the details page*" and produced a duplicate of another journey. Never shrink into a path another journey already covers.

### `mapper/explorer.ts`
Goal-directed; records durable selectors; self-rejects a proof that was already on screen.
- Blocks clicks on links that leave the origin, and **auto-recovers** (`gotoStart()`, discard recorded steps) if an action still escapes — otherwise the run is unrecoverably lost on a marketing site.
- `config.allowActions` (from `product.json`) is the **only** way destructive verbs get permitted — a human decision, never agent self-authorised.

### `observer.ts` — Intent Rescue
Tier 0 free DOM sensing (browser) → Tier 1 free gate → Tier 2 **one** vision call that may abstain → Tier 3 grounded interjection. Acting stays with the Agent, so the two never fight over the browser.
- **Prompt wording is load-bearing:** framing it as "watching a prospect", or the phrase "Speak up, or reply SILENT", trips hosted content filters (bisected empirically). Use `NO_TIP` and "product demo assistant helping a user who is exploring".
- Strength model: rage-click = strong (acts alone); dead-click on something clickable = medium (needs 2 signals); blank space/idle = weak; dead-click on a **text input = ignore** (clicking a field is never friction).
- Retrieves top-4 relevant flows — it used to enumerate *all* of them, which breaks at ~50.

### `brain.ts` — model adapter
Neutral message model → Anthropic or any OpenAI-compatible endpoint. Wraps every call in telemetry.
- **Retryability must inspect the response BODY, not just the status:** the gateway reports transient upstream outages as **HTTP 400** `provider_error: temporarily unavailable`.
- On the llmapi gateway, `reasoning_effort: "none"` is required whenever function tools are sent.

---

## 7. THE GOTCHA LIST — read before changing anything

These cost real debugging time. Several are non-obvious and will silently re-appear.

1. **`.catch(() => default)` masks real defects.** Three separate bugs hid this way (invalid base64, a JS SyntaxError, an empty list). **Log in catches.**
2. **Escapes inside injected page scripts.** `split('\n')` in a **TS template literal** becomes a real newline → SyntaxError in the page. Use `String.fromCharCode(10)`.
3. **Never blank image data when pruning context** — an empty base64 produces `data:image/png;base64,` and a 400 `invalid_base64`. Replace the block with text instead.
4. **`a[href]` misses SPA anchors.** Use plain `a`.
5. **`<select>.innerText` is every option concatenated** — useless as an accessible name.
6. **Auth: resetting via `goto(startUrl)` lands on the login page** and drops the session.
7. **"Fresh browser" ≠ "clean data"** — carts/drafts live in storage; clear it.
8. **Postconditions must be differential**, or they false-pass on leftover state.
9. **Ordering can't be proven by text presence** — needs `order_changed`.
10. **Don't guess click coordinates in tests** — measure with `getBoundingClientRect()`; guesses silently hit `<body>` and invalidate the test.
11. **Content filters react to phrasing**, not intent (see Observer).
12. **Transient failures can arrive as 400s** — inspect the body.
13. **Embeddings encode topic, not action** — hence verb classes.
14. **Word collisions in verb regexes** — "sort **order**" was classified as a purchase.
15. **Rate limits degrade retrieval silently** — cache queries; warn on degradation.
16. **Minimising against a weak proof destroys meaning** — keep the duplicate guard.
17. **macOS/harness:** no `timeout` command; foreground `sleep` is blocked in this harness (background it); kill stray browsers with `pkill -f "Google Chrome for Testing"`.

---

## 8. Verified state (as of handoff)

Product under test: `content/saucedemo/` (Swag Labs — login-gated, multi-screen).

- **9 journeys, 9/9 verified**, including a 6-step multi-screen checkout and an order-proof sort.
- **25/25 retrieval evals**, stable across repeated runs.
- Taxonomy: **Cart management (3) · Product browsing (2) · Checkout (4)**; 5 prerequisite edges.
- Graph traversal live: a query returns flow + capability + prerequisite chain.
- Deterministic replay confirmed: `DETERMINISTIC REPLAY … ok (6 steps, 0 model calls)`.
- **Measured cost: $0.039 for a 4-turn qualified demo** (13 calls, ~2.8 s/call) via `GET /api/telemetry`.
- Voice: real Sarvam STT verified transcribing a spoken command ("Add a task called buy groceries…").
- Vision: proven with a control — reads text present only in pixels; says `NO IMAGE RECEIVED` without one.

**Verified working across 3 products** (`saucedemo`, `sample-tasks-app`, `acme-crm`) by changing one env var.

### Not verified / known weak
- **Real microphone** end-to-end (this environment has no mic; STT proven with generated speech).
- **`"Total: $0.00"`** is a value-dependent proof — it verified only because the cart was empty.
- **`click link "4"`** (a cart *badge count*) is a brittle selector — breaks if the count differs.
- **SSO / MFA / OAuth logins** — only simple form auth is implemented.
- **Multi-tenant storage** — JSON files only; `db/` pgvector schema is scaffolded and unused.
- **Journey minimality is bounded by selector brittleness** — one 7-step journey stays long because a later step depends on the cart count produced by earlier steps.

---

## 9. Where to go next (my recommendation, highest value first)

1. **Robust proofs** — replace value-dependent proofs (`Total: $0.00`) and count-based selectors (`link "4"`) with stable ones. These are the most likely sources of future flakiness.
2. **Mapper M2 — human demonstration capture** (see `MAPPER_PLAN.md`): record one real seller and induce a journey. Per the research this beats autonomous exploration, and it is still unbuilt.
3. **Coverage** — real doc ingestion at scale via `content/<product>/sources.txt` (implemented, never tested on a large docs site). The Brain's ceiling is content, not architecture.
4. **Graph-composed planning** — `requiresJourney` edges exist and are surfaced to the prompt, but the agent doesn't yet *chain* journeys automatically to satisfy a multi-step goal.
5. **Multi-tenant storage** — move to the scaffolded pgvector schema when more than one customer matters.

**Working rule that produced everything above: change one thing, then `npm run eval`.** Nearly every
bug in `AUDIT.md` was found by running the same thing twice and noticing it disagreed with itself.

## Signing in to products behind Google / SSO (`chromeprofile.ts`)

**The constraint that shapes this whole component:** Google will not complete OAuth
inside Playwright's Chromium. It answers with *"this browser or app may not be
secure"*. We hit this on a real product (Cloze) after the streamed sign-in window
was working perfectly — the page loaded, keystrokes landed, and Google still
refused. The check is not a fingerprint to defeat: it keys on the build not being
Google-branded and on `--enable-automation`, and fundamentally on an automation
harness asking for account access. Hardening the spoof would be fragile and
adversarial, so we do not.

**What we do instead.** Launch the user's OWN installed Google Chrome — no
Playwright, no CDP, no automation flags — pointed at a profile directory we own.
It *is* genuine Chrome, so Google treats it as genuine Chrome. The human signs in
on their own desktop. Then we close it and drive that same profile afterwards via
`chromium.launchPersistentContext(profileDir, { channel: "chrome" })`.

### Three auth modes, and when each applies
| mode | who signs in | used for |
|---|---|---|
| `none` | nobody | public/demo apps |
| `login` | the agent fills a form | products with a plain username+password |
| `session` | human, in the **streamed** window (`authsession.ts`) | ordinary forms the agent shouldn't hold a password for |
| `profile` | human, in **real Chrome** (`chromeprofile.ts`) | **Google SSO, SAML, 2FA — the only mode that works for these** |

### Flow
1. `POST /api/products/:id/auth/desktop` — spawns real Chrome on the product's
   sign-in page with `--user-data-dir=content/<id>/chrome-profile`.
2. `GET /api/products/:id/auth/desktop` — is that window still open? (drives the UI)
3. `POST /api/products/:id/auth/desktop/done` — closes Chrome with **SIGTERM** (a
   hard kill can leave freshly-set cookies unflushed, which is indistinguishable
   from a failed sign-in), waits for the profile's `SingletonLock` to clear, then
   reopens the profile and **verifies** it is authenticated before committing.
4. On success: `auth.mode = "profile"`, and mapping starts.

### Non-obvious details that are load-bearing
- **A claim of being signed in is not evidence of it.** `/done` re-probes with the
  same `LiveBox` the mapper uses and rejects the profile if a password field is
  present or the URL still looks like an auth page. Committing an unauthenticated
  profile would send the mapper off to explore a login wall. The rejection path is
  tested.
- **`resetState()` used to sign us out.** It clears cookies to get a clean *data*
  state, but for an SSO product there is no form for `loginIfNeeded()` to fill, so
  every verification would have run as an anonymous visitor and failed for reasons
  unrelated to the journey. This was a latent bug in `session` mode too. Fixed by
  storing the **pristine post-sign-in `storageState` as a baseline** and re-applying
  it after every clear — cookies immediately, `localStorage` after navigation
  (`restoreOriginStorage`), since it can only be written from its own origin.
- **`localStorage` restore is inlined as percent-encoded JSON**, not an `evaluate`
  argument: `evaluate()` only binds arguments for a real function, and this codebase
  passes page scripts as strings, where the argument is silently dropped. That is
  how the restore first failed while reporting success — the in-page `catch`
  returned `0`. Percent-encoding also means arbitrary stored values (quotes,
  backslashes, U+2028) cannot break the expression.
- **Profile mode overrides the UA.** Headless Chrome announces
  `HeadlessChrome/<v>`, which some products answer with a degraded page. The
  version is read off the real binary (`chromebin.ts`) rather than hardcoded,
  because `navigator.userAgentData.brands` reports the true major version and
  cannot be overridden here — a contradiction is a louder signal than a headless UA.
- **`stop()` must close the context in profile mode.** A persistent context owns
  its browser process and has no `Browser` handle; closing the context is what
  releases the profile lock so the next run can open it.
- **The profile is a live credential.** Dedicated per product (never the user's
  personal Chrome profile, so linking one product cannot expose their other
  accounts), stored only under `content/<id>/`, stripped from API responses by
  `safeAuth()` (which reports `hasProfile`, never the path), and **deleted** by
  `POST /api/products/:id/auth/clear` — revoking the copy without the profile
  would not be revoking.
- The user's password and 2FA codes never enter this process in any mode.

## Proof from observation, and demonstration capture (M2) — 2026-07-28

Two changes that together decide whether an ARBITRARY product can be onboarded.

### `mapper/proof.ts` — evidence is observed, never composed
A postcondition used to be a free string the model wrote, checked only against
the baseline. So it could assert text the product never displays: OrangeHRM's
add-employee journey filled First="Ava", Middle="Marie", Last="Johnson" and
claimed proof **"Ava Johnson"** — assembled from its own inputs, while the page
renders "Ava Marie Johnson". A journey that genuinely worked was recorded broken.

Now the model only ever CHOOSES among candidates we observed. `validateProof`
requires the text to be present after and absent before; rejections hand back the
real candidates. Scoring is deliberately structural (length, uniqueness, digit
stability, set difference) — **no vocabulary of confirmation words**, which would
bind proof quality to English and to products that happen to show toasts.
11 unit tests in `proof.test.ts`, including the "0 items left" regression.

> ⚠️ **`observeOutcome()` — watch, don't sample.** `settle()`/`runProgram()`
> return before the app has finished reacting. Measured on OrangeHRM's Save:
> unchanged at +0ms, "Successfully Saved" toast at ~+3s, navigated away by ~+5s.
> Sampling once gets nothing or gets page furniture, so we poll and UNION
> everything new across a window. **Observe ONCE and cache** — a second pass sees
> only the settled page; that is literally how "Successfully Saved" became
> "Other Id". `verifier.ts` now polls for the postcondition too (`PROOF_WAIT_MS`),
> which is what makes a transient toast usable as proof at all.

> ⚠️ **A typed value appearing in captured text is the STRONGEST proof**, not a
> suspicious echo. `innerText` excludes `<input>` values, so if we can see it the
> product rendered it as content. An earlier "only trust this after a navigation"
> rule was too narrow and demoted a created record's own name in favour of
> furniture on single-page apps.

### `demonstrate.ts` — teach a journey by doing it once (Mapper M2)
The escape hatch for everything autonomous exploration cannot reach. A human
drives the streamed browser; clicks/typing/navigation are recorded as durable
role+name steps via the same snapshot path the explorer uses, so recorder and
resolver agree by construction (`LiveBox.identifyAt` resolves through
`data-aidan-id` — **never** `describeAt`, which names innerText-first).

**A demonstration earns no special trust**: `finish` replays it from a clean
state through the same gate, and publishes only if it passes.

- `POST /api/products/:id/demonstrate` · `GET /ws/demo?demoId=` · `/status` ·
  `/proofs` · `/finish` · `/cancel`
- `npm run demo:record -- --id X --goal "..." --steps '...'` drives it headlessly
- `LiveBox.canResolve()` checks each selector AT RECORD TIME, so an unaddressable
  step is reported immediately instead of burning a 20s replay
- `LiveBox.boxOfElement()` returns MEASURED coordinates — scripts must never
  guess a fraction; a guess silently hits `<body>` and invalidates the test

> ⚠️ **Submitting usually CLEARS the field.** Flushing a typed value after Enter
> reads `""` on a to-do box, search box or chat composer, and the fill step is
> silently dropped — the recording comes back empty. Read the value BEFORE
> forwarding the submitting key.

**Verified:** Swag Labs add-to-cart and a TodoMVC task capture both recorded →
verified from clean state → published, with proof chosen from observation
("Prepare the Q3 board pack", the created record itself).

### Why OrangeHRM still cannot be catalogued — now precisely
Demonstration captured the add-employee journey perfectly (5 steps, 0
unresolvable) and proof selection correctly chose "Successfully Saved". Replay
then failed with **"Employee Id already exists"**: OrangeHRM auto-assigns an id
the journey does not control, and on a shared public demo instance it collides.
The journey is genuinely not reproducible, so refusing it is correct — replaying
it for a prospect would show an error. **The blocker is the target instance, not
widget support.**

## Real-scale knowledge: crawling, calibration, lexicon (2026-07-28)

Until now every product's corpus was 1–2 hand-written chunks, which meant the
whole retrieval stack was **architecture with nothing in it** — and untestable,
because top-4 over 2 chunks returns the entire knowledge base and scores
perfectly while proving nothing. HubSpot's knowledge base is now ingested
(**450 pages → 4,378 chunks**), and everything below follows from being able to
measure for the first time.

### `knowledge/crawl.ts` — document acquisition
Sitemap expansion, include/exclude filters, concurrent fetch, main-content
extraction, corpus-level boilerplate stripping, overlapping chunks, dedup.
Configure with `content/<id>/sources.json` (`{ "crawls": [CrawlSpec] }`);
`sources.txt` still works and now goes through the same fetcher.

**The bug that motivated it:** the old crawler never checked the HTTP status. A
404 on knowledge.hubspot.com returned a styled error page from which it
extracted 2,033 characters of language-picker and menu text and stored it as
*official documentation*. It also had no main-content extraction, so even a 200
was ~⅓ navigation chrome — and chrome is identical across pages, which is the
worst thing to hand an embedder: thousands of mutually-similar chunks about
nothing.

### `knowledge/calibration.ts` + `npm run calibrate` — per-product parameters
`semWeight`, `flowFloor`, `flowStrong`, `flowDominance` are now **measured per
product** and stored at `data/brain/<id>/calibration.json`. Precedence is
**env > calibration > default**, so nothing changes for an uncalibrated product.

Measured results worth keeping:
- **The hybrid weight was wrong.** Swept on the real corpus, the optimum is
  **0.90/0.10**, not the shipped 0.70/0.30 — worth +3.3pt recall@1, +3.3pt
  recall@4, +0.027 MRR, +1.7pt article recall. It had never been challenged
  because there was no corpus on which any setting differed.
- **Flow floor 0.30 was right, and is now justified by data** rather than by
  memory of one tuning session — calibration independently derives 0.304.
- **Score distributions OVERLAP on realistic phrasing** (Swag Labs: correct p10
  0.363, competitor p90 0.577). No threshold separates them; discrimination
  rests on verb class + dominance. `calibrate` warns when it sees this.

> ⚠️ **Calibrate on REALISTIC phrasings, never on goal restatements.** The first
> version phrased each journey as its own goal ("Start checkout", "show me how to
> start checkout"), measured a distribution centred at 0.69, and derived a floor
> of **0.45** — which then rejected the correct match for "I need to sort out
> payment for this lot" (0.357) and fell through to keyword matching. Paraphrases
> are now model-generated.

> ⚠️ **A degraded run must never be persisted.** Calibration hit an HTTP 429
> mid-measurement and wrote thresholds derived from partially-lexical scores.
> `embeddings.ts` now exports `degradedCount()`/`resetDegraded()` and
> `calibrate` **exits non-zero and writes nothing** if it moved. A transient rate
> limit must not become a permanent mis-tuning.

### Grounding floor — the refusal guarantee had to be rebuilt at scale
**Fixing the empty corpus quietly broke "refuses rather than invents."** With 2
chunks, an off-topic question matched nothing above the score filter, so `facts`
came back empty and the agent *had* to refuse. At 4,378 chunks something always
clears an absolute filter: *"does this integrate with SAP S/4HANA?"* retrieved
four chunks about chatflows and NetSuite, leaving refusal to depend on the model
noticing they don't answer the question.

Unlike the flow scores, these distributions **separate cleanly** — measured on
HubSpot: answerable p05 **0.744**, off-domain max **0.626**. So `groundingFloor`
(in `calibration.json`) returns NO facts when the best match falls below it.
Default **0 = off**, so a product too small to measure both distributions is
unaffected, and `calibrate` refuses to enable it if the distributions overlap.
`expectNoFacts` eval cases are a hard failure once a floor is active, a soft note
otherwise.

> ⚠️ **Ordering costs a cooldown.** Grounding is measured after the weight sweep
> so the floor reflects served scores — but the sweep's ~60 embeddings plus the
> probes reliably tripped the gateway's rate limit, every run. Each probe
> succeeds alone; it is throughput, not a bad query. Hence the 20s pause and
> per-probe pacing. Without them the degradation guard fires and calibration can
> never complete.

### Events: two bugs that made the "system of record" silently partial
1. **Only the HTTP route was traced.** `trace()` was called in exactly ONE place
   (`server.ts`), wrapping `startOnboardingJob`. The pipeline itself was
   untraced, so `npm run product:onboard` and `npm run map:learn` — the commands
   the docs tell a maintainer to run — produced **zero events** for a
   twenty-minute run, while the log claimed to be the system of record. Tracing
   now lives in `onboardProduct`, covering both callers; the route no longer
   wraps it (that would nest two traces around one run).
2. **`emit()` is fire-and-forget, and every CLI ends in `process.exit()`.** The
   queued `appendFile` is killed mid-flight with no error. Added
   `flushEvents()`, awaited before every CLI exit including the error paths — an
   error is exactly the event worth not losing.

Verified: a CLI onboard that previously emitted nothing now writes 13 events
(`map.run`, `map.verify`, `model.call` ×7, `tts.synth` ×2).

> ⚠️ **`data/events/` is at the REPO root, not under `server/`.** `EVENT_ROOT`
> resolves `../../data/events` from `src/events.ts`, which lands one level
> shallower than `BRAIN_ROOT` (`server/data/brain`) resolving the same string
> from `src/knowledge/store.ts`. Two sibling "data" directories with different
> roots — I checked the wrong one twice and wrongly concluded events were never
> written at all.

### `knowledge/lexicon.ts` — verb/intent patterns as data
The two blocks of hardcoded English regexes now live in data, overridable per
product via `content/<id>/lexicon.json` (**merged** over the defaults, so a
partial file cannot disable a class). Defaults are the exact previous patterns.
See `content/hubspot/lexicon.json` for a CRM vocabulary example ("log a call",
"enrol in a sequence", "close the deal" — none of which the generic verbs match).

Found immediately by having it: **"sort out payment" routed to the sorting
flow** — the same word-collision family as the "sort ORDER" bug. Fixed with a
negative lookahead, plus `matchFlow()` (the lexical fallback) now **rejects
verb-class clashes**, which it never did — so it was quietly undoing the verb
work the semantic path does.

### Graph-assisted recall (`graphview.capabilityCandidates`)
The graph used to only *decorate* a flow flat search had already found. It can
now **find one flat search missed**: on a miss, match the CAPABILITY (a much
broader target than any single journey goal), then re-score only its member
journeys at a relaxed floor. A second retrieval route, not a re-ranking.

### Retrieval reranking — measured, and OFF
A model-free reranker (title match, document evidence, MMR diversity) exists
behind `RERANK=boost|full`. It is **off by default because it was measured and
did not help**: first-stage article-recall@4 93.3%, boost 90.0%, boost+MMR
93.3%. The only thing it reliably buys is source diversity (2.18 → 2.37 distinct
articles). Kept with the benchmark that would settle it rather than shipped for
sounding sophisticated.

### New commands
| Command | Purpose |
|---|---|
| `npm run bench:generate [n]` | build a retrieval benchmark from the corpus (default 60) |
| `npm run bench` | recall@1 / recall@4 / MRR + article-level recall |
| `npm run calibrate` | measure and persist this product's retrieval parameters |
| `npm run map:publish` | republish verified journeys to `flows.json` **without** re-verifying (repair path) |

### `flows.json` had two writers that silently deleted each other
Content ingestion (hand-authored) and mapper publish both called `setFlows()`,
which replaces the whole array — so `brain:ingest` after `map:learn` **destroyed
every executable program**, downgrading the agent from deterministic replay to
improvisation with no error and no log line. `sample-tasks-app` shipped in
exactly that state. Fixed with `Flow.origin` (`authored` | `mapped`) and
`setAuthoredFlows()` / `setMappedFlows()`, which replace only their own rows.

**`runConsistencyEvals()` (eval layer 0, free) now guards it**: a journey
`verified` in the graph must exist in `flows.json`, carry an executable program
of the same length, and have a `startUrl`. It immediately found a *second*
latent defect — `acme-swag-store` and `sample-tasks-app` had programs with **no
`startUrl`**, which was backfilled on Swag Labs only, so their replay could not
reposition and the agent silently improvised. `journeysToFlows` now falls back
to the graph's `startUrl`.

## Observability: the event log (`events.ts`)

Durable, per-product, append-only JSONL at `data/events/<product>.jsonl`. Replaces
nothing — `telemetry.ts` still backs the live header counter — but it is now the
system of record. See `OBSERVABILITY_PLAN.md` for the full phased plan and
`ENTERPRISE_PLAN.md` for enterprise/PLG gaps.

Three things a maintainer must know:

1. **Tracing is ambient, via `AsyncLocalStorage`.** `trace(product, activity, kind,
   data, fn)` opens one; everything emitted underneath — including `model.call` deep
   inside `makeBrain()` — attaches automatically. Do NOT thread trace ids by hand.
   For lifecycles that outlive a function (a websocket demo), use `openTrace()` and
   wrap each turn in `withTrace(ctx, …)`; `Session.traceCtx` holds it.

2. **Redaction happens on write.** A value that is a **number is never a
   credential** — the first version of the key regex matched `token` inside
   `inTokens` and scrubbed token counts, so the console showed 0 tokens beside a
   non-zero cost. Keep that exemption if you touch `isSecret()`.

3. **`startOnboardingJob` returns a promise now.** It used to return `void` and
   detach its work, so any timing wrapper recorded a multi-minute mapping run as
   0 ms. The route still does not await it — only the trace does.

Also fixed here: `makeBrain()` never recorded a model call that *threw*, so a run
failing every request still produced a clean, cheap-looking telemetry summary. Error
rate was structurally invisible. Both paths are recorded now.

### UI
- The admin console's "This product needs you to sign in" banner fired for any new
  product with no journeys — including public, no-login ones, which were told to
  sign in to themselves. It now requires actual evidence (preflight failure or a
  login-shaped status message) and `auth.mode !== "none"`; "not mapped yet" is a
  separate prompt with a different call to action.
- New **Activity** tab: events grouped by trace into "Journey mapping" / "Demo
  session" / "Sign-in", each with step count, duration, spend and failures.
- The demo opens with a greeting and suggested openers built from **that product's
  verified journeys** (`openers` on `POST /api/session`) — nothing hardcoded, and a
  suggestion can never advertise a journey the agent has not proven it can run.

## Access control (`auth.ts`) — READ THIS FIRST

The platform now requires a login. Every route is closed unless explicitly opened.

- **First run** creates an owner account and prints a one-time password to the
  server console. `ADMIN_EMAIL`/`ADMIN_PASSWORD` override it. There is deliberately
  no guessable default — that would be the same as having no auth.
- **Sessions are a signed, stateless cookie** (HMAC over `{uid, exp}` with the
  secret in `data/auth/secret`). An earlier version kept them in a `Map`, which
  logged everyone out on every restart and made the persisted secret pointless.
  Trade-off: a stateless token cannot be un-issued, so explicit logouts go in an
  in-memory `revoked` set (best-effort across restarts). Deleting a user IS
  immediately effective — `userForToken` re-reads the user file and fails closed.
- **Roles**: `owner` (user management) > `admin` (products, demos) > `viewer`.
- **Public paths** are exactly: `/login.html`, the login/logout API, `/healthz`,
  `/readyz`, and the demo page itself. `/metrics` returns **401**, not a redirect —
  a Prometheus scraper cannot follow one.

### Share links — and the bug worth remembering
`POST /api/products/:id/share` mints a token so a customer can hand a demo to their
buyer with no account. Two things went wrong building it, both instructive:

1. `getProduct()` rebuilds the record field by field and **silently dropped
   `share`** on read, so the token was written to disk and never loaded. Any new
   `ProductRecord` field must be added to that mapping or it will not survive a
   round-trip. (That `catch` now logs instead of returning `null`, because a
   corrupt manifest previously looked identical to "product not found".)
2. The gate validated the token but never bound it to the requested product, so a
   share link for one product could open **any** product — including ones behind a
   captured session. `/api/session` now enforces the binding, because only there is
   the requested product known.

The demo page enters **guest mode** on a 401 from `/api/products`: it hides the
operator chrome and runs the one product named in the link. Without that the share
link died with "products is not iterable" before starting.

## Spend limits (`budget.ts`)
Per-trace and per-product-per-day ceilings, checked **before** each model call —
charging first would let any ceiling be exceeded by one unbounded call. The daily
counter is seeded from the event log at startup, so a restart cannot reset a cap.
`BUDGET_TRACE_USD` (default 1) and `BUDGET_DAILY_USD` (default 10).

## Graph versioning (`mapper/graph.ts`)
`saveGraph` archives the previous graph to `graph-versions/` (keeps 10). Re-mapping
used to overwrite in place, so one bad run destroyed journeys that are expensive to
earn. `restoreGraphVersion` archives the current graph first, so restoring is itself
undoable — and it **republishes the derived flows**, without which a restore would
appear to succeed while the live agent kept replaying the version just replaced.

## Operations
`/healthz` (liveness), `/readyz` (content + model endpoint reachable; a missing
Chrome only disables SSO sign-in and must not fail readiness), `/metrics`
(Prometheus, auth-gated). CI in `.github/workflows/ci.yml` runs typecheck + evals;
`npm run verify` does both locally.

## Verification: measure at the point of ACTION (read before touching `verifier.ts`)

`verifyJourney` used to take its "before" snapshot immediately after `resetState()`,
which leaves the browser on the **post-login landing page** — while nearly every
journey *begins by navigating elsewhere*. The differential was therefore satisfied by
the navigation, not by the journey. Any word that merely exists on the destination
page counted as proof.

Found on OrangeHRM (see `EVALUATION_ORANGEHRM.md`), proven directly: `"Directory"`,
`"No Records Found"` and even an employee's own name were all on screen *before* the
action ran. **All 3 "verified" journeys were false passes.**

Now: split the program at the first non-`navigate` step, run the navigation lead-in,
snapshot, then run the acting steps. A journey that only navigates is rejected —
there is no action whose effect could be proven.

Regression guard: Swag Labs must stay **9/9** under this gate. It does. If a change
makes it stricter than that, the change is wrong; if OrangeHRM starts passing without
the widget work below, the gate has been loosened by accident.

**Verified status now expires.** Onboarding re-verifies existing verified journeys
before learning new ones and demotes failures. Previously "verified" was permanent,
so a badge outlived both UI drift in the customer's product and bug fixes in the gate
itself — which is exactly how three known-bad journeys survived a full re-map.

### Known capability gaps (the reason enterprise apps map to zero)
1. **Custom dropdowns** — `select` only drives native `<select>`. OrangeHRM's
   `<div>` comboboxes broke the Leave and Recruitment journeys. Highest-value fix.
2. **Icon-only buttons** — accessible name falls back to the CSS class
   (`"oxd-icon-button oxd-table-cell-action-"`), so table row actions are unreachable.
3. **Proof selection** — the explorer accepts page furniture and empty-state text
   ("No Records Found") as proof. It should prefer text caused by the action.
4. **Verification speed** — a cold LiveBox per attempt costs p50 17.6s / p95 25.6s,
   and re-verification now pays it twice per re-map.
