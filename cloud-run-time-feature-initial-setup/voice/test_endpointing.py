from __future__ import annotations

import asyncio
import unittest

from voice.buffering import UtteranceState, merge_transcript, wait_for_stable_transcript


class TranscriptEndpointingTests(unittest.IsolatedAsyncioTestCase):
    async def test_waits_for_queued_audio_and_late_transcript_update(self) -> None:
        state = UtteranceState()
        lock = asyncio.Lock()
        queue: asyncio.Queue[bytes] = asyncio.Queue()
        await queue.put(b"last audio")

        async def provider() -> None:
            await asyncio.sleep(0.03)
            queue.get_nowait()
            queue.task_done()
            async with lock:
                merge_transcript(state.transcript_buffer, "go back")
                state.transcript_revision += 1
            await asyncio.sleep(0.04)
            async with lock:
                merge_transcript(state.transcript_buffer, "go back to smart report")
                state.transcript_revision += 1

        provider_task = asyncio.create_task(provider())
        text, superseded = await wait_for_stable_transcript(
            state,
            lock,
            queue,
            timeout_seconds=0.5,
            stability_seconds=0.08,
        )
        await provider_task
        self.assertFalse(superseded)
        self.assertEqual(text, "go back to smart report")

    async def test_can_abandon_a_silence_endpoint_when_speech_resumes(self) -> None:
        state = UtteranceState(transcript_buffer=["tell me"], transcript_revision=1)
        lock = asyncio.Lock()
        queue: asyncio.Queue[bytes] = asyncio.Queue()
        activity = {"revision": 1}

        async def resume() -> None:
            await asyncio.sleep(0.03)
            activity["revision"] += 1

        resume_task = asyncio.create_task(resume())
        text, superseded = await wait_for_stable_transcript(
            state,
            lock,
            queue,
            timeout_seconds=0.5,
            stability_seconds=0.1,
            superseded=lambda: activity["revision"] != 1,
        )
        await resume_task
        self.assertTrue(superseded)
        self.assertEqual(text, "")

    async def test_waits_for_provider_end_speech_and_its_final_transcript(self) -> None:
        state = UtteranceState(transcript_buffer=["go back to smart"], transcript_revision=1)
        lock = asyncio.Lock()
        queue: asyncio.Queue[bytes] = asyncio.Queue()
        provider_final = asyncio.Event()

        async def provider() -> None:
            await asyncio.sleep(0.04)
            provider_final.set()
            await asyncio.sleep(0.03)
            async with lock:
                merge_transcript(state.transcript_buffer, "go back to smart report please")
                state.transcript_revision += 1

        provider_task = asyncio.create_task(provider())
        text, superseded = await wait_for_stable_transcript(
            state,
            lock,
            queue,
            timeout_seconds=0.5,
            stability_seconds=0.08,
            provider_final_event=provider_final,
        )
        await provider_task
        self.assertFalse(superseded)
        self.assertEqual(text, "go back to smart report please")

    async def test_missing_provider_end_speech_uses_bounded_fallback(self) -> None:
        state = UtteranceState(transcript_buffer=["continue"], transcript_revision=1)
        lock = asyncio.Lock()
        queue: asyncio.Queue[bytes] = asyncio.Queue()
        provider_final = asyncio.Event()
        started = asyncio.get_running_loop().time()
        text, superseded = await wait_for_stable_transcript(
            state,
            lock,
            queue,
            timeout_seconds=0.15,
            stability_seconds=0.05,
            provider_final_event=provider_final,
        )
        self.assertLess(asyncio.get_running_loop().time() - started, 0.3)
        self.assertFalse(superseded)
        self.assertEqual(text, "continue")


if __name__ == "__main__":
    unittest.main()
