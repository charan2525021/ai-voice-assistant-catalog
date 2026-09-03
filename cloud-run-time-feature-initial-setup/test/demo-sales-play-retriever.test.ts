import assert from "node:assert/strict";
import test from "node:test";
import type { SignedCatalogEnvelope } from "@sable/sdk-contracts";
import type { GuidedDemoSessionState } from "../src/demo-director.js";
import type { DemoInterruptionPlan } from "../src/demo-interruption-planner.js";
import {
  allowedDemoSalesPlayKinds,
  resolveDemoSalesPlays,
  retrieveDemoSalesPlays,
} from "../src/demo-sales-play-retriever.js";

const demo: GuidedDemoSessionState = {
  profileId: "niro-demo",
  profileVersion: 1,
  phase: "awaiting_resume",
  answers: { "lead.role": "laboratory" },
  personaId: "lab",
  genericQuestionIndex: 2,
  playlistModuleIds: ["reports"],
  moduleIndex: 0,
  activeModuleId: "reports",
  resumeReason: "interruption",
  checkpoint: { journeyId: "show-reports", completedStepIds: ["open"], nextStepId: "explain" },
  updatedAt: new Date().toISOString(),
};

function plan(values: Partial<DemoInterruptionPlan> = {}): DemoInterruptionPlan {
  return {
    intent: "product_question",
    responseMode: "answer",
    taskControl: "side_question",
    playbackDirective: "resume_after_answer",
    needsFreshObservation: false,
    needsKnowledge: true,
    actionRequested: false,
    presentationRequested: false,
    journeyInputs: {},
    policyAdjustments: [],
    ...values,
  };
}

function catalog(): SignedCatalogEnvelope {
  return { payload: {
    manifest: { catalogVersionId: "v1" },
    journeys: [],
    demoProfile: {
      id: "niro-demo", version: 1, greeting: { text: "Welcome" }, questions: [],
      intake: { genericQuestionIds: ["role", "goal"], personaQuestionByPersonaId: {} },
      personas: [{ id: "lab", name: "Lab", description: "Lab", classifierSignals: ["laboratory"] }],
      modules: [{ id: "reports", name: "Reports", journeyId: "show-reports", introduction: { text: "Reports" }, completion: { text: "Done" }, failureMessage: { text: "Failed" } }],
      defaultPlaylistModuleIds: ["reports"], playlistModuleIdsByPersonaId: { lab: ["reports"] }, closing: { text: "Thanks" },
    },
    salesPlays: [
      { id: "value-smart-report", kind: "value_proposition", title: "Patient-friendly smart reports", content: "Smart reports help patients understand results.", personaIds: [], capabilityIds: [], journeyIds: ["show-reports"], signalPhrases: ["patient engagement", "smart reports"] },
      { id: "proof-lab", kind: "proof", title: "Laboratory evidence", content: "Use only the approved laboratory evidence and state its source.", personaIds: ["lab"], capabilityIds: [], journeyIds: ["show-reports"], signalPhrases: ["evidence", "proof"] },
      { id: "answer-included", kind: "product_answer", title: "What is included", content: "Patient-friendly report explanations are included in this approved package.", personaIds: [], capabilityIds: [], journeyIds: [], signalPhrases: ["included in the product"] },
      { id: "positioning-reports", kind: "positioning", title: "Report positioning", content: "Explain how reports differ from raw result tables.", personaIds: [], capabilityIds: [], journeyIds: ["show-reports"], signalPhrases: ["different"] },
      { id: "objection-cost", kind: "objection_response", title: "Cost objection", content: "Acknowledge budget constraints without inventing pricing.", personaIds: ["lab"], capabilityIds: [], journeyIds: [], signalPhrases: ["too expensive"] },
      { id: "hospital-only", kind: "proof", title: "Hospital evidence", content: "Hospital-only evidence.", personaIds: ["hospital"], capabilityIds: [], journeyIds: ["show-reports"], signalPhrases: ["proof"] },
      { id: "nba-pricing", kind: "next_best_action", title: "Pricing follow-up", content: "Offer the approved pricing module as an option; do not start it.", personaIds: [], capabilityIds: [], journeyIds: [], signalPhrases: ["pricing"] },
    ],
  } } as unknown as SignedCatalogEnvelope;
}

