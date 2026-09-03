import assert from "node:assert/strict";
import test from "node:test";
import { credentialMatches, hashCredential, TokenSigner } from "../src/security.js";

test("installation credentials are stored and compared as hashes", () => {
  const hash = hashCredential("one-time-secret");
  assert.notEqual(hash, "one-time-secret");
  assert.equal(credentialMatches("one-time-secret", hash), true);
  assert.equal(credentialMatches("wrong", hash), false);
});

test("tickets are purpose-bound", () => {
  const signer = new TokenSigner("12345678901234567890123456789012");
  const token = signer.sign({ purpose: "voice_ticket", sub: "session-1", exp: Date.now() + 1000 });
  assert.equal(signer.verify(token, "voice_ticket").sub, "session-1");
  assert.throws(() => signer.verify(token, "control_ticket"), /purpose/);
});
