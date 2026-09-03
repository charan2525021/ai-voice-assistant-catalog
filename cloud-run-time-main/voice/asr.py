from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncIterator

from .config import Settings


class SarvamStreamingASR:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        if not settings.sarvam_api_key:
            raise ValueError("SARVAM_API_KEY is required for STT_PROVIDER=sarvam")
        from sarvamai import AsyncSarvamAI
        self.client = AsyncSarvamAI(api_subscription_key=settings.sarvam_api_key)

    @asynccontextmanager
    async def connect(self) -> AsyncIterator:
        async with self.client.speech_to_text_streaming.connect(
            model=self.settings.sarvam_model,
            mode=self.settings.sarvam_mode,
            language_code=self.settings.sarvam_language_code,
            high_vad_sensitivity=True,
            vad_signals=True,
        ) as socket:
            yield socket


def build_asr_provider(settings: Settings) -> SarvamStreamingASR:
    return SarvamStreamingASR(settings)
