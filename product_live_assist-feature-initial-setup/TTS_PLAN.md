# TTS Engine — build plan

> Goal: Aidan **speaks**, so it guides a user through a product like a person would — while keeping the
> product promise (grounded, verified, reliable) and scalability (cost per demo stays near-zero) intact.

This is not "call a TTS API in `onSay`". Voice turns the demo into a **real-time turn-taking system**,
and the two things that make it feel human are **latency** and **interruptibility** — neither of which
a naive integration gives you.

---

## 0. What's already in place (and why it makes this cheap)

| Existing | Why it matters for TTS |
|---|---|
| **Every spoken line flows through one callback** (`onSay` in `agent.ts`, plus the observer's interjections) | One integration point. No hunting for "where does Aidan talk". |
| **`JourneyStep.say` — per-step lines written at ONBOARDING time** | The narration for every verified journey is **known before any demo runs**. It can be pre-synthesised, cached, and replayed at **0 ms and 0 cost**. This is the single biggest architectural advantage we have. |
| **Deterministic replay** (`runProgram` + `onStep`) | The *sequence* of upcoming lines is known, so audio can be prefetched and paced against actions. |
| **STT already live** (`voice/`, Sarvam, `:8089`) | Input half is done; we're closing a loop, not building one. |
| **WS already streams binary frames** to the client | Audio rides the same connection; no new transport. |
| **Provider-pluggable pattern** (`brain.ts`) | Copy the shape: interface + adapters + graceful degrade. |

**Providers verified working today with keys we already hold:**

| Provider | Endpoint | Result | Notes |
|---|---|---|---|
| **Sarvam** | `POST /text-to-speech` | ✅ 200, base64 **WAV**, ~84 KB | Same vendor as our STT — one key, one bill, Indian-language support |
| **llmapi gateway** | `POST /v1/audio/speech` (`gpt-4o-mini-tts`) | ✅ 200, `audio/mpeg`, 24 kHz mono, ~62 KB | OpenAI-compatible; also exposes Gemini TTS models |

> Both are already paid for. **No new vendor is required** — so the "self-contained, no new paid
> services" principle holds. A local option (Piper/Kokoro) stays available for a zero-cloud build.

---

## 1. Architecture

```
                    ┌──────────────── server ────────────────┐
 mic ──► STT(:8089) │  turn state machine                    │
                    │        │                               │
 user text ────────►│   agent.onSay(line) ──► TTSEngine      │
                    │                          │  cache?     │
                    │                          ├─ hit  ──────┼──► WS  {type:"audio", seq, mime, b64}
                    │                          └─ miss ─► provider (Sarvam | OpenAI-compat | local)
                    │  barge-in ◄── {type:"user_speaking"}   │
                    └────────────────────────────────────────┘
                                        │
 browser: AudioQueue (sequential, flushable) ──► speakers
          reports {audio_started|audio_ended, seq}
```

**Decisions and why:**

1. **Server-side synthesis, audio over the existing WebSocket.** Keys stay server-side, one connection, and it reuses the frame-streaming path already proven. *(Rejected: client-side synthesis — leaks keys. Deferred: WebRTC — better jitter handling, much bigger lift; the upgrade path stays open because the client already consumes a stream.)*
2. **Sentence-level chunking, not whole-reply.** Synthesise and send the first sentence while the rest is still being produced. Time-to-first-audio is what the ear judges.
3. **A pre-synthesis cache keyed by `hash(text + voice + provider)`.** Journey `say` lines are finite per product, so they are synthesised **once at onboarding** and then free forever.
4. **The client owns a flushable audio queue.** Barge-in must cut audio in <100 ms, which only the client can do; the server can't unsend.

---

## 2. Components to build

| # | Component | File | Job |
|---|---|---|---|
| 1 | **TTS provider interface + adapters** | `server/src/tts/provider.ts`, `sarvam.ts`, `openai.ts`, `local.ts` | `synthesize(text, voice) → {mime, bytes}`; retries + `Retry-After` (reuse the embeddings pattern); graceful degrade to **text-only** if TTS is down — the demo must never break because audio failed |
| 2 | **Cache** | `server/src/tts/cache.ts` | Content-addressed files under `server/data/tts/<product>/<hash>.<ext>` + an in-memory index. Cache-hit path must do **zero** network work |
| 3 | **Engine / queue** | `server/src/tts/engine.ts` | Sentence splitter, per-session ordered `seq`, cancellation token, prefetch of the next journey step's line |
| 4 | **Pre-synthesis at onboarding** | hook in `onboarding.ts` | After `describeSteps()`, synthesise every `say` line and every `meaning` → warms the cache so **demo-time narration is instant** |
| 5 | **Turn-taking state machine** | `server/src/turn.ts` | `IDLE → LISTENING → THINKING → SPEAKING`; owns barge-in, echo suppression, and "don't start a flow while the user is talking" |
| 6 | **Client audio queue** | `web/index.html` | Web Audio sequential playback, instant `flush()`, reports `audio_started`/`audio_ended` per `seq` |
| 7 | **Barge-in wiring** | `voice/server.py` + client | Emit `user_speaking` on the FIRST voiced chunk (not on the final transcript — far too late) |
| 8 | **Action/audio pacing** | `agent.ts` + `runProgram` | Advance a journey step when its line finishes speaking (capped), so speech and clicks stay together |

---

## 3. The four hard problems (and the fix for each)

### a) Latency — target <300 ms to first audio
- **Pre-synthesised journey lines → ~0 ms.** This covers the *entire guided walkthrough*, which is the product's centrepiece.
- **Dynamic replies:** split on the first sentence boundary and synthesise that alone (~60–120 chars). Measured provider round-trip today: Sarvam ~1 s for a full paragraph; a single sentence is a fraction of that.
- **Prefetch:** while step *n* plays, synthesise step *n+1* (already known from the program).
- Instrument it: add `tts` as a `CallPurpose` in `telemetry.ts` and report **time-to-first-audio** per turn, so this is measured rather than assumed (the same discipline that caught the cost and flakiness bugs).

### b) Barge-in — the strongest "human" signal
State machine in `turn.ts`:
```
SPEAKING + user voiced audio detected  →  emit {type:"stop_audio"} (client flushes)
                                       →  cancel in-flight synthesis (AbortController)
                                       →  drop queued lines for this turn
                                       →  if mid-journey: PAUSE the replay, don't abandon it
                                       →  state = LISTENING
```
Two rules learned from the existing observer work: **never interject while the user is speaking**, and
after an interruption **re-ground** (the screen may have moved).
The trigger must be the STT service's *first voiced frame*, not the final transcript — the transcript
arrives ~1–2 s late, by which time a human would already have stopped.

### c) Echo — the failure mode that will bite
Aidan's voice comes out of the speakers, the mic hears it, STT transcribes it, and Aidan answers itself.
- Browser: `echoCancellation: true` (already set in `getUserMedia`).
- Server: while `SPEAKING`, **suppress transcripts that match what we just said** (fuzzy compare against the last N spoken lines).
- ⚠️ **Note for whoever builds this:** the original `live-assist` code I trimmed had exactly this — `normalize_echo_text` / `text_similarity` / an echo-window. I removed it because single-speaker STT didn't need it. **TTS makes it necessary again.** Recover the approach from git history / `AUDIT.md` rather than reinventing it.

### d) Action ↔ audio sync
Speech is often longer than the click it describes, so a naive loop finishes the flow while the voice is three steps behind.
- Client reports `audio_ended{seq}`; `runProgram`'s `onStep` awaits that (with a **hard cap**, e.g. 4 s, so a dropped event can never wedge a demo).
- Fall back to `NARRATION_STEP_DELAY_MS` (already implemented) when audio is disabled.

---

## 4. Scalability & cost

**The key property: the guided journey is finite and cacheable; only conversation is dynamic.**

| Cost element | Behaviour |
|---|---|
| Journey narration (`say` lines) | Synthesised **once per product**, reused by every demo → amortises to ~$0 |
| `meaning` / capability lines | Same — pre-synthesised at onboarding |
| Dynamic conversational replies | Only these hit the provider live |
| Repeated phrasings (greetings, "let me show you…") | Cache hits across sessions and products |

Estimate for a 4-turn demo: ~6 dynamic sentences ≈ **600 characters** live-synthesised; every step line
free. At typical TTS pricing (~$15/1M chars) that is **well under a cent per demo** — the same
conclusion as `VISION_PLAN.md`: **compute is not the constraint, quality and latency are.**

**Scaling the process:** cache is content-addressed and shareable (a CDN or object store later);
synthesis is stateless and parallelisable; the per-product cache directory mirrors the existing
`data/brain/<product>` layout, so multi-tenancy needs no new concept.

---

## 5. Keeping the product promise intact

Voice must not weaken the guarantees that make this trustworthy:

1. **Grounding is unchanged.** TTS speaks *only* what the agent already produced — it is downstream of retrieval and citations. It cannot introduce a claim.
2. **Verified journeys stay verified.** `say` lines are metadata *about* proven steps; they never alter selectors, proofs, or the replay path. Evals and `map:reverify` are unaffected.
3. **Audio failure must degrade to text, never break the demo.** Same rule as embeddings: warn loudly, keep working. (And per the gotcha list — **log the failure, don't swallow it in a `.catch`**.)
4. **Irreversible actions still require confirmation.** Verified live already: it declined to click "Finish" without approval. Voice must not turn that into an easy-to-miss spoken aside — a confirmation stays an explicit stop-and-wait.
5. **Disclosure.** A spoken agent should say it's an AI at the start; more important once it sounds human.

---

## 6. Build order

| Phase | Deliverable | Verify by |
|---|---|---|
| **T1 — Speak at all** | Provider interface + Sarvam/OpenAI adapters + cache; audio over WS; client `AudioQueue`; sentence chunking | A typed question produces spoken audio; measured time-to-first-audio |
| **T2 — Guide the journey** | Pre-synthesis at onboarding; per-step audio during replay; `audio_ended` pacing | Run a verified 7-step flow: **7 spoken lines paced to 7 actions**, all cache hits |
| **T3 — Interruptible** | `turn.ts` state machine; `user_speaking` from STT's first voiced frame; client flush; echo suppression | Speak over Aidan mid-flow → audio stops <100 ms, flow pauses, the interruption is answered |
| **T4 — Production polish** | TTS telemetry (time-to-first-audio, cache-hit rate, cost), voice/persona config per product, `TTS=off` kill-switch, eval case asserting narration coverage | `npm run eval` still green; telemetry shows cache-hit rate >90% on a guided demo |

**T1+T2 is the demo-able milestone** — that's the "real human guiding you through the product" moment.
**T3 is what makes it feel alive** and is the piece most likely to need iteration.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| Barge-in latency feels sluggish | Trigger on first voiced frame; flush client-side; measure it |
| Echo feedback loop | Browser AEC + server-side transcript suppression (recover the removed `live-assist` logic) |
| Provider outage mid-demo | Degrade to text, warn, continue |
| Voice/action drift on slow networks | `audio_ended` events with a hard timeout cap |
| Cost surprise | Cache-hit-rate telemetry + a per-session character budget |
| Sounding *too* human | Explicit AI disclosure; keep confirmations explicit |

---

## 8. Open decisions (need your call)

1. **Default provider** — **Sarvam** (one vendor with our STT, WAV, Indian-language support) or **llmapi `gpt-4o-mini-tts`** (MP3, likely lower latency, more voices)? My lean: **Sarvam default, OpenAI-compat as the swap**, both behind the interface.
2. **Voice per product?** `product.json` could carry `voice`/`persona` so each product's Aidan sounds distinct — cheap to add now, awkward to retrofit.
3. **Scope of T3** — full barge-in, or ship T1+T2 first and iterate on interruption with you in the loop?


---

# BUILD RESULT — T1–T3 shipped and verified

## What was built
| Phase | Files | Status |
|---|---|---|
| **T1 speak at all** | `tts/provider.ts` (Sarvam + OpenAI-compat, retries, abort), `tts/cache.ts` (content-addressed), `tts/engine.ts` (split/seq/cancel/prefetch), client `audioQ` | ✅ |
| **T2 guide the journey** | pre-synthesis in `onboarding.ts`, per-step audio during replay, per-product voice in `product.json` | ✅ |
| **T3 interruptible** | `turn.ts` state machine, `speech_start` from STT's first voiced frame, client flush, echo suppression | ✅ |

## Measured
- **Cache: 7275 ms → 0 ms** for a repeated line. **92.5 % hit rate** on a spoken walkthrough.
- **Cost: $0.00045** for a full spoken checkout walkthrough (only 3 live calls; the 6 step lines were free).
- **Barge-in: STOP_AUDIO in 2 ms** (target was <100 ms).
- **Echo suppression: 5/5** — rejects our own voice, accepts real user speech.
- Per-product voices working (`anushka` / `abhilash` / `manisha`).
- 31 narration lines pre-synthesised for `saucedemo`; all 9 journeys backfilled with per-step lines.
- `npm run eval` still **25/25**.

## Four bugs found by building it (all fixed)

1. **Live synthesis is ~4 s on BOTH providers** (Sarvam 3785 ms, OpenAI 3855 ms). Pre-synthesis is therefore *not* an optimisation — it is the only thing that makes voice feel responsive. Consequence: the greeting and common phrases are now pre-warmed too, because the first thing a user hears would otherwise stall for four seconds.
2. **The sentence splitter broke decimals** — `$29.99` became `"$29." + "99"`, which TTS reads as "twenty-nine dot". Now protects digit-period-digit and requires a terminator followed by whitespace.
3. **Audio played out of order.** `seq` was assigned at *emit* time, so a cached step line (0 ms) overtook the dynamic intro line (4 s) that introduced it. Fixed by **reserving seq before synthesis**; the client sorts by seq and briefly holds gaps.
4. **Barge-in was a no-op.** The server treated "finished emitting" as "finished speaking", while the client still had ~40 s queued — so `onUserVoice()` saw state `listening` and did nothing. Fixed with **playback-aware state**: `audioOutstanding` increments per chunk sent and only clears when the client reports `audio_ended`.

> Bugs 3 and 4 share a root cause worth remembering: **in a voice system, "sent" is not "heard".**
> Ordering and turn state must both be defined by *playback*, which only the client knows.

## Still open
- **Real-microphone barge-in untested here** (no mic in this environment). The signal path is proven end-to-end with a synthetic `user_speaking`; the browser half needs a human.
- **Flow pause on interrupt is recorded (`turn.flowPaused`) but not yet resumed** — an interrupted journey stops rather than continuing where it left off.
- **No `audio_ended`-driven step pacing yet** — steps advance as fast as they emit, so on long lines speech can trail the clicks. `NARRATION_STEP_DELAY_MS` is the current lever.
- Sarvam returns WAV (~140 KB/line) vs OpenAI MP3 (~77 KB); consider MP3 for bandwidth at scale.


---

# T3b — resume + audio pacing (built)

## Audio pacing
The client now reports **`audio_played {seq}` per chunk** (not just queue-drained), and
`tts/sync.ts` (`AudioSync`) lets the server await a specific chunk. `replay()` speaks each step's line
and **waits until it has actually been heard** before performing the action, so the voice never
narrates a screen that already changed. Every wait is capped (`AUDIO_WAIT_CAP_MS`, default 12 s) — a
dropped event can slow a demo but can never wedge one.

## Resume of interrupted journeys
`runProgram` gained `shouldStop()` and `startAt`, so it stops cleanly **between** steps and reports
`stoppedAt`. The agent keeps a `paused` record (`flowName`, `program`, `nextIndex`, `url`) and exposes
a **`resume_flow`** tool; the turn prompt tells the model a paused walkthrough exists so it answers the
interruption first and then offers to continue.

Verified end-to-end:
```
[agent] "Proceed from the cart through checkout…" PAUSED at step 2/6 (prospect spoke)
        → answered an unrelated question about sorting
[agent] RESUMING "Proceed from the cart through checkout…" from step 2/6
```

## Two real bugs this surfaced

**1. Replay wasn't self-positioning — and the agent was right to refuse it.**
Programs are recorded from a clean start screen, so replaying one from wherever the prospect happens to
be is invalid (the first click may not exist). The agent noticed and improvised instead:
*"We're on a product details page, so I'll return to the catalog rather than…"* — which silently
bypassed the whole verified-replay mechanism. Fixed by recording `Journey.startUrl` and having replay
**reposition itself** before step 0. Only then did `DETERMINISTIC REPLAY … 0 model calls` actually fire.

**2. Resuming into a changed world fails.**
Answering the interruption navigated away and emptied the cart, so resuming at step 2 ran but was
meaningless (*"the cart is empty"*). Resume is now **state-aware**: if the URL has moved since the
pause, it restarts the flow from the top and says so, instead of continuing into broken state.

> Lesson: a paused walkthrough is not just an index — it's an index **plus the world it assumed**.

## Still open
- Real-microphone barge-in (no mic in this environment; the signal path is proven synthetically).
- Preconditions aren't re-satisfied on restart — the graph knows `requiresJourney`, but resume doesn't yet chain prerequisite flows to rebuild state (e.g. re-add a cart item).


---

# T4 — voice QUALITY rework (user feedback: "poor, it narrates text it already wrote")

The complaint was right, and the fix was not the engine. Three things were wrong:

### 1. It was writing prose for the eye and reading it aloud
Lines were documentation register with markdown, citations and raw UI ids
(`**Checkout: Overview**`, `product-sort-container`, `[Docs: …]`). Fixed at three levels:
- **Agent prompt**: "YOU ARE SPEAKING OUT LOUD… write DIALOGUE, not prose", hard cap of two short
  sentences / <30 words, never speak markdown, ids or screen titles verbatim.
- **Sanitiser** (`splitForSpeech`): strips brackets/markdown, turns slug ids into words, `A: B` → `A, B`,
  `/` → "or", `$29.99` → "29 dollars 99 cents", and cleans dangling punctuation.
- **Transcript = speech**: the chat panel now shows exactly what was said, so citations never appear.

### 2. One robotic line per mechanical step
Before: *"I enter the first name required for shipping." / "…the last name…" / "…the postal code…"*
After: **"I'll enter your shipping details, then continue."**
`describeSteps` now GROUPS steps and returns `"<step n>: <line>"`, so 6 UI steps become 2 spoken lines.
Measured across the 9 saucedemo journeys: 6→2, 6→4, 2→2, 1→1.
*(The earlier "one line per step with `-` placeholders" format silently failed on every multi-step
journey — the model returns only the grouped lines — leaving long walkthroughs unnarrated.)*

### 3. Text arrived before audio, so the voice felt like subtitles
`speak()` is now **voice-first**: the transcript is released when the first audio chunk is ready
(1.5 s grace cap so a slow provider can't hide it). Verified: AUDIO and TEXT land on the same
millisecond.

### Also fixed
- **`finish` was speaking a recap** ("Walked through checkout to the order review screen") — nobody
  narrates themselves. It is now a ≤12-word handover: *"Want me to add merchandise and review a real total?"*
- **Greeting was silent** — it fired before the speech engine existed. Now awaits it, and is pre-warmed
  per product: **audio at +10 ms**.
- **Truncation backstop clipped the greeting.** Counting sentences turned "Hi! I'm Aidan. Where would
  you like to start?" into "Hi! I'm Aidan." — short interjections no longer consume a sentence slot.

### Result
```
🗣 Hi! I'm Aidan. I can walk you through Swag Labs live. Where would you like to start?   (+10ms)
🗣 Let’s open your cart and head into checkout.
🗣 I’ll enter your shipping details, then continue.
🗣 You’re at the order review… I won’t finish an empty order—want to add merchandise first?
```
86–92% cache hit rate, **$0.00028** per spoken walkthrough, evals 25/25.

### Still open
- **Voice timbre itself** is a taste call I can't judge. `GET /api/voice/preview?speaker=X&provider=Y&text=…`
  returns audio so you can A/B speakers by ear; set the winner in `content/<id>/product.json → voice`.
- Live synthesis is still ~2–4 s, so any *unanticipated* sentence lags. Only pre-warming hides this.


---

# T5 — two workflows + conversational timing

## Two separate workflows (switchable mid-session)

| | **Text mode** 💬 | **Voice mode** 🎧 |
|---|---|---|
| Input | typing | mic (typing still works) |
| Output | **full written answer**, no audio ever | 2 short spoken sentences, transcript mirrors it |
| Mic button | hidden | shown |
| Verified | **0 audio chunks** | 4 chunks, ack in 16 ms |

Chosen at `POST /api/session {mode}`, toggled live via `{type:"set_mode"}` (the client remembers your
choice). Switching to text instantly flushes audio, so you're never talked over after asking for quiet.
Both modes do the same jobs — answer questions, explain features, run a demo — they just deliver
differently. Text mode is deliberately **not** capped to two sentences: reading tolerates length,
listening doesn't.

## Conversational timing (`tts/conversation.ts`)

Three things a person does that a TTS loop doesn't:

1. **Acknowledge instantly.** The model needs 15–20 s to think; silence reads as "it didn't hear me".
   A pre-cached phrase plays in **~16 ms** ("Good question." / "Sure." / "Let me take a look."), rotated
   so it never becomes a tic.
2. **Breathe.** Each audio chunk carries a `gapMs`: **280 ms** between sentences, **900 ms after a
   question** — because a person who asks something then waits. Butting sentences together is the
   clearest machine tell.
3. **Yield and reconnect.** Cut in and it says *"Sorry, go ahead."* and stops. Resume and it rejoins with
   *"Right, where were we."* instead of restarting mid-sentence.

## Nothing is hardcoded
Every phrase set and every duration has a code default but is overridable per product in
`content/<id>/product.json → voice.phrases` / `voice.pacing`, alongside `speaker`/`language`/`pace`.
A different product — or language — can sound completely different with **no code change**. All phrases
are pre-synthesised per product at onboarding (10 per product warmed), so they cost nothing and play
instantly; scalability is unchanged because this is all cache-side.

Evals: **25/25**.

## Still open
- Real-microphone barge-in and the felt quality of the voice — both need your ears.
- Live synthesis remains ~2–4 s, so a genuinely novel sentence still lags; only pre-warming hides it.
- No filler *during* long actions (a person might say "one sec…" while a page loads).
