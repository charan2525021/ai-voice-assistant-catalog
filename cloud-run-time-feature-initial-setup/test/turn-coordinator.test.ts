import assert from "node:assert/strict";
import test from "node:test";
import type { ModelClient, ModelResult } from "@sable/model-client";
import type { RuntimeBundle } from "@sable/runtime-core";
import type { ScreenObservation, SignedCatalogEnvelope } from "@sable/sdk-contracts";
import { loadConfig } from "../src/config.js";
import type { RuntimeSession } from "../src/contracts.js";
import { MemoryStores } from "../src/stores/memory.js";
import { TurnCoordinator } from "../src/turn-coordinator.js";

const config = loadConfig({ TOKEN_SIGNING_SECRET: "12345678901234567890123456789012" });
const installation = { installationId: "i", organizationId: "o", productId: "p", environmentId: "e", credentialHash: "00", allowedOrigins: ["https://app.test"], allowedRoles: ["member"], activeCatalogVersionId: "v1" };
const session: RuntimeSession = { sessionId: "s", installation, userId: "u", role: "member", origin: "https://app.test", catalogVersionId: "v1", expiresAt: new Date(Date.now() + 10_000).toISOString() };
const catalog = { payload: { manifest: { catalogVersionId: "v1" }, journeys: [
  { id: "allowed", name: "Open settings", description: "Show the settings section", intents: ["open settings"], roles: ["member"], state: "approved", risk: "read", inputSchema: { required: [], properties: {} }, compatibility: [{ classification: "SDK_DIRECT" }] },
  { id: "jump-section", name: "Jump to a page section", description: "Move to an approved in-page section", intents: ["show a section"], roles: ["member"], state: "approved", risk: "read", inputSchema: { required: ["sectionHash"], properties: { sectionHash: { type: "string" } } }, compatibility: [{ classification: "SDK_DIRECT" }] },
  { id: "broken-pricing", name: "View pricing", description: "Known broken link returning HTTP 404", intents: ["show pricing"], roles: ["member"], state: "verified", risk: "read", inputSchema: { required: [], properties: {} }, compatibility: [{ classification: "SDK_DIRECT" }] },
] } } as unknown as SignedCatalogEnvelope;
const bundle: RuntimeBundle = {
  schemaVersion: 1, organizationId: "o", productId: "p", environmentId: "e", catalogVersionId: "v1", catalogVersion: 1, generatedAt: new Date().toISOString(), salesPlays: [], screens: [], transitions: [], coverage: { weighted: 1, verified: 1, total: 1, unknown: 0 },
  journeys: [
    { key: "allowed", name: "Open settings", roleProfileIds: ["member"], intentPhrases: ["open settings"], reliability: 1, workflow: { schemaVersion: 1, id: "allowed", version: 1, name: "Open settings", risk: "read", preconditions: [], steps: [{ id: "one", action: "click", say: "Opening settings." }], postconditions: [] } },
    { key: "jump-section", name: "Jump to a page section", roleProfileIds: ["member"], intentPhrases: ["show a section"], reliability: 1, workflow: { schemaVersion: 1, id: "jump-section", version: 1, name: "Jump to a page section", risk: "read", preconditions: [], steps: [{ id: "one", action: "navigate", say: "This is the requested section." }], postconditions: [] } },
    { key: "broken-pricing", name: "View pricing", roleProfileIds: ["member"], intentPhrases: ["show pricing"], reliability: 0.2, workflow: { schemaVersion: 1, id: "broken-pricing", version: 1, name: "View pricing", risk: "read", preconditions: [], steps: [{ id: "one", action: "navigate" }], postconditions: [] } },
  ],
};

const planningCall = (value: Record<string, unknown>): ModelResult => ({
  texts: [], toolCalls: [{ id: "plan-1", name: "submit_turn_plan", args: (() => {
    const mode = String(value.mode ?? "answer");
    const journeyId = String(value.subjectJourneyId ?? value.journeyId ?? "");
    const targetScreenId = String(value.targetScreenId ?? "");
    const responseStrategy = value.responseStrategy ?? ({
      answer: "respond_answer", observe_then_answer: "respond_observe_then_answer", navigate: "respond_navigate",
      execute: journeyId ? "respond_execute" : "respond_answer",
      execute_then_observe_and_answer: "respond_execute_then_observe_and_answer", clarify: "respond_clarify",
    } as Record<string, string>)[mode];
    const taskControl = String(value.taskControl ?? "none");
    return {
      intent: value.intent ?? "conversation",
      responseStrategy,
      journeyDisposition: value.journeyDisposition ?? `journey_${taskControl}`,
      target: value.target ?? (targetScreenId
        ? { kind: "screen", id: targetScreenId }
        : journeyId ? { kind: "journey", id: journeyId } : { kind: "none", id: "" }),
      journeyInputsJson: value.journeyInputsJson ?? JSON.stringify(value.journeyInputs ?? {}),
      clarification: value.clarification ?? "",
    };
  })() }], done: false,
});

