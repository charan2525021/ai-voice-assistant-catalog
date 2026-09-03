import assert from "node:assert/strict";
import test from "node:test";
import { AudioSync, SpeechEngine, TurnManager, splitForSpeech, type Audio, type TextToSpeechProvider } from "../src/index.js";

test("preserves proven speech cleanup without splitting decimals", () => {
  assert.deepEqual(splitForSpeech("The price is $29.99. Want me to open product-sort-container?", 450), ["The price is 29 dollars 99 cents. Want me to open product sort container?"]);
});

test("reserves sequence before asynchronous synthesis and never caches answers", async () => {
  const emitted: number[] = [];
  let cacheReads = 0;
  const provider: TextToSpeechProvider = { id: "sarvam", defaultSpeaker: "voice", maxChars: 450, synthesize: async (): Promise<Audio> => ({ mime: "audio/wav", bytes: Buffer.alloc(64, 1) }) };
  const engine = new SpeechEngine("product", {}, provider, (audio) => emitted.push(audio.sequence), { betweenSentencesMs: 280, afterQuestionMs: 900 }, { get: async () => { cacheReads++; return undefined; }, put: async () => undefined });
  await engine.say("This is a dynamic answer.", { utteranceId: "u1", turnId: "t1", purpose: "answer" });
  assert.deepEqual(emitted, [1]);
  assert.equal(cacheReads, 0);
  await engine.say("Signed narration.", { utteranceId: "u2", turnId: "t2", purpose: "journey_step" }, { cache: "catalog" });
  assert.equal(cacheReads, 1);
});

test("audio synchronization releases on matching playback or bounded timeout", async () => {
  const sync = new AudioSync(20);
  let released = false;
  const wait = sync.waitFor(3).then(() => { released = true; });
  sync.notePlayed(2);
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(released, false);
  sync.notePlayed(3);
  await wait;
  assert.equal(released, true);
});

test("barge-in stops playback once and rejects assistant echo", () => {
  let stops = 0;
  const manager = new TurnManager({ stopAudio: () => { stops++; }, cancelSpeech: () => undefined }, { echoWindowMs: 12_000, yieldCooldownMs: 6_000 });
  manager.noteSpoken("I will open settings now.");
  manager.noteAudioSent();
  assert.deepEqual(manager.onUserVoice(), { interrupted: true, shouldYield: true });
  assert.equal(stops, 1);
  assert.equal(manager.acceptTranscript("I will open settings now").accept, false);
});
