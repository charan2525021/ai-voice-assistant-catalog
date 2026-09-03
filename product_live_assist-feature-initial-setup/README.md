# Sable AI employee — merged backend

> Merge scope and component choices: [`MERGE_DECISIONS.md`](MERGE_DECISIONS.md).

> **New to this codebase? Start with [`HANDOFF.md`](HANDOFF.md)** — current architecture,
> component reference, the hard-won gotchas, commands and verified state.

An AI sales engineer that runs a **live, interactive product demo**: it drives a real product in a
browser, talks to the buyer, watches the shared screen, and answers questions. Self-contained and
open-source — **no paid services required**. See [`../BUILD_PLAN.md`](../BUILD_PLAN.md) for the full teardown.

## Run it (zero config)

```bash
npm install
npx playwright install chromium   # one-time, downloads the open-source browser
npm run dev --workspace aidan-server
```

Open **http://localhost:8787**. You'll see a real browser (local Chromium) loading a demo app,
streamed live — **you can click around in it yourself**. Then give Aidan a brain (below) and ask it
to show you things in chat.

## Give Aidan a brain (pick one)

Everything runs without a model except Aidan's *replies*. Enable reasoning with either:

- **Anthropic (best):** put `ANTHROPIC_API_KEY=...` in `aidan/.env` (copy from `.env.example`).
- **Fully local, zero cloud (Ollama):** `ollama pull qwen2.5vl`, then in `.env` set
  `MODEL_PROVIDER=openai` (defaults point at `http://localhost:11434/v1`).

Then restart `npm run dev`.

## Demo your own product

In `aidan/.env` set `DEMO_START_URL` (and `DEMO_NAME`) to your app. If it needs a login, set
`DEMO_AUTH_MODE=login` + `DEMO_USERNAME`/`DEMO_PASSWORD`. No integration required — Aidan drives the
real UI.

## Architecture

```
web/            zero-build client — live browser view (screencast) + chat + takeover
server/
  livebox.ts    local Chromium (Playwright): Hands (click/type/nav), Eyes (snapshot), screencast
  brain.ts      pluggable model: Claude (Anthropic SDK) OR any OpenAI-compatible / Ollama endpoint
  agent.ts      the talk+act loop (computer use over a DOM-grounded action space)
  server.ts     Fastify + ws gateway: streams frames, forwards input, runs chat
db/             Postgres + pgvector durable multi-tenant product/catalog/knowledge store
```

The scalable backend, deployment variables, publish lifecycle, and migration
path are documented in [`DURABLE_BACKBONE.md`](DURABLE_BACKBONE.md).

The in-page production path is the new [Sable Web SDK](WEB_SDK.md). It runs in
the end user's real logged-in browser, consumes a signed role-scoped catalog,
and performs only locally verified high-level journeys. The existing LiveBox
path and `RuntimeBundle v1` remain only for legacy remote-browser deployments.

The browser UI now prefers the durable `/api/v2` product, mapping, knowledge,
catalog and session path whenever `DATABASE_URL` is enabled. Public customer
embeds use revocable product+role grants with an origin allowlist; configure
`EMBED_TOKEN_SECRET` before issuing them.

To run the durable stack locally:

```bash
docker compose up -d
DATABASE_ADMIN_URL=postgres://aidan:aidan@localhost:5433/aidan ADMIN_ORG_ID=00000000-0000-4000-8000-000000000001 npm run db:migrate --workspace aidan-server
npm test
```

Verify the browser engine works with no model/keys:

```bash
node --import tsx server/src/test-livebox.ts
```

## Implemented runtime

- **Hands + eyes:** live browser, screen state, verified actions and user takeover.
- **Product brain:** documentation ingestion, screen/journey graph and evidence-grounded answers.
- **Voice:** streaming STT, TTS, playback acknowledgement and interruption handling.
- **Durable scale path:** tenant-scoped PostgreSQL catalogs, mapping jobs, credentials and embeds.

## Voice (speak to Aidan)

A lean STT service lives in [`voice/`](voice/). Run it alongside the app:

```bash
python3 -m venv .venv && ./.venv/bin/pip install -r voice/requirements.txt
./.venv/bin/python -m voice.server     # ws://127.0.0.1:8089 (mock mode, no key)
```

Then the 🎤 button in the UI streams your mic to it and feeds transcripts into chat. Swap mock → Sarvam
via `ASR_PROVIDER=sarvam` + `SARVAM_API_KEY` in `.env`. Full dependency chart: [`voice/README.md`](voice/README.md).
