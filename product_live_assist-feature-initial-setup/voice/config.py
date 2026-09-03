"""Minimal config for the single-speaker STT service.

Trimmed from the original StreamingSettings (which had ~40 fields for a
two-speaker sales-call product). Kept only what single-mic STT needs.
Reads aidan/.env, then real env vars override. No pydantic dependency.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _load_env() -> dict[str, str]:
    values: dict[str, str] = {}
    env_file = Path(__file__).resolve().parents[1] / ".env"  # aidan/.env (shared)
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            s = line.strip()
            if not s or s.startswith("#") or "=" not in s:
                continue
            k, v = s.split("=", 1)
            values[k.strip()] = v.strip().strip('"').strip("'")
    values.update(os.environ)
    return values


@dataclass
class Settings:
    # server
    stream_host: str = "127.0.0.1"
    stream_port: int = 8089
    # provider: "whisper" (local, default) | "sarvam" (hosted) | "mock"
    asr_provider: str = "mock"
    # sarvam
    sarvam_api_key: str = ""
    sarvam_model: str = "saaras:v3"
    sarvam_mode: str = "transcribe"  # single speaker → transcribe (not translate)
    sarvam_language_code: str = "en-IN"
    # audio (mono PCM16)
    sample_rate: int = 16000
    chunk_size: int = 1024
    # 1024 samples x 3 = 192ms analysis packets at 16kHz.  The old value (6)
    # made both speech confirmation and end-of-speech detection operate in
    # 384ms jumps, adding roughly 1.5s around every short voice turn before the
    # recogniser even ran.
    buffer_chunks: int = 3
    # Microphone energy that counts as speech, as int16 RMS.
    #
    # Was 100 — which is 0.003 in the float units the browser uses, while the
    # browser's own "this is speech" threshold is 0.02. The server was therefore
    # 6.6x more trigger-happy than the client: room tone opened an utterance,
    # the audio went to Whisper, and Whisper hallucinated words onto silence
    # ("Scroll Scroll Scroll...", ". . . . ."). Those fake turns then cancelled
    # whatever Aidan was saying. Matched to the client so both agree on what
    # speech is; raise further in a noisy room.
    energy_threshold: int = 650
    # How long to let the ASR catch up after WE think you stopped talking.
    # Sarvam's streaming runs seconds behind the audio, so finalising the moment
    # our own energy VAD sees silence produced an EMPTY transcript and the turn
    # was dropped in total silence. Measured: words from one utterance arrived
    # only during the next.
    asr_grace_seconds: float = 2.5
    # Local Whisper (default provider).
    #
    # base.en is the default because it is MEASURED to be as good here and far
    # faster: on the same sample, base.en decoded in 86ms (31x realtime) and
    # large-v3-turbo in 1347ms (2.0x) — both returning exactly
    # "Hello, show me how to create a new service." A 1.3s decode is a second of
    # silence the listener feels; there is no reason to pay it for identical text.
    # Raise to small.en (194ms) or large-v3-turbo for accented or noisy audio.
    whisper_model: str = "mlx-community/whisper-base.en-mlx"
    # utterance finalization
    # Four 192ms quiet packets keep ordinary thinking pauses inside one turn.
    # Two packets (the previous live override) split "check July 28th" into
    # several user turns and each fragment cancelled the answer before it.
    low_energy_packet_target: int = 4
    max_utterance_seconds: float = 20.0


def get_settings() -> Settings:
    v = _load_env()

    def s(key: str, default: str) -> str:
        return v.get(key, v.get(key.lower(), default))

    return Settings(
        stream_host=s("STREAM_HOST", "127.0.0.1"),
        stream_port=int(s("VOICE_PORT", s("STREAM_PORT", "8089"))),
        asr_provider=s("ASR_PROVIDER", "mock"),
        sarvam_api_key=s("SARVAM_API_KEY", ""),
        sarvam_model=s("SARVAM_MODEL", "saaras:v3"),
        sarvam_mode=s("SARVAM_MODE", "transcribe"),
        sarvam_language_code=s("SARVAM_LANGUAGE_CODE", "en-IN"),
        sample_rate=int(s("SAMPLE_RATE", "16000")),
        chunk_size=int(s("CHUNK_SIZE", "1024")),
        buffer_chunks=int(s("BUFFER_CHUNKS", "3")),
        energy_threshold=int(s("ENERGY_THRESHOLD", "650")),
        asr_grace_seconds=float(s("ASR_GRACE_SECONDS", "2.5")),
        low_energy_packet_target=int(s("LOW_ENERGY_PACKET_TARGET", "4")),
        max_utterance_seconds=float(s("MAX_UTTERANCE_SECONDS", "20.0")),
    )


settings = get_settings()
