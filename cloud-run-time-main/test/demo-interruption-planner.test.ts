import assert from "node:assert/strict";
import test from "node:test";
import type { ModelClient } from "@sable/model-client";
import type { SignedCatalogEnvelope } from "@sable/sdk-contracts";
import type { RuntimeSession } from "../src/contracts.js";
import { DemoInterruptionPlanner, validateDemoInterruptionPlan, type DemoInterruptionContext } from "../src/demo-interruption-planner.js";

function catalog(): SignedCatalogEnvelope {
  const journey = (id: string, demoSafe: boolean) => ({
    kind: "sable.catalog.journey", id, version: 1, name: id, intents: [], roles: ["member"], risk: "read",
    inputSchema: { kind: "sable.journey_input_schema", properties: {}, required: [], additionalProperties: false },
    workflow: { kind: "sable.workflow", version: 1, risk: "read", preconditions: [], steps: [], postconditions: [] },
    compatibility: [], state: "approved", demoSafe,
  });
  return { payload: {
    manifest: { catalogVersionId: "v1" },
    journeys: [journey("show-reports", true), journey("show-risk", true), journey("unsafe-write", false)],
    demoProfile: {
      id: "niro-demo", version: 1, greeting: { text: "Welcome" },
      questions: [
        { id: "role", captureKey: "lead.role", prompt: { text: "Role?" } },
        { id: "goal", captureKey: "lead.goal", prompt: { text: "Goal?" } },
      ],
      intake: { genericQuestionIds: ["role", "goal"], personaQuestionByPersonaId: {} }, personas: [],
      modules: [
        { id: "reports", name: "Reports", journeyId: "show-reports", introduction: { text: "Reports" }, completion: { text: "Done" }, failureMessage: { text: "Failed" } },
        { id: "risk", name: "Risk calculator", journeyId: "show-risk", introduction: { text: "Risk" }, completion: { text: "Done" }, failureMessage: { text: "Failed" } },
        { id: "unsafe", name: "Unsafe", journeyId: "unsafe-write", introduction: { text: "Unsafe" }, completion: { text: "Done" }, failureMessage: { text: "Failed" } },
      ],
      defaultPlaylistModuleIds: ["reports"], playlistModuleIdsByPersonaId: {}, closing: { text: "Thanks" },
    },
  } } as unknown as SignedCatalogEnvelope;
}

function context(): DemoInterruptionContext {
  const session = {
    sessionId: "session-1",
    installation: { installationId: "install", organizationId: "tenant", productId: "niro", environmentId: "test", credentialHash: "hash", allowedOrigins: ["https://client.test"], allowedRoles: ["member"], activeCatalogVersionId: "v1", guidedDemo: { enabled: true } },
    userId: "lead", role: "member", origin: "https://client.test", catalogVersionId: "v1", expiresAt: new Date(Date.now() + 60_000).toISOString(),
  } satisfies RuntimeSession;
  return {
    session,
    catalog: catalog(),
    demo: {
      profileId: "niro-demo", profileVersion: 1, phase: "answering",
      answers: { "lead.role": "laboratory", "lead.goal": "understand reports" }, genericQuestionIndex: 2,
      playlistModuleIds: ["reports"], moduleIndex: 0, activeModuleId: "reports", resumeReason: "interruption",
      checkpoint: { journeyId: "show-reports", completedStepIds: ["open"], nextStepId: "explain" }, updatedAt: new Date().toISOString(),
    },
    request: { turnId: "interrupt-1", text: "What does this number on the screen mean?", modality: "text" },
    transcript: [{ key: "user:interrupt-1", role: "user", text: "What does this number on the screen mean?", createdAt: new Date().toISOString() }],
    currentScreenId: "reports-screen",
  };
}

