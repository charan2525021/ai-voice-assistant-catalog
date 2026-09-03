import assert from "node:assert/strict";
import test from "node:test";
import { ConversationTranscript } from "../src/transcript.js";

test("partial user speech updates one message and final speech closes it", () => {
  const transcript = new ConversationTranscript();
  const first = transcript.userVoice("show me", false);
  const second = transcript.userVoice("show me the platform", false);
  const final = transcript.userVoice("Show me the platform", true);

  assert.equal(first.key, second.key);
  assert.equal(second.key, final.key);
  assert.equal(first.partial, true);
  assert.equal(final.partial, false);
  assert.equal(final.role, "user");
});

test("the next spoken turn gets a new message", () => {
  const transcript = new ConversationTranscript();
  const first = transcript.userVoice("First question", true);
  const second = transcript.userVoice("Second question", true);
  assert.notEqual(first.key, second.key);
});

test("streamed and final assistant text share one message key", () => {
  const transcript = new ConversationTranscript();
  const partial = transcript.assistant("turn-42", "The platform", true);
  const final = transcript.assistant("turn-42", "The platform helps schools.", false);
  assert.equal(partial.key, final.key);
  assert.equal(final.partial, false);
  assert.equal(final.role, "assistant");
});

test("journey narration has a stable step-specific transcript key", () => {
  const transcript = new ConversationTranscript();
  const first = transcript.journeyNarration("turn-1", "walkthrough", "about", "This is the About section.");
  const repeated = transcript.journeyNarration("turn-1", "walkthrough", "about", "This is the About section.");
  const next = transcript.journeyNarration("turn-1", "walkthrough", "contact", "This is the Contact section.");
  assert.equal(first.key, repeated.key);
  assert.notEqual(first.key, next.key);
  assert.equal(first.text, "This is the About section.");
});