const model = (plan: Record<string, unknown>, answer: ModelResult): ModelClient => ({
  label: "test",
  step: async (_system, _messages, tools, options) => {
    const result = tools.some((tool) => tool.name === "submit_turn_plan") ? planningCall(plan) : answer;
    for (const text of result.texts) options?.onSentence?.(text);
    return result;
  },
});

test("the LLM turn plan—not a phrase rule—requests a fresh page observation", async () => {
  const stores = new MemoryStores([installation], [catalog], [bundle], []).asRuntimeStores();
  const coordinator = new TurnCoordinator(config, stores, model({ intent: "screen_question", mode: "observe_then_answer" }, { texts: ["Seven."], toolCalls: [], done: true }));
  const plan = await coordinator.plan(session, catalog, { messages: [] }, { turnId: "t", text: "What am I looking at?", modality: "text" });
  assert.equal(plan.intent, "screen_question");
  assert.equal(plan.needsFreshObservation, true);
});

test("a named informational subject is preserved without granting journey execution", async () => {
  const stores = new MemoryStores([installation], [catalog], [bundle], []).asRuntimeStores();
  const coordinator = new TurnCoordinator(config, stores, model({
    intent: "product_question",
    mode: "answer",
    needsKnowledge: true,
    subjectJourneyId: "allowed",
  }, { texts: ["Settings are available."], toolCalls: [], done: true }));
  const plan = await coordinator.plan(session, catalog, { messages: [] }, { turnId: "subject", text: "What is in settings?", modality: "text" });
  assert.equal(plan.subjectJourneyId, "allowed");
  assert.equal(plan.journeyId, undefined);
  assert.equal(plan.actionRequested, false);
});

