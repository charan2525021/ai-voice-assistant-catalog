from __future__ import annotations

import asyncio
import json
import re
import time

import websockets

from .asr import build_asr_provider
from .audio import calculate_rms, pcm_to_wav_b64, target_buffer_bytes
from .buffering import UtteranceState, build_final_transcript, merge_transcript
from .config import settings
from .guards import strip_repetition


async def handle_client(socket) -> None:
    try:
        await serve(socket)
    except Exception as error:
        try:
            await socket.send(json.dumps({"type": "error", "text": f"Speech-to-text unavailable: {str(error)[:300]}"}))
        except Exception:
            pass


async def serve(socket) -> None:
    provider = build_asr_provider(settings)
    state = UtteranceState()
    lock = asyncio.Lock()
    audio_buffer = b""
    preroll_chunks: list[bytes] = []
    target = target_buffer_bytes(settings.chunk_size, settings.buffer_chunks)
    low_energy = 0
    stt_queue: asyncio.Queue[bytes | None] = asyncio.Queue()
    send_lock = asyncio.Lock()
    packet_ms = round(target / (2 * settings.sample_rate) * 1000)
    timing = {"candidate_at": None, "speech_at": None, "last_voice_at": None}

    async def emit(payload: dict) -> None:
        async with send_lock:
            try:
                await socket.send(json.dumps(payload))
            except Exception:
                pass

    speaking = {"active": False, "quiet": 0, "loud": 0}

    async def note_voice_activity(rms: float) -> None:
        voiced = rms >= settings.energy_threshold
        if voiced:
            now = time.perf_counter()
            speaking["quiet"] = 0
            speaking["loud"] += 1
            if speaking["loud"] == 1:
                timing["candidate_at"] = now
            timing["last_voice_at"] = now
            if not speaking["active"] and speaking["loud"] >= settings.speech_confirmation_packets:
                speaking["active"] = True
                timing["speech_at"] = timing["candidate_at"] or now
                await emit({"type": "speech_start", "timing": {"detection_ms": packet_ms * settings.speech_confirmation_packets}})
            if speaking["active"]:
                async with lock:
                    state.waiting_for_silence = True
                    if state.utterance_started_at is None:
                        state.utterance_started_at = time.time()
        else:
            speaking["loud"] = 0
            if not speaking["active"]:
                timing["candidate_at"] = None
            speaking["quiet"] += 1
            if speaking["active"] and speaking["quiet"] >= 2:
                speaking["active"] = False

    async with provider.connect() as asr_socket:
        async def stt_sender() -> None:
            while True:
                pcm = await stt_queue.get()
                if pcm is None:
                    return
                try:
                    await asr_socket.transcribe(audio=pcm_to_wav_b64(pcm, settings.sample_rate), encoding="audio/wav", sample_rate=settings.sample_rate)
                except Exception:
                    pass

        async def reader() -> None:
            async for message in asr_socket:
                if getattr(message, "type", None) != "data":
                    continue
                text = (getattr(getattr(message, "data", None), "transcript", "") or "").strip()
                if not text:
                    continue
                async with lock:
                    merge_transcript(state.transcript_buffer, text)
                    state.waiting_for_silence = True
                    state.consecutive_low_energy_packets = 0
                    if state.utterance_started_at is None:
                        state.utterance_started_at = time.time()
                    partial = build_final_transcript(state.transcript_buffer)
                await emit({"type": "partial", "text": partial})

        finalizing = {"busy": False}

        async def finalize(reason: str) -> None:
            nonlocal low_energy
            if finalizing["busy"]:
                return
            finalizing["busy"] = True
            try:
                finalize_at = time.perf_counter()
                deadline = time.time() + settings.asr_grace_seconds
                while time.time() < deadline:
                    async with lock:
                        if build_final_transcript(state.transcript_buffer):
                            break
                    await asyncio.sleep(0.1)
                decoded_at = time.perf_counter()
                async with lock:
                    final_text = build_final_transcript(state.transcript_buffer)
                    state.reset()
                low_energy = 0
                speaking["active"] = False
                speaking["quiet"] = 0
                speaking["loud"] = 0
                voice_timing = {
                    "packet_ms": packet_ms,
                    "endpoint_ms": round((finalize_at - timing["last_voice_at"]) * 1000) if timing["last_voice_at"] else None,
                    "decode_ms": round((decoded_at - finalize_at) * 1000),
                    "speech_to_final_ms": round((decoded_at - timing["speech_at"]) * 1000) if timing["speech_at"] else None,
                }
                timing["candidate_at"] = timing["speech_at"] = timing["last_voice_at"] = None
                final_text = strip_repetition(final_text)
                words = re.findall(r"[a-z0-9]+", final_text.lower())
                looping = len(words) >= 6 and len(set(words)) <= max(2, len(words) // 8)
                if looping or not words or sum(len(word) for word in words) < 2:
                    await emit({"type": "no_speech", "reason": reason, "timing": voice_timing})
                else:
                    await emit({"type": "transcript", "text": final_text, "is_final": True, "reason": reason, "timing": voice_timing})
            finally:
                finalizing["busy"] = False

        async def receive_audio() -> None:
            nonlocal audio_buffer, low_energy
            async for message in socket:
                if isinstance(message, str):
                    try:
                        control = json.loads(message)
                        if control.get("type") == "flush":
                            await finalize("client_flush")
                        elif control.get("type") == "vocabulary":
                            terms = str(control.get("terms") or "").strip()[:400]
                            if terms and hasattr(asr_socket, "prompt"):
                                asr_socket.prompt = terms
                    except Exception:
                        pass
                    continue
                if not isinstance(message, (bytes, bytearray)):
                    continue
                audio_buffer += bytes(message)
                while len(audio_buffer) >= target:
                    chunk, audio_buffer = audio_buffer[:target], audio_buffer[target:]
                    rms = calculate_rms(chunk)
                    await note_voice_activity(rms)
                    if speaking["active"]:
                        for held in preroll_chunks:
                            await stt_queue.put(held)
                        preroll_chunks.clear()
                        await stt_queue.put(chunk)
                    else:
                        preroll_chunks.append(chunk)
                        if len(preroll_chunks) > 3:
                            preroll_chunks.pop(0)
                    async with lock:
                        waiting = state.waiting_for_silence
                        started = state.utterance_started_at
                    if not waiting:
                        continue
                    low_energy = low_energy + 1 if rms < settings.energy_threshold else 0
                    too_long = started is not None and time.time() - started >= settings.max_utterance_seconds
                    if low_energy >= settings.low_energy_packet_target:
                        await finalize("silence")
                    elif too_long:
                        await finalize("max_duration")

        await emit({"type": "ready", "provider": "sarvam"})
        reader_task = asyncio.create_task(reader())
        sender_task = asyncio.create_task(stt_sender())
        receiver_task = asyncio.create_task(receive_audio())
        try:
            done, _ = await asyncio.wait({receiver_task, reader_task, sender_task}, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        finally:
            try:
                await finalize("connection_closed")
            except Exception:
                pass
            await stt_queue.put(None)
            for task in (receiver_task, reader_task, sender_task):
                if not task.done():
                    task.cancel()
            await asyncio.gather(receiver_task, reader_task, sender_task, return_exceptions=True)


async def main_async() -> None:
    async with websockets.serve(handle_client, settings.stream_host, settings.stream_port, max_size=16 * 1024 * 1024):
        print(f"Sable private STT sidecar on ws://{settings.stream_host}:{settings.stream_port} [provider=sarvam]", flush=True)
        await asyncio.Future()


def main() -> None:
    asyncio.run(main_async())


if __name__ == "__main__":
    main()
