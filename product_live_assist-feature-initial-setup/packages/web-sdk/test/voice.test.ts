import assert from "node:assert/strict";
import test from "node:test";
import { CloudVoiceClient, ensureAudioContextRunning, resamplePcm16, StreamingPcm16Framer } from "../src/voice.js";

const OPEN_SOCKET_STATE = 1;

test("voice capture resamples browser audio to fixed 16 kHz PCM16", () => {
  const input = new Float32Array(48_000);
  for (let index = 0; index < input.length; index++) input[index] = Math.sin(index / 20) * 0.5;
  const output = new Int16Array(resamplePcm16(input, 48_000, 16_000));
  assert.equal(output.length, 16_000);
  assert.ok(output.some((sample) => sample !== 0));
  assert.ok(output.every((sample) => sample >= -32_768 && sample <= 32_767));
});

test("empty microphone frames stay empty", () => {
  assert.equal(resamplePcm16(new Float32Array(), 44_100).byteLength, 0);
});

test("voice capture resumes a suspended browser audio context", async () => {
  let state: AudioContextState = "suspended";
  let resumes = 0;
  await ensureAudioContextRunning({
    get state() { return state; },
    async resume() { resumes += 1; state = "running"; },
  });
  assert.equal(resumes, 1);
  assert.equal(state, "running");
});

test("voice capture reports when the browser keeps audio suspended", async () => {
  await assert.rejects(() => ensureAudioContextRunning({ state: "suspended", resume: async () => undefined }), /audio could not start/);
});

test("88.2 kHz worklet blocks are combined into exact 40 ms Sarvam frames", () => {
  const framer = new StreamingPcm16Framer(88_200, 16_000, 40);
  const emitted: ArrayBuffer[] = [];
  const input = new Float32Array(8_820);
  for (let index = 0; index < input.length; index++) input[index] = Math.sin(index / 30) * 0.4;
  for (let offset = 0; offset < input.length; offset += 128) {
    emitted.push(...framer.push(input.subarray(offset, Math.min(offset + 128, input.length))));
  }
  assert.deepEqual(emitted.map((frame) => frame.byteLength), [1_280, 1_280]);
  const remainder = framer.flush();
  assert.equal(remainder.length, 1);
  assert.ok(remainder[0].byteLength >= 636 && remainder[0].byteLength <= 642);
});

test("a single Chrome render quantum is buffered instead of sent as a tiny frame", () => {
  const framer = new StreamingPcm16Framer(88_200, 16_000, 40);
  assert.deepEqual(framer.push(new Float32Array(128)), []);
  const remainder = framer.flush();
  assert.equal(remainder.length, 1);
  assert.ok(remainder[0].byteLength < 1_280);
});

