import assert from "node:assert/strict";
import test from "node:test";
import type { SdkCatalog, SdkServerCommand, WorkflowStep } from "@sable/sdk-contracts";
import { GuidedDemoController, VerifiedDemoAudioPlayer, isAtomicDemoBoundary, isGuidedDemoActive } from "../src/guided-demo.js";

function demoCatalog(demoSafe = true): SdkCatalog {
  return {
    journeys: [{ id: "show-risk", state: "approved", demoSafe }],
    demoAudioAssets: [{ id: "voice", mime: "audio/mpeg", sha256: "a".repeat(64) }],
    demoProfile: {
      id: "niroggyan-demo",
      version: 1,
      greeting: { text: "Welcome to Niroggyan.", audioAssetId: "voice" },
      questions: [
        { id: "role", captureKey: "lead.role", prompt: { text: "What kind of organisation are you from?", audioAssetId: "voice" } },
        { id: "goal", captureKey: "lead.goal", prompt: { text: "What would you like to see?" } },
      ],
      intake: { genericQuestionIds: ["role", "goal"], personaQuestionByPersonaId: {} },
      personas: [],
      modules: [{
        id: "risk-assessment",
        name: "Risk assessment",
        journeyId: "show-risk",
        introduction: { text: "Let me show the risk assessment." },
        completion: { text: "That completes the risk assessment." },
        failureMessage: { text: "I could not complete the risk assessment safely." },
      }],
      defaultPlaylistModuleIds: ["risk-assessment"],
      playlistModuleIdsByPersonaId: {},
      closing: { text: "Thank you for exploring Niroggyan." },
    },
  } as unknown as SdkCatalog;
}

const commandBase = {
  kind: "sable.sdk.server.demo_state",
  schemaVersion: 1,
  commandId: "command",
  sessionId: "session",
  sentAt: "2026-08-24T00:00:00.000Z",
} as const;

function state(
  phase: Extract<SdkServerCommand, { kind: "sable.sdk.server.demo_state" }>["phase"],
  values: Partial<Extract<SdkServerCommand, { kind: "sable.sdk.server.demo_state" }>> = {},
): Extract<SdkServerCommand, { kind: "sable.sdk.server.demo_state" }> {
  return {
    ...commandBase,
    phase,
    canStart: false,
    canContinue: false,
    canRetry: false,
    canSkip: false,
    canStop: !["idle", "completed", "stopped"].includes(phase),
    ...values,
  };
}

test("guided demo starts disabled when the signed catalog has no demo profile", () => {
  const controller = new GuidedDemoController({ journeys: [] } as unknown as SdkCatalog);
  assert.equal(controller.snapshot().enabled, false);
  assert.throws(() => controller.request("start"), /not available/);
});

test("voice listening preserves every active guided-demo phase", () => {
  const controller = new GuidedDemoController(demoCatalog());
  for (const phase of ["intake", "playing", "pausing", "paused", "answering", "awaiting_resume", "closing"] as const) {
    controller.applyServerState(state(phase, phase === "intake" ? { activeQuestionId: "role" } : {}));
    assert.equal(isGuidedDemoActive(controller.snapshot()), true, `${phase} must retain guided-demo ownership of voice`);
  }
  for (const phase of ["idle", "completed", "stopped"] as const) {
    controller.applyServerState(state(phase, { canStart: true, canStop: false }));
    assert.equal(isGuidedDemoActive(controller.snapshot()), false, `${phase} is terminal for guided-demo voice ownership`);
  }
});

test("server states expose only phase-valid controls and emit signed cues once per state transition", () => {
  const controller = new GuidedDemoController(demoCatalog());
  assert.equal(controller.snapshot().controls.canStart, false);
  controller.applyServerState(state("idle", { canStart: true, canStop: false }));
  assert.equal(controller.request("start").pendingAction, "start");
  assert.throws(() => controller.request("start"), /already processing/);

  const intake = controller.applyServerState(state("intake", { activeQuestionId: "role" }));
  assert.deepEqual(intake.cues.map((cue) => cue.kind), ["greeting", "question"]);
  assert.equal(intake.cues[0]?.audioAsset?.id, "voice");
  assert.equal(controller.applyServerState(state("intake", { activeQuestionId: "role" })).cues.length, 0);

  const playing = controller.applyServerState(state("playing", { activeModuleId: "risk-assessment" }));
  assert.deepEqual(playing.cues.map((cue) => cue.kind), ["module_introduction"]);
  assert.equal(controller.canRunActiveModuleJourney("show-risk"), true);
  assert.throws(
    () => controller.applyServerState(state("playing", { activeModuleId: "risk-assessment", canSkip: true })),
    /cannot enable canSkip/,
  );
  assert.throws(
    () => controller.applyServerState(state("intake", { activeQuestionId: "invented" })),
    /unknown question/,
  );
});

