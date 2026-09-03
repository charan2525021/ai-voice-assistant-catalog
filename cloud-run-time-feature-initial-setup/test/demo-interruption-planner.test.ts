import assert from "node:assert/strict";
import test from "node:test";
import type { SignedCatalogEnvelope } from "@sable/sdk-contracts";
import type { RuntimeSession } from "../src/contracts.js";
import { planDemoInterruption, turnPlanFromDemoInterruption, type DemoInterruptionContext } from "../src/demo-interruption-planner.js";
import type { TurnPlan } from "../src/turn-planner.js";

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
    transcript: [],
    currentScreenId: "reports-screen",
  };
}

function turn(values: Partial<TurnPlan> = {}): TurnPlan {
  return {
    intent: "conversation",
    mode: "answer",
    taskControl: "side_question",
    needsFreshObservation: false,
    needsKnowledge: false,
    actionRequested: false,
    presentationRequested: false,
    journeyInputs: {},
    ...values,
  };
}

test("a screen interruption preserves the normal observe-then-answer mode", () => {
  const plan = planDemoInterruption(turn({ intent: "screen_question", mode: "observe_then_answer" }), context());
  assert.equal(plan.responseMode, "observe_then_answer");
  assert.equal(plan.needsFreshObservation, true);
  assert.equal(plan.playbackDirective, "remain_paused");
});

test("a compound replace-and-explain request selects one approved demo module", () => {
  const plan = planDemoInterruption(turn({
    intent: "action",
    mode: "execute_then_observe_and_answer",
    taskControl: "replace",
    needsKnowledge: true,
    actionRequested: true,
    presentationRequested: true,
    subjectJourneyId: "show-risk",
    journeyId: "show-risk",
  }), context());
  assert.equal(plan.playbackDirective, "replace_module");
  assert.equal(plan.requestedModuleId, "risk");
  assert.equal(plan.answerSubjectModuleId, "risk");
  assert.equal(plan.responseMode, "execute_then_observe_and_answer");
});

test("an informational subject does not replace the resumable active module", () => {
  const plan = planDemoInterruption(turn({
    intent: "product_question",
    needsKnowledge: true,
    subjectJourneyId: "show-risk",
  }), context());
  assert.equal(plan.playbackDirective, "remain_paused");
  assert.equal(plan.requestedModuleId, undefined);
  assert.equal(plan.answerSubjectModuleId, "risk");
  assert.equal(context().demo.activeModuleId, "reports");
});

test("an unsafe or non-demo journey cannot become a replacement", () => {
  const plan = planDemoInterruption(turn({
    intent: "action", mode: "execute", taskControl: "replace", actionRequested: true, journeyId: "unsafe-write",
  }), context());
  assert.equal(plan.playbackDirective, "remain_paused");
  assert.equal(plan.requestedModuleId, undefined);
  assert.match(plan.unavailableReason ?? "", /approved demo-safe module/i);
});

test("mapped navigation uses the normal mode without silently discarding the checkpoint", () => {
  const plan = planDemoInterruption(turn({
    intent: "action", mode: "navigate", taskControl: "replace", actionRequested: true, navigationTargetScreenId: "reports-screen",
  }), context());
  assert.equal(plan.responseMode, "navigate");
  assert.equal(plan.playbackDirective, "remain_paused");
  assert.equal(plan.needsFreshObservation, true);
  assert.match(plan.policyAdjustments.join(" "), /remains resumable/i);
  assert.equal(turnPlanFromDemoInterruption(plan).navigationTargetScreenId, "reports-screen");
});

test("navigate plus replace commits a different named demo module", () => {
  const plan = planDemoInterruption(turn({
    intent: "action",
    mode: "navigate",
    taskControl: "replace",
    actionRequested: true,
    subjectJourneyId: "show-risk",
    navigationTargetScreenId: "risk-screen",
  }), context());
  assert.equal(plan.playbackDirective, "replace_module");
  assert.equal(plan.requestedModuleId, "risk");
  assert.equal(plan.answerSubjectModuleId, "risk");
});

test("continue and stop remain deterministic playback controls", () => {
  assert.equal(planDemoInterruption(turn({ taskControl: "continue" }), context()).playbackDirective, "resume_now");
  assert.equal(planDemoInterruption(turn({ taskControl: "stop" }), context()).playbackDirective, "stop");
});

test("a failed module can be answered or replaced but never silently resumed", () => {
  const failed = context();
  failed.demo = {
    ...failed.demo,
    phase: "awaiting_resume",
    resumeReason: "failure",
    checkpoint: undefined,
  };
  const continued = planDemoInterruption(turn({ intent: "action", taskControl: "continue" }), failed);
  assert.equal(continued.playbackDirective, "remain_paused");
  assert.match(continued.unavailableReason ?? "", /failed module cannot continue/i);

  const replacement = planDemoInterruption(turn({
    intent: "action", mode: "execute_then_observe_and_answer", taskControl: "replace",
    actionRequested: true, presentationRequested: true, journeyId: "show-risk", subjectJourneyId: "show-risk",
  }), failed);
  assert.equal(replacement.playbackDirective, "replace_module");
  assert.equal(replacement.requestedModuleId, "risk");
});
