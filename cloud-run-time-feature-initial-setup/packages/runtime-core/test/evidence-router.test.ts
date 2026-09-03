import assert from "node:assert/strict";
import test from "node:test";
import type { ScreenObservation } from "@sable/sdk-contracts";
import { EvidenceRouter, evidenceToSystem, type RuntimeBundle, type RuntimeScope } from "../src/index.js";

const scope: RuntimeScope = {
  organizationId: "org-1",
  productId: "product-1",
  roleProfileId: "admin",
  catalogVersionId: "catalog-1",
};

const workflow = {
  schemaVersion: 1 as const,
  id: "open-settings",
  version: 1,
  name: "Open settings",
  startUrl: "https://app.example.test/home",
  risk: "read" as const,
  preconditions: [],
  steps: [{ id: "step-1", action: "click", say: "I will open settings." }],
  postconditions: [],
};

const bundle: RuntimeBundle = {
  schemaVersion: 1,
  organizationId: scope.organizationId,
  productId: scope.productId,
  environmentId: "env-1",
  catalogVersionId: scope.catalogVersionId,
  catalogVersion: 1,
  generatedAt: "2026-08-17T00:00:00.000Z",
  journeys: [{
    key: "open-settings",
    name: "Open settings",
    roleProfileIds: ["admin"],
    intentPhrases: ["open settings", "show me settings"],
    workflow,
    reliability: 0.98,
    screenFingerprints: ["home-fingerprint"],
    screenKeys: ["home"],
  }],
  salesPlays: [],
  screens: [{ key: "home", name: "Home", url: "https://app.example.test/home", fingerprint: "home-fingerprint", controls: [{ key: "settings", role: "button", accessibleName: "Settings" }] }],
  transitions: [{ fromScreenKey: "home", fromFingerprint: "home-fingerprint", toScreenKey: "settings", controlKey: "settings", action: { kind: "click" }, reliability: 0.99 }],
  coverage: { weighted: 1, verified: 1, total: 1, unknown: 0 },
};

const observation: ScreenObservation = {
  kind: "sable.screen_observation",
  schemaVersion: 1,
  observationId: "observation-1",
  version: 1,
  capturedAt: "2026-08-17T00:00:00.000Z",
  url: "https://app.example.test/home?account=private",
  origin: "https://app.example.test",
  title: "Home",
  fingerprint: "home-fingerprint",
  visibleText: "Welcome",
  elements: [{ id: "e-1", role: "button", name: "Settings", visible: true, enabled: true }],
};

test("preserves role-scoped journey, screen and transition matching", async () => {
  const router = new EvidenceRouter(
    { getBundle: async () => bundle },
    { search: async () => [] },
  );
  const evidence = await router.route(scope, { text: "Open settings", screen: observation, routing: { intent: "action", needsKnowledge: false, journeyId: "open-settings" } });
  assert.equal(evidence.journey?.key, "open-settings");
  assert.equal(evidence.matchedScreen?.key, "home");
  assert.equal(evidence.nextTransitions[0]?.controlKey, "settings");
  assert.deepEqual(evidence.provenance, ["live_screen", "verified_journey"]);
  assert.match(evidenceToSystem(evidence), /I will open settings\./);
});

test("runs lexical and semantic retrieval in parallel and merges by score", async () => {
  const calls: Array<"lexical" | "semantic"> = [];
  const router = new EvidenceRouter(
    { getBundle: async () => bundle },
    { search: async (_scope, input) => {
      if (input.embedding) {
        calls.push("semantic");
        return [{ id: "semantic", title: "Semantic", section: "A", content: "Semantic answer", source: "docs", trust: "official", score: 0.9 }];
      }
      calls.push("lexical");
      return [{ id: "lexical", title: "Lexical", section: "B", content: "Lexical answer", source: "docs", trust: "official", score: 0.8 }];
    } },
    async () => [0.1, 0.2],
  );
  const evidence = await router.route(scope, { text: "What is the policy?", routing: { intent: "product_question", needsKnowledge: true } });
  assert.deepEqual(new Set(calls), new Set(["lexical", "semantic"]));
  assert.deepEqual(evidence.knowledge.map((hit) => hit.id), ["semantic", "lexical"]);
});

test("rejects a runtime bundle from another tenant or version", async () => {
  const router = new EvidenceRouter({ getBundle: async () => ({ ...bundle, organizationId: "other" }) }, { search: async () => [] });
  await assert.rejects(router.route(scope, { text: "hello", routing: { intent: "conversation", needsKnowledge: false } }), /scope mismatch/);
});

test("uses the validated semantic plan and exposes known action limitations", async () => {
  const router = new EvidenceRouter({ getBundle: async () => bundle }, { search: async () => [] });
  const evidence = await router.route(scope, {
    text: "Could you take me to the broken pricing page?",
    routing: { intent: "action", needsKnowledge: true, unavailableReason: "The pricing destination is known to return 404." },
  });
  assert.equal(evidence.intent, "action");
  assert.equal(evidence.journey, undefined);
  assert.match(evidenceToSystem(evidence), /known to return 404/);
});

test("read-only exploration uses the relevant live excerpt and only controls visible now", async () => {
  const router = new EvidenceRouter({ getBundle: async () => bundle }, { search: async () => [] });
  const longObservation: ScreenObservation = {
    ...observation,
    matchedScreenId: "home",
    visibleText: `${"Unrelated dashboard summary. ".repeat(180)} Product Description: Settings controls notification preferences and profile visibility.`,
    elements: [
      { id: "settings-live", role: "button", name: "Settings", visible: true, enabled: true },
      { id: "hidden", role: "button", name: "Hidden control", visible: false, enabled: true },
    ],
  };
  const evidence = await router.route(scope, {
    text: "Read the product description for settings",
    screen: longObservation,
    routing: { intent: "screen_question", needsKnowledge: false },
  });
  assert.match(evidence.screenExcerpt ?? "", /Product Description/);
  assert.equal((evidence.screenExcerpt ?? "").startsWith("Unrelated dashboard summary"), false);
  assert.deepEqual(evidence.matchedControls.map((control) => control.key), ["settings"]);
  const prompt = evidenceToSystem(evidence);
  assert.match(prompt, /descriptive evidence only; this does not authorize a click/);
  assert.match(prompt, /button: Settings/);
});
