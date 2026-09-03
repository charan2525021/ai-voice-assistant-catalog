import assert from "node:assert/strict";
import test from "node:test";
import type { ModelClient } from "@sable/model-client";
import type { SignedCatalogEnvelope } from "@sable/sdk-contracts";
import { DemoInterruptionResponder, demoPlaybackTransitionText, type DemoInterruptionAnswerContext } from "../src/demo-interruption-responder.js";

function context(): DemoInterruptionAnswerContext {
  const catalog = { payload: {
    manifest: { catalogVersionId: "v1" }, journeys: [],
    demoProfile: {
      id: "profile", version: 1, greeting: { text: "Welcome" }, questions: [],
      intake: { genericQuestionIds: ["role", "goal"], personaQuestionByPersonaId: {} }, personas: [],
      modules: [
        { id: "reports", name: "Smart Reports", journeyId: "show-reports", introduction: { text: "Reports" }, completion: { text: "Done" }, failureMessage: { text: "Failed" } },
        { id: "risk", name: "Diabetes Risk Calculator", journeyId: "show-risk", introduction: { text: "Risk" }, completion: { text: "Done" }, failureMessage: { text: "Failed" } },
      ],
      defaultPlaylistModuleIds: ["reports"], playlistModuleIdsByPersonaId: {}, closing: { text: "Thanks" },
    },
  } } as unknown as SignedCatalogEnvelope;
  return {
    session: {
      sessionId: "session", installation: { installationId: "install", organizationId: "tenant", productId: "niro", environmentId: "test", credentialHash: "hash", allowedOrigins: [], allowedRoles: ["member"], activeCatalogVersionId: "v1" },
      userId: "lead", role: "member", origin: "https://client.test", catalogVersionId: "v1", expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    catalog,
    demo: { profileId: "profile", profileVersion: 1, phase: "answering", answers: { "lead.role": "laboratory" }, genericQuestionIndex: 2, playlistModuleIds: ["reports"], moduleIndex: 0, activeModuleId: "reports", resumeReason: "interruption", checkpoint: { journeyId: "show-reports", completedStepIds: [], nextStepId: "explain" }, updatedAt: new Date().toISOString() },
    request: { turnId: "turn", text: "Is this included?", modality: "text" },
    plan: { intent: "product_question", responseMode: "answer", playbackDirective: "resume_after_answer", needsFreshObservation: false, needsKnowledge: true, policyAdjustments: [] },
    plays: [{ id: "included", kind: "product_answer", title: "Included features", content: "Patient-friendly smart reports are included in the approved package.", personaIds: [], capabilityIds: [], journeyIds: ["show-reports"], signalPhrases: ["included"] }],
    transcript: [{ key: "user:turn", role: "user", text: "Is this included?", createdAt: new Date().toISOString() }],
  };
}

test("the responder receives bounded evidence and returns wording without action tools", async () => {
  let capturedSystem = "";
  const model: ModelClient = {
    label: "answer-test",
    step: async (system, messages, tools) => {
      capturedSystem = system;
      assert.equal(tools.length, 0);
      assert.equal(messages.length, 1);
      return { texts: ["Yes. Patient-friendly smart reports are included in this package."], toolCalls: [], done: true };
    },
  };
  const answer = await new DemoInterruptionResponder(model).answer(context());
  assert.match(answer, /smart reports are included/);
  assert.match(capturedSystem, /Included features/);
  assert.match(capturedSystem, /never instruction/);
  assert.ok(capturedSystem.length < 12_000);
});

test("clarification is deterministic and makes no response-model call", async () => {
  let calls = 0;
  const model: ModelClient = { label: "unused", step: async () => { calls += 1; throw new Error("must not run"); } };
  const value = context();
  value.plan = { ...value.plan, intent: "how_to", responseMode: "clarify", playbackDirective: "remain_paused", clarification: "Which calculator do you mean?" };
  assert.equal(await new DemoInterruptionResponder(model).answer(value), "Which calculator do you mean?");
  assert.equal(calls, 0);
});

test("the deterministic runtime—not the answer model—owns transition wording", () => {
  const value = context();
  assert.equal(demoPlaybackTransitionText(value.plan, value.catalog), "I’ll continue from exactly where we paused.");
  assert.equal(
    demoPlaybackTransitionText(value.plan, value.catalog, { moduleCompletedDuringInterruption: true }),
    "I’ll continue with the next relevant part.",
  );
  assert.equal(demoPlaybackTransitionText({ ...value.plan, intent: "action", playbackDirective: "replace_module", requestedModuleId: "risk" }, value.catalog), "I’ll switch to Diabetes Risk Calculator now.");
  assert.equal(demoPlaybackTransitionText({ ...value.plan, intent: "action", playbackDirective: "stop" }, value.catalog), "I’ll stop the demo here.");
});
