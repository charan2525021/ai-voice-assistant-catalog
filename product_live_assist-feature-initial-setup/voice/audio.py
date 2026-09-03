"""Mono PCM16 audio helpers. Trimmed from audio/pcm.py.

Dropped: split_stereo_to_mono (single mic = mono, no channel split).
"""
from __future__ import annotations

import base64
import io
import math
import wave

PCM_SAMPLE_WIDTH_BYTES = 2  # 16-bit


def pcm_to_wav_b64(pcm_bytes: bytes, sample_rate: int) -> str:
    """Wrap raw mono PCM16 in a WAV container, base64-encoded (what Sarvam wants)."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(PCM_SAMPLE_WIDTH_BYTES)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_bytes)
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def calculate_rms(pcm_bytes: bytes) -> float:
    """Loudness of a mono PCM16 chunk — the voice-activity signal for finalizing."""
    if len(pcm_bytes) < PCM_SAMPLE_WIDTH_BYTES:
        return 0.0
    samples = len(pcm_bytes) // PCM_SAMPLE_WIDTH_BYTES
    total = 0
    for i in range(0, len(pcm_bytes), PCM_SAMPLE_WIDTH_BYTES):
        sample = int.from_bytes(pcm_bytes[i : i + PCM_SAMPLE_WIDTH_BYTES], "little", signed=True)
        total += sample * sample
    return math.sqrt(total / samples)


def target_buffer_bytes(chunk_size: int, buffer_chunks: int) -> int:
    """Process audio in fixed chunks (~0.38s at the default 16kHz settings)."""
    return chunk_size * buffer_chunks * PCM_SAMPLE_WIDTH_BYTES
