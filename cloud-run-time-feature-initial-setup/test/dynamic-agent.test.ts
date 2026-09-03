import assert from "node:assert/strict";
import test from "node:test";
import type { ModelClient, ModelResult, NeutralToolCall } from "@sable/model-client";
import type { RuntimeBundle } from "@sable/runtime-core";
import type { DynamicToolResult, SignedCatalogEnvelope, UIMapSnapshot } from "@sable/sdk-contracts";
import { loadConfig } from "../src/config.js";
import type { DynamicModeConfig, RuntimeSession } from "../src/contracts.js";
import { DynamicAgent, type DynamicAgentEvents } from "../src/dynamic-agent.js";
import type { ConversationState, TurnRequest } from "../src/turn-coordinator.js";

const config = loadConfig({ TOKEN_SIGNING_SECRET: "12345678901234567890123456789012" });
const installation = {
  installationId: "i",
  organizationId: "o",
  productId: "p",
  environmentId: "e",
  credentialHash: "00",
  allowedOrigins: ["https://app.test"],
  allowedRoles: ["member"],
  activeCatalogVersionId: "v1",
  dynamicMode: { enabled: true, autoConfirmLowRisk: true, maxIterationsPerTurn: 8 },
};
const session: RuntimeSession = {
  sessionId: "s",
  installation,
  userId: "u",
  role: "member",
  origin: "https://app.test",
  catalogVersionId: "v1",
  expiresAt: new Date(Date.now() + 10_000).toISOString(),
};
const catalog = { payload: { manifest: { catalogVersionId: "v1" }, journeys: [] } } as unknown as SignedCatalogEnvelope;
const bundle: RuntimeBundle = {
  schemaVersion: 1,
  organizationId: "o",
  productId: "p",
  environmentId: "e",
  catalogVersionId: "v1",
  catalogVersion: 1,
  generatedAt: new Date().toISOString(),
  salesPlays: [],
  screens: [],
  transitions: [],
  coverage: { weighted: 0, verified: 0, total: 0, unknown: 0 },
  journeys: [],
};

function makeRequest(): TurnRequest {
  return { turnId: "turn-1", text: "click the primary Save button on this page", modality: "text" };
}
function makeConversation(): ConversationState { return { messages: [] }; }
function makeUIMap(): UIMapSnapshot {
  return {
    url: "https://app.test/",
    path: "/",
    title: "Test App",
    elements: [
      { id: "e1", role: "button", label: "Save", testId: "save-btn", path: "/main/button[1]", visible: true },
      { id: "e2", role: "textbox", label: "Name", placeholder: "Full name", path: "/main/input[1]", editable: true, visible: true },
    ],
    capturedAt: new Date().toISOString(),
  };
}

function toolCall(args: Record<string, unknown>): NeutralToolCall {
  return { id: "call-1", name: "submit_next_action", args };
}

function makeModel(sequence: ModelResult[]): ModelClient {
  let index = 0;
  return {
    label: "test",
    step: async () => {
      if (index >= sequence.length) throw new Error("model was called more times than expected");
      return sequence[index++];
    },
  };
}

const dynamicConfig: DynamicModeConfig = { enabled: true, autoConfirmLowRisk: true };

const noopEvents = (): DynamicAgentEvents => ({
  async executeTool() {
    throw new Error("executeTool should not have been called");
  },
});

const ctx = () => ({
  session,
  catalog,
  bundle,
  conversation: makeConversation(),
  request: makeRequest(),
  uiMap: makeUIMap(),
});

test("dynamic agent terminates on a single-iteration answer", async () => {
  const model = makeModel([
    { texts: [], toolCalls: [toolCall({ action: "answer", text: "The Save button is highlighted at the top-right." })], done: false },
  ]);
  const agent = new DynamicAgent(model, config);
  const result = await agent.run(ctx(), noopEvents(), dynamicConfig);
  assert.equal(result.status, "answered");
  assert.equal(result.iterations, 1);
  assert.equal(result.finalText, "The Save button is highlighted at the top-right.");
  assert.equal(result.toolCallsRun, 0);
});

test("dynamic agent asks a clarifying question and stops", async () => {
  const model = makeModel([
    { texts: [], toolCalls: [toolCall({ action: "ask", text: "Which Save button do you mean?" })], done: false },
  ]);
  const agent = new DynamicAgent(model, config);
  const result = await agent.run(ctx(), noopEvents(), dynamicConfig);
  assert.equal(result.status, "asked");
  assert.equal(result.finalText, "Which Save button do you mean?");
});

test("dynamic agent enforces the iteration cap and reports iteration_cap", async () => {
  // Model always returns narrate — never terminates. maxIterations = 3 to keep the test fast.
  const narrate: ModelResult = { texts: [], toolCalls: [toolCall({ action: "narrate", text: "Working…" })], done: false };
  const model = makeModel([narrate, narrate, narrate]);
  const agent = new DynamicAgent(model, config);
  const narrations: string[] = [];
  const events: DynamicAgentEvents = {
    async executeTool() { throw new Error("no tool expected"); },
    onNarration: (text) => narrations.push(text),
  };
  const result = await agent.run(ctx(), events, { enabled: true, autoConfirmLowRisk: true, maxIterationsPerTurn: 3 });
  assert.equal(result.status, "iteration_cap");
  assert.equal(result.iterations, 3);
  assert.equal(narrations.length, 3);
  assert.match(result.finalText, /more direction|stopped before finishing/i);
});

