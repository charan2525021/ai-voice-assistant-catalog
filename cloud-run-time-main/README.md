# Sable Cloud Runtime

This repository is the hosted half of Sable's Web SDK proof of concept. Think of it as an air-traffic controller: it understands a request and authorizes a known route, while the SDK inside the customer's page remains the pilot that touches the product.

## Scope boundary

The runtime starts with a finished, signed Web SDK catalog. It does not map a product, plan training journeys, record selectors, run a training review, or compile legacy training data. Those responsibilities stay in the existing training repository without behavioral changes.

The runtime has no Playwright dependency. Playwright is allowed only in the unchanged training system, Gate 1 verification, and external browser tests. During a real user session, the Web SDK observes and acts inside the user's own page.

## Spoken request flow

1. A user taps the SDK's Mic button. Browser permission is requested only then.
2. The SDK converts microphone audio to mono PCM16 at 16 kHz and sends temporary frames over a one-use authenticated voice socket.
3. Sarvam Saaras transcribes the audio. Raw audio is never written to a store or log.
4. The final transcript follows the same `TurnOrchestrator` as typed text.
5. Deterministic rules handle obvious intent; the configured reasoning service classifies ambiguous requests.
6. The runtime loads eligible approved journeys and documentation from the selected file or PostgreSQL store.
7. Questions about the current page trigger a new, turn-correlated, privacy-filtered SDK observation. A stale or unrelated observation is ignored.
8. The reasoning model either answers, asks one clarification, or names one eligible journey with inputs.
9. The runtime independently validates that journey. It sends only the journey ID and inputs—never selectors, coordinates, JavaScript, or low-level clicks.
10. The SDK executes and verifies the signed workflow locally. The runtime reports success only after the matching result arrives.
11. For a voice turn, Sarvam Bulbul creates short-lived audio and the SDK plays it. Text remains visible if synthesis or playback fails.

## Separation by code

- `src/providers`: provider interfaces plus native Anthropic, generic OpenAI-compatible reasoning, and Sarvam speech adapters.
- `src/stores`: one runtime contract implemented by local files and PostgreSQL.
- `src/orchestrator.ts`: intent, evidence, journey eligibility, clarification, and final decision flow.
- `src/server.ts`: identity, sessions, control/voice WebSockets, correlated commands, and ephemeral audio delivery.
- `migrations`: runtime-only PostgreSQL tables with forced tenant row-level security.
- `sample-app`: deterministic product with documentation, a private field, page facts, normal journeys, and an approval journey.

Provider interfaces make later additions possible without changing the orchestration or browser protocol. Reasoning can use native Anthropic or an OpenAI-compatible endpoint such as LLMAPI.ai or OpenAI. Speech remains on Sarvam.

## Cross-page continuity

The browser keeps a bounded same-tab display cache in `sessionStorage`. The
runtime keeps the authoritative reasoning history in `runtime_continuities` in
PostgreSQL mode. Both expire after 30 minutes idle or eight hours absolute, and
logout deletes the active continuity record.

On a same-origin full-page load, the new SDK connection sends its opaque
continuity ID and browser checkpoint. If a matching server record exists, the
server record wins. Browser-supplied transcript is treated only as untrusted
context and is never accepted as proof that an action succeeded.

Cross-origin navigation uses `POST /api/v3/sdk/handoffs` and
`POST /api/v3/sdk/handoffs/consume`. The URL carries only a random one-use code;
the snapshot remains server-side, expires after two minutes, and is bound to the
installation, user, role, catalog, exact destination URL and approved origin.
The runtime resumes only an approved read-risk catalog journey after a fresh
destination observation matches one of its trained screen IDs.

## Run the file-backed POC

Requirements: Node.js 20 or newer and built SDK bundles in the sibling `product_live_assist` repository.

```bash
npm install
npm run sample:generate
cp .env.example .env
```

Set a reasoning credential, `SARVAM_API_KEY`, and a new `TOKEN_SIGNING_SECRET` of at least 32 characters in `.env`. `SARVAM_API_KEY` is optional when testing text only. Then set:

```text
RUNTIME_STORE=file
RUNTIME_FILE=./data/sample-runtime.generated.json
```

Start the runtime and sample product in two terminals:

```bash
npm run dev
npm run sample:serve
```

