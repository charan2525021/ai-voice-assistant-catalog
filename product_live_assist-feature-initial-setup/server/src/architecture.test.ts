import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { tenantContext } from "./domain/context.js";
import type { CoverageItem, JourneyVersion, SalesPlay } from "./domain/catalog.js";
import type { ScreenState } from "./runtime/screen-state.js";
import { memoryRepositories } from "./storage/memory.js";
import { WorkflowExecutor, type ActionDriver, type DriverResult } from "./workflow/executor.js";
import { WORKFLOW_SCHEMA_VERSION, legacyProgramToWorkflow, validateWorkflow, type PrimitiveWorkflowStep, type WorkflowAssertion, type WorkflowDefinition } from "./workflow/schema.js";
import { LayeredBundleCache, MemoryBundleCache } from "./catalog/cache.js";
import { MemoryObjectStore } from "./catalog/object-store.js";
import { CatalogService } from "./catalog/service.js";
import { summarizeCoverage } from "./mapping/coverage.js";
import { EvidenceRouter, classifyRuntimeIntent, evidenceToSystem } from "./runtime/evidence-router.js";
import { shouldAutoRunVerifiedFlow, toolsForTurn } from "./agent.js";
import { issueEmbedToken, verifyEmbedToken } from "./identity/embed-token.js";
import { assertSafeKnowledgeUrl } from "./knowledge/source-safety.js";
import type { KnowledgeRepository } from "./storage/contracts.js";
import { MappingJobRunner } from "./mapping/job-runner.js";
import { MemoryMappingQueue } from "./mapping/queue.js";
import { TurnManager } from "./turn.js";

