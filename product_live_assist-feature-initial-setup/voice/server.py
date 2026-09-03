"""Single-speaker STT WebSocket server for Aidan's voice input.

Trimmed to the essential path from the original ~800-line two-speaker server.

Flow:  browser mic (mono PCM16 @16kHz binary frames)  ->  buffer + energy VAD
       ->  ASR (mock | Sarvam)  ->  merge partials  ->  finalize on silence
       ->  emit {"type":"transcript", ...}  ->  browser feeds it into Aidan chat.

REMOVED vs the original: stereo/dual-speaker, echo/mic-bleed/overlap
suppression, the live-feedback RAG webhook, the session-management API
(heartbeat + silence auto-pause), native audio framing/sequencing, and the
diagnostics/timing instrumentation. Aidan has its own brain, so none of that
belongs here.

Run:  python -m voice.server     (from the aidan/ directory)
"""
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


def strip_repetition(text: str) -> str:
    """Drop a hallucinated repeating tail, keeping the real speech before it.

    Whisper's failure mode on thin audio is to latch onto a phrase and repeat it.
    The repetition is almost always at the END, after whatever was genuinely
    said, so cutting at the first sentence that starts repeating preserves the
    user's actual words instead of losing the turn entirely.
    """
    parts = [p.strip() for p in re.split(r"(?<=[.!?])\s+", text) if p.strip()]
    if len(parts) < 3:
        return text
    seen: dict[str, int] = {}
    for i, part in enumerate(parts):
        key = re.sub(r"[^a-z0-9 ]", "", part.lower()).strip()
        if not key:
            continue
        seen[key] = seen.get(key, 0) + 1
        # Third occurrence of the same sentence: everything from here is noise.
        if seen[key] >= 3:
            return " ".join(parts[:i]).strip() or text
    return text


async def handle_client(ws) -> None:
    """Wrap the session so any STT/provider failure reaches the browser as a
    clean error (e.g. Sarvam 'Credits exhausted') instead of a raw socket close."""
    try:
        await _serve(ws)
    except Exception as e:
        try:
            await ws.send(json.dumps({"type": "error", "text": f"Speech-to-text unavailable: {str(e)[:300]}"}))
        except Exception:
            pass


