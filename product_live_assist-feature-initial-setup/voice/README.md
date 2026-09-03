# Aidan Voice (speech → text)

A lean single-speaker STT WebSocket server, trimmed from the `live-assist-websocket-streaming`
project. Someone speaks into the mic → their words become Aidan chat input. **Output stays text**
(no TTS yet). Aidan already has its own brain, so this service does STT *only*.

## Run

```bash
# 1) speech-to-text server (from the aidan/ directory)
python3 -m venv .venv && ./.venv/bin/pip install -r voice/requirements.txt
./.venv/bin/python -m voice.server          # ws://127.0.0.1:8089  (mock mode, no key)

# 2) the Aidan app (separate terminal) — already running via server/
cd server && npm run dev                     # http://localhost:8787
```

Open the app, click **🎤**, and speak. Mock mode emits placeholder words (`word1 word2…`) so you can
verify the plumbing with zero keys. For real transcription, use Sarvam (below).

### Real STT (Sarvam)

In `aidan/.env`:

```
ASR_PROVIDER=sarvam
SARVAM_API_KEY=<your key>       # ⚠️ rotate the one hardcoded in the original repo
SARVAM_MODE=transcribe          # single speaker
SARVAM_LANGUAGE_CODE=en-IN
```

Then `./.venv/bin/pip install sarvamai` and restart the server.

## Dependency chart — what this needs vs. what was removed

**pip packages**

| Package | Status | Why |
|---|---|---|
| `websockets` | ✅ keep | the STT WebSocket server |
| `sarvamai` | ✅ keep (prod only) | Sarvam streaming ASR; not needed for mock |
| `httpx` | ❌ removed | only the live-feedback webhook + session API used it — both gone |
| `python-dotenv` | ❌ removed | config never imported it (it hand-parsed `.env`) |
| `pydantic`, `pydantic-settings` | ❌ removed | config is now a plain dataclass |

**runtime**: Python 3.12. (`audioop` is used *only* by the mock provider and is removed in Python
3.13 — on 3.13 either use Sarvam or swap mock's `audioop.rms` for the pure-Python `calculate_rms`.)

**internal modules (kept, trimmed)**

| File | From original | Kept for |
|---|---|---|
| `config.py` | `config/config.py` (~40 fields) | ASR + audio + finalize settings only |
| `audio.py` | `audio/pcm.py` | `pcm_to_wav_b64`, `calculate_rms`, `target_buffer_bytes` (mono) |
| `buffering.py` | `audio/buffering.py` | `UtteranceState`, `merge_transcript`, `build_final_transcript` |
| `asr.py` | `providers/asr/{factory,sarvam,mock}.py` | Sarvam + mock, one interface |
| `server.py` | `websocket_server.py` (~800 lines → ~150) | receive audio → VAD → ASR → finalize → emit |

**removed entirely (not useful for a single-speaker, own-brain agent)**

- **Two-speaker / stereo**: `split_stereo_to_mono`, customer/worker channels & labels, per-channel queues.
- **Echo / mic-bleed / overlap suppression**: `classify_worker_echo`, `text_similarity`, `recent_activity_summary`, `should_send_worker_stt`, all the `mic_bleed_*` / `echo_*` / `simple_overlap_*` settings — these only matter when a worker's mic bleeds into system audio.
- **External brain**: `forward_utterance`, the live-feedback webhook, `LIVE_ASSIST_RESULT`/`ERROR`, RAG timing — Aidan has its own model.
- **Session-management API**: heartbeat loop, silence auto-pause, `session_api_base_url`, the ASR pause/resume supervisor.
- **Desktop-native framing**: `AUDIO_CHUNK_META`, `native_seq` gap tracking, `input_source`/`desktop_audio_capture_mode`.
- **Instrumentation**: `audio/diagnostics.py`, `audio/terminal_log.py`, and all `diag_print`/`log_event`/`timing_log` calls.

## Wire protocol

Client → server: binary frames of **mono PCM16 @ 16 kHz**; optional `{"type":"flush"}` to force-finalize.
Server → client: `{"type":"ready"}`, `{"type":"partial","text":…}` (live), `{"type":"transcript","text":…,"is_final":true,"reason":…}` (finalized on silence).

The browser (`web/index.html`) captures the mic, streams PCM here, shows partials in the input, and on
a final transcript submits it to Aidan's existing chat — so speech becomes a normal Aidan turn.