test("one mapped read-only destination becomes a journey-independent catalog navigation", async () => {
  const navigationCatalog = { payload: { manifest: { catalogVersionId: "v1" }, screens: [
    { id: "home", name: "Home", roles: ["member"] }, { id: "travel", name: "Travel", roles: ["member"] },
  ], controls: [{ id: "travel-link", screenId: "home", name: "Travel", risk: "read", locators: [] }], journeys: [{
    id: "browse", version: 1, name: "Browse", description: "Browse safely", intents: [], roles: ["member"], state: "approved", risk: "read",
    inputSchema: { required: [], properties: {} }, compatibility: [],
    workflow: { preconditions: [{ kind: "screen_matches", screenId: "home", minimumConfidence: 0.6 }], steps: [
      { id: "open-travel", kind: "action", action: "navigate", url: { kind: "literal", value: "https://app.test/travel" }, continuity: { expectedScreenIds: ["travel"], destinationOrigins: ["https://app.test"] }, compatibility: { classification: "SDK_RESUMABLE_NAVIGATION" } },
      { id: "verify-travel", kind: "assert", assertion: { kind: "screen_matches", screenId: "travel", minimumConfidence: 0.6 }, compatibility: { classification: "SDK_DIRECT" } },
    ] },
  }] } } as unknown as SignedCatalogEnvelope;
  const navigationBundle: RuntimeBundle = {
    ...bundle, journeys: [],
    screens: [
      { key: "home", name: "Home", fingerprint: "home", roleProfileId: "member", controls: [{ key: "travel-link", role: "link", accessibleName: "Travel", risk: "read" }] },
      { key: "travel", name: "Travel", fingerprint: "travel", roleProfileId: "member", controls: [] },
    ],
    transitions: [{ fromScreenKey: "home", fromFingerprint: "home", toScreenKey: "travel", toFingerprint: "travel", roleProfileId: "member", controlKey: "travel-link", action: { action: "navigate" }, reliability: 0.98 }],
  };
  const stores = new MemoryStores([installation], [navigationCatalog], [navigationBundle], []).asRuntimeStores();
  const coordinator = new TurnCoordinator(config, stores, model({ intent: "action", mode: "navigate", targetScreenId: "travel" }, { texts: ["I’ll open Travel."], toolCalls: [], done: true }));
  const request = { turnId: "t", text: "Open Travel", modality: "text" as const };
  const conversation = { messages: [] };
  const plan = await coordinator.plan(session, navigationCatalog, conversation, request);
  assert.equal(plan.mode, "navigate");
  assert.equal(plan.needsFreshObservation, true);
  const observation: ScreenObservation = {
    kind: "sable.screen_observation", schemaVersion: 1, observationId: "o1", version: 1, capturedAt: new Date().toISOString(),
    url: "https://app.test/", origin: "https://app.test", title: "Home", fingerprint: "home", visibleText: "Travel", matchedScreenId: "home", matchConfidence: 1,
    elements: [{ id: "e1", role: "link", name: "Travel", visible: true, enabled: true, controlId: "travel-link" }],
  };
  const result = await coordinator.run(session, navigationCatalog, conversation, request, plan, observation);
  assert.deepEqual(result.catalogNavigation, {
    sourceScreenId: "home", controlId: "travel-link", targetScreenId: "travel",
    steps: [{ sourceScreenId: "home", controlId: "travel-link", targetScreenId: "travel" }],
    acknowledgement: "I’ll open Travel.",
  });
  assert.equal(result.action, undefined);

  const rawObservation = { ...observation, matchedScreenId: undefined, matchConfidence: undefined };
  const rejected = await coordinator.run(session, navigationCatalog, { messages: [] }, request, plan, rawObservation);
  assert.equal(rejected.action, undefined);
  assert.equal(rejected.catalogNavigation, undefined);
  assert.match(rejected.answer, /didn't click/);
});

test("a multi-step destination is composed only from signed read-only catalog edges", async () => {
  const navigationCatalog = { payload: { manifest: { catalogVersionId: "v1" }, journeys: [], screens: [
    { id: "home", name: "Home", roles: ["member"] },
    { id: "mystery", name: "Mystery", roles: ["member"] },
    { id: "sharp", name: "Sharp Objects", roles: ["member"] },
  ], controls: [
    { id: "mystery-link", screenId: "home", name: "Mystery", risk: "read", locators: [] },
    { id: "sharp-link", screenId: "mystery", name: "Sharp Objects", risk: "read", locators: [] },
  ] } } as unknown as SignedCatalogEnvelope;
  const navigationBundle: RuntimeBundle = {
    ...bundle, journeys: [],
    screens: [
      { key: "home", name: "Home", fingerprint: "home", roleProfileId: "member", controls: [{ key: "mystery-link", role: "link", accessibleName: "Mystery", risk: "read" }] },
      { key: "mystery", name: "Mystery", fingerprint: "mystery", roleProfileId: "member", controls: [{ key: "sharp-link", role: "link", accessibleName: "Sharp Objects", risk: "read" }] },
      { key: "sharp", name: "Sharp Objects", fingerprint: "sharp", roleProfileId: "member", controls: [] },
    ],
    transitions: [
      { fromScreenKey: "home", fromFingerprint: "home", toScreenKey: "mystery", toFingerprint: "mystery", roleProfileId: "member", controlKey: "mystery-link", action: { action: "navigate" }, reliability: 0.98 },
      { fromScreenKey: "mystery", fromFingerprint: "mystery", toScreenKey: "sharp", toFingerprint: "sharp", roleProfileId: "member", controlKey: "sharp-link", action: { action: "navigate" }, reliability: 0.98 },
    ],
  };
  const stores = new MemoryStores([installation], [navigationCatalog], [navigationBundle], []).asRuntimeStores();
  const coordinator = new TurnCoordinator(config, stores, model({ intent: "action", mode: "navigate", targetScreenId: "sharp" }, { texts: ["I’ll take you to Sharp Objects."], toolCalls: [], done: true }));
  const request = { turnId: "multi", text: "Open Sharp Objects", modality: "text" as const };
  const conversation = { messages: [] };
  const plan = await coordinator.plan(session, navigationCatalog, conversation, request);
  const result = await coordinator.run(session, navigationCatalog, conversation, request, plan, {
    kind: "sable.screen_observation", schemaVersion: 1, observationId: "home-observation", version: 1, capturedAt: new Date().toISOString(),
    url: "https://app.test/", origin: "https://app.test", title: "Home", fingerprint: "home", visibleText: "Mystery", matchedScreenId: "home", matchConfidence: 1,
    elements: [{ id: "mystery", role: "link", name: "Mystery", visible: true, enabled: true, controlId: "mystery-link" }],
  });
  assert.deepEqual(result.catalogNavigation?.steps, [
    { sourceScreenId: "home", controlId: "mystery-link", targetScreenId: "mystery" },
    { sourceScreenId: "mystery", controlId: "sharp-link", targetScreenId: "sharp" },
  ]);
});

test("the planner requires a structured tool result from every provider", async () => {
  const stores = new MemoryStores([installation], [catalog], [bundle], []).asRuntimeStores();
  let toolChoice: "auto" | "required" | undefined;
  let strictRequested = false;
  let plannerProperties: Record<string, unknown> = {};
  const requiredToolModel: ModelClient = {
    label: "required-tool-test",
    step: async (_system, _messages, tools, options) => {
      const plannerTool = tools.find((tool) => tool.name === "submit_turn_plan");
      if (plannerTool) {
        toolChoice = options?.toolChoice;
        strictRequested = plannerTool.strict === true;
        plannerProperties = (plannerTool.parameters.properties ?? {}) as Record<string, unknown>;
      }
      return planningCall({ intent: "product_question", mode: "answer", needsKnowledge: true });
    },
  };
  const coordinator = new TurnCoordinator(config, stores, requiredToolModel);
  await coordinator.plan(session, catalog, { messages: [] }, { turnId: "t", text: "What is this platform?", modality: "text" });
  assert.equal(toolChoice, "required");
  assert.equal(strictRequested, true);
  assert.deepEqual(Object.keys(plannerProperties).sort(), ["clarification", "intent", "journeyDisposition", "journeyInputsJson", "responseStrategy", "target"]);
});

test("the semantic planner receives the live guided-demo position", async () => {
  const stores = new MemoryStores([installation], [catalog], [bundle], []).asRuntimeStores();
  let plannerSystem = "";
  const stateAwareModel: ModelClient = {
    label: "state-aware-test",
    step: async (system) => {
      plannerSystem = system;
      return planningCall({
        intent: "conversation",
        responseStrategy: "respond_answer",
        journeyDisposition: "journey_continue",
        target: { kind: "none", id: "" },
      });
    },
  };
  const coordinator = new TurnCoordinator(config, stores, stateAwareModel);
  await coordinator.plan(session, catalog, { messages: [] }, { turnId: "state", text: "Continue", modality: "voice" }, {
    activeJourney: { journeyId: "allowed", journeyName: "Overview", paused: true },
    demoRuntimeState: {
      phase: "awaiting_resume",
      activeModule: { id: "overview", name: "Overview", journeyId: "allowed" },
      journeyOutcome: "completed",
      resumeReason: "module_complete",
      checkpointAvailable: false,
      moduleCompletedDuringInterruption: false,
      nextModule: { id: "smart-reporting", name: "Smart Reporting", journeyId: "jump-section" },
      currentScreen: { id: "home", confidence: 1 },
      pendingInterruption: true,
    },
  });
  assert.match(plannerSystem, /DEMO RUNTIME STATE/);
  assert.match(plannerSystem, /"journeyOutcome":"completed"/);
  assert.match(plannerSystem, /"name":"Smart Reporting"/);
  assert.match(plannerSystem, /Resolve pronouns and follow-ups/);
});

test("two malformed planner results degrade to a safe clarification instead of stopping the session", async () => {
  const stores = new MemoryStores([installation], [catalog], [bundle], []).asRuntimeStores();
  let calls = 0;
  const malformedModel: ModelClient = {
    label: "malformed-test",
    step: async () => {
      calls += 1;
      return planningCall({ responseStrategy: "journey_continue" });
    },
  };
  const coordinator = new TurnCoordinator(config, stores, malformedModel);
  const plan = await coordinator.plan(session, catalog, { messages: [] }, { turnId: "fallback", text: "Tell me more", modality: "voice" });
  assert.equal(calls, 2);
  assert.equal(plan.mode, "clarify");
  assert.equal(plan.actionRequested, false);
  assert.match(plan.clarification ?? "", /explain something or show a specific section/);
});

test("a strict module target resolves through the signed demo profile to its journey", async () => {
  const moduleCatalog = {
    payload: {
      ...catalog.payload,
      journeys: catalog.payload.journeys.map((journey) => journey.id === "allowed" ? { ...journey, demoSafe: true } : journey),
      demoProfile: {
        id: "demo", version: 1, greeting: { text: "Hello" }, questions: [],
        intake: { genericQuestionIds: ["one", "two"], personaQuestionByPersonaId: {} }, personas: [],
        modules: [{ id: "smart-report", name: "Smart Reporting", journeyId: "allowed", introduction: { text: "Intro" }, completion: { text: "Done" }, failureMessage: { text: "Failed" } }],
        defaultPlaylistModuleIds: ["smart-report"], playlistModuleIdsByPersonaId: {}, closing: { text: "Bye" },
      },
    },
  } as unknown as SignedCatalogEnvelope;
  const stores = new MemoryStores([installation], [moduleCatalog], [bundle], []).asRuntimeStores();
  const coordinator = new TurnCoordinator(config, stores, model({
    intent: "action",
    responseStrategy: "respond_execute",
    journeyDisposition: "journey_none",
    target: { kind: "module", id: "smart-report" },
  }, { texts: ["Opening Smart Reporting."], toolCalls: [], done: true }));
  const plan = await coordinator.plan(session, moduleCatalog, { messages: [] }, { turnId: "module", text: "Go directly to Smart Reporting", modality: "voice" });
  assert.equal(plan.subjectJourneyId, "allowed");
  assert.equal(plan.journeyId, "allowed");
  assert.equal(plan.mode, "execute");
});

test("a provider outage is not disguised as an invalid intent plan", async () => {
  const stores = new MemoryStores([installation], [catalog], [bundle], []).asRuntimeStores();
  const unavailableModel: ModelClient = {
    label: "unavailable-test",
    step: async () => { throw new Error("Reasoning provider is temporarily unavailable (HTTP 503)"); },
  };
  const coordinator = new TurnCoordinator(config, stores, unavailableModel);
  await assert.rejects(
    coordinator.plan(session, catalog, { messages: [] }, { turnId: "t", text: "Give me a walkthrough", modality: "voice" }),
    /temporarily unavailable \(HTTP 503\)/,
  );
});

test("an unsupported provider intent is repaired once instead of reaching the user", async () => {
  const stores = new MemoryStores([installation], [catalog], [bundle], []).asRuntimeStores();
  let planningCalls = 0;
  const repairingModel: ModelClient = {
    label: "repair-test",
    step: async (_system, _messages, tools) => {
      if (!tools.some((tool) => tool.name === "submit_turn_plan")) return { texts: ["unused"], toolCalls: [], done: true };
      planningCalls += 1;
      return planningCall(planningCalls === 1
        ? { intent: "capability_question", mode: "answer" }
        : { intent: "product_question", mode: "answer", needsKnowledge: true });
    },
  };
  const coordinator = new TurnCoordinator(config, stores, repairingModel);
  const plan = await coordinator.plan(session, catalog, { messages: [] }, { turnId: "t", text: "Tell me about capabilities", modality: "voice" });
  assert.equal(planningCalls, 2);
  assert.equal(plan.intent, "product_question");
  assert.equal(plan.mode, "answer");
});

test("a crossed planner field is repaired before execution", async () => {
  const stores = new MemoryStores([installation], [catalog], [bundle], []).asRuntimeStores();
  let planningCalls = 0;
  const repairingModel: ModelClient = {
    label: "repair-test",
    step: async (_system, _messages, tools) => {
      if (!tools.some((tool) => tool.name === "submit_turn_plan")) return { texts: ["unused"], toolCalls: [], done: true };
      planningCalls += 1;
      return planningCall(planningCalls === 1
        ? { intent: "action", responseStrategy: "journey_continue", mode: "answer", journeyId: "allowed" }
        : { intent: "action", mode: "execute", journeyId: "allowed" });
    },
  };
  const coordinator = new TurnCoordinator(config, stores, repairingModel);
  const plan = await coordinator.plan(session, catalog, { messages: [] }, { turnId: "t", text: "Open settings", modality: "text" });
  assert.equal(planningCalls, 2);
  assert.equal(plan.mode, "execute");
  assert.equal(plan.journeyId, "allowed");
});

test("a screen-description request ignores an irrelevant journey ID instead of failing", async () => {
  const stores = new MemoryStores([installation], [catalog], [bundle], []).asRuntimeStores();
  const coordinator = new TurnCoordinator(config, stores, model({
    intent: "screen_question", mode: "observe_then_answer", journeyId: "allowed",
  }, { texts: ["The visible description explains this book."], toolCalls: [], done: true }));
  const conversation = { messages: [] };
  const request = { turnId: "t", text: "Read me the product description", modality: "voice" as const };
  const plan = await coordinator.plan(session, catalog, conversation, request);
  assert.equal(plan.mode, "observe_then_answer");
  assert.equal(plan.journeyId, undefined);
  assert.equal(plan.needsFreshObservation, true);
  const result = await coordinator.run(session, catalog, conversation, request, plan, {
    kind: "sable.screen_observation", schemaVersion: 1, observationId: "book-screen", version: 1,
    capturedAt: new Date().toISOString(), url: "https://app.test/book", origin: "https://app.test",
    title: "Book", fingerprint: "book", visibleText: "Product Description: A fictional travel memoir.", elements: [],
  });
  assert.equal(result.action, undefined);
  assert.equal(result.answer, "The visible description explains this book.");
});

test("an action with no approved journey becomes a grounded limitation instead of a planner error", async () => {
  const stores = new MemoryStores([installation], [catalog], [bundle], []);
  const coordinator = new TurnCoordinator(config, stores.asRuntimeStores(), model({
    intent: "action", mode: "execute", journeyId: "", needsKnowledge: false,
  }, { texts: ["I don't have an approved journey to return home yet."], toolCalls: [], done: true }));
  const conversation = { messages: [] };
  const request = { turnId: "t", text: "Go back to home", modality: "voice" as const };
  const plan = await coordinator.plan(session, catalog, conversation, request);
  assert.equal(plan.mode, "answer");
  assert.equal(plan.actionRequested, false);
  assert.equal(plan.needsKnowledge, true);
  assert.match(plan.unavailableReason ?? "", /No approved catalog journey/);
  const result = await coordinator.run(session, catalog, conversation, request, plan, undefined);
  assert.equal(result.action, undefined);
  assert.match(result.answer, /not a trained screen/);
  assert.equal(stores.events.at(-1)?.type, "catalog.gap_detected");
  assert.equal(stores.events.at(-1)?.detail?.reason, "action_on_untrained_screen");
  assert.equal(JSON.stringify(stores.events.at(-1)?.detail).includes("Go back to home"), false);
});

test("an unmapped action on a trained screen refuses execution and records only privacy-safe gap metadata", async () => {
  const navigationCatalog = { payload: { manifest: { catalogVersionId: "v1" }, journeys: [], screens: [
    { id: "home", name: "Home", roles: ["member"] },
  ], controls: [] } } as unknown as SignedCatalogEnvelope;
  const navigationBundle: RuntimeBundle = {
    ...bundle, journeys: [], transitions: [],
    screens: [{ key: "home", name: "Home", fingerprint: "home", roleProfileId: "member", controls: [] }],
  };
  const stores = new MemoryStores([installation], [navigationCatalog], [navigationBundle], []);
  const coordinator = new TurnCoordinator(config, stores.asRuntimeStores(), model(
    { intent: "action", mode: "clarify", clarification: "What do you expect to happen after clicking Submit?" },
    { texts: ["unused"], toolCalls: [], done: true },
  ));
  const request = { turnId: "gap", text: "Click the secret submit button", modality: "text" as const };
  const conversation = { messages: [] };
  const plan = await coordinator.plan(session, navigationCatalog, conversation, request);
  assert.equal(plan.actionAttempted, false);
  assert.equal(plan.actionRequested, false);
  const result = await coordinator.run(session, navigationCatalog, conversation, request, plan, {
    kind: "sable.screen_observation", schemaVersion: 1, observationId: "gap-observation", version: 1, capturedAt: new Date().toISOString(),
    url: "https://app.test/home", origin: "https://app.test", title: "Home", fingerprint: "home", visibleText: "Secret submit button", matchedScreenId: "home", matchConfidence: 1,
    elements: [{ id: "submit", role: "button", name: "Secret submit button", visible: true, enabled: true }],
  });
  assert.match(result.answer, /control is not mapped/);
  const event = stores.events.at(-1);
  assert.equal(event?.type, "catalog.gap_detected");
  assert.equal(event?.detail?.reason, "unmapped_action_on_trained_screen");
  assert.equal(event?.detail?.routePath, "/home");
  assert.equal(event?.detail?.unmappedElementCount, 1);
  assert.deepEqual(event?.detail?.unmappedRoleCounts, { button: 1 });
  const serialized = JSON.stringify(event?.detail);
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes("submit button"), false);
  assert.equal(serialized.includes("selector"), false);
});