async def _serve(ws) -> None:
    asr = build_asr_provider(settings)
    state = UtteranceState()
    lock = asyncio.Lock()
    audio_buffer = b""
    preroll_chunks: list[bytes] = []  # ~1s of pre-speech audio, so onsets aren't clipped
    target = target_buffer_bytes(settings.chunk_size, settings.buffer_chunks)
    low_energy = 0
    stt_queue: asyncio.Queue[bytes | None] = asyncio.Queue()
    send_lock = asyncio.Lock()
    packet_ms = round(target / (2 * settings.sample_rate) * 1000)
    timing = {"candidate_at": None, "speech_at": None, "last_voice_at": None}

    async def emit(payload: dict) -> None:
        """Best-effort send. A closed socket is normal at end of session and must
        never abort the caller — the teardown path emits too."""
        async with send_lock:
            try:
                await ws.send(json.dumps(payload))
            except Exception:
                pass

    # Barge-in needs the EARLIEST possible signal. The final transcript lands
    # 1-2s after the user starts talking — far too late to stop the agent
    # mid-sentence — so announce the first voiced chunk of each utterance.
    speaking = {"active": False, "quiet": 0}

    async def note_voice_activity(rms: float) -> None:
        """Announce the start of each new run of speech.

        Previously this latched until finalize(). While the agent is talking no
        transcript finalizes, so one trigger disabled barge-in for the rest of the
        session — the "stops listening once it starts speaking" bug. Re-arm after a
        short lull instead, so every fresh utterance is announced.
        """
        voiced = rms >= settings.energy_threshold
        if voiced:
            now = time.perf_counter()
            speaking["quiet"] = 0
            # Require SUSTAINED energy before declaring speech. A single loud
            # packet is a door, a keyboard, a cough — announcing speech_start on
            # one of those cut Aidan off mid-sentence and started an utterance
            # that only Whisper's imagination could fill.
            speaking["loud"] = speaking.get("loud", 0) + 1
            if speaking["loud"] == 1:
                timing["candidate_at"] = now
            timing["last_voice_at"] = now
            if not speaking["active"] and speaking["loud"] >= 2:
                speaking["active"] = True
                timing["speech_at"] = timing["candidate_at"] or now
                await emit({"type": "speech_start", "timing": {"detection_ms": packet_ms * 2}})
            # "We are inside an utterance" is a fact about the AUDIO, so VAD
            # must own it — it used to be set only when the ASR returned a
            # partial, which silently broke every BATCH provider (Whisper emits
            # no partials, so no utterance ever finalised).
            #
            # But only once speech is CONFIRMED. Opening an utterance on a single
            # loud packet meant one keyboard clack was buffered, sent to Whisper
            # and returned as invented words.
            if speaking["active"]:
                async with lock:
                    state.waiting_for_silence = True
                    if state.utterance_started_at is None:
                        state.utterance_started_at = time.time()
        else:
            speaking["loud"] = 0  # a burst must be CONSECUTIVE to count as speech
            if not speaking["active"]:
                timing["candidate_at"] = None
            speaking["quiet"] += 1
            if speaking["active"] and speaking["quiet"] >= 2:
                speaking["active"] = False  # re-arm for the next utterance

    async with asr.connect() as asr_ws:

        async def stt_sender() -> None:
            while True:
                pcm = await stt_queue.get()
                if pcm is None:
                    return
                try:
                    await asr_ws.transcribe(
                        audio=pcm_to_wav_b64(pcm, settings.sample_rate),
                        encoding="audio/wav",
                        sample_rate=settings.sample_rate,
                    )
                except Exception:
                    pass  # a dropped chunk shouldn't kill the stream

        async def reader() -> None:
            """Consume ASR partials → grow the current utterance, stream it live."""
            async for message in asr_ws:
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
            """End the utterance — but WAIT for the ASR, which runs behind us.

            The bug this fixes made the product look dead. Our energy VAD decides
            you stopped talking ~1.9s after your last loud packet; Sarvam's
            streaming transcript arrives seconds later still. Finalising
            immediately therefore read an EMPTY buffer, and the old code emitted
            nothing at all when the text was empty — no transcript, no error, no
            log. Measured directly: the words of one utterance only arrived while
            the NEXT one was being spoken. Seven consecutive turns produced total
            silence from the agent.

            So: give the ASR a bounded grace period to deliver, then finalise on
            whatever we have. If it is still empty, say so explicitly — a lost
            utterance must be visible, never silent.
            """
            nonlocal low_energy
            # The receive loop keeps hitting the silence threshold while we wait,
            # so without this guard the grace period spawns a finalize per packet.
            if finalizing["busy"]:
                return
            finalizing["busy"] = True
            try:
                finalize_at = time.perf_counter()
                decode_started = finalize_at
                # A BATCH provider (Whisper) transcribes on demand: we ask for
                # the text at exactly the moment we decide speech ended, so there
                # is no race to lose and no waiting on someone else's stream.
                # A STREAMING provider (Sarvam) delivers seconds late, so we give
                # it a bounded grace period to catch up before finalising.
                if hasattr(asr_ws, "flush"):
                    text = await asr_ws.flush()
                    if text:
                        async with lock:
                            merge_transcript(state.transcript_buffer, text)
                else:
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
                speaking["active"] = False; speaking["quiet"] = 0  # utterance over
                voice_timing = {
                    "packet_ms": packet_ms,
                    "endpoint_ms": round((finalize_at - timing["last_voice_at"]) * 1000)
                    if timing["last_voice_at"] else None,
                    "decode_ms": round((decoded_at - decode_started) * 1000),
                    "speech_to_final_ms": round((decoded_at - timing["speech_at"]) * 1000)
                    if timing["speech_at"] else None,
                }
                timing["candidate_at"] = None
                timing["speech_at"] = None
                timing["last_voice_at"] = None
                # Whisper HALLUCINATES on non-speech. Fed room tone it returns
                # ". . . . . .", "Thank you." or "you" — confidently, as if
                # transcribed. Caught live: a stray noise produced ". . . . . .",
                # which passed the length guard, was submitted as the prospect's
                # turn, and cancelled the answer Aidan had just started. Speech
                # has WORDS; punctuation and whitespace alone never do.
                # Salvage before judging. Whisper often returns REAL speech and
                # then loops — "let us explore submissions" followed by "I feel
                # like I'm feeling it" fourteen times. Discarding the whole
                # transcript threw away what the user actually said, so strip the
                # repeated tail and keep the genuine head.
                final_text = strip_repetition(final_text)
                words = re.findall(r"[a-z0-9]+", final_text.lower())
                # Whisper's OTHER hallucination is a repetition loop: fed noise it
                # emits one token dozens of times — "Scroll Scroll Scroll..." (70x)
                # and "Okay. Okay. Okay..." (28x) were both captured live, and both
                # were submitted as real turns, which is how the agent ended up
                # answering "scrolling won't reveal more here". Genuine speech has
                # variety; a near-single-token utterance does not.
                looping = len(words) >= 6 and len(set(words)) <= max(2, len(words) // 8)
                if looping:
                    print(f"[stt] discarded a repetition loop ({len(words)} words, "
                          f"{len(set(words))} unique): {final_text[:60]!r}", flush=True)
                if looping or not words or sum(len(w) for w in words) < 2:
                    if final_text:
                        LOG_NOISE = f" (discarded {final_text!r})"
                    else:
                        LOG_NOISE = ""
                    print(f"[stt] no speech in this utterance{LOG_NOISE}", flush=True)
                    await emit({"type": "no_speech", "reason": reason, "timing": voice_timing})
                elif final_text:
                    await emit({"type": "transcript", "text": final_text, "is_final": True, "reason": reason, "timing": voice_timing})
                else:
                    # Visible failure beats silent failure: the caller can tell the
                    # difference between "heard nothing" and "still thinking".
                    await emit({"type": "no_speech", "reason": reason, "timing": voice_timing})
            finally:
                finalizing["busy"] = False

        async def receive_audio() -> None:
            nonlocal audio_buffer, low_energy
            async for message in ws:
                # A JSON control frame can force-finalize (e.g. push-to-talk release).
                if isinstance(message, str):
                    try:
                        control = json.loads(message)
                        if control.get("type") == "flush":
                            await finalize("client_flush")
                        elif control.get("type") == "vocabulary":
                            # The app knows which product this demo is for; this
                            # service does not, and should not. Take the terms as
                            # data so any product biases decoding without code.
                            terms = str(control.get("terms") or "").strip()[:400]
                            if terms and hasattr(asr_ws, "prompt"):
                                asr_ws.prompt = terms
                                LOG.info("vocabulary hint: %s", terms[:80])
                    except Exception:
                        pass
                    continue
                if not isinstance(message, (bytes, bytearray)):
                    continue

                audio_buffer += bytes(message)
                while len(audio_buffer) >= target:
                    chunk = audio_buffer[:target]
                    audio_buffer = audio_buffer[target:]

                    rms = calculate_rms(chunk)
                    # Send only what is plausibly SPEECH to the recogniser.
                    #
                    # Every chunk used to go through, so a Whisper utterance
                    # accumulated minutes of room tone — and a long silent buffer
                    # is exactly what makes Whisper loop: it returned real words
                    # followed by "I feel like I'm feeling it" fourteen times.
                    # The loop then swamped the genuine speech and the whole
                    # transcript was discarded, which is why it appeared to stop
                    # listening mid-conversation.
                    #
                    # A short pre-roll rides along so the first syllable of an
                    # utterance is not clipped by the two-packet confirmation.
                    if speaking["active"]:
                        for held in preroll_chunks:
                            await stt_queue.put(held)
                        preroll_chunks.clear()
                        await stt_queue.put(chunk)
                    else:
                        preroll_chunks.append(chunk)
                        if len(preroll_chunks) > 3:
                            preroll_chunks.pop(0)
                    await note_voice_activity(rms)
                    async with lock:
                        waiting = state.waiting_for_silence
                        started = state.utterance_started_at
                    if not waiting:
                        continue
                    if rms < settings.energy_threshold:
                        low_energy += 1
                    else:
                        low_energy = 0
                    too_long = started is not None and (time.time() - started) >= settings.max_utterance_seconds
                    if low_energy >= settings.low_energy_packet_target:
                        await finalize("silence")
                    elif too_long:
                        await finalize("max_duration")

        await emit({"type": "ready", "provider": settings.asr_provider})
        reader_task = asyncio.create_task(reader())
        sender_task = asyncio.create_task(stt_sender())
        recv_task = asyncio.create_task(receive_audio())
        try:
            done, _ = await asyncio.wait(
                {recv_task, reader_task, sender_task}, return_when=asyncio.FIRST_COMPLETED
            )
            for t in done:
                t.result()
        finally:
            # Teardown must not depend on the socket still being open. This used
            # to call finalize() first, which emits on the websocket — and at
            # "connection_closed" that raises, so the cancellation below never
            # ran and every disconnect leaked a reader and a sender ("Task was
            # destroyed but it is pending!" once per connection).
            try:
                await finalize("connection_closed")
            except Exception:
                pass
            await stt_queue.put(None)
            for t in (recv_task, reader_task, sender_task):
                if not t.done():
                    t.cancel()
            await asyncio.gather(recv_task, reader_task, sender_task, return_exceptions=True)


async def main_async() -> None:
    async with websockets.serve(handle_client, settings.stream_host, settings.stream_port, max_size=16 * 1024 * 1024):
        print(
            f"Aidan voice (STT) server on ws://{settings.stream_host}:{settings.stream_port} "
            f"[provider={settings.asr_provider}]",
            flush=True,
        )
        await asyncio.Future()


def main() -> None:
    asyncio.run(main_async())


if __name__ == "__main__":
    main()