test("the bounded planner calls one required tool and policy forces fresh observation for a screen question", async () => {
  let calls = 0;
  let capturedSystem = "";
  const model: ModelClient = {
    label: "test",
    step: async (system, _messages, tools, options) => {
      calls += 1;
      capturedSystem = system;
      assert.equal(options?.toolChoice, "required");
      assert.deepEqual(tools.map((tool) => tool.name), ["submit_demo_interruption_plan"]);
      return { texts: [], toolCalls: [{ id: "plan", name: "submit_demo_interruption_plan", args: {
        intent: "screen_question", responseMode: "answer", playbackDirective: "resume_after_answer",
        needsKnowledge: false, requestedModuleId: "", clarification: "",
      } }], done: true };
    },
  };
  const plan = await new DemoInterruptionPlanner(model).plan(context());
  assert.equal(calls, 1);
  assert.equal(plan.responseMode, "observe_then_answer");
  assert.equal(plan.needsFreshObservation, true);
  assert.equal(plan.playbackDirective, "resume_after_answer");
  assert.match(capturedSystem, /Do not decide qualification or sales strategy/);
  assert.match(capturedSystem, /"id":"risk"/);
  assert.doesNotMatch(capturedSystem, /unsafe-write.*allowed/i);
  assert.ok(capturedSystem.length < 12_000, `planner context unexpectedly grew to ${capturedSystem.length} characters`);
});

test("product questions and objections deterministically require knowledge", () => {
  const product = validateDemoInterruptionPlan({
    intent: "product_question", responseMode: "answer", playbackDirective: "resume_after_answer",
    needsKnowledge: false, requestedModuleId: "", clarification: "",
  }, context());
  assert.equal(product.needsKnowledge, true);
  const objection = validateDemoInterruptionPlan({
    intent: "objection", responseMode: "answer", playbackDirective: "remain_paused",
    needsKnowledge: false, requestedModuleId: "", clarification: "",
  }, context());
  assert.equal(objection.needsKnowledge, true);
});

test("replacement is allowed only for an exact approved demo-safe module and action intent", () => {
  const allowed = validateDemoInterruptionPlan({
    intent: "action", responseMode: "answer", playbackDirective: "replace_module",
    needsKnowledge: false, requestedModuleId: "risk", clarification: "",
  }, context());
  assert.equal(allowed.playbackDirective, "replace_module");
  assert.equal(allowed.requestedModuleId, "risk");

  const unsafe = validateDemoInterruptionPlan({
    intent: "action", responseMode: "answer", playbackDirective: "replace_module",
    needsKnowledge: false, requestedModuleId: "unsafe", clarification: "",
  }, context());
  assert.equal(unsafe.playbackDirective, "remain_paused");
  assert.equal(unsafe.requestedModuleId, undefined);
  assert.match(unsafe.unavailableReason ?? "", /not an approved demo-safe replacement/);

  const invented = validateDemoInterruptionPlan({
    intent: "action", responseMode: "answer", playbackDirective: "replace_module",
    needsKnowledge: false, requestedModuleId: "invented", clarification: "",
  }, context());
  assert.equal(invented.playbackDirective, "remain_paused");
});

test("clarification always keeps the demo paused", () => {
  const plan = validateDemoInterruptionPlan({
    intent: "how_to", responseMode: "clarify", playbackDirective: "resume_after_answer",
    needsKnowledge: false, requestedModuleId: "", clarification: "Which calculator do you mean?",
  }, context());
  assert.equal(plan.playbackDirective, "remain_paused");
  assert.equal(plan.clarification, "Which calculator do you mean?");
});

test("invalid structured output is repaired once", async () => {
  let calls = 0;
  const model: ModelClient = {
    label: "repair-test",
    step: async () => {
      calls += 1;
      return calls === 1
        ? { texts: [], toolCalls: [{ id: "bad", name: "submit_demo_interruption_plan", args: { intent: "invented" } }], done: true }
        : { texts: [], toolCalls: [{ id: "good", name: "submit_demo_interruption_plan", args: {
          intent: "conversation", responseMode: "answer", playbackDirective: "resume_after_answer",
          needsKnowledge: false, requestedModuleId: "", clarification: "",
        } }], done: true };
    },
  };
  const plan = await new DemoInterruptionPlanner(model).plan(context());
  assert.equal(calls, 2);
  assert.equal(plan.intent, "conversation");
});