test("streamed playback acknowledgements never expose audio payloads", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "Audio");
  class FakeAudio extends EventTarget {
    preload = "";
    constructor(readonly src: string) { super(); }
    async play() { this.dispatchEvent(new Event("playing")); queueMicrotask(() => this.dispatchEvent(new Event("ended"))); }
    pause() {}
    removeAttribute() {}
    load() {}
  }
  Object.defineProperty(globalThis, "Audio", { configurable: true, writable: true, value: FakeAudio });
  try {
    const playback: object[] = [];
    const client = new CloudVoiceClient({} as never, {
      onState() {}, onTranscript() {}, onPlayback(value) { playback.push(value); },
    });
    (client as unknown as { receive(raw: string): void }).receive(JSON.stringify({ type: "tts.chunk", utteranceId: "utterance-1", turnId: "turn-1", sequence: 7, mime: "audio/wav", base64Audio: "UklGRg==", gapMs: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(playback, [
      { utteranceId: "utterance-1", turnId: "turn-1", sequence: 7, state: "started" },
      { utteranceId: "utterance-1", turnId: "turn-1", sequence: 7, state: "ended" },
    ]);
    assert.ok(!JSON.stringify(playback).includes("UklGRg"));
  } finally {
    if (original) Object.defineProperty(globalThis, "Audio", original);
    else Reflect.deleteProperty(globalThis, "Audio");
  }
});

test("intentional cancellation does not surface Chrome's interrupted play error", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "Audio");
  class PendingAudio extends EventTarget {
    preload = "";
    private rejectPlay?: (error: Error) => void;
    constructor(readonly src: string) { super(); }
    play() { return new Promise<void>((_resolve, reject) => { this.rejectPlay = reject; }); }
    pause() { this.rejectPlay?.(new DOMException("play() was interrupted by pause()", "AbortError")); }
    removeAttribute() {}
    load() {}
  }
  Object.defineProperty(globalThis, "Audio", { configurable: true, writable: true, value: PendingAudio });
  try {
    const playback: Array<{ state: string }> = [];
    const states: string[] = [];
    const client = new CloudVoiceClient({} as never, {
      onState(state) { states.push(state); }, onTranscript() {}, onPlayback(value) { playback.push(value); },
    });
    (client as unknown as { receive(raw: string): void }).receive(JSON.stringify({ type: "tts.chunk", utteranceId: "utterance-1", turnId: "turn-1", sequence: 1, mime: "audio/wav", base64Audio: "UklGRg==", gapMs: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    client.cancelPlayback();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(playback.map((value) => value.state), ["cancelled"]);
    assert.ok(!states.includes("failed"));
  } finally {
    if (original) Object.defineProperty(globalThis, "Audio", original);
    else Reflect.deleteProperty(globalThis, "Audio");
  }
});

test("microphone startup can cancel old playback without falsely returning the UI to idle", () => {
  const states: string[] = [];
  const client = new CloudVoiceClient({} as never, {
    onState(state) { states.push(state); }, onTranscript() {}, onPlayback() {},
  });
  client.cancelPlayback(false);
  assert.deepEqual(states, []);
  client.cancelPlayback();
  assert.deepEqual(states, ["idle"]);
});

test("continuous voice pauses one utterance without tearing down microphone capture", async () => {
  const sent: unknown[] = [];
  let trackStops = 0;
  let contextCloses = 0;
  const client = new CloudVoiceClient({
    sampleRate: 16_000,
    audioFrameMs: 40,
    maximumUtteranceMs: 30_000,
    minimumSpeechMs: 250,
  } as never, {
    onState() {}, onTranscript() {}, onPlayback() {},
  });
  const internals = client as unknown as {
    socket: { readyState: number; send(value: unknown): void };
    context: { sampleRate: number; close(): Promise<void> };
    stream: { getTracks(): Array<{ stop(): void }> };
    source: { disconnect(): void };
    worklet: { disconnect(): void };
    sessionActive: boolean;
    listening: boolean;
    speechStartedAt: number;
    beginUtterance(): void;
    finishUtterance(submit: boolean): void;
    receive(raw: string): void;
  };
  internals.socket = { readyState: OPEN_SOCKET_STATE, send(value) { sent.push(value); } };
  internals.context = { sampleRate: 48_000, async close() { contextCloses++; } };
  internals.stream = { getTracks: () => [{ stop() { trackStops++; } }] };
  internals.source = { disconnect() {} };
  internals.worklet = { disconnect() {} };
  internals.sessionActive = true;

  internals.beginUtterance();
  internals.speechStartedAt = Date.now() - 500;
  internals.finishUtterance(true);
  assert.equal(client.active, true);
  assert.equal(trackStops, 0);
  assert.equal(contextCloses, 0);
  assert.ok(sent.some((value) => typeof value === "string" && JSON.parse(value).type === "voice.flush"));

  internals.receive(JSON.stringify({ type: "voice.listen", turnId: "turn-1" }));
  assert.equal(sent.filter((value) => typeof value === "string" && JSON.parse(value).type === "voice.start").length, 2);

  await client.stop(false);
  assert.equal(client.active, false);
  assert.equal(trackStops, 1);
  assert.equal(contextCloses, 1);
});

test("continuous voice sends no microphone audio while processing", () => {
  const sent: unknown[] = [];
  const client = new CloudVoiceClient({ vadThreshold: 0.02 } as never, {
    onState() {}, onTranscript() {}, onPlayback() {},
  });
  const internals = client as unknown as {
    socket: { readyState: number; send(value: unknown): void };
    context: { sampleRate: number };
    listening: boolean;
    capture(input: Float32Array): void;
  };
  internals.socket = { readyState: OPEN_SOCKET_STATE, send(value) { sent.push(value); } };
  internals.context = { sampleRate: 48_000 };
  internals.listening = false;
  internals.capture(new Float32Array(4_800).fill(0.5));
  assert.deepEqual(sent, []);
});

test("voice listening stays armed underneath TTS and remains armed after cancellation", () => {
  const sent: unknown[] = [];
  const states: string[] = [];
  const client = new CloudVoiceClient({ maximumUtteranceMs: 30_000 } as never, {
    onState(state) { states.push(state); }, onTranscript() {}, onPlayback() {},
  });
  const player = { pause() {}, removeAttribute() {}, load() {} };
  const internals = client as unknown as {
    socket: { readyState: number; send(value: unknown): void };
    context: { sampleRate: number };
    player: typeof player | undefined;
    sessionActive: boolean;
    listening: boolean;
    receive(raw: string): void;
    finishUtterance(submit: boolean): void;
  };
  internals.socket = { readyState: OPEN_SOCKET_STATE, send(value) { sent.push(value); } };
  internals.context = { sampleRate: 48_000 };
  internals.player = player;
  internals.sessionActive = true;

  internals.receive(JSON.stringify({ type: "voice.listen", turnId: "turn-speaking" }));
  assert.equal(internals.listening, true);
  assert.equal(states.at(-1), "speaking");
  assert.ok(sent.some((value) => typeof value === "string" && JSON.parse(value).type === "voice.start"));

  internals.receive(JSON.stringify({ type: "tts.cancel", reason: "barge_in" }));
  assert.equal(internals.listening, true);
  assert.equal(states.at(-1), "listening");

  internals.sessionActive = false;
  internals.finishUtterance(false);
});

test("speech that continues after the echo probe waits for transcript confirmation before cancellation", () => {
  const sent: unknown[] = [];
  let paused = 0;
  let barges = 0;
  const client = new CloudVoiceClient({
    sampleRate: 16_000, audioFrameMs: 40, vadThreshold: 0.02,
  } as never, {
    onState() {}, onTranscript() {}, onPlayback() {}, onBargeIn() { barges++; },
  });
  const player = { pause() { paused++; }, async play() {}, removeAttribute() {}, load() {} };
  const internals = client as unknown as {
    socket: { readyState: number; send(value: unknown): void };
    context: { sampleRate: number };
    framer: StreamingPcm16Framer;
    player: typeof player;
    sessionActive: boolean;
    listening: boolean;
    capture(input: Float32Array): void;
    receive(raw: string): void;
  };
  internals.socket = { readyState: OPEN_SOCKET_STATE, send(value) { sent.push(value); } };
  internals.context = { sampleRate: 48_000 };
  internals.framer = new StreamingPcm16Framer(48_000, 16_000, 40);
  internals.player = player;
  internals.sessionActive = true;
  internals.listening = true;
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    internals.capture(new Float32Array(4_800).fill(0.08));
    now += 121;
    internals.capture(new Float32Array(4_800).fill(0.08));
    // The assistant is now paused. Sustained energy in this echo-free window
    // confirms that a person, rather than the loudspeaker, is still speaking.
    now += 1;
    internals.capture(new Float32Array(4_800).fill(0.08));
    now += 141;
    internals.capture(new Float32Array(4_800).fill(0.08));
  } finally { Date.now = originalNow; }
  assert.ok(paused >= 1);
  assert.equal(barges, 0);
  assert.equal(internals.listening, true);
  assert.ok(sent.some((value) => typeof value === "string" && JSON.parse(value).type === "voice.barge_in"));
  assert.ok(sent.some((value) => value instanceof ArrayBuffer));
  internals.receive(JSON.stringify({ type: "speech.confirmed", interrupted: true }));
  assert.equal(barges, 1);
});

test("brief echo pauses TTS for probing and then resumes without barge-in", async () => {
  const sent: unknown[] = [];
  let paused = 0;
  let resumed = 0;
  let barges = 0;
  const client = new CloudVoiceClient({
    sampleRate: 16_000, audioFrameMs: 40, vadThreshold: 0.02,
  } as never, {
    onState() {}, onTranscript() {}, onPlayback() {}, onBargeIn() { barges++; },
  });
  const player = { pause() { paused++; }, async play() { resumed++; }, removeAttribute() {}, load() {} };
  const internals = client as unknown as {
    socket: { readyState: number; send(value: unknown): void };
    context: { sampleRate: number };
    framer: StreamingPcm16Framer;
    player: typeof player;
    sessionActive: boolean;
    listening: boolean;
    capture(input: Float32Array): void;
    receive(raw: string): void;
  };
  internals.socket = { readyState: OPEN_SOCKET_STATE, send(value) { sent.push(value); } };
  internals.context = { sampleRate: 48_000 };
  internals.framer = new StreamingPcm16Framer(48_000, 16_000, 40);
  internals.player = player;
  internals.sessionActive = true;
  internals.listening = true;
  const originalNow = Date.now;
  let now = 2_000;
  Date.now = () => now;
  try {
    internals.capture(new Float32Array(4_800).fill(0.08));
    now += 121;
    internals.capture(new Float32Array(4_800).fill(0.08));
    // Once TTS is paused, the echo disappears instead of remaining voiced.
    now += 20;
    internals.capture(new Float32Array(4_800).fill(0));
    internals.receive(JSON.stringify({ type: "voice.no_speech", reason: "echo" }));
    await Promise.resolve();
  } finally { Date.now = originalNow; }
  assert.equal(paused, 1);
  assert.equal(resumed, 1);
  assert.equal(barges, 0);
  assert.equal(sent.some((value) => typeof value === "string" && JSON.parse(value).type === "voice.barge_in"), false);
});

test("sidecar speech confirmation upgrades an existing browser probe and keeps TTS paused", async () => {
  let paused = 0;
  let resumed = 0;
  let barges = 0;
  const client = new CloudVoiceClient({
    sampleRate: 16_000, audioFrameMs: 40, vadThreshold: 0.02, minimumSpeechMs: 250, maximumUtteranceMs: 20_000,
  } as never, {
    onState() {}, onTranscript() {}, onPlayback() {}, onBargeIn() { barges++; },
  });
  const player = { pause() { paused++; }, async play() { resumed++; }, removeAttribute() {}, load() {} };
  const internals = client as unknown as {
    socket: { readyState: number; send(value: unknown): void };
    context: { sampleRate: number };
    framer: StreamingPcm16Framer;
    player: typeof player;
    sessionActive: boolean;
    listening: boolean;
    bargeInProbe?: { authority: string };
    capture(input: Float32Array): void;
    receive(raw: string): void;
  };
  internals.socket = { readyState: OPEN_SOCKET_STATE, send() {} };
  internals.context = { sampleRate: 48_000 };
  internals.framer = new StreamingPcm16Framer(48_000, 16_000, 40);
  internals.player = player;
  internals.sessionActive = true;
  internals.listening = true;
  const originalNow = Date.now;
  let now = 3_000;
  Date.now = () => now;
  try {
    internals.capture(new Float32Array(4_800).fill(0.08));
    now += 121;
    internals.capture(new Float32Array(4_800).fill(0.08));
  } finally { Date.now = originalNow; }

  assert.equal(paused, 1);
  assert.equal(internals.bargeInProbe?.authority, "browser_candidate");
  internals.receive(JSON.stringify({ type: "speech.candidate", source: "sidecar_vad" }));
  assert.equal(internals.bargeInProbe?.authority, "sidecar_confirmed");

  // This is longer than the browser-only decision window. The old race would
  // have resumed TTS here even though the sidecar had confirmed speech.
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(resumed, 0);
  assert.equal(barges, 0);

  internals.receive(JSON.stringify({ type: "speech.confirmed", interrupted: true }));
  assert.equal(barges, 1);
});

test("sidecar-confirmed echo remains reversible when STT returns no speech", async () => {
  let resumed = 0;
  let barges = 0;
  const client = new CloudVoiceClient({ maximumUtteranceMs: 20_000 } as never, {
    onState() {}, onTranscript() {}, onPlayback() {}, onBargeIn() { barges++; },
  });
  const player = { pause() {}, async play() { resumed++; }, removeAttribute() {}, load() {} };
  const internals = client as unknown as {
    player: typeof player;
    sessionActive: boolean;
    listening: boolean;
    receive(raw: string): void;
  };
  internals.player = player;
  internals.sessionActive = true;
  internals.listening = true;
  internals.receive(JSON.stringify({ type: "speech.candidate", source: "sidecar_vad" }));
  internals.receive(JSON.stringify({ type: "voice.no_speech", reason: "echo" }));
  await Promise.resolve();
  assert.equal(resumed, 1);
  assert.equal(barges, 0);
});

test("interruption barrier rejects stale chunks until the server opens the accepted generation", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "Audio");
  let plays = 0;
  class FakeAudio extends EventTarget {
    preload = "";
    src = "";
    volume = 1;
    async play() { plays++; this.dispatchEvent(new Event("playing")); queueMicrotask(() => this.dispatchEvent(new Event("ended"))); }
    pause() {}
    removeAttribute() {}
    load() {}
  }
  Object.defineProperty(globalThis, "Audio", { configurable: true, writable: true, value: FakeAudio });
  try {
    const client = new CloudVoiceClient({} as never, {
      onState() {}, onTranscript() {}, onPlayback() {},
    });
    const internals = client as unknown as { receive(raw: string): void };
    internals.receive(JSON.stringify({ type: "tts.cancel", reason: "barge_in", generation: 4 }));
    internals.receive(JSON.stringify({ type: "tts.chunk", generation: 3, utteranceId: "stale", turnId: "old", sequence: 1, mime: "audio/wav", base64Audio: "UklGRg==" }));
    internals.receive(JSON.stringify({ type: "tts.chunk", generation: 4, utteranceId: "also-stale", turnId: "old", sequence: 2, mime: "audio/wav", base64Audio: "UklGRg==" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(plays, 0);

    internals.receive(JSON.stringify({ type: "tts.resume", generation: 4, turnId: "new" }));
    internals.receive(JSON.stringify({ type: "tts.chunk", generation: 3, utteranceId: "old-generation", turnId: "old", sequence: 3, mime: "audio/wav", base64Audio: "UklGRg==" }));
    internals.receive(JSON.stringify({ type: "tts.chunk", generation: 4, utteranceId: "new-generation", turnId: "new", sequence: 4, mime: "audio/wav", base64Audio: "UklGRg==" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(plays, 1);
  } finally {
    if (original) Object.defineProperty(globalThis, "Audio", original);
    else Reflect.deleteProperty(globalThis, "Audio");
  }
});

test("utterance waits distinguish completed, interrupted, and failed playback", async () => {
  const client = new CloudVoiceClient({ audioWaitCapMs: 20 } as never, {
    onState() {}, onTranscript() {}, onPlayback() {},
  });
  const internals = client as unknown as { receive(raw: string): void };

  const completed = client.waitForUtterance("completed", 100);
  internals.receive(JSON.stringify({ type: "tts.end", utteranceId: "completed", lastSequence: null }));
  assert.equal(await completed, "completed");

  const interrupted = client.waitForUtterance("interrupted", 100);
  client.cancelPlayback(false);
  assert.equal(await interrupted, "interrupted");

  assert.equal(await client.waitForUtterance("failed", 1), "failed");
});

test("a queued narration does not fail while an earlier line is still playing", async () => {
  const client = new CloudVoiceClient({ audioWaitCapMs: 5 } as never, {
    onState() {}, onTranscript() {}, onPlayback() {},
  });
  const player = { pause() {}, removeAttribute() {}, load() {} };
  const internals = client as unknown as { player: typeof player | undefined };
  internals.player = player;
  let settled: string | undefined;
  const queued = client.waitForUtterance("queued", 5).then((outcome) => { settled = outcome; return outcome; });

  await new Promise((resolve) => setTimeout(resolve, 12));
  assert.equal(settled, undefined);
  client.cancelPlayback(false);
  assert.equal(await queued, "interrupted");
});
