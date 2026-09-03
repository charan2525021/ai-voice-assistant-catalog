import "dotenv/config";
import { randomUUID } from "node:crypto";
import { tenantContext } from "../domain/context.js";
import { Database } from "./database.js";
import { postgresRepositories } from "./postgres.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for the PostgreSQL integration test");

const database = new Database(process.env.DATABASE_URL);
const orgA = tenantContext({ organizationId: randomUUID(), actorId: randomUUID(), requestId: randomUUID() });
const orgB = tenantContext({ organizationId: randomUUID(), actorId: randomUUID(), requestId: randomUUID() });
let passed = 0;
const check = (name: string, condition: boolean) => {
  if (!condition) throw new Error(`failed: ${name}`);
  passed++;
  console.log(`  ✓ ${name}`);
};

try {
  for (const [ctx, slug] of [[orgA, `test-a-${orgA.organizationId}`], [orgB, `test-b-${orgB.organizationId}`]] as const) {
    await database.withTenant(ctx, (client) => client.query(
      "INSERT INTO organizations(id,slug,name) VALUES($1,$2,'Integration test')",
      [ctx.organizationId, slug],
    ).then(() => undefined));
  }
  const repositories = postgresRepositories(database);
  const a = await repositories.products.create(orgA, {
    key: "shared-key", name: "A", environment: { key: "sandbox", name: "Sandbox", startUrl: "https://a.example.test" },
  });
  const b = await repositories.products.create(orgB, {
    key: "shared-key", name: "B", environment: { key: "sandbox", name: "Sandbox", startUrl: "https://b.example.test" },
  });
  check("same product key is accepted across organizations", a.product.id !== b.product.id);
  check("repository read is hidden by PostgreSQL RLS", (await repositories.products.get(orgA, b.product.id)) === null);
  const lowLevel = await database.withTenant(orgA, (client) => client.query("SELECT id FROM products WHERE id=$1", [b.product.id]));
  check("direct tenant-scoped SQL cannot see another organization", lowLevel.rowCount === 0);

  const draft = await repositories.catalogs.createDraft(orgA, a.product.id, a.environments[0].id);
  check("catalog draft is allocated transactionally", draft.version === 1 && draft.organizationId === orgA.organizationId);
  check("the open catalog is reused for concurrent role mapping", (await repositories.catalogs.getOpenDraft(
    orgA, a.product.id, a.environments[0].id,
  ))?.id === draft.id);
  await repositories.catalogs.replaceMappedCatalog(orgA, draft.id, a.roles[0].id, {
    screens: [{ key: "home", name: "Home", url: "https://a.example.test", purpose: "Entry", fingerprint: "home-v1",
      controls: [{ key: "create", role: "button", accessibleName: "Create" }] }],
    transitions: [{ fromScreenKey: "home", controlKey: "create", action: { action: "click" }, reliability: 1 }],
    journeys: [{
      key: "create-record--role-default", goal: "Create record", capabilityKey: "records", capabilityName: "Records",
      workflow: { schemaVersion: 1, id: "create-record--role-default", version: 1, name: "Create record", risk: "reversible_write",
        startUrl: "https://a.example.test", preconditions: [],
        steps: [{ id: "create", action: "click", target: { role: "button", accessibleName: "Create" } }],
        postconditions: [{ kind: "screen_changed" }] },
      reliability: 1, evidence: { replayed: true }, depth: 4,
    }],
  });
  const mapped = await repositories.catalogs.get(orgA, draft.id);
  check("mapped screens and verified journeys persist transactionally", mapped?.catalog.status === "review" && mapped.journeys.length === 1);
  check("coverage gaps have explicit blocked evidence in PostgreSQL", mapped?.coverage.length === 5 &&
    mapped.coverage.filter((item) => item.status === "blocked").length === 4 && mapped.coverage.every((item) => item.status !== "unknown"));
  const secondRoleId = randomUUID();
  const roleTimestamp = new Date().toISOString();
  await repositories.access.saveRoleProfile(orgA, {
    id: secondRoleId, organizationId: orgA.organizationId, environmentId: a.environments[0].id,
    key: "manager", name: "Manager", permissionHints: [], createdAt: roleTimestamp, updatedAt: roleTimestamp,
  });
  await repositories.catalogs.replaceMappedCatalog(orgA, draft.id, secondRoleId, {
    screens: [{ key: "home", name: "Home", url: "https://a.example.test", purpose: "Manager entry", fingerprint: "manager-home-v1",
      controls: [{ key: "approve", role: "button", accessibleName: "Approve" }] }],
    transitions: [{ fromScreenKey: "home", controlKey: "approve", action: { action: "click" }, reliability: 0.95 }],
    journeys: [{
      key: "approve-record--role-manager", goal: "Approve record", capabilityKey: "approvals", capabilityName: "Approvals",
      workflow: { schemaVersion: 1, id: "approve-record--role-manager", version: 1, name: "Approve record", risk: "reversible_write",
        startUrl: "https://a.example.test", preconditions: [],
        steps: [{ id: "approve", action: "click", target: { role: "button", accessibleName: "Approve" } }],
        postconditions: [{ kind: "screen_changed" }] },
      reliability: 0.95, evidence: { replayed: true }, depth: 4,
    }],
  });
  const cumulative = await repositories.catalogs.get(orgA, draft.id);
  check("mapping a second role does not erase the first role", cumulative?.journeys.length === 2 && cumulative.coverage.length === 10);
  const persistedGraph = await database.withTenant(orgA, (client) => client.query(
    `SELECT count(*)::int AS transitions, count(DISTINCT s.conditions->>'roleProfileId')::int AS roles
     FROM transitions t JOIN screen_states s ON s.id=t.from_state_id WHERE t.catalog_version_id=$1`,
    [draft.id],
  ));
  check("role-specific screen transitions form a durable graph", persistedGraph.rows[0].transitions === 2 && persistedGraph.rows[0].roles === 2);
  let approvalGateBlocked = false;
  try { await repositories.catalogs.publish(orgA, draft.id, { key: "blocked.json", checksum: "blocked" }); }
  catch { approvalGateBlocked = true; }
  check("PostgreSQL publication requires explicit approval after machine verification", approvalGateBlocked);
  for (const candidate of cumulative?.journeys ?? []) {
    await repositories.catalogs.reviewJourney(orgA, candidate.id, { decision: "approved", comment: "integration review" });
  }
  await repositories.catalogs.publish(orgA, draft.id, { key: "integration/catalog.json", checksum: "integration" });
  const successor = await repositories.catalogs.createDraft(orgA, a.product.id, a.environments[0].id);
  const inherited = await repositories.catalogs.get(orgA, successor.id);
  check("successor catalogs copy the published multi-role graph and coverage", inherited?.journeys.length === 2 &&
    inherited.screens.length === 2 && inherited.transitions.length === 2 && inherited.coverage.length === 10);
  const grantTimestamp = new Date().toISOString();
  const grantId = randomUUID();
  await repositories.access.saveEmbedGrant(orgA, {
    id: grantId, organizationId: orgA.organizationId, productId: a.product.id, roleProfileId: a.roles[0].id,
    allowedOrigins: ["https://customer.example"], expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: grantTimestamp, updatedAt: grantTimestamp,
  });
  check("embed grants are tenant-scoped and revocable", (await repositories.access.getEmbedGrant(orgA, grantId))?.productId === a.product.id &&
    (await repositories.access.getEmbedGrant(orgB, grantId)) === null);
  await repositories.access.revokeEmbedGrant(orgA, grantId);
  check("revoked embed grants fail closed", !!(await repositories.access.getEmbedGrant(orgA, grantId))?.revokedAt);
  const sessionId = randomUUID();
  await repositories.sessions.create(orgA, {
    id: sessionId, organizationId: orgA.organizationId, productId: a.product.id,
    environmentId: a.environments[0].id, roleProfileId: a.roles[0].id, catalogVersionId: draft.id,
    mode: "text", status: "active", memory: { turns: 2 }, lastSeenAt: grantTimestamp,
    browserSessionId: "steel-session-test", workerId: "dead-worker",
    recoveryLeaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
    createdAt: grantTimestamp, updatedAt: grantTimestamp,
  });
  const recoveredSession = await repositories.sessions.claimRecovery(orgA, sessionId, "replacement-worker", 45);
  check("an expired browser-session lease is atomically fenced to one replacement worker",
    recoveredSession?.workerId === "replacement-worker" && recoveredSession.browserSessionId === "steel-session-test" &&
    (await repositories.sessions.claimRecovery(orgA, sessionId, "other-worker", 45)) === null);
  const ingested = await repositories.knowledge.ingestDocument(orgA, {
    productId: a.product.id, sourceType: "manual", uri: "manual://integration", trust: "official",
    externalKey: "integration", title: "Integration", contentHash: "v1",
    chunks: [{ title: "Integration", section: "Test", content: "This tenant owns this knowledge." }],
  });
  check("knowledge document versions and chunks persist", ingested.chunks === 1);
  const hits = await repositories.knowledge.search(orgA, {
    productId: a.product.id, catalogVersionId: draft.id, query: "tenant owns knowledge", limit: 4,
  });
  check("global product knowledge is available to a catalog", hits.length === 1);
  check("durable mapper can read the tenant's latest document chunks", (await repositories.knowledge.listForPlanning(orgA, a.product.id)).length === 1);
  check("durable planner corpus is isolated from another tenant", (await repositories.knowledge.listForPlanning(orgB, a.product.id)).length === 0);
  check("the same knowledge is isolated from another tenant", (await repositories.knowledge.search(orgB, {
    productId: a.product.id, catalogVersionId: draft.id, query: "tenant owns knowledge", limit: 4,
  })).length === 0);
  const feedbackTimestamp = new Date().toISOString();
  await repositories.feedback.save(orgA, {
    id: randomUUID(), organizationId: orgA.organizationId, productId: a.product.id, catalogVersionId: draft.id,
    kind: "unanswered_question", content: "How do I approve a record?", metadata: { roleProfileId: secondRoleId },
    createdAt: feedbackTimestamp, updatedAt: feedbackTimestamp,
  });
  check("runtime gaps are durably available to the next mapper run", (await repositories.feedback.listForProduct(orgA, a.product.id)).length === 1);
  const jobTimestamp = new Date().toISOString();
  const jobId = randomUUID();
  await repositories.mappingJobs.enqueue(orgA, {
    id: jobId, organizationId: orgA.organizationId, productId: a.product.id,
    environmentId: a.environments[0].id, catalogVersionId: successor.id,
    status: "queued", stage: "preflight", cursor: {}, attempts: 0, createdAt: jobTimestamp, updatedAt: jobTimestamp,
  });
  await repositories.mappingJobs.claim(orgA, jobId, "integration-worker", 60);
  check("durable mapping control pauses, resumes and cancels through PostgreSQL",
    (await repositories.mappingJobs.control(orgA, jobId, "pause")).status === "waiting_for_human" &&
    (await repositories.mappingJobs.control(orgA, jobId, "resume")).status === "queued" &&
    (await repositories.mappingJobs.control(orgA, jobId, "cancel")).status === "cancelled");
  const trainingEventId = randomUUID();
  await repositories.training.append(orgA, {
    id: trainingEventId, organizationId: orgA.organizationId, productId: a.product.id,
    catalogVersionId: successor.id, mappingJobId: jobId, eventType: "training.review",
    actorType: "human", actorId: orgA.actorId, payload: { decision: "approved" },
    createdAt: jobTimestamp, updatedAt: jobTimestamp,
  });
  check("durable training audit events are tenant isolated",
    (await repositories.training.list(orgA, a.product.id)).some((event) => event.id === trainingEventId) &&
    (await repositories.training.list(orgB, a.product.id)).length === 0);

  console.log(`\n✅ ${passed} PostgreSQL integration checks passed`);
} finally {
  for (const ctx of [orgA, orgB]) {
    await database.withTenant(ctx, (client) => client.query("DELETE FROM organizations WHERE id=$1", [ctx.organizationId]).then(() => undefined)).catch(() => {});
  }
  await database.close();
}