test("signed control behavior grounds explanations without granting execution authority", async () => {
  const behaviorCatalog = { payload: { manifest: { catalogVersionId: "v1" }, journeys: [], screens: [
    { id: "form", name: "Web form", roles: ["member"] },
  ], controls: [{
    id: "submit", screenId: "form", name: "Submit", risk: "external_side_effect", locators: [],
    description: "Submits the demonstration form.",
    behavior: { kind: "form_submission", summary: "Submits the current fields with an HTTP GET request and opens submitted-form.html." },
  }] } } as unknown as SignedCatalogEnvelope;
  const behaviorBundle: RuntimeBundle = {
    ...bundle, journeys: [], transitions: [],
    screens: [{ key: "form", name: "Web form", fingerprint: "form", roleProfileId: "member", controls: [{ key: "submit", role: "button", accessibleName: "Submit", risk: "external_side_effect" }] }],
  };
  let answerSystem = "";
  const behaviorModel: ModelClient = {
    label: "behavior-test",
    step: async (system, _messages, tools) => {
      if (tools.some((tool) => tool.name === "submit_turn_plan")) return planningCall({ intent: "screen_question", mode: "observe_then_answer", needsKnowledge: false });
      answerSystem = system;
      return { texts: ["It submits the fields with GET and opens submitted-form.html."], toolCalls: [], done: true };
    },
  };
  const stores = new MemoryStores([installation], [behaviorCatalog], [behaviorBundle], []).asRuntimeStores();
  const coordinator = new TurnCoordinator(config, stores, behaviorModel);
  const request = { turnId: "behavior", text: "What does Submit do?", modality: "text" as const };
  const conversation = { messages: [] };
  const plan = await coordinator.plan(session, behaviorCatalog, conversation, request);
  const result = await coordinator.run(session, behaviorCatalog, conversation, request, plan, {
    kind: "sable.screen_observation", schemaVersion: 1, observationId: "form-observation", version: 1, capturedAt: new Date().toISOString(),
    url: "https://app.test/form", origin: "https://app.test", title: "Web form", fingerprint: "form", visibleText: "Submit", matchedScreenId: "form", matchConfidence: 1,
    elements: [{ id: "submit", role: "button", name: "Submit", visible: true, enabled: true, controlId: "submit" }],
  });
  assert.match(answerSystem, /SIGNED TRAINED CONTROL BEHAVIOR/);
  assert.match(answerSystem, /HTTP GET request/);
  assert.equal(result.action, undefined);
});

