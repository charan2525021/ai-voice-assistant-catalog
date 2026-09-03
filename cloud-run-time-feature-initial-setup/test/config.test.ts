import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

const base = { TOKEN_SIGNING_SECRET: "12345678901234567890123456789012" };

test("voice defaults include the configurable 800 ms silence value", () => {
  const config = loadConfig(base);
  assert.equal(config.voice.silenceTimeoutMs, 800);
  assert.equal(config.voice.sttModel, "saaras:v3");
  assert.equal(config.voice.ttsModel, "bulbul:v3");
});

test("numeric voice settings are safely clamped", () => {
  const high = loadConfig({ ...base, VOICE_SILENCE_TIMEOUT_MS: "99999", VOICE_VAD_THRESHOLD: "0.0001" });
  assert.equal(high.voice.silenceTimeoutMs, 3000);
  assert.equal(high.voice.vadThreshold, 0.001);
});

test("reasoning can use native Anthropic or an OpenAI-compatible endpoint", () => {
  const native = loadConfig({ ...base, REASONING_PROVIDER: "anthropic", ANTHROPIC_MODEL: "claude-test" });
  assert.equal(native.providers.reasoning, "anthropic");
  assert.equal(native.reasoning.model, "claude-test");

  const compatible = loadConfig({ ...base, REASONING_PROVIDER: "openai_compatible", OPENAI_COMPATIBLE_API_KEY: "secret", OPENAI_COMPATIBLE_BASE_URL: "https://api.llmapi.ai/v1", REASONING_MODEL: "" });
  assert.equal(compatible.providers.reasoning, "openai_compatible");
  assert.equal(compatible.openAiCompatibleApiKey, "secret");
  assert.equal(compatible.openAiCompatibleBaseUrl, "https://api.llmapi.ai/v1");
  assert.equal(compatible.reasoning.model, "gpt-4o");
});

test("unregistered providers fail startup", () => {
  assert.throws(() => loadConfig({ ...base, REASONING_PROVIDER: "other" }), /must be one of: anthropic, openai_compatible/);
  assert.throws(() => loadConfig({ ...base, STT_PROVIDER: "other" }), /must be one of: sarvam/);
});

test("postgres mode requires a database URL", () => {
  assert.throws(() => loadConfig({ ...base, RUNTIME_STORE: "postgres" }), /DATABASE_URL/);
});