test("deterministic intent gating—not the planner—chooses eligible play kinds", () => {
  assert.deepEqual(allowedDemoSalesPlayKinds(plan()), ["product_answer", "value_proposition", "proof", "positioning"]);
  assert.deepEqual(allowedDemoSalesPlayKinds(plan({ intent: "objection" })), ["objection_response", "proof", "positioning", "value_proposition"]);
  assert.deepEqual(allowedDemoSalesPlayKinds(plan({ intent: "how_to" })), ["product_answer"]);
  assert.deepEqual(allowedDemoSalesPlayKinds(plan({ intent: "conversation", needsKnowledge: true })), []);
  assert.deepEqual(allowedDemoSalesPlayKinds(plan({ responseMode: "clarify", playbackDirective: "remain_paused" })), []);
  assert.deepEqual(allowedDemoSalesPlayKinds(plan({ intent: "action", playbackDirective: "resume_now" })), []);
});

test("screen questions retrieve no sales play unless validated product knowledge is also needed", () => {
  const noKnowledge = retrieveDemoSalesPlays(plan({ intent: "screen_question", responseMode: "observe_then_answer", needsFreshObservation: true, needsKnowledge: false }), {
    catalog: catalog(), demo, requestText: "What does this number mean?",
  });
  assert.equal(noKnowledge.playMode, "none");
  assert.deepEqual(noKnowledge.selectedPlayIds, []);

  const withKnowledge = retrieveDemoSalesPlays(plan({ intent: "screen_question", responseMode: "observe_then_answer", needsFreshObservation: true }), {
    catalog: catalog(), demo, requestText: "Is this included in the product?",
  });
  assert.equal(withKnowledge.playMode, "retrieve");
  assert.deepEqual(withKnowledge.allowedPlayKinds, ["product_answer", "proof"]);
  assert.ok(withKnowledge.selectedPlayIds.includes("answer-included"));
});

test("retrieval enforces kind and persona, ranks signed context, and caps the result", () => {
  const grounding = retrieveDemoSalesPlays(plan(), {
    catalog: catalog(), demo, requestText: "What proof shows smart reports improve patient engagement and what is included in the product?",
  });
  assert.equal(grounding.playMode, "retrieve");
  assert.equal(grounding.maximumChunks, 3);
  assert.equal(grounding.selectedPlayIds.length, 3);
  assert.ok(grounding.selectedPlayIds.includes("value-smart-report"));
  assert.ok(grounding.selectedPlayIds.includes("answer-included"));
  assert.ok(grounding.selectedPlayIds.includes("proof-lab"));
  assert.ok(!grounding.selectedPlayIds.includes("hospital-only"));
  assert.ok(!grounding.selectedPlayIds.includes("nba-pricing"));
});

test("an action-oriented play remains knowledge and never grants journey authority", () => {
  const grounding = retrieveDemoSalesPlays(plan({
    intent: "action", playbackDirective: "remain_paused", unavailableReason: "Pricing module is unavailable.",
  }), { catalog: catalog(), demo, requestText: "Can you show pricing?" });
  assert.deepEqual(grounding.allowedPlayKinds, ["product_answer", "next_best_action"]);
  assert.deepEqual(grounding.selectedPlayIds, ["nba-pricing"]);
  const resolved = resolveDemoSalesPlays(catalog(), grounding);
  assert.equal(resolved[0]?.id, "nba-pricing");
  assert.equal(resolved[0]?.suggestedJourneyId, undefined);
});
