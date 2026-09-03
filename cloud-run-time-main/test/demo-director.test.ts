import assert from "node:assert/strict";
import test from "node:test";
import type { SignedCatalogEnvelope } from "@sable/sdk-contracts";
import { DeterministicDemoDirector, isLikelyIntakeInterruption } from "../src/demo-director.js";

function catalog(): SignedCatalogEnvelope {
  const journey = (id: string) => ({
    kind: "sable.catalog.journey",
    id,
    version: 1,
    name: id,
    intents: [],
    roles: ["member"],
    risk: "read",
    inputSchema: { kind: "sable.journey_input_schema", properties: {}, required: [], additionalProperties: false },
    workflow: { kind: "sable.workflow", version: 1, risk: "read", preconditions: [], steps: [], postconditions: [] },
    compatibility: [],
    state: "approved",
    demoSafe: true,
  });
  return {
    payload: {
      manifest: { catalogVersionId: "v1" },
      journeys: [journey("show-lab"), journey("show-reports")],
      demoProfile: {
        id: "niroggyan-demo",
        version: 3,
        greeting: { text: "Welcome" },
        questions: [
          { id: "role", captureKey: "lead.role", prompt: { text: "What kind of organisation are you from?" } },
          { id: "goal", captureKey: "lead.goal", prompt: { text: "What would you like to see?" } },
          { id: "volume", captureKey: "lead.labVolume", prompt: { text: "How many reports?" } },
        ],
        intake: { genericQuestionIds: ["role", "goal"], personaQuestionByPersonaId: { lab: "volume" } },
        personas: [{ id: "lab", name: "Lab", description: "Lab operator", classifierSignals: ["laboratory", "diagnostic centre"] }],
        modules: [
          { id: "lab", name: "Lab", journeyId: "show-lab", introduction: { text: "Lab intro" }, completion: { text: "Lab done" }, failureMessage: { text: "Lab failed" } },
          { id: "reports", name: "Reports", journeyId: "show-reports", introduction: { text: "Reports intro" }, completion: { text: "Reports done" }, failureMessage: { text: "Reports failed" } },
        ],
        defaultPlaylistModuleIds: ["reports"],
        playlistModuleIdsByPersonaId: { lab: ["lab", "reports"] },
        closing: { text: "Thank you" },
      },
    },
  } as unknown as SignedCatalogEnvelope;
}

test("obvious intake questions are distinguished from legitimate lead answers", () => {
  assert.equal(isLikelyIntakeInterruption("what is overview"), true);
  assert.equal(isLikelyIntakeInterruption("Can you explain smart reports?"), true);
  assert.equal(isLikelyIntakeInterruption("I operate a diagnostic centre"), false);
  assert.equal(isLikelyIntakeInterruption("how reporting works"), false);
  assert.equal(isLikelyIntakeInterruption("nothing"), false);
});

test("intake stores lead details and classifies persona only from the first generic answer", () => {
  const director = new DeterministicDemoDirector(catalog(), "member");
  let transition = director.control(director.idle(), "start");
  assert.equal(transition.state.phase, "intake");
  assert.equal(transition.state.activeQuestionId, "role");
  assert.equal(director.view(transition.state).canStop, true);

  transition = director.captureIntake(transition.state, "I operate a diagnostic centre");
  assert.equal(transition.state.personaId, "lab");
  assert.equal(transition.state.activeQuestionId, "goal");
  assert.equal(transition.state.answers["lead.role"], "I operate a diagnostic centre");

  transition = director.captureIntake(transition.state, "Please show reports");
  assert.equal(transition.state.activeQuestionId, "volume");
  assert.equal(transition.state.answers["lead.goal"], "Please show reports");

  transition = director.captureIntake(transition.state, "About 800 each day");
  assert.equal(transition.state.phase, "playing");
  assert.equal(transition.state.activeModuleId, "lab");
  assert.deepEqual(transition.state.playlistModuleIds, ["lab", "reports"]);
  assert.deepEqual(transition.instruction, { kind: "run", moduleId: "lab" });
  assert.equal(transition.state.answers["lead.labVolume"], "About 800 each day");
});

test("a persona word in the second answer does not retroactively change the default playlist", () => {
  const director = new DeterministicDemoDirector(catalog(), "member");
  let state = director.start().state;
  state = director.captureIntake(state, "I work at a hospital").state;
  const transition = director.captureIntake(state, "Show the diagnostic centre workflow");
  assert.equal(transition.state.personaId, undefined);
  assert.equal(transition.state.phase, "playing");
  assert.deepEqual(transition.state.playlistModuleIds, ["reports"]);
});

test("verified results advance the signed playlist and then close", () => {
  const director = new DeterministicDemoDirector(catalog(), "member");
  let state = director.start().state;
  state = director.captureIntake(state, "laboratory").state;
  state = director.captureIntake(state, "show everything").state;
  state = director.captureIntake(state, "100").state;
  assert.equal(director.activeJourney(state)?.journey.id, "show-lab");

  let transition = director.journeyResult(state, true);
  assert.equal(transition.state.activeModuleId, "reports");
  assert.deepEqual(transition.instruction, { kind: "run", moduleId: "reports" });
  transition = director.journeyResult(transition.state, true);
  assert.equal(transition.state.phase, "closing");
  assert.deepEqual(transition.instruction, { kind: "none" });
  transition = director.completeClosing(transition.state);
  assert.equal(transition.state.phase, "completed");
  assert.equal(director.view(transition.state).canStart, true);
});

