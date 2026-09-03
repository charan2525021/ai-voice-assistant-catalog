import {
  classifyScreenKind,
  goalGroundedInScreens,
  matchesUrlTemplate,
  urlTemplate,
  validateGoalAlignment,
} from "./journey-evidence.js";
import { isPlaceholderContent } from "../knowledge/ingest.js";
import { BrainStore, type Flow } from "../knowledge/store.js";
import { isJourneyMachineVerified, isJourneyPublishable } from "./verifier.js";
import { reviewJourney } from "./journey-review.js";
import type { Journey, ScreenNode } from "./types.js";

function check(label: string, ok: boolean) {
  if (!ok) throw new Error(`FAIL: ${label}`);
  console.log(`✓ ${label}`);
}

check(
  "dynamic record ids become a reusable URL contract",
  urlTemplate("https://app.test/projects/cffe03a2-c576-4a49-9b08-5d582a7acd74?tab=history") === "/projects/:id?tab=:value",
);
check(
  "a concrete URL satisfies its stable template",
  matchesUrlTemplate("https://app.test/projects/12345?tab=overview", "/projects/:id?tab=:value"),
);
check("legal pages are classified", classifyScreenKind("https://app.test/privacy") === "legal");
check("billing pages are classified", classifyScreenKind("https://app.test/settings/billing") === "billing");
check(
  "customer records are classified separately from product surfaces",
  classifyScreenKind("https://app.test/projects/cffe03a2-c576-4a49-9b08-5d582a7acd74") === "tenant_content",
);

const screen = (title: string, url: string, controls: string[]): ScreenNode => ({
  id: title, title, url, controls, purpose: "", kind: "product",
});
check(
  "planner accepts a goal grounded in observed product controls",
  goalGroundedInScreens("Browse connector integrations", [screen("Integrations", "https://app.test/integrations", ['button "Connectors"'])]),
);
check(
  "planner rejects a docs-only capability absent from the live product",
  !goalGroundedInScreens("Configure quantum governance", [screen("Projects", "https://app.test/projects", ['button "New project"'])]),
);

const base = (goal: string): Journey => ({
  id: "test", goal, capability: goal, entities: [], preconditions: [], startUrl: "https://app.test/projects",
  steps: [], postcondition: "", proof: "screen_reached", status: "unverified", reliability: 0, attempts: 0,
});
const wrong = base("Explore community resources");
wrong.steps = [{ action: "click", role: "tab", name: "Owned by me", toUrl: "https://app.test/projects" }];
wrong.evidence = { kind: "screen_reached", expectedUrl: "/projects", expectedTitle: "Owned by me" };
check("unrelated destination cannot prove a goal", !validateGoalAlignment(wrong).ok);

const weakAnalytics = base("View usage analytics");
weakAnalytics.steps = [{ action: "click", role: "link", name: "Analytics", fromUrl: "https://app.test/projects", toUrl: "https://app.test/analytics" }];
weakAnalytics.postcondition = "Generated successfully";
weakAnalytics.evidence = { kind: "text", expectedText: "Generated successfully" };
check("unrelated text cannot substitute for destination evidence", validateGoalAlignment(weakAnalytics).category === "proof_inconclusive");

const aligned = base("Browse connector integrations");
aligned.steps = [{ action: "click", role: "tab", name: "Connectors", toUrl: "https://app.test/integrations" }];
aligned.evidence = { kind: "screen_reached", expectedUrl: "/integrations", expectedTitle: "Connectors" };
check("matching action and destination can prove a goal", validateGoalAlignment(aligned).ok);

const pinned = base("Open a project");
pinned.steps = [{
  action: "click", role: "link", name: "Marketing Website",
  toUrl: "https://app.test/projects/cffe03a2-c576-4a49-9b08-5d582a7acd74",
}];
pinned.evidence = { kind: "screen_reached", expectedUrl: "/projects/:id" };
check("journey pinned to one customer's record is rejected", validateGoalAlignment(pinned).category === "record_specific");

check("documentation scaffolding is never ingested as product truth", isPlaceholderContent("# Overview\nReplace this with real product documentation."));
check("real documentation is retained", !isPlaceholderContent("# Overview\nProjects let teams build and publish applications."));

const replayed = base("Browse connector integrations");
replayed.status = "verified";
replayed.verificationRuns = [{ ok: true, detail: "reached", attemptedAt: new Date().toISOString() }];
check("one lucky replay is not publishable", !isJourneyPublishable(replayed));
replayed.verificationRuns.push({ ok: true, detail: "reached again", attemptedAt: new Date().toISOString() });
check("two consecutive navigation replays pass the machine gate", isJourneyMachineVerified(replayed));
check("machine verification alone is not publishable", !isJourneyPublishable(replayed));
reviewJourney(replayed, "approved", "reviewer@test");
check("human approval unlocks the exact machine-passed revision", isJourneyPublishable(replayed));
replayed.proof = "record_created";
replayed.evidence = { kind: "record_created", expectedText: "Created" };
check("mutations require a third replay", !isJourneyPublishable(replayed));
replayed.verificationRuns.push({ ok: true, detail: "created again", attemptedAt: new Date().toISOString() });
check("changing a journey invalidates its old approval", !isJourneyPublishable(replayed));
reviewJourney(replayed, "approved", "reviewer@test");
check("three replayed and newly approved mutation runs are publishable", isJourneyPublishable(replayed));

const flow = (id: string): Flow => ({
  id, name: id, feature: "test", intents: [id], steps: ["Open it"], talkingPoints: [],
  prerequisites: "none", resetSteps: "", program: [{ action: "click", role: "button", name: id }],
});
const runtimeStore = new BrainStore("verification-policy-test");
runtimeStore.setMappedFlows([flow("legacy-mapped")]);
check("legacy mapped flows remain unavailable until reverified", runtimeStore.flows.length === 0);
runtimeStore.setMappedFlows([{ ...flow("reverified"), verification: { passedRuns: 2, requiredRuns: 2 } }]);
check("reverified but unapproved mapped flows remain unavailable", runtimeStore.flows.length === 0);
runtimeStore.setMappedFlows([{ ...flow("approved"), verification: { passedRuns: 2, requiredRuns: 2 },
  approval: { status: "approved", revision: 1, checksum: "same", approvedChecksum: "same" } }]);
check("reverified and approved mapped flows are available to the runtime", runtimeStore.flows.length === 1);
runtimeStore.setAuthoredFlows([{ ...flow("authored"), program: undefined }]);
check("authored flows are unaffected by the mapper replay policy", runtimeStore.flows.length === 2);