Open `http://localhost:4173`. Generated signing material and the permanent installation credential are written only to ignored files. The browser receives the public catalog verification key, never the installation credential or provider keys.

### Reasoning provider choice

Native Anthropic uses Anthropic's own Messages API:

```text
REASONING_PROVIDER=anthropic
ANTHROPIC_API_KEY=your-key
ANTHROPIC_MODEL=claude-sonnet-4-5
```

LLMAPI.ai uses the OpenAI-compatible adapter:

```text
REASONING_PROVIDER=openai_compatible
OPENAI_COMPATIBLE_BASE_URL=https://api.llmapi.ai/v1
LLM_API_KEY=your-key
OPENAI_COMPATIBLE_MODEL=gpt-4o
```

Direct OpenAI uses the same adapter with `https://api.openai.com/v1` and `OPENAI_API_KEY`. `OPENAI_COMPATIBLE_API_KEY` is the provider-neutral key name and takes priority when more than one key variable is present. `REASONING_MODEL` can override either provider's model. Changing providers does not change retrieval, journey validation, SDK messages, or action safety.

## PostgreSQL mode

Apply `migrations/001_runtime.sql` with a database owner/migration role, generate the sample, and import it:

```bash
DATABASE_URL=postgres://... npm run postgres:import
```

Then set `RUNTIME_STORE=postgres` and `DATABASE_URL`. File and PostgreSQL stores expose the same catalog, knowledge, installation, session, continuity, one-time handoff, and event interfaces, so the turn behavior does not change. File mode keeps continuity and handoffs in process and is intended only for local development.

For production, the runtime database user should not own the tables and should not have `BYPASSRLS`; the migration forces row-level security. The import command is intentionally an operator/migration action.

## Runtime administration

Set a separate `ADMIN_API_KEY` to use the authenticated installation endpoints. They create, list, rotate, revoke, and report on installations under `/api/v3/sdk/installations`. A new permanent credential is returned only at creation or rotation; every store keeps only its SHA-256 digest. These endpoints are runtime administration only and do not edit training data or catalogs.

### Guided-demo configuration ownership

The guided-demo runtime is client-agnostic: it reads a signed `demoProfile` and never hardcodes a client's questions, personas, recordings, playlists, modules, or journey IDs. Those values are client-specific catalogue configuration. The current POC prepares that configuration outside the runtime and publishes it as part of the signed catalogue.

The intended production administration module must let an authorised operator configure and publish, per client and catalogue version:

- the greeting, two generic lead-capture questions, optional persona questions, and closing;
- persona names and deterministic classifier signals;
- the default playlist and persona-to-playlist mappings;
- demo modules and their mappings to existing approved `demoSafe` journeys; and
- approved recording metadata and assets.

Changing those values must create a new validated, signed catalogue version; it must not require a runtime or SDK code change. The admin module is a later control-plane feature and is not implemented in this repository yet. The runtime continues to fail closed when a profile references a missing, unapproved, role-ineligible, unsupported, or non-`demoSafe` journey.

### Guided-demo interruption planning boundary

Greeting, intake, deterministic persona mapping, recorded module playback, and normal module advancement do not call the reasoning model. When a prospect interrupts a playing module, the SDK first pauses at a verified atomic boundary. Only after that checkpoint does the bounded interruption planner receive the prospect's current request, small recent transcript, captured lead context, current demo position, current screen ID, and the IDs/names of eligible signed demo modules.

The planner returns structured data only: one intent, one response mode, one playback directive, a knowledge-needed flag, and optionally one exact configured replacement module. It cannot return selectors, primitive browser actions, journey inputs, generated journeys, qualification decisions, sales strategy, or user-facing prose. Deterministic policy then validates the combination, forces fresh observation for screen questions, forces knowledge grounding for product/how-to/objection turns, keeps clarification paused, and rejects invented or non-`demoSafe` module replacements. The validated plan is stored in runtime continuity. Knowledge/play retrieval and generation of the actual interruption answer are subsequent runtime phases; Phase 4 does not silently treat a planning decision as execution authority.

### Guided-demo sales-play grounding

After interruption policy validation, the runtime—not the planner model—derives whether sales-play retrieval is allowed. Product questions may use approved product-answer, value-proposition, proof, or positioning chunks; objections may use approved objection-response, proof, positioning, or value-proposition chunks; how-to questions may use product-answer chunks. Screen questions normally use the fresh page observation alone and retrieve product-answer or proof chunks only when the validated plan also requires product knowledge. Direct continue/stop commands, clarification turns, and ordinary conversation retrieve no sales plays.