test("failure supports deterministic retry and skip", () => {
  const director = new DeterministicDemoDirector(catalog(), "member");
  let state = director.start().state;
  state = director.captureIntake(state, "hospital").state;
  state = director.captureIntake(state, "reports").state;
  let transition = director.journeyResult(state, false);
  assert.equal(transition.state.resumeReason, "failure");
  assert.equal(director.view(transition.state).canContinue, false);
  assert.equal(director.view(transition.state).canRetry, true);
  transition = director.control(transition.state, "retry");
  assert.deepEqual(transition.instruction, { kind: "run", moduleId: "reports" });

  transition = director.journeyResult(transition.state, false);
  transition = director.control(transition.state, "skip");
  assert.equal(transition.state.phase, "closing");
});

test("an interruption resumes only from a matching verified checkpoint", () => {
  const director = new DeterministicDemoDirector(catalog(), "member");
  let state = director.start().state;
  state = director.captureIntake(state, "hospital").state;
  state = director.captureIntake(state, "reports").state;
  state = director.beginInterruption(state).state;
  state = director.checkpointInterruption(state, { journeyId: "show-reports", completedStepIds: ["open"], nextStepId: "explain" }).state;
  assert.equal(director.view(state).canContinue, true);
  state = director.beginInterruptionAnswer(state).state;
  assert.equal(state.phase, "answering");
  assert.equal(director.view(state).canContinue, false);
  state = director.finishInterruptionAnswer(state).state;
  assert.equal(state.phase, "awaiting_resume");
  const transition = director.control(state, "continue");
  assert.equal(transition.instruction.kind, "resume");
  if (transition.instruction.kind === "resume") assert.deepEqual(transition.instruction.checkpoint.completedStepIds, ["open"]);
});

test("a completed module interruption is answered before advancing to the next module", () => {
  const director = new DeterministicDemoDirector(catalog(), "member");
  let state = director.start().state;
  state = director.captureIntake(state, "laboratory").state;
  state = director.captureIntake(state, "show everything").state;
  state = director.captureIntake(state, "100").state;
  state = director.beginInterruption(state).state;
  state = director.completeModuleDuringInterruption(state, "show-lab").state;
  assert.equal(state.phase, "awaiting_resume");
  assert.equal(state.moduleCompletedDuringInterruption, true);
  assert.equal(state.checkpoint, undefined);
  assert.equal(director.view(state).canContinue, true);

  state = director.beginInterruptionAnswer(state).state;
  state = director.finishInterruptionAnswer(state).state;
  const transition = director.control(state, "continue");
  assert.equal(transition.state.activeModuleId, "reports");
  assert.deepEqual(transition.instruction, { kind: "run", moduleId: "reports" });
});

test("a completed interruption on the final module advances to closing after its answer", () => {
  const director = new DeterministicDemoDirector(catalog(), "member");
  let state = director.start().state;
  state = director.captureIntake(state, "hospital").state;
  state = director.captureIntake(state, "show reports").state;
  state = director.beginInterruption(state).state;
  state = director.completeModuleDuringInterruption(state, "show-reports").state;
  state = director.beginInterruptionAnswer(state).state;
  state = director.finishInterruptionAnswer(state).state;
  const transition = director.control(state, "continue");
  assert.equal(transition.state.phase, "closing");
  assert.deepEqual(transition.instruction, { kind: "none" });
});

test("an approved replacement changes only the active slot and preserves the remaining playlist", () => {
  const director = new DeterministicDemoDirector(catalog(), "member");
  let state = director.start().state;
  state = director.captureIntake(state, "hospital").state;
  state = director.captureIntake(state, "reports").state;
  state = director.beginInterruption(state).state;
  state = director.checkpointInterruption(state, { journeyId: "show-reports", completedStepIds: ["open"], nextStepId: "explain" }).state;
  const replacement = director.replaceAfterInterruption(state, "lab");
  assert.equal(replacement.state.phase, "playing");
  assert.equal(replacement.state.activeModuleId, "lab");
  assert.deepEqual(replacement.state.playlistModuleIds, ["reports"]);
  assert.deepEqual(replacement.instruction, { kind: "run", moduleId: "lab" });
  // The requested detour replaces this slot; after it completes, the original
  // playlist has no later slot and closes deterministically.
  assert.equal(director.journeyResult(replacement.state, true).state.phase, "closing");
});

test("restoration fails closed when profile IDs or signed references changed", () => {
  const director = new DeterministicDemoDirector(catalog(), "member");
  const started = director.start().state;
  assert.equal(director.restore({ ...started, profileVersion: 999 }).phase, "idle");
  assert.equal(director.restore({ ...started, activeQuestionId: "invented-question" }).phase, "idle");
  assert.equal(director.restore({ ...started, playlistModuleIds: ["invented-module"] }).phase, "idle");
});
