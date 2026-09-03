# Analytics, Monitoring & LLM Observability

Status: **Phase 0 is built and running.** Phases 1–4 are planned.

The goal this serves: hand a demo to a client and be able to answer, from the
record rather than from memory — *what did it do, in what order, how long did each
step take, what did it cost, where did it break, and what did the model see?*

---

## Phase 0 — the spine (BUILT)

`server/src/events.ts`. Append-only JSONL per product at `data/events/<product>.jsonl`.

**Why this shape.** The only prior record was `telemetry.ts`: a module-level array
of model calls. It answered "what did this cost" and nothing else — it vanished on
restart, was not scoped to a product or session, recorded no failures, and grew
without bound. JSONL is cheap to append, trivially tailable, survives a crash
mid-write (a torn last line costs one event, not the file), needs no database for a
local demo, and ships to ClickHouse/BigQuery later unchanged.

**Ambient tracing.** A model call happens six frames below the request that caused
it. Rather than thread a trace id through every signature (which touches the whole
codebase and gets dropped somewhere), the trace is ambient via `AsyncLocalStorage`.
Open one at the entry point and everything underneath attaches automatically —
verified: a `model.call` emitted deep inside `Agent.handleUserMessage` lands in the
same trace as `demo.start`, carrying its own latency, token counts and cost.

**Event shape**
```
id, ts, product, trace, span, parent, kind, status(start|ok|error), ms, data, error
```

**Recorded today**

| kind | emitted from | carries |
|---|---|---|
| `product.linked` | `POST /api/products` | url, auth mode, preflight result |
| `auth.granted` / `auth.rejected` / `auth.revoked` | Chrome-profile sign-in | method, origins, cookie count — never session material |
| `map.run` | mapping job | maxJobs/maxScreens, real duration, failure |
| `demo.start` / `demo.turn` / `demo.end` | websocket session | mode, per-turn latency, persona, needs, objections, KB gaps |
| `model.call` | `makeBrain()` — every provider call | purpose, model, in/out tokens, images, **cost**, tool names, **and failures** |

**Two bugs this surfaced immediately**, both worth keeping in mind:
- `makeBrain` never recorded a call that *threw*. A run failing every request still
  produced a clean, cheap-looking telemetry summary — error rate was structurally
  invisible. Now both paths are recorded.
- `startOnboardingJob` returned `void` and detached its work, so any timing wrapper
  would have recorded a multi-minute mapping run as 0 ms. It now returns the job
  promise; the route still doesn't await it.

**Redaction is on write, not on display**, so a new view cannot leak by forgetting
to redact. Credential-shaped keys are dropped, strings capped at 400 chars. Note the
rule: a value that is a **number is never a credential** — the first version matched
`token` inside `inTokens` and scrubbed token *counts*, reporting 0 tokens beside a
non-zero cost.

**Surfaced in** the admin console's **Activity** tab: events grouped by trace into
"Journey mapping" / "Demo session" / "Sign-in", each with step count, duration,
spend, failures; plus a rollup strip (events, failures, spend, tokens, slowest step
by p95). API: `GET /api/products/:id/events?limit&since&kind&trace`.

---

## Phase 1 — make it answer product questions (next)

Events tell you what the *system* did. These tell you whether the demo *worked*.

1. **Journey-level events.** `map.explore`, `map.verify` (pass/fail + the
   differential postcondition), `map.publish`, `journey.replay` (which journey, how
   many steps, did it complete, where it stopped). Today a failed verification is
   only in job log lines — unqueryable.
2. **Demo outcome events.** `demo.qualified`, `demo.objection`, `demo.kb_gap`,
   `demo.friction`. `SessionMemory` already collects all of this and drops it into
   `sessions.json`; emit it as events so it joins the same timeline.
3. **Voice/TTS events.** `tts.synth` (provider, chars, cache hit, ms),
   `voice.bargein`, `voice.stt` — barge-in quality is currently unmeasurable, which
   is exactly why its thresholds are still tuned by ear.
4. **Derived metrics endpoint** `GET /api/metrics`: time-to-first-verified-journey,
   mapping success rate, demo completion rate, cost per demo, p95 turn latency.

*Why first:* these are the numbers that decide whether the product is working for a
client, and every one of them is currently unanswerable.

## Phase 2 — LLM observability proper

`makeBrain()` is a single choke point — all of this lands in one file.

1. **Prompt/response capture, sampled.** Full system prompt, messages and completion
   for N% of calls (100% on error), written to `data/traces/<trace>.json`, with the
   same scrubbing. Screenshots referenced by content hash, not inlined — they are
   the bulk of the payload and are already content-addressed by the TTS cache
   pattern.
2. **Retrieval tracing.** For every turn: the query, the hybrid scores (0.7 semantic
   / 0.3 lexical), which chunks won, and whether the answer used them. Debugging a
   wrong answer today means re-running by hand and guessing.
3. **Eval-in-production.** The 25-case eval harness runs offline only. Run the same
   assertions against sampled live turns and emit `eval.online` — the regression
   signal that matters is on real traffic.
4. **Adopt OpenTelemetry semantics now, not later.** Rename event fields to
   `gen_ai.*` (`gen_ai.request.model`, `gen_ai.usage.input_tokens`, …). The event
   shape above is already span-shaped; doing this before there is data to migrate
   makes Langfuse / Phoenix / Braintrust / Datadog LLM Observability a config change
   rather than a rewrite. **Recommendation: Langfuse** — self-hostable (matches the
   zero-paid-services constraint), OTel-native, and its trace/generation model maps
   onto what already exists.
5. **Token accounting from the provider.** `estTokens` is `length/4`. Fine for
   ballpark cost, wrong for billing a client. Read real usage off the API response.

## Phase 3 — monitoring & alerting

1. **Health**: `/healthz` (process, disk, Chrome present) and `/readyz` (model
   endpoint reachable, embeddings warm). There is no health endpoint today.
2. **RED metrics** exported at `/metrics` in Prometheus text format — rate, errors,
   duration per event kind. `rollup()` already computes exactly this.
3. **Alert on the four that end a client demo**: model endpoint 5xx/429 rate,
   mapping failure rate, demo turn p95 > 20s, spend per hour over budget. The
   embeddings 429 that once looked like a retrieval-quality problem is precisely the
   class of failure this catches.
4. **Cost guardrails**: per-product and per-session budget caps enforced in
   `makeBrain()`, with a hard stop and a clear user-facing message. Nothing bounds
   spend today.
5. **Synthetic canary**: run one verified journey per product hourly against the
   real target and alert on failure. Journeys break when the customer ships UI
   changes — you want to know before the prospect does.

## Phase 4 — customer-facing analytics (this is the product loop)

The client's own dashboard, from the same events:
- which capabilities prospects asked about most (demand signal)
- questions the KB could not answer (`kbGaps` → content backlog)
- where prospects took the controls or dropped off (friction)
- objections raised, by frequency
- demos run, completion rate, qualified rate

This is the thing an enterprise buyer renews for, and it is nearly free given
Phase 0–1. It also converts the demo agent from a cost centre into a source of
product intelligence the customer cannot get elsewhere.

---

## Sequencing

Phase 1 → Phase 3 (health + cost caps) → Phase 2 → Phase 4.

Rationale: Phase 1 makes demo quality measurable; Phase 3's cost caps and health
checks are what stop an unattended client demo from failing loudly or expensively;
Phase 2 is depth for debugging; Phase 4 is the commercial payoff and is cheap once
1 and 2 exist.