test("dynamic agent dispatches tool calls through the executor with an inferred risk level", async () => {
  const model = makeModel([
    { texts: [], toolCalls: [toolCall({ action: "plan", steps: [{ id: "s1", title: "Click Save" }, { id: "s2", title: "Confirm" }] })], done: false },
    { texts: [], toolCalls: [toolCall({ action: "tool", stepId: "s1", reasoning: "Save the form", tool: { name: "click", target: { testId: "save-btn" }, arguments: {} } })], done: false },
    { texts: [], toolCalls: [toolCall({ action: "done", text: "Done." })], done: false },
  ]);
  const agent = new DynamicAgent(model, config);
  const invocations: Array<{ tool: string; risk: string; requiresConfirmation: boolean; stepId: string }> = [];
  const plans: number[] = [];
  const events: DynamicAgentEvents = {
    async executeTool(call) {
      invocations.push({ tool: call.tool, risk: call.risk, requiresConfirmation: call.requiresConfirmation, stepId: call.stepId });
      const result: DynamicToolResult = {
        commandId: "cmd-1",
        turnId: "turn-1",
        stepId: call.stepId,
        success: true,
        matchedElement: { testId: "save-btn", strategy: "testId", confidence: 1 },
        durationMs: 5,
      };
      return result;
    },
    onPlan: (plan) => plans.push(plan.version),
  };
  const result = await agent.run(ctx(), events, dynamicConfig);
  assert.equal(result.status, "done");
  assert.equal(result.iterations, 3);
  assert.equal(result.toolCallsRun, 1);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].tool, "click");
  // click maps to reversible_write; autoConfirmLowRisk=true skips confirmation.
  assert.equal(invocations[0].risk, "reversible_write");
  assert.equal(invocations[0].requiresConfirmation, false);
  assert.equal(invocations[0].stepId, "s1");
  // Plan emitted once (version 1) and once after the tool run marks the step done.
  assert.ok(plans.length >= 1);
  assert.equal(plans[0], 1);
  // Final step status should be done for s1 in the reported plan.
  const s1 = result.plan?.steps.find((step) => step.id === "s1");
  assert.equal(s1?.status, "done");
});

test("dynamic agent treats plain-text output on iter1 as an answer (knowledge question fallback)", async () => {
  const model = makeModel([
    // No tool calls, just prose — this happens when the model chooses to
    // reply conversationally to a knowledge question like "what is this app".
    // The runtime should use that prose as the assistant reply rather than
    // emitting a generic error.
    { texts: ["This is a healthcare demo application."], toolCalls: [], done: true },
  ]);
  const agent = new DynamicAgent(model, config);
  const result = await agent.run(ctx(), noopEvents(), dynamicConfig);
  assert.equal(result.status, "answered");
  assert.equal(result.iterations, 1);
  assert.match(result.finalText, /healthcare demo application/i);
});

test("dynamic agent errors when the model returns nothing at all (no tool, no text)", async () => {
  const model = makeModel([
    { texts: [], toolCalls: [], done: true },
  ]);
  const agent = new DynamicAgent(model, config);
  const result = await agent.run(ctx(), noopEvents(), dynamicConfig);
  assert.equal(result.status, "error");
  assert.equal(result.iterations, 1);
  assert.match(result.finalText, /couldn't decide/i);
});

test("dynamic agent rejects a tool outside the allowed list", async () => {
  const model = makeModel([
    { texts: [], toolCalls: [toolCall({ action: "tool", tool: { name: "click", target: { testId: "x" }, arguments: {} }, stepId: "s1" })], done: false },
  ]);
  const agent = new DynamicAgent(model, config);
  const events: DynamicAgentEvents = {
    async executeTool() { throw new Error("executor should not run"); },
  };
  const result = await agent.run(ctx(), events, { enabled: true, autoConfirmLowRisk: true, allowedTools: ["read"] });
  assert.equal(result.status, "error");
  assert.match(result.finalText, /not enabled/);
});

test("failed tool results still complete the loop without throwing", async () => {
  const model = makeModel([
    { texts: [], toolCalls: [toolCall({ action: "tool", tool: { name: "click", target: { testId: "missing-btn" }, arguments: {} }, stepId: "s1" })], done: false },
    { texts: [], toolCalls: [toolCall({ action: "answer", text: "I could not find that button." })], done: false },
  ]);
  const agent = new DynamicAgent(model, config);
  const events: DynamicAgentEvents = {
    async executeTool(call) {
      return {
        commandId: "c",
        turnId: "turn-1",
        stepId: call.stepId,
        success: false,
        error: { code: "CONTROL_NOT_FOUND", message: "not found" },
        durationMs: 3,
      } satisfies DynamicToolResult;
    },
  };
  const result = await agent.run(ctx(), events, dynamicConfig);
  assert.equal(result.status, "answered");
  assert.equal(result.finalText, "I could not find that button.");
  assert.equal(result.toolCallsRun, 1);
});