test("an interruption checkpoints only the active signed module journey", () => {
  const controller = new GuidedDemoController(demoCatalog());
  controller.applyServerState(state("playing", { activeModuleId: "risk-assessment" }));
  assert.equal(controller.beginInterruption()?.phase, "pausing");
  assert.throws(() => controller.checkpointJourney({
    journeyId: "invented",
    catalogVersionId: "catalog-v1",
    completedStepIds: ["open"],
    nextStepId: "explain",
    nextStepIndex: 1,
  }), /does not match/);

  const paused = controller.checkpointJourney({
    journeyId: "show-risk",
    catalogVersionId: "catalog-v1",
    completedStepIds: ["open"],
    nextStepId: "explain",
    nextStepIndex: 1,
  });
  assert.equal(paused.phase, "paused");
  assert.equal(paused.controls.canContinue, false);
  assert.equal(paused.controls.canStop, true);
  assert.deepEqual(paused.checkpoint?.completedStepIds, ["open"]);
});

test("retry replays the module introduction but an unsafe journey never becomes executable", () => {
  const controller = new GuidedDemoController(demoCatalog());
  controller.applyServerState(state("playing", { activeModuleId: "risk-assessment" }));
  controller.applyServerState(state("awaiting_resume", {
    activeModuleId: "risk-assessment",
    canContinue: true,
    canRetry: true,
    canSkip: true,
  }));
  controller.request("retry");
  const retry = controller.applyServerState(state("playing", { activeModuleId: "risk-assessment" }));
  assert.equal(retry.cues[0]?.key, "module:risk-assessment:introduction:2");

  const unsafe = new GuidedDemoController(demoCatalog(false));
  unsafe.applyServerState(state("playing", { activeModuleId: "risk-assessment" }));
  assert.equal(unsafe.canRunActiveModuleJourney("show-risk"), false);
});

test("recorded demo audio is played only after its signed digest is verified", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "Audio");
  class FakeAudio extends EventTarget {
    preload = "";
    constructor(readonly src: string) { super(); }
    async play() { queueMicrotask(() => this.dispatchEvent(new Event("ended"))); }
    pause() {}
    removeAttribute() {}
    load() {}
  }
  Object.defineProperty(globalThis, "Audio", { configurable: true, writable: true, value: FakeAudio });
  try {
    const bytes = new TextEncoder().encode("approved Niroggyan demo recording");
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
    const sha256 = [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
    const request = {
      key: "greeting",
      kind: "greeting",
      utterance: { text: "Welcome." },
      text: "Welcome.",
      audioAsset: { id: "voice", mime: "audio/mpeg", sha256 },
    } as const;
    assert.equal(await new VerifiedDemoAudioPlayer(async () => bytes.buffer).play(request), true);
    await assert.rejects(
      () => new VerifiedDemoAudioPlayer(async () => bytes.buffer).play({
        ...request,
        audioAsset: { ...request.audioAsset, sha256: "0".repeat(64) },
      }),
      /failed signed SHA-256 verification/,
    );
  } finally {
    if (original) Object.defineProperty(globalThis, "Audio", original);
    else Reflect.deleteProperty(globalThis, "Audio");
  }
});

test("nested workflow children are never treated as resumable atomic boundaries", () => {
  const nested = { id: "nested-action" } as WorkflowStep;
  const topLevel = [{ id: "branch", kind: "branch", then: [nested] }, { id: "next" }] as WorkflowStep[];
  assert.equal(isAtomicDemoBoundary(topLevel, nested, 0), false);
  assert.equal(isAtomicDemoBoundary(topLevel, topLevel[0], 0), true);
  assert.equal(isAtomicDemoBoundary(topLevel, topLevel[1], 1), true);
});