let passed = 0;
let failed = 0;
const check = (name: string, condition: boolean, detail = "") => {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

const orgA = tenantContext({ organizationId: randomUUID(), actorId: randomUUID(), requestId: "test-a" });
const orgB = tenantContext({ organizationId: randomUUID(), actorId: randomUUID(), requestId: "test-b" });
const repositories = memoryRepositories();

const a = await repositories.products.create(orgA, {
  key: "same-product-key", name: "Tenant A Product",
  environment: { key: "sandbox", name: "Sandbox", startUrl: "https://a.example.test" },
});
const b = await repositories.products.create(orgB, {
  key: "same-product-key", name: "Tenant B Product",
  environment: { key: "sandbox", name: "Sandbox", startUrl: "https://b.example.test" },
});
check("same product key can exist in different tenants", a.product.key === b.product.key && a.product.id !== b.product.id);
check("tenant A cannot read tenant B product", (await repositories.products.get(orgA, b.product.id)) === null);
check("tenant lists contain only owned products", (await repositories.products.list(orgA)).every((p) => p.product.organizationId === orgA.organizationId));

class FakeDriver implements ActionDriver {
  private version = 1;
  private text = "Ready";
  private url = "https://fixture.example.test";
  private values = new Map<string, string>();
  async observe(): Promise<ScreenState> {
    return {
      observationId: randomUUID(), sessionId: "fixture", version: this.version, url: this.url,
      title: "Fixture", visibleText: this.text, controls: [], fingerprint: `v${this.version}`,
      loading: false, capturedAt: new Date().toISOString(),
    };
  }
  async perform(step: PrimitiveWorkflowStep): Promise<DriverResult> {
    if (step.action === "navigate") this.url = step.url;
    if (step.action === "fill") this.values.set(step.target.accessibleName ?? "field", step.value);
    if (step.action === "click") this.text = `${this.text}\nCreated ${[...this.values.values()].join(" ")}`;
    this.version++;
    return { ok: true, detail: step.action };
  }
  async check(assertion: WorkflowAssertion, baseline?: ScreenState): Promise<boolean> {
    if (assertion.kind === "text_visible") return this.text.includes(assertion.text);
    if (assertion.kind === "text_absent") return !this.text.includes(assertion.text);
    if (assertion.kind === "url_matches") return new RegExp(assertion.pattern).test(this.url);
    if (assertion.kind === "screen_changed") return `v${this.version}` !== (assertion.fromFingerprint ?? baseline?.fingerprint);
    return true;
  }
}

const workflowFor = (noun: string): WorkflowDefinition => ({
  schemaVersion: WORKFLOW_SCHEMA_VERSION,
  id: `create-${noun.toLowerCase()}`,
  version: 1,
  name: `Create ${noun}`,
  startUrl: "https://a.example.test",
  risk: "reversible_write",
  preconditions: [{ kind: "text_visible", text: "Ready" }],
  steps: [
    { id: "name", action: "fill", target: { role: "textbox", accessibleName: `${noun} name` }, value: noun },
    { id: "save", action: "click", target: { role: "button", accessibleName: "Save" } },
  ],
  postconditions: [{ kind: "text_visible", text: `Created ${noun}` }],
});

for (const noun of ["Lead", "Employee", "Order"]) {
  const result = await new WorkflowExecutor(new FakeDriver()).execute(workflowFor(noun));
  check(`same executor runs ${noun.toLowerCase()} workflow`, result.ok, result.error);
}

const destructive = workflowFor("Dangerous");
destructive.risk = "destructive";
const destructiveResult = await new WorkflowExecutor(new FakeDriver()).execute(destructive);
check("workflow-level risk cannot be bypassed by low-risk steps", !destructiveResult.ok && /require a stricter approval policy/.test(destructiveResult.error ?? ""));
const external = legacyProgramToWorkflow({ id: "send", name: "Send invoice", program: [{ action: "click", role: "button", name: "Send" }] });
check("legacy journey risk is inferred instead of blanket-labelled reversible", external.risk === "external_side_effect" &&
  !(await new WorkflowExecutor(new FakeDriver()).execute(external)).ok);

const unbounded = workflowFor("Invalid");
unbounded.steps = [{ id: "loop", action: "loop", until: { kind: "text_visible", text: "Never" }, maxIterations: 100, steps: [] }];
check("workflow validator rejects unbounded loops", !validateWorkflow(unbounded).ok);

const draft = await repositories.catalogs.createDraft(orgA, a.product.id, a.environments[0].id);
const timestamp = new Date().toISOString();
const journey: JourneyVersion = {
  id: randomUUID(), organizationId: orgA.organizationId, catalogVersionId: draft.id,
  journeyKey: "create-lead", capabilityId: randomUUID(), customerJobId: randomUUID(), roleProfileIds: [],
  workflow: workflowFor("Lead"), verificationStatus: "verified", reliability: 1, evidence: { replayed: true },
  verifiedAt: timestamp, createdAt: timestamp, updatedAt: timestamp,
};
await repositories.catalogs.saveJourney(orgA, journey);
const approvedPlay: SalesPlay = {
  id: randomUUID(), organizationId: orgA.organizationId, catalogVersionId: draft.id,
  kind: "value_proposition", title: "Faster qualification", content: "Qualify a lead without leaving the record.",
  personaKeys: ["sales-manager"], capabilityIds: [], journeyKeys: ["create-lead"], signalKeywords: ["qualify"],
  approvalStatus: "approved", approvedBy: orgA.actorId, approvedAt: timestamp, createdAt: timestamp, updatedAt: timestamp,
};
const draftPlay: SalesPlay = { ...approvedPlay, id: randomUUID(), title: "Unreviewed", approvalStatus: "draft", approvedBy: undefined, approvedAt: undefined };
await repositories.catalogs.saveSalesPlay(orgA, approvedPlay);
await repositories.catalogs.saveSalesPlay(orgA, draftPlay);

const coverage: CoverageItem[] = [
  { id: randomUUID(), organizationId: orgA.organizationId, catalogVersionId: draft.id, roleProfileId: randomUUID(), customerJobId: journey.customerJobId,
    dimensionKey: "happy", depth: 5, status: "verified", importance: 3, createdAt: timestamp, updatedAt: timestamp },
  { id: randomUUID(), organizationId: orgA.organizationId, catalogVersionId: draft.id, roleProfileId: randomUUID(), customerJobId: journey.customerJobId,
    dimensionKey: "error", depth: 0, status: "unknown", importance: 1, createdAt: timestamp, updatedAt: timestamp },
];
await repositories.catalogs.replaceCoverage(orgA, draft.id, coverage);
check("coverage is weighted by journey importance and depth", summarizeCoverage(coverage).weightedCoverage === 0.75);

const objects = new MemoryObjectStore();
const cache = new MemoryBundleCache();
const catalogs = new CatalogService(repositories.catalogs, objects, cache);
let unapprovedBlocked = false;
try { await catalogs.publish(orgA, draft.id); } catch { unapprovedBlocked = true; }
check("machine verification alone cannot publish without human approval", unapprovedBlocked);
await repositories.catalogs.reviewJourney(orgA, journey.id, { decision: "approved", comment: "reviewed in architecture test" });
const bundle = await catalogs.publish(orgA, draft.id);
check("published bundle contains verified journeys", bundle.journeys.length === 1);
check("published bundle excludes unapproved sales plays", bundle.salesPlays.length === 1 && bundle.salesPlays[0].id === approvedPlay.id);
check("active catalog is tenant scoped", (await catalogs.activeBundle(orgB, a.product.id)) === null);

const nextDraft = await repositories.catalogs.createDraft(orgA, a.product.id, a.environments[0].id);
const inheritedDraft = await repositories.catalogs.get(orgA, nextDraft.id);
check("a successor catalog inherits the active journeys, coverage, and approved plays", inheritedDraft?.journeys.length === 1 &&
  inheritedDraft.coverage.length === 2 && inheritedDraft.salesPlays.length === 1);
await catalogs.publish(orgA, nextDraft.id);
check("publishing atomically retires the previous catalog", (await repositories.catalogs.get(orgA, draft.id))?.catalog.status === "retired");
check("the active pointer advances to the new immutable catalog", (await repositories.catalogs.getActive(orgA, a.product.id))?.catalog.id === nextDraft.id);
const retiredBundle = await new CatalogService(repositories.catalogs, objects, new MemoryBundleCache()).bundle(orgA, draft.id);
check("an active conversation can remain pinned to its retired immutable bundle", retiredBundle?.catalogVersionId === draft.id);
let immutableBlocked = false;
try { await repositories.catalogs.saveJourney(orgA, { ...journey, id: randomUUID(), catalogVersionId: nextDraft.id }); }
catch { immutableBlocked = true; }
check("published catalog rows cannot be mutated", immutableBlocked);
const mappingProduct = await repositories.products.create(orgA, {
  key: "unmapped-product", name: "Unmapped Product",
  environment: { key: "sandbox", name: "Sandbox", startUrl: "https://mapped.example.test" },
});
const emptyDraft = await repositories.catalogs.createDraft(orgA, mappingProduct.product.id, mappingProduct.environments[0].id);
let emptyPublishBlocked = false;
try { await catalogs.publish(orgA, emptyDraft.id); } catch { emptyPublishBlocked = true; }
check("an empty catalog cannot be published", emptyPublishBlocked);
await repositories.catalogs.replaceMappedCatalog(orgA, emptyDraft.id, mappingProduct.roles[0].id, {
  screens: [{ key: "home", name: "Home", url: "https://a.example.test", purpose: "Entry", fingerprint: "home-v1",
    controls: [{ key: "save", role: "button", accessibleName: "Save" }] }],
  transitions: [{ fromScreenKey: "home", controlKey: "save", action: { action: "click" }, reliability: 1 }],
  journeys: [{ key: "create-order", goal: "Create Order", capabilityKey: "orders", capabilityName: "Orders",
    workflow: workflowFor("Order"), reliability: 1, verifiedAt: timestamp, evidence: { replayed: true }, depth: 4 }],
});
const mappedDraft = await repositories.catalogs.get(orgA, emptyDraft.id);
check("durable mapper persists a client-neutral screen and journey catalog", mappedDraft?.journeys.length === 1 && mappedDraft.catalog.status === "review");
check("mapper records happy path plus evidence-backed blocked branches", mappedDraft?.coverage.length === 5 &&
  mappedDraft.coverage.filter((item) => item.status === "blocked").length === 4 &&
  mappedDraft.coverage.every((item) => item.status !== "unknown"));
const secondRole = {
  id: randomUUID(), organizationId: orgA.organizationId, environmentId: mappingProduct.environments[0].id,
  key: "manager", name: "Manager", permissionHints: [], createdAt: timestamp, updatedAt: timestamp,
};
await repositories.access.saveRoleProfile(orgA, secondRole);
check("mapping jobs reuse the environment's open catalog", (await repositories.catalogs.getOpenDraft(
  orgA, mappingProduct.product.id, mappingProduct.environments[0].id,
))?.id === emptyDraft.id);
await repositories.catalogs.replaceMappedCatalog(orgA, emptyDraft.id, secondRole.id, {
  screens: [{ key: "manager-home", name: "Manager home", url: "https://a.example.test/manager", purpose: "Manage", fingerprint: "manager-v1", controls: [] }],
  journeys: [{ key: "approve-order-role-manager", goal: "Approve Order", capabilityKey: "orders", capabilityName: "Orders",
    workflow: workflowFor("Approval"), reliability: 1, verifiedAt: timestamp, evidence: { replayed: true }, depth: 4 }],
});
const multiRoleDraft = await repositories.catalogs.get(orgA, emptyDraft.id);
check("role mapping is cumulative and does not erase earlier roles", multiRoleDraft?.journeys.length === 2 &&
  multiRoleDraft.coverage.filter((item) => item.status === "verified").length === 2);
for (const candidate of multiRoleDraft?.journeys ?? []) {
  await repositories.catalogs.reviewJourney(orgA, candidate.id, { decision: "approved" });
}
const mappedBundle = await catalogs.publish(orgA, emptyDraft.id);
check("published runtime bundle includes the role-scoped screen graph", mappedBundle.screens?.length === 2 &&
  mappedBundle.screens.every((screen) => !!screen.roleProfileId));
const mappedEvidence = await new EvidenceRouter(catalogs, { ...({} as KnowledgeRepository),
  ingestDocument: async (_ctx, input) => ({ documentId: input.externalKey, versionId: input.contentHash, chunks: input.chunks.length }),
  search: async () => [],
}).route(orgA, {
  productId: mappingProduct.product.id, roleProfileId: mappingProduct.roles[0].id, text: "what is on this screen",
  screen: { observationId: randomUUID(), sessionId: "graph", version: 1, url: "https://a.example.test", title: "Home",
    visibleText: "Home", controls: [], fingerprint: "home-v1", loading: false, capturedAt: timestamp },
});
check("live runtime grounding matches graph state and verified next controls", mappedEvidence.matchedScreen?.key === "home" &&
  mappedEvidence.nextTransitions.length === 1);
const coldCatalogs = new CatalogService(repositories.catalogs, objects, new MemoryBundleCache());
const restored = await coldCatalogs.activeBundle(orgA, a.product.id);
check("a cold worker restores the exact published artifact", JSON.stringify(restored) === JSON.stringify(await catalogs.activeBundle(orgA, a.product.id)));

let knowledgeSearches = 0;
const fakeKnowledge: KnowledgeRepository = {
  ingestDocument: async (_ctx, input) => ({ documentId: input.externalKey, versionId: input.contentHash, chunks: input.chunks.length }),
  listForPlanning: async () => [],
  search: async () => {
    knowledgeSearches++;
    return [{ id: "fact", title: "Guide", section: "Leads", content: "Lead creation is supported.", source: "docs", trust: "official", score: 1 }];
  },
};
const evidenceRouter = new EvidenceRouter(coldCatalogs, fakeKnowledge);
const actionEvidence = await evidenceRouter.route(orgA, { productId: a.product.id, roleProfileId: a.roles[0].id, text: "show me how to create Lead" });
check("an action turn selects the verified journey", actionEvidence.journey?.key === "create-lead");
check("verified action routing skips unnecessary knowledge search", knowledgeSearches === 0);
check("explicit verified actions still execute when the model omits its tool call",
  shouldAutoRunVerifiedFlow("action", true, []));
check("a model-issued verified-flow call is never executed twice",
  !shouldAutoRunVerifiedFlow("action", true, ["run_verified_flow"]));
check("explanations never auto-execute a workflow",
  !shouldAutoRunVerifiedFlow("product_question", true, []));
await evidenceRouter.route(orgA, { productId: a.product.id, roleProfileId: a.roles[0].id, text: "hello there" });
check("small talk stays on the low-latency lane", knowledgeSearches === 0);
const productEvidence = await evidenceRouter.route(orgA, { productId: a.product.id, roleProfileId: a.roles[0].id, text: "Can it create Lead?" });
check("product questions retrieve authoritative knowledge", knowledgeSearches === 1 && productEvidence.knowledge.length === 1);
check("runtime prompt exposes evidence provenance", /EVIDENCE PROVENANCE/.test(evidenceToSystem(productEvidence)));
check("recent-screen questions stay on the live-screen lane", classifyRuntimeIntent("What was just added to the list?") === "screen_question");
check("chart interpretation is grounded in the current screen", classifyRuntimeIntent("What does the cost over time graph tell me?") === "screen_question");
check("chart date follow-ups stay on the current screen", classifyRuntimeIntent("Can you check July 28th?") === "screen_question");
let stoppedForCandidate = false;
const turnManager = new TurnManager({ stopAudio: () => { stoppedForCandidate = true; }, cancelSpeech: () => {} });
turnManager.beginThinking();
const unconfirmedCandidate = turnManager.onUserVoice();
check("unconfirmed microphone noise does not cancel a thinking turn",
  !unconfirmedCandidate.interrupted && !stoppedForCandidate && turnManager.state === "thinking");
const liveScreen: ScreenState = {
  observationId: randomUUID(), sessionId: "live", version: 1, url: "https://a.example.test", title: "Home",
  visibleText: "Ready", controls: [], fingerprint: "home", loading: false, capturedAt: timestamp,
};
const screenEvidence = await evidenceRouter.route(orgA, {
  productId: a.product.id, roleProfileId: a.roles[0].id, text: "clicked a button and paused", screen: liveScreen,
});
check("proactive evidence can select a verified journey from the live screen", screenEvidence.journey?.key === "create-lead" && screenEvidence.provenance.includes("live_screen"));

const slowRouter = new EvidenceRouter(coldCatalogs, fakeKnowledge, () => new Promise(() => {}));
const previousBudget = process.env.KNOWLEDGE_RETRIEVAL_BUDGET_MS;
process.env.KNOWLEDGE_RETRIEVAL_BUDGET_MS = "30";
const retrievalStarted = Date.now();
const bounded = await slowRouter.route(orgA, { productId: a.product.id, roleProfileId: a.roles[0].id, text: "Can it create Lead?" });
if (previousBudget === undefined) delete process.env.KNOWLEDGE_RETRIEVAL_BUDGET_MS; else process.env.KNOWLEDGE_RETRIEVAL_BUDGET_MS = previousBudget;
check("slow semantic retrieval cannot block the live answer", Date.now() - retrievalStarted < 150 && bounded.knowledge.length > 0);

check("unmatched durable actions cannot receive improvisational UI tools", !toolsForTurn("action", false, false, true)
  .some((tool) => ["navigate", "click", "type", "scroll", "run_verified_flow"].includes(tool.name)));
const embedSecret = "architecture-test-secret-that-is-long-enough";
const embedToken = issueEmbedToken({ v: 1, jti: randomUUID(), organizationId: orgA.organizationId,
  productId: a.product.id, roleProfileId: a.roles[0].id, exp: Math.floor(Date.now() / 1000) + 60 }, embedSecret);
check("embed grants are signed, scoped, and reject tampering", verifyEmbedToken(embedToken, embedSecret)?.productId === a.product.id &&
  verifyEmbedToken(`${embedToken}x`, embedSecret) === null);

const sharedCache = new MemoryBundleCache();
const workerACache = new LayeredBundleCache(new MemoryBundleCache(), sharedCache);
const workerBCache = new LayeredBundleCache(new MemoryBundleCache(), sharedCache);
await workerACache.setActive(orgA, a.product.id, bundle);
await workerBCache.getActive(orgA, a.product.id);
const newerBundle = { ...bundle, catalogVersionId: randomUUID(), catalogVersion: bundle.catalogVersion + 1 };
await workerACache.setActive(orgA, a.product.id, newerBundle);
check("a second worker observes a newly published active catalog", (await workerBCache.getActive(orgA, a.product.id))?.catalogVersionId === newerBundle.catalogVersionId);

const jobId = randomUUID();
await repositories.mappingJobs.enqueue(orgA, {
  id: jobId, organizationId: orgA.organizationId, productId: a.product.id,
  environmentId: a.environments[0].id, catalogVersionId: nextDraft.id,
  status: "queued", stage: "discover", cursor: {}, attempts: 0,
  createdAt: timestamp, updatedAt: timestamp,
});
const claimed = await repositories.mappingJobs.claim(orgA, jobId, "worker-a", 300);
const doubleClaim = await repositories.mappingJobs.claim(orgA, jobId, "worker-b", 300);
check("one mapper worker owns a live job lease", claimed?.status === "running" && doubleClaim === null);
const artifactValue = { screens: Array.from({ length: 200 }, (_, index) => ({ id: `screen-${index}`, controls: ["open", "save"] })) };
const artifactReceipt = await repositories.mappingJobs.saveArtifact(orgA, jobId, "working-graph", artifactValue);
check("large mapper state is stored outside the hot job cursor with a checksum", artifactReceipt.checksum.length === 64 &&
  (await repositories.mappingJobs.getArtifact<typeof artifactValue>(orgA, jobId, "working-graph"))?.screens.length === 200 &&
  !(await repositories.mappingJobs.get(orgA, jobId))?.cursor.workingGraph);
const pausedJob = await repositories.mappingJobs.control(orgA, jobId, "pause");
check("a reviewer can durably pause a running mapping job", pausedJob.status === "waiting_for_human");
let staleCheckpointBlocked = false;
try { if (claimed) await repositories.mappingJobs.checkpoint(orgA, claimed, { owner: "worker-a", seconds: 60 }); } catch { staleCheckpointBlocked = true; }
check("a paused job fences the old worker from overwriting human control", staleCheckpointBlocked);
const resumedJob = await repositories.mappingJobs.control(orgA, jobId, "resume");
check("a paused mapping job resumes from its saved stage and cursor", resumedJob.status === "queued" && resumedJob.stage === "discover");
const resumedClaim = await repositories.mappingJobs.claim(orgA, jobId, "worker-b", 60);
check("a resumed mapping job can be leased by another worker", resumedClaim?.status === "running");
const cancelledJob = await repositories.mappingJobs.control(orgA, jobId, "cancel");
check("cancellation is durable and terminal", cancelledJob.status === "cancelled");

const trainingEvent = {
  id: randomUUID(), organizationId: orgA.organizationId, productId: a.product.id,
  catalogVersionId: draft.id, mappingJobId: jobId, eventType: "training.exploring",
  actorType: "agent" as const, actorId: "test-worker", payload: { goal: "Create lead", step: 1 },
  createdAt: timestamp, updatedAt: timestamp,
};
await repositories.training.append(orgA, trainingEvent);
check("training events are durable and tenant-scoped", (await repositories.training.list(orgA, a.product.id)).length === 1 &&
  (await repositories.training.list(orgB, a.product.id)).length === 0);

const resumableId = randomUUID();
await repositories.mappingJobs.enqueue(orgA, {
  id: resumableId, organizationId: orgA.organizationId, productId: a.product.id,
  environmentId: a.environments[0].id, catalogVersionId: emptyDraft.id, status: "queued", stage: "discover", cursor: {}, attempts: 0,
  createdAt: timestamp, updatedAt: timestamp,
});
const progressRunner = new MappingJobRunner(repositories.mappingJobs, [
  { name: "discover", run: async (_job, _signal, checkpoint) => { await checkpoint?.({ discovered: { screens: 2 } }); return { ok: true }; } },
  { name: "persist", run: async (job) => ({ sawCheckpoint: !!job.cursor.discovered }) },
], "progress-worker", 60);
const progressed = await progressRunner.run(orgA, resumableId);
check("mapping stages persist resumable progress before completion", progressed.status === "completed" && !!progressed.cursor.discovered && !!progressed.cursor.persist);

const retryId = randomUUID();
await repositories.mappingJobs.enqueue(orgA, {
  id: retryId, organizationId: orgA.organizationId, productId: a.product.id,
  environmentId: a.environments[0].id, catalogVersionId: emptyDraft.id, status: "queued", stage: "discover", cursor: {}, attempts: 0,
  createdAt: timestamp, updatedAt: timestamp,
});
let transientAttempts = 0;
const retryRunner = new MappingJobRunner(repositories.mappingJobs, [{
  name: "discover", run: async () => {
    transientAttempts++;
    if (transientAttempts === 1) throw new Error("temporary browser fleet outage");
    return { recovered: true };
  },
}], "retry-worker", 60);
await retryRunner.run(orgA, retryId).catch(() => {});
check("a transient mapping failure remains queued at its resumable stage", (await repositories.mappingJobs.get(orgA, retryId))?.status === "queued");
const recovered = await retryRunner.run(orgA, retryId);
check("a queued mapping job recovers on a bounded retry", recovered.status === "completed" && Boolean(recovered.cursor.discover) && transientAttempts === 2);

const queue = new MemoryMappingQueue();
const queuedJob = { ...progressed, id: randomUUID(), status: "queued" as const };
await queue.enqueue(orgA, queuedJob);
const queuedItem = await queue.next();
check("mapping queue retains work until the worker explicitly completes it", !!queuedItem && (await queue.next())?.jobId === queuedItem.jobId);
if (queuedItem) await queue.complete(queuedItem);
check("mapping queue removes completed work", (await queue.next()) === null);

await repositories.feedback.save(orgA, {
  id: randomUUID(), organizationId: orgA.organizationId, productId: a.product.id, catalogVersionId: emptyDraft.id,
  kind: "unanswered_question", content: "Does it support territory routing?", metadata: {}, createdAt: timestamp, updatedAt: timestamp,
});
check("durable feedback is available to the next mapping curriculum", (await repositories.feedback.listForProduct(orgA, a.product.id)).length === 1);

let privateSourceBlocked = false;
try { await assertSafeKnowledgeUrl("https://127.0.0.1/internal-docs"); } catch { privateSourceBlocked = true; }
check("external knowledge connectors reject private-network and metadata targets", privateSourceBlocked);

const executorSource = await readFile(fileURLToPath(new URL("./workflow/executor.ts", import.meta.url)), "utf8");
check("workflow executor contains no client-name branching", !/hubspot|dolibarr|orangehrm|saucedemo|salesforce/i.test(executorSource));
const platformSources = await Promise.all(["./mapping/durable-pipeline.ts", "./runtime/evidence-router.ts", "./mapper/coverage-prober.ts"]
  .map((source) => readFile(fileURLToPath(new URL(source, import.meta.url)), "utf8")));
check("mapping and runtime behavior contain no client-specific conditions", !platformSources.some((source) =>
  /(?:if|switch|case)[^\n]*(hubspot|dolibarr|orangehrm|saucedemo|salesforce)/i.test(source)));

const migrationSource = await readFile(fileURLToPath(new URL("../../db/migrations/001_durable_backbone.sql", import.meta.url)), "utf8");
check("database forces row-level security", /FORCE ROW LEVEL SECURITY/i.test(migrationSource));
check("tenant policy reads organization from transaction context", /current_setting\('app\.organization_id'/i.test(migrationSource));
check("mapping jobs have durable lease fields", /lease_owner text[\s\S]*lease_expires_at timestamptz/i.test(migrationSource));

const secretMigrationSource = await readFile(fileURLToPath(new URL("../../db/migrations/007_secret_store.sql", import.meta.url)), "utf8");
const secretProviderSource = await readFile(fileURLToPath(new URL("./secrets/postgres-provider.ts", import.meta.url)), "utf8");
check("encrypted credentials are tenant-owned and forced through RLS",
  /organization_id uuid NOT NULL/i.test(secretMigrationSource) && /FORCE ROW LEVEL SECURITY/i.test(secretMigrationSource));
check("secret operations set tenant context in their transaction",
  /set_config\('app\.organization_id'/i.test(secretProviderSource) && /WHERE organization_id=\$1 AND secret_path=\$2/i.test(secretProviderSource));

const crawlSource = await readFile(fileURLToPath(new URL("./knowledge/crawl.ts", import.meta.url)), "utf8");
check("rendered documentation validates every browser subrequest",
  /page\.route\("\*\*\/\*"[\s\S]*assertSafeKnowledgeUrl\(url\)/i.test(crawlSource));

console.log(`\n${failed ? "❌" : "✅"} ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
