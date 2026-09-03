# NirogGyan brochure guided-demo test

This directory is the Phase 6.5B/6.5C staging surface for the real target:

- logical site: `https://brochure.niroggyan.com`
- canonical browser origin: `https://www.brochure.niroggyan.com`
- catalog: `niroggyan-brochure-v2-test`
- installation: `niroggyan-brochure-guided-demo-test-installation`

The original `niroggyan-brochure-v1` artifacts remain unchanged. Generate this
test version from the `sable-cloud-runtime` directory:

```sh
npm run niroggyan:guided-demo:generate
npm run niroggyan:guided-demo:verify
```

## What is configured

- two generic lead-capture questions;
- deterministic diagnostic-lab and hospital persona matching from the first answer only;
- one optional persona question whose answer is stored as lead context, not scored;
- signed default, diagnostic-lab, and hospital module playlists;
- eight modules backed only by approved `demoSafe` journeys;
- bounded brochure sales-knowledge chunks for product, value, proof, positioning, objection, and next-action answers;
- stable route/text/ARIA selectors only;
- no external Viz App, dashboard, niro.health, pricing, login, or booking submission authority.

The two transient UI demonstrations use composite journeys. They open the
WhatsApp or scheduling preview, keep it visible while the signed narration is
spoken, and close it before playlist advancement.

## Recording boundary

The correct brochure catalog currently has no approved audio bytes whose exact
transcript can be cryptographically tied to the file. Therefore the signed
catalog uses exact signed text and runtime TTS fallback. The generated
`recording-manifest.source.json` lists every required recording slot. Once the
approved brochure recordings arrive, add their SHA-256 metadata and exact
`audioAssetId` references; never reuse unrelated `niro.health` cache files.

## One-command live brochure test

The repeatable path uses one temporary HTTPS endpoint. It serves the SDK/UI,
mints short-lived identity tokens, and proxies runtime HTTP and WebSocket
traffic to the local runtime. The permanent installation credential remains on
the local machine.

From `sable-cloud-runtime`, run:

```sh
npm run niroggyan:guided-demo:live
```

The launcher builds the current code, starts the NirogGyan guided runtime,
opens a temporary Cloudflare tunnel, starts the test gateway, and prints two
single-line DevTools Console snippets:

- an automated, text-only diagnostic-lab demo that starts and answers intake;
- a manual voice demo that waits for the user to click **Start Demo**, which is
  required to unlock browser audio reliably.

Keep the launcher running throughout the test and press Ctrl-C to stop all
three temporary processes. Tokens and tunnel addresses are generated for that
run and are not written into the repository.

## Earlier two-tunnel layout

The one-command gateway supersedes the earlier two-tunnel instructions below.
They are retained only as architectural context.

### Phase 6.5C local and tunnel layout

Two short-lived Cloudflare tunnels are intentional:

```text
brochure page
  -> runtime HTTPS tunnel -> local cloud runtime :8787 (HTTP + WebSocket)
  -> asset HTTPS tunnel   -> local test host :8790 (SDK bundles + short-lived token broker)
```

The asset/token host keeps the permanent installation credential on the local
machine. The browser receives only a one-minute identity token scoped to the
canonical brochure origin and public role.

### 1. Start the runtime tunnel

```sh
cloudflared tunnel --url http://127.0.0.1:8787 --no-autoupdate
```

Copy its `https://...trycloudflare.com` URL as `RUNTIME_TUNNEL_URL`.

### 2. Start the cloud runtime

Use a fresh secret of at least 32 characters. Provider credentials remain in
the local environment and must not be added to this directory.

```sh
RUNTIME_STORE=file \
RUNTIME_FILE=./data/niroggyan-brochure-guided-demo-runtime.generated.json \
TOKEN_SIGNING_SECRET=<local-32-character-secret> \
PUBLIC_API_URL=<RUNTIME_TUNNEL_URL> \
npm run dev
```

### 3. Start the asset tunnel

```sh
cloudflared tunnel --url http://127.0.0.1:8790 --no-autoupdate
```

Copy its HTTPS URL as `ASSET_TUNNEL_URL`.

### 4. Start the ephemeral asset/token host

Create a new random broker secret for every live test. It is not an
installation credential and should be discarded when the tunnels stop.

```sh
PUBLIC_API_URL=<RUNTIME_TUNNEL_URL> \
BROCHURE_TEST_ASSET_URL=<ASSET_TUNNEL_URL> \
BROCHURE_TEST_BROKER_SECRET=<random-24-plus-character-test-secret> \
npm run niroggyan:guided-demo:host
```

The host prints the one-use test injection URL. Injection and live interaction
belong to Phase 6.5D and must not be performed during Phase 6.5C.

## Origin rule

The installation's `allowedOrigins` remains exactly:

```json
["https://www.brochure.niroggyan.com"]
```

Neither Cloudflare URL belongs in `allowedOrigins`. They are service endpoints;
the page executing the SDK remains the canonical brochure origin.

## Shutdown

After the live acceptance run, stop the runtime, test host, and both quick
tunnels. Quick-tunnel URLs and the broker secret are temporary and must not be
committed or treated as production deployment configuration.
