from __future__ import annotations

import base64
import io
import math
import wave

PCM_SAMPLE_WIDTH_BYTES = 2


def pcm_to_wav_b64(pcm_bytes: bytes, sample_rate: int) -> str:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(PCM_SAMPLE_WIDTH_BYTES)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm_bytes)
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


def calculate_rms(pcm_bytes: bytes) -> float:
    if len(pcm_bytes) < PCM_SAMPLE_WIDTH_BYTES:
        return 0.0
    samples = len(pcm_bytes) // PCM_SAMPLE_WIDTH_BYTES
    total = 0
    for index in range(0, len(pcm_bytes), PCM_SAMPLE_WIDTH_BYTES):
        sample = int.from_bytes(pcm_bytes[index:index + PCM_SAMPLE_WIDTH_BYTES], "little", signed=True)
        total += sample * sample
    return math.sqrt(total / samples)


def target_buffer_bytes(chunk_size: int, buffer_chunks: int) -> int:
    return chunk_size * buffer_chunks * PCM_SAMPLE_WIDTH_BYTES
