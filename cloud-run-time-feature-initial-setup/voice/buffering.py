from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Callable


@dataclass
class UtteranceState:
    transcript_buffer: list[str] = field(default_factory=list)
    waiting_for_silence: bool = False
    consecutive_low_energy_packets: int = 0
    utterance_started_at: float | None = None
    transcript_revision: int = 0

    def reset(self) -> None:
        self.transcript_buffer.clear()
        self.waiting_for_silence = False
        self.consecutive_low_energy_packets = 0
        self.utterance_started_at = None
        self.transcript_revision = 0


def merge_transcript(buffer: list[str], new_text: str) -> bool:
    text = new_text.strip()
    if not text:
        return False
    if not buffer:
        buffer.append(text)
        return True
    last = buffer[-1]
    if text == last:
        return False
    if text.startswith(last):
        buffer[-1] = text
        return True
    if last.startswith(text):
        return False
    buffer.append(text)
    return True


def build_final_transcript(buffer: list[str]) -> str:
    return " ".join(part.strip() for part in buffer if part.strip()).strip()


async def wait_for_stable_transcript(
    state: UtteranceState,
    lock: asyncio.Lock,
    audio_queue: asyncio.Queue,
    *,
    timeout_seconds: float,
    stability_seconds: float,
    provider_final_event: asyncio.Event | None = None,
    superseded: Callable[[], bool] | None = None,
) -> tuple[str, bool]:
    """Wait until all submitted audio is sent and its transcript stops changing.

    Queue drain means the provider has received every captured audio packet. A
    provider-final signal is preferred over guessing finality from a quiet
    transcript. A short stability window then allows the final provider update
    to replace/extend the transcript. The timeout keeps provider failure
    bounded. ``superseded`` lets a caller abandon a silence endpoint if fresh
    speech resumes meanwhile.
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout_seconds
    try:
        await asyncio.wait_for(audio_queue.join(), timeout=max(0.01, deadline - loop.time()))
    except TimeoutError:
        pass

    if provider_final_event is not None and not provider_final_event.is_set():
        # Preserve time after END_SPEECH for the final data message, which may
        # be delivered immediately before or after the event depending on the
        # provider connection.
        final_wait = max(0.01, deadline - loop.time() - stability_seconds)
        try:
            await asyncio.wait_for(provider_final_event.wait(), timeout=final_wait)
        except TimeoutError:
            # Provider events are authoritative when present, but a missing
            # event must never freeze the microphone session.
            pass

    stable_revision = -1
    stable_since = loop.time()
    while loop.time() < deadline:
        if superseded and superseded():
            return "", True
        async with lock:
            text = build_final_transcript(state.transcript_buffer)
            revision = state.transcript_revision
        now = loop.time()
        if text:
            if revision != stable_revision:
                stable_revision = revision
                stable_since = now
            elif now - stable_since >= stability_seconds:
                return text, False
        await asyncio.sleep(min(0.05, max(0.01, deadline - now)))

    async with lock:
        return build_final_transcript(state.transcript_buffer), False
