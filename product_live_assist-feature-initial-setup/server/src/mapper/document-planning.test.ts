import { chunkStructuredSections, parseDocumentSections } from "../knowledge/document-structure.js";
import { exactSourcePhrase, proceduresFromSections } from "../knowledge/procedures.js";
import { matchDocumentProcedure, safetyForDocumentProcedure } from "./document-path.js";
import { approvalIsCurrent, reviewJourney } from "./journey-review.js";
import { actionableGoal } from "./planner.js";
import type { Journey, ScreenNode } from "./types.js";

let passed = 0;
function check(name: string, condition: boolean, detail = "") {
  if (!condition) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  passed++;
  console.log(`✓ ${name}`);
}

const manual = `# API keys

## Create an API key

Prerequisite: you must be an administrator.

1. Open API Keys.
2. Click "Create API key".
3. Enter a name.
4. Click "Save".

When complete, the success message: "API key created".`;

const sections = parseDocumentSections(manual, {
  source: "admin-guide.md", title: "Administrator guide", trust: "official", freshness: "2026-08-12T00:00:00.000Z",
});
const procedureSection = sections.find((section) => section.heading === "Create an API key")!;
check("preserves heading boundaries", !!procedureSection);
check("preserves one ordered four-step procedure", procedureSection.lists[0]?.items.length === 4);

const chunks = chunkStructuredSections(sections, 80);
const procedureChunk = chunks.find((chunk) => chunk.structure.containsOrderedProcedure)!;
check("never splits a numbered procedure across chunks", ["1. Open API Keys.", "4. Click \"Save\"."].every((text) => procedureChunk.text.includes(text)));
check("retains source coordinates on retrieval chunks", procedureChunk.structure.paragraphStart > 0 && procedureChunk.structure.paragraphEnd >= procedureChunk.structure.paragraphStart);

const procedure = proceduresFromSections(sections)[0];
check("extracts a journey candidate", procedure.goal === "Create an API key" && procedure.steps.length === 4);
check("uses only an exact source success message", procedure.successMessage === "API key created", procedure.successMessage);
check("rejects model-invented success evidence", exactSourcePhrase(procedureSection, "Created successfully") === undefined);
check("retains an auditable citation excerpt", procedure.citation.source === "admin-guide.md" && procedure.citation.excerpt.includes("Create API key"));

const screens: ScreenNode[] = [{
  id: "keys", title: "API Keys", url: "https://app.test/api-keys", purpose: "Manage keys", kind: "product",
  controls: ['button "Create API key"', 'textbox "Name"', 'button "Save"'],
}];
const matched = matchDocumentProcedure(procedure, screens);
check("matches documentation language to observed controls without a browser", matched.matchStatus === "full", JSON.stringify(matched.matches));
check("builds only a safe consecutive executable prefix", matched.executablePrefix.length === 2, JSON.stringify(matched.executablePrefix));
check("blocks unsafe documented writes before browser budget", !safetyForDocumentProcedure(procedure, screens[0].url).allowed);
const allowedProcedure = { ...procedure, goal: "Create a project", steps: procedure.steps.map((step) => step.replace(/API key/gi, "project")) };
check("honours explicit product mutation policy outside never-touch areas", safetyForDocumentProcedure(allowedProcedure, screens[0].url, ["create"]).allowed);

const journey: Journey = {
  id: "journey", goal: procedure.goal, capability: "API keys", entities: ["API key"], preconditions: procedure.prerequisites,
  startUrl: screens[0].url, steps: matched.executablePrefix, postcondition: procedure.successMessage!, proof: "text",
  evidence: { kind: "text", expectedText: procedure.successMessage }, documentation: matched,
  status: "verified", reliability: 1, attempts: 2,
  verificationRuns: [
    { ok: true, detail: "passed", attemptedAt: "2026-08-12T00:00:00.000Z" },
    { ok: true, detail: "passed", attemptedAt: "2026-08-12T00:01:00.000Z" },
  ],
};
reviewJourney(journey, "approved", "reviewer@test");
check("approval binds the exact documented source context", approvalIsCurrent(journey));
journey.documentation!.procedure.citation.excerpt += " changed";
check("changing source context invalidates approval", !approvalIsCurrent(journey));

/*
 * Documentation is guidance, not a script — so the planner filters on whether
 * an entry describes a TASK, not on how well its steps match today's UI.
 *
 * Every string below is a real goal from one Jira run. The FAQ entries were
 * planned as journeys, sent an explorer to whatever screen shared a word with
 * them, and failed verification.
 */
for (const reference of [
  "What is Jira work item hierarchy?",
  "What is a workflow scheme?",
  "What are key elements of a Jira space?",
  "What types of permissions exist?",
  "Requirements",
  "Overview",
  "Prerequisites",
  "Best practices",
  "Supported browsers",
]) {
  check(`reference material rejected: "${reference}"`, !actionableGoal(reference));
}
for (const task of [
  "Create multiple boards within a single company-managed space",
  "Manage workflows in Jira",
  "Configure work item layout in Jira",
  "How to create a permission scheme",
  "Open the Kanban board",
  "Filter to active items",
]) {
  check(`task accepted: "${task}"`, actionableGoal(task));
}

console.log(`\n✅ ${passed} document-planning checks passed`);