test("a model cannot invent a journey ID", async () => {
  const stores = new MemoryStores([installation], [catalog], [bundle], []).asRuntimeStores();
  const coordinator = new TurnCoordinator(config, stores, model({ intent: "action", mode: "execute", journeyId: "invented" }, { texts: ["I cannot safely do that."], toolCalls: [], done: true }));
  const conversation = { messages: [] };
  const request = { turnId: "t", text: "Open settings", modality: "text" as const };
  const plan = await coordinator.plan(session, catalog, conversation, request);
  const result = await coordinator.run(session, catalog, conversation, request, plan, undefined);
  assert.equal(result.action, undefined);
  assert.match(plan.unavailableReason ?? "", /does not match any journey/);
});

test("the one matching approved SDK journey can be returned with its inputs", async () => {
  const stores = new MemoryStores([installation], [catalog], [bundle], []).asRuntimeStores();
  const coordinator = new TurnCoordinator(config, stores, model({ intent: "action", mode: "execute", journeyId: "allowed" }, { texts: ["I’ll show you settings."], toolCalls: [], done: true }));
  const conversation = { messages: [] };
  const request = { turnId: "t", text: "Open settings", modality: "voice" as const };
  const plan = await coordinator.plan(session, catalog, conversation, request);
  const result = await coordinator.run(session, catalog, conversation, request, plan, undefined);
  assert.equal(result.action?.journeyId, "allowed");
  assert.equal(result.answer, "I’ll show you settings.");
});

