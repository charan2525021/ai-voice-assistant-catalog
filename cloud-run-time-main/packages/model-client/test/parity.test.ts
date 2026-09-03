import assert from "node:assert/strict";
import test from "node:test";
import { makeModelClient, SentenceStream, normalizeToolHistory, pruneNeutralHistory, readSse, toOpenAiMessages, type NeutralMessage } from "../src/index.js";

test("does not split a streamed decimal at a delta boundary", () => {
  const stream = new SentenceStream();
  assert.deepEqual(stream.push("Usage was 17."), []);
  assert.deepEqual(stream.push("4 million tokens. Next sentence is ready."), ["Usage was 17.4 million tokens.", "Next sentence is ready."]);
});

test("releases a short complete question without gluing it to the next sentence", () => {
  const stream = new SentenceStream();
  assert.deepEqual(stream.push("Want me to show you?"), ["Want me to show you?"]);
});

test("repairs interrupted tool history atomically", () => {
  const input: NeutralMessage[] = [
    { role: "assistant", blocks: [{ type: "tool_call", id: "call-1", name: "run_journey", args: {} }] },
    { role: "user", blocks: [{ type: "text", text: "stop" }] },
  ];
  const normalized = normalizeToolHistory(input);
  assert.equal(normalized[1].blocks[0].type, "tool_result");
  assert.equal(normalized[2].blocks[0].type, "text");
  // The original pruning logic keeps whole tool/result groups, and prefers the
  // newest ordinary turn when the requested budget cannot contain both groups.
  assert.deepEqual(pruneNeutralHistory(input, 2), [normalized[2]]);
  assert.equal((toOpenAiMessages(input)[1] as { role: string }).role, "tool");
});

test("assembles streamed tool-call argument fragments and sentence order", async () => {
  const encoder = new TextEncoder();
  const frames = [
    'data: {"choices":[{"delta":{"content":"I can help with that. "}}]}\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tool-1","function":{"name":"run_journey","arguments":"{\\"journeyId\\":\\"open"}}]}}]}\n',
    'data: {"choices":[{"finish_reason":"tool_calls","delta":{"tool_calls":[{"index":0,"function":{"arguments":"-settings\\"}"}}]}}]}\n',
    "data: [DONE]\n",
  ];
  const response = new Response(new ReadableStream({ start(controller) { for (const frame of frames) controller.enqueue(encoder.encode(frame)); controller.close(); } }));
  const spoken: string[] = [];
  const result = await readSse(response, (sentence) => spoken.push(sentence));
  assert.deepEqual(spoken, ["I can help with that."]);
  assert.equal(result.toolCalls[0]?.name, "run_journey");
  assert.deepEqual(result.toolCalls[0]?.args, { journeyId: "open-settings" });
  assert.equal(result.done, false);
});

test("a required planning tool is forced at the OpenAI-compatible boundary", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({
      choices: [{
        finish_reason: "tool_calls",
        message: { tool_calls: [{ id: "plan-1", function: { name: "submit_turn_plan", arguments: "{}" } }] },
      }],
    });
  };
  try {
    const model = makeModelClient({
      provider: "openai_compatible", apiKey: "test", baseUrl: "https://example.test/v1",
      model: "test", maxTokens: 200, timeoutMs: 1_000, retries: 0,
    });
    const result = await model.step("plan", [{ role: "user", blocks: [{ type: "text", text: "walk through" }] }], [{
      name: "submit_turn_plan", description: "plan", parameters: { type: "object" },
    }], { toolChoice: "required" });
    assert.equal(requestBody?.tool_choice, "required");
    assert.equal(result.toolCalls[0]?.name, "submit_turn_plan");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an upstream 503 is reported as provider unavailability without leaking HTML", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("<html>upstream unavailable</html>", { status: 503 });
  try {
    const model = makeModelClient({
      provider: "openai_compatible", apiKey: "test", baseUrl: "https://example.test/v1",
      model: "test", maxTokens: 200, timeoutMs: 1_000, retries: 0,
    });
    await assert.rejects(
      model.step("answer", [{ role: "user", blocks: [{ type: "text", text: "hello" }] }], []),
      (error: Error) => error.message === "Reasoning provider is temporarily unavailable (HTTP 503)",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