The retriever reads only `salesPlays` from the session's pinned signed catalogue. It first enforces allowed play kind and persona eligibility, then deterministically ranks signal-phrase, title/content, active-journey, and persona matches. It returns at most three play IDs. Play content remains in the signed catalogue and is resolved by ID for the eventual answer phase; continuity does not copy editable sales content. A play can ground wording, but `suggestedJourneyId`, `next_best_action`, and every other play field remain non-authoritative: they cannot start, replace, or modify a journey. Embedding retrieval and another LLM call are intentionally unnecessary for this bounded catalogue path; semantic product documents continue to use the existing knowledge-retrieval path.

### Guided-demo interruption answers and natural resume

The response model is called only after interruption planning and play grounding. It receives the current question, validated intent/mode, active signed module, small captured lead context, four recent transcript items, at most three resolved play chunks, and—only when policy requires it—a fresh privacy-filtered screen observation. It returns wording only, capped at 90 spoken words. It has no tools and cannot choose playback behavior. Clarification and direct playback controls use deterministic wording and avoid this second model call.

The runtime appends its own exact transition sentence and waits for answer audio to drain before applying the validated directive. `resume_after_answer` and `resume_now` continue from the SDK's exact atomic checkpoint; `remain_paused` reopens listening without moving the product; `stop` abandons the checkpoint and stops the demo; `replace_module` first clears the paused journey and then runs only the exact approved, role-eligible, `demoSafe` module validated in Phase 4. A screen-observation timeout disables automatic resume and leaves the demo paused rather than answering from stale UI state.

Recorded demo cues are also ordered with product execution. The SDK waits for greeting/question/module-introduction cues before handling a following command, and waits for module-completion or failure cues before reporting the journey result that advances the cloud playlist. Consequently the next module cannot begin while the prior module's human-style completion narration is still playing. Closing uses the same serial SDK cue ordering, with signed duration metadata retained as the cloud's bounded reconnect fallback.

## Configuration

The complete starting set is in `.env.example`. Important voice defaults are:

| Setting | Default | Safe range |
|---|---:|---:|
| `VOICE_SILENCE_TIMEOUT_MS` | 800 | 300–3,000 ms |
| `VOICE_MIN_SPEECH_MS` | 250 | 100–2,000 ms |
| `VOICE_MAX_UTTERANCE_MS` | 30,000 | 5,000–120,000 ms |
| `VOICE_AUDIO_FRAME_MS` | 40 | 20–100 ms |
| `VOICE_VAD_SENSITIVITY` | 0.55 | 0.1–0.95 |
| `VOICE_STT_FINAL_TIMEOUT_MS` | 5,000 | 1,000–15,000 ms |
| `VOICE_TTS_START_TIMEOUT_MS` | 8,000 | 2,000–20,000 ms |
| `VOICE_NARRATION_TIMEOUT_MS` | 15,000 | 3,000–30,000 ms |

Numbers are validated and clamped to server-owned safety ranges. Tenant values can narrow important limits but cannot expand server maxima. Hard safety rules—no raw-audio storage, no remote selectors, no arbitrary code, no unapproved journey, no unverified success, and no cross-page write action—are not configuration switches.

Other deployment settings cover model names/timeouts/retries, retrieval size/deadline, observation limits, session/ticket lifetimes, rate and audio limits, public URL, origins, speaker/language, barge-in, and speech mode.

## Verification

```bash
npm run typecheck
npm test
npm run build
```

Tests cover configuration boundaries, both reasoning protocols, credential/token security, mandatory fresh page observations, and invented-journey rejection. The parent SDK suite covers signed catalogs, privacy filtering, local safety, workflow execution, and browser-independent audio resampling.

## Current POC limits

- Sarvam TTS uses its REST endpoint and a one-use runtime URL. The provider interface can switch to Sarvam's WebSocket stream later without changing the SDK protocol.
- Runtime sessions are in process in file mode; PostgreSQL mode persists them.
- The legacy live runtime remains available during validation. Removing it is a separate cutover after acceptance.
- A production pilot still needs deployed secrets, TLS, DNS, monitoring credentials, and live reasoning/Sarvam quota.
