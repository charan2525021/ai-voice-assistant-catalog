from __future__ import annotations

import math
import os
from dataclasses import dataclass
from pathlib import Path


def _load_env() -> dict[str, str]:
    values: dict[str, str] = {}
    env_file = Path(__file__).resolve().parents[1] / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            value = line.strip()
            if not value or value.startswith("#") or "=" not in value:
                continue
            key, raw = value.split("=", 1)
            values[key.strip()] = raw.strip().strip('"').strip("'")
    values.update(os.environ)
    return values


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


@dataclass(frozen=True)
class Settings:
    stream_host: str
    stream_port: int
    sarvam_api_key: str
    sarvam_model: str
    sarvam_mode: str
    sarvam_language_code: str
    sample_rate: int
    chunk_size: int
    buffer_chunks: int
    energy_threshold: int
    asr_grace_seconds: float
    transcript_stability_seconds: float
    low_energy_packet_target: int
    speech_confirmation_packets: int
    max_utterance_seconds: float


def get_settings() -> Settings:
    values = _load_env()
    get = lambda key, default: values.get(key, default)
    sample_rate = 16000
    chunk_size = 1024
    buffer_chunks = 3
    packet_ms = chunk_size * buffer_chunks / sample_rate * 1000
    silence_ms = _clamp(float(get("VOICE_SILENCE_TIMEOUT_MS", "800")), 300, 3000)
    minimum_speech_ms = _clamp(float(get("VOICE_MIN_SPEECH_MS", "250")), 100, 2000)
    vad_threshold = _clamp(float(get("VOICE_VAD_THRESHOLD", "0.02")), 0.001, 0.5)
    return Settings(
        stream_host=get("VOICE_STT_HOST", "127.0.0.1"),
        stream_port=int(get("VOICE_STT_PORT", "8089")),
        sarvam_api_key=get("SARVAM_API_KEY", ""),
        sarvam_model=get("SARVAM_STT_MODEL", "saaras:v3"),
        sarvam_mode="transcribe",
        sarvam_language_code=get("VOICE_LANGUAGE_CODE", "en-IN"),
        sample_rate=sample_rate,
        chunk_size=chunk_size,
        buffer_chunks=buffer_chunks,
        energy_threshold=round(vad_threshold * 32768),
        asr_grace_seconds=_clamp(float(get("VOICE_ASR_GRACE_MS", "2500")), 500, 10000) / 1000,
        transcript_stability_seconds=_clamp(float(get("VOICE_TRANSCRIPT_STABILITY_MS", "500")), 200, 2000) / 1000,
        low_energy_packet_target=max(2, math.ceil(silence_ms / packet_ms)),
        speech_confirmation_packets=max(2, math.ceil(minimum_speech_ms / packet_ms)),
        max_utterance_seconds=_clamp(float(get("VOICE_MAX_UTTERANCE_MS", "20000")), 5000, 120000) / 1000,
    )


settings = get_settings()