test("a named-section explanation becomes an approved presentation journey", async () => {
  const stores = new MemoryStores([installation], [catalog], [bundle], []).asRuntimeStores();
  const coordinator = new TurnCoordinator(config, stores, model({
    intent: "product_question", mode: "execute_then_observe_and_answer", needsKnowledge: true, journeyId: "allowed",
  }, { texts: ["Let’s look at settings."], toolCalls: [], done: true }));
  const conversation = { messages: [] };
  const request = { turnId: "t", text: "Tell me what the settings section has", modality: "text" as const };
  const plan = await coordinator.plan(session, catalog, conversation, request);
  assert.equal(plan.presentationRequested, true);
  assert.equal(plan.journeyId, "allowed");
  const result = await coordinator.run(session, catalog, conversation, request, plan, undefined);
  assert.equal(result.action?.journeyId, "allowed");
});

test("a known broken journey becomes grounded knowledge, never an action", async () => {
  const stores = new MemoryStores([installation], [catalog], [bundle], []).asRuntimeStores();
  const coordinator = new TurnCoordinator(config, stores, model({
    intent: "action", mode: "execute", journeyId: "broken-pricing",
  }, { texts: ["That pricing destination is unavailable."], toolCalls: [], done: true }));
  const conversation = { messages: [] };
  const request = { turnId: "t", text: "Take me to pricing", modality: "text" as const };
  const plan = await coordinator.plan(session, catalog, conversation, request);
  assert.equal(plan.journeyId, undefined);
  assert.equal(plan.needsKnowledge, true);
  assert.match(plan.unavailableReason ?? "", /HTTP 404/);
  const result = await coordinator.run(session, catalog, conversation, request, plan, undefined);
  assert.equal(result.action, undefined);
});

