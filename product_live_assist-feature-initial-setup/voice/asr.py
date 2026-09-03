"""ASR providers. Trimmed from providers/asr/{factory,sarvam,mock}.py.

Interface (both providers): async context manager `connect()` yielding a
session that supports `await session.transcribe(audio=, encoding=, sample_rate=)`
and is async-iterable, producing messages with `.type == "data"` and
`.data.transcript`.

- mock:   no key, no network, deterministic — for local dev/tests.
- sarvam: production STT (needs `pip install sarvamai` + SARVAM_API_KEY).
"""
from __future__ import annotations

import asyncio
import audioop
import base64
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import AsyncIterator

from .config import Settings

_WAV_HEADER_BYTES = 44


def build_asr_provider(settings: Settings):
    if settings.asr_provider == "whisper":
        return WhisperASR(settings)
    if settings.asr_provider == "sarvam":
        return SarvamStreamingASR(settings)
    return MockStreamingASR(settings)


# ---------------- Whisper, local (default) ----------------


class WhisperASR:
    """Local Whisper via MLX (Metal on Apple Silicon).

    Chosen over the hosted streaming provider for three reasons, all measured:

    * **Accuracy.** On the same 2.7s sample Sarvam returned "Hello" and Whisper
      returned "Hello, show me how to create a new service." A demo agent that
      mishears the question is worse than a slow one.
    * **Timing we control.** Sarvam's stream delivered transcripts SECONDS after
      the audio, which raced our own end-of-speech detection and dropped whole
      utterances in silence. Whisper is a batch model: we decide when to run it,
      so there is no race to lose.
    * **Cost and deployment.** No key, no per-minute billing, no network hop.

    It is batch, not streaming, so we transcribe the buffered utterance once the
    caller decides speech has ended. Measured ~1.3s for 2.7s of audio on an M1
    Pro (2x realtime) with large-v3-turbo.
    """

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.model = settings.whisper_model
        import mlx_whisper  # imported lazily so other providers need no dep

        self._mlx = mlx_whisper

    @asynccontextmanager
    async def connect(self) -> AsyncIterator:
        session = _WhisperSession(self._mlx, self.model, self.settings)
        try:
            yield session
        finally:
            session.close()


class _WhisperSession:
    """Accumulates PCM and transcribes the whole utterance on demand."""

    def __init__(self, mlx, model: str, settings: Settings) -> None:
        self._mlx = mlx
        self._model = model
        self._settings = settings
        self._pcm = bytearray()
        self.queue: asyncio.Queue = asyncio.Queue()
        self.closed = False
        # Product vocabulary, set by the client at connect time. Whisper decodes
        # toward words it has just "seen", so naming the product and its screens
        # stops "Dolibarr" coming back as "DOLIBER". Supplied per connection so
        # this service stays product-agnostic and deployable on its own.
        self.prompt: str = ""

    async def transcribe(self, audio: str, encoding: str, sample_rate: int) -> None:
        """Buffer only — Whisper is far more accurate over a whole utterance
        than over 384ms fragments, and running it per fragment would burn CPU
        re-decoding the same words."""
        if self.closed:
            raise RuntimeError("whisper session is closed")
        self._pcm.extend(base64.b64decode(audio)[_WAV_HEADER_BYTES:])

    async def flush(self) -> str:
        """Transcribe everything buffered so far and reset. Runs in a thread so
        a CPU-bound decode never blocks the websocket event loop."""
        pcm, self._pcm = bytes(self._pcm), bytearray()
        if len(pcm) < self._settings.sample_rate:  # under ~0.5s is not speech
            return ""
        import numpy as np

        audio = np.frombuffer(pcm, dtype="<i2").astype("float32") / 32768.0

        prompt = self.prompt

        def run() -> str:
            kwargs = {"path_or_hf_repo": self._model}
            if prompt:
                kwargs["initial_prompt"] = prompt
            out = self._mlx.transcribe(audio, **kwargs)
            return (out.get("text") or "").strip()

        return await asyncio.to_thread(run)

    def close(self) -> None:
        self.closed = True

    def __aiter__(self) -> AsyncIterator:
        return self

    async def __anext__(self):
        message = await self.queue.get()
        if message is None:
            raise StopAsyncIteration
        return message


# ---------------- Sarvam (production) ----------------

class SarvamStreamingASR:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        if not settings.sarvam_api_key:
            raise ValueError("SARVAM_API_KEY is required for ASR_PROVIDER=sarvam")
        from sarvamai import AsyncSarvamAI  # imported lazily so mock mode needs no dep

        self.client = AsyncSarvamAI(api_subscription_key=settings.sarvam_api_key)

    @asynccontextmanager
    async def connect(self) -> AsyncIterator:
        async with self.client.speech_to_text_streaming.connect(
            model=self.settings.sarvam_model,
            mode=self.settings.sarvam_mode,
            language_code=self.settings.sarvam_language_code,
            high_vad_sensitivity=True,
            vad_signals=True,
        ) as ws:
            yield ws


# ---------------- Mock (no key, deterministic) ----------------

@dataclass
class _MessageData:
    transcript: str


@dataclass
class _Message:
    type: str
    data: _MessageData


class _MockSession:
    def __init__(self, energy_threshold: float) -> None:
        self.energy_threshold = energy_threshold
        self.queue: asyncio.Queue[_Message | None] = asyncio.Queue()
        self.voiced_chunks = 0
        self.closed = False

    async def transcribe(self, audio: str, encoding: str, sample_rate: int) -> None:
        if self.closed:
            raise RuntimeError("mock ASR session is closed")
        pcm = base64.b64decode(audio)[_WAV_HEADER_BYTES:]
        rms = audioop.rms(pcm, 2) if pcm else 0
        if rms > self.energy_threshold:
            self.voiced_chunks += 1
            partial = " ".join(f"word{i}" for i in range(1, self.voiced_chunks + 1))
            await self.queue.put(_Message(type="data", data=_MessageData(partial)))

    def __aiter__(self) -> AsyncIterator[_Message]:
        return self

    async def __anext__(self) -> _Message:
        message = await self.queue.get()
        if message is None:
            raise StopAsyncIteration
        return message

    async def close(self) -> None:
        self.closed = True
        await self.queue.put(None)


class MockStreamingASR:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    @asynccontextmanager
    async def connect(self) -> AsyncIterator[_MockSession]:
        session = _MockSession(float(self.settings.energy_threshold))
        try:
            yield session
        finally:
            await session.close()
