import assert from "node:assert/strict";
import test from "node:test";
import type { ModelClient, ModelResult, NeutralToolCall } from "@sable/model-client";
import type { RuntimeBundle } from "@sable/runtime-core";
import type { DynamicToolResult, SignedCatalogEnvelope, UIMapSnapshot } from "@sable/sdk-contracts";
import { loadConfig } from "../src/config.js";
import type { DynamicModeConfig, RuntimeSession } from "../src/contracts.js";
import { MemoryStores } from "../src/stores/memory.js";
import { TurnCoordinator, type ConversationState } from "../src/turn-coordinator.js";

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
  dynamicMode: { enabled: true, autoConfirmLowRisk: true } satisfies DynamicModeConfig,
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

const uiMap: UIMapSnapshot = {
  url: "https://app.test/",
  path: "/",
  title: "Test App",
  elements: [
    { id: "e1", role: "button", label: "Contacts", testId: "nav-contacts", path: "/nav/button[1]", visible: true },
  ],
  capturedAt: new Date().toISOString(),
};

function toolCall(args: Record<string, unknown>): NeutralToolCall {
  return { id: "call-1", name: "submit_next_action", args };
}
function makeSequence(sequence: ModelResult[]): ModelClient {
  let index = 0;
  return {
    label: "test",
    step: async () => {
      if (index >= sequence.length) throw new Error("model called more than expected");
      return sequence[index++];
    },
  };
}

test("runDynamic writes only the final assistant message to conversation history", async () => {
  const stores = new MemoryStores([installation], [catalog], [bundle], []).asRuntimeStores();
  const model = makeSequence([
    { texts: [], toolCalls: [toolCall({ action: "answer", text: "Contacts is in the top navigation." })], done: false },
  ]);
  const coordinator = new TurnCoordinator(config, stores, model);
  const conversation: ConversationState = { messages: [] };
  const request = { turnId: "turn-1", text: "where is contacts?", modality: "text" as const };

  const result = await coordinator.runDynamic(
    session,
    catalog,
    conversation,
    request,
    uiMap,
    installation.dynamicMode,
    { async executeTool() { throw new Error("no tool expected"); } },
  );

  assert.equal(result.status, "answered");
  assert.equal(result.finalText, "Contacts is in the top navigation.");
  assert.equal(conversation.messages.length, 2);
  const [userMsg, assistantMsg] = conversation.messages;
  assert.equal(userMsg?.role, "user");
  assert.equal(assistantMsg?.role, "assistant");
  const firstBlock = assistantMsg?.blocks?.[0];
  assert.equal(firstBlock?.type, "text");
  assert.equal(firstBlock?.type === "text" ? firstBlock.text : "", "Contacts is in the top navigation.");
});

test("runDynamic threads tool results back into the loop", async () => {
  const stores = new MemoryStores([installation], [catalog], [bundle], []).asRuntimeStores();
  const model = makeSequence([
    { texts: [], toolCalls: [toolCall({ action: "tool", stepId: "s1", tool: { name: "click", target: { testId: "nav-contacts" }, arguments: {} } })], done: false },
    { texts: [], toolCalls: [toolCall({ action: "done", text: "Opened Contacts." })], done: false },
  ]);
  const coordinator = new TurnCoordinator(config, stores, model);
  const conversation: ConversationState = { messages: [] };
  const request = { turnId: "turn-1", text: "open contacts", modality: "text" as const };
  const invocations: string[] = [];
  const result = await coordinator.runDynamic(
    session,
    catalog,
    conversation,
    request,
    uiMap,
    installation.dynamicMode,
    {
      async executeTool(call) {
        invocations.push(`${call.tool}:${call.target?.testId ?? ""}`);
        return { commandId: "c", turnId: request.turnId, stepId: call.stepId, success: true, matchedElement: { testId: "nav-contacts", strategy: "testId", confidence: 1 }, durationMs: 4 } satisfies DynamicToolResult;
      },
    },
  );
  assert.equal(result.status, "done");
  assert.equal(result.toolCallsRun, 1);
  assert.deepEqual(invocations, ["click:nav-contacts"]);
  assert.equal(result.finalText, "Opened Contacts.");
});