test("a missing section input asks one clarification and does not execute", async () => {
  const stores = new MemoryStores([installation], [catalog], [bundle], []).asRuntimeStores();
  const coordinator = new TurnCoordinator(config, stores, model({
    intent: "product_question", mode: "clarify",
    journeyId: "", journeyInputs: {}, clarification: "Which section would you like me to show?",
  }, { texts: ["unused"], toolCalls: [], done: true }));
  const conversation = { messages: [] };
  const request = { turnId: "t", text: "Tell me what the section has", modality: "text" as const };
  const plan = await coordinator.plan(session, catalog, conversation, request);
  const result = await coordinator.run(session, catalog, conversation, request, plan, undefined);
  assert.equal(result.action, undefined);
  assert.equal(result.answer, "Which section would you like me to show?");
});

test("post-navigation explanation is grounded in the fresh DOM observation", async () => {
  const stores = new MemoryStores([installation], [catalog], [bundle], [{
    id: "settings-kb", tenantId: "o", productId: "p", catalogVersionId: "v1",
    title: "Settings", section: "Settings", content: "Settings contains notification and profile controls.", source: "docs", trust: "official", score: 1,
  }]).asRuntimeStores();
  let answerCalls = 0;
  const dynamicModel: ModelClient = {
    label: "test",
    step: async (_system, _messages, tools, options) => {
      if (tools.some((tool) => tool.name === "submit_turn_plan")) return planningCall({
        intent: "product_question", mode: "execute_then_observe_and_answer", needsKnowledge: true, journeyId: "allowed",
      });
      answerCalls += 1;
      const text = answerCalls === 1 ? "Let’s look at settings." : "This section contains notification and profile controls.";
      options?.onSentence?.(text);
      return { texts: [text], toolCalls: [], done: true };
    },
  };
  const coordinator = new TurnCoordinator(config, stores, dynamicModel);
  const conversation = { messages: [] };
  const request = { turnId: "t", text: "Tell me what the settings section has", modality: "voice" as const };
  const plan = await coordinator.plan(session, catalog, conversation, request);
  const first = await coordinator.run(session, catalog, conversation, request, plan, undefined);
  assert.equal(first.action?.journeyId, "allowed");
  coordinator.recordJourneyResult(conversation, first.action!, { ok: true, completedSteps: 1 });
  const observation: ScreenObservation = {
    kind: "sable.screen_observation", schemaVersion: 1, observationId: "obs", version: 2,
    capturedAt: new Date().toISOString(), url: "https://app.test/settings", origin: "https://app.test",
    title: "Settings", fingerprint: "settings", visibleText: "Notifications Profile",
    elements: [],
  };
  const explanation = await coordinator.explainAfterPresentation(session, conversation, request, plan, observation);
  assert.equal(explanation.answer, "This section contains notification and profile controls.");
  assert.equal(explanation.evidence.screen?.observationId, "obs");
});
