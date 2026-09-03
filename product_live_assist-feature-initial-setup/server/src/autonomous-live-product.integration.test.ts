import "dotenv/config";
import { randomUUID } from "node:crypto";
import { tenantContext } from "./domain/context.js";
import type { MappingJob } from "./domain/runtime.js";
import { Database } from "./storage/database.js";
import { postgresRepositories } from "./storage/postgres.js";
import { DurableMappingPipeline } from "./mapping/durable-pipeline.js";
import { MappingJobRunner } from "./mapping/job-runner.js";
import {
  EnvironmentSecretProvider,
  SecretProviderRegistry,
  type SecretProvider,
  type SecretValue,
} from "./secrets/provider.js";
import { CatalogService } from "./catalog/service.js";
import { MemoryObjectStore } from "./catalog/object-store.js";
import { MemoryBundleCache } from "./catalog/cache.js";
import { EvidenceRouter, evidenceToSystem } from "./runtime/evidence-router.js";
import { getProduct, type ProductAuth } from "./products.js";
import { LiveBox } from "./livebox.js";
import { LiveScreenObserver } from "./runtime/screen-state.js";
import { Agent } from "./agent.js";
import { SessionMemory } from "./knowledge/memory.js";
import { BrainStore } from "./knowledge/store.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const fixtureId = process.env.LIVE_TEST_PRODUCT_ID?.trim();
const fixture = fixtureId ? await getProduct(fixtureId) : null;
if (fixtureId && !fixture) throw new Error(`LIVE_TEST_PRODUCT_ID ${fixtureId} was not found`);
const target = fixture?.startUrl ?? process.env.LIVE_TEST_PRODUCT_URL ?? "https://demo.playwright.dev/todomvc/#/";
const fixtureSecret: SecretValue | undefined = fixture && fixture.auth.mode !== "none" ? {
  username: fixture.auth.username,
  password: fixture.auth.password,
  sessionState: fixture.auth.sessionState,
  sessionStorage: fixture.auth.sessionStorage,
  profileDir: fixture.auth.profileDir,
} : undefined;
const fixtureRuntimeAuth: ProductAuth = fixtureSecret?.sessionState || fixtureSecret?.sessionStorage
  ? { mode: "session", sessionState: fixtureSecret.sessionState, sessionStorage: fixtureSecret.sessionStorage }
  : fixtureSecret?.profileDir
    ? { mode: "profile", profileDir: fixtureSecret.profileDir }
    : fixtureSecret?.username
      ? { mode: "login", username: fixtureSecret.username, password: fixtureSecret.password }
      : { mode: "none" };

/** Keeps authenticated live-test material in this process only; PostgreSQL receives a pointer. */
class EphemeralLiveTestSecretProvider implements SecretProvider {
  readonly name = "ephemeral-live-test";
  constructor(private readonly secret: SecretValue) {}
  async get(): Promise<SecretValue> { return this.secret; }
}

const database = new Database(process.env.DATABASE_URL);
const repositories = postgresRepositories(database);
const secrets = new SecretProviderRegistry();
secrets.register(new EnvironmentSecretProvider());
if (fixtureSecret) secrets.register(new EphemeralLiveTestSecretProvider(fixtureSecret));
const pipeline = new DurableMappingPipeline(repositories, secrets);
const catalogs = new CatalogService(repositories.catalogs, new MemoryObjectStore(), new MemoryBundleCache(), repositories.products);
const evidence = new EvidenceRouter(catalogs, repositories.knowledge);
const ctx = tenantContext({ organizationId: randomUUID(), actorId: randomUUID(), requestId: randomUUID() });
let passed = 0;
const check = (name: string, condition: boolean, detail = "") => {
  if (!condition) throw new Error(`failed: ${name}${detail ? ` (${detail})` : ""}`);
  passed++; console.log(`  ✓ ${name}`);
};

try {
  await database.withTenant(ctx, (client) => client.query(
    "INSERT INTO organizations(id,slug,name) VALUES($1,$2,'Autonomous live mapping test')",
    [ctx.organizationId, `autonomous-live-${ctx.organizationId}`],
  ).then(() => undefined));
  const timestamp = new Date().toISOString();
  const product = await repositories.products.create(ctx, {
    key: `autonomous-${randomUUID().slice(0, 8)}`, name: fixture?.name ?? "Autonomous live test product",
    environment: { key: "live-test", name: "Live test", startUrl: target },
  });
  if (fixtureSecret) {
    const credentialId = randomUUID();
    const role = product.roles[0];
    await repositories.access.saveCredentialRef(ctx, {
      id: credentialId, organizationId: ctx.organizationId, provider: "ephemeral-live-test",
      secretPath: `live-test/${ctx.organizationId}`, metadata: { account: "authenticated test fixture" },
      createdAt: timestamp, updatedAt: timestamp,
    });
    const authenticatedRole = { ...role, credentialRefId: credentialId, updatedAt: timestamp };
    await repositories.access.saveRoleProfile(ctx, authenticatedRole);
    product.roles[0] = authenticatedRole;
    const storedRef = await repositories.access.getCredentialRef(ctx, credentialId);
    check("the durable store contains only an authenticated credential pointer",
      storedRef?.provider === "ephemeral-live-test" && !JSON.stringify(storedRef).includes("sessionState"));
  }
  const draft = await repositories.catalogs.createDraft(ctx, product.product.id, product.environments[0].id);
  const job: MappingJob = {
    id: randomUUID(), organizationId: ctx.organizationId, productId: product.product.id,
    environmentId: product.environments[0].id, catalogVersionId: draft.id,
    status: "queued", stage: "preflight", cursor: {
      roleProfileId: product.roles[0].id,
      maxJobs: Math.max(1, Math.min(10, Number(process.env.LIVE_TEST_MAX_JOBS ?? 4))),
      maxScreens: Math.max(2, Math.min(30, Number(process.env.LIVE_TEST_MAX_SCREENS ?? 10))),
    }, attempts: 0, createdAt: timestamp, updatedAt: timestamp,
  };
  await repositories.mappingJobs.enqueue(ctx, job);
  const runner = new MappingJobRunner(repositories.mappingJobs, [
    { name: "preflight", run: (value, signal) => pipeline.preflight(ctx, value, signal) },
    { name: "map", run: (value, signal, checkpoint) => pipeline.map(ctx, value, signal, checkpoint) },
    { name: "persist", run: (value, signal) => pipeline.persist(ctx, value, signal) },
  ], "autonomous-live-test", 15 * 60);
  const completed = await runner.run(ctx, job.id);
  check("the generic mapper completes without a seeded workflow", completed.status === "completed");
  check("the working graph is a checksummed durable artifact", !!(await repositories.mappingJobs.getArtifact(ctx, job.id, "working-graph")) &&
    typeof (completed.cursor.mappingProgress as any)?.checksum === "string");
  const snapshot = await repositories.catalogs.get(ctx, draft.id);
  check("autonomous discovery persists screen states and verified journeys", !!snapshot?.screens.length && !!snapshot.journeys.length);
  check("every persisted journey passed replay verification", snapshot!.journeys.every((journey) => journey.verificationStatus === "verified"));
  check("non-happy branches carry evidence rather than unknown placeholders", snapshot!.coverage.every((item) => item.status !== "unknown"));

  const previousThreshold = process.env.PUBLISH_MIN_COVERAGE;
  process.env.PUBLISH_MIN_COVERAGE = process.env.LIVE_TEST_MIN_COVERAGE ?? "0.3";
  const bundle = await catalogs.publish(ctx, draft.id);
  if (previousThreshold === undefined) delete process.env.PUBLISH_MIN_COVERAGE; else process.env.PUBLISH_MIN_COVERAGE = previousThreshold;
  check("the autonomously mapped graph compiles into a role-scoped runtime bundle", !!bundle.screens?.length &&
    bundle.screens.every((screen) => screen.roleProfileId === product.roles[0].id));
  const routed = await evidence.route(ctx, {
    productId: product.product.id, roleProfileId: product.roles[0].id,
    text: `show me how to ${bundle.journeys[0].name.toLowerCase()}`,
  });
  check("a natural request reaches the autonomously learned journey", routed.journey?.key === bundle.journeys[0].key);

  if (process.env.LIVE_TEST_MODEL === "true") {
    const box = new LiveBox({ startUrl: target, auth: fixtureRuntimeAuth, allowActions: [] });
    let started = false;
    try {
      const browser = await box.start();
      started = true;
      const observer = new LiveScreenObserver(browser.sessionId, box);
      const observationStarted = Date.now();
      const screen = await observer.observe(false);
      const observationMs = Date.now() - observationStarted;
      check("the customer runtime sees the signed-in live screen",
        !/\/login(?:[/?#]|$)/.test(screen.url) && screen.controls.length > 0,
        `${screen.url}; controls=${screen.controls.length}`);
      const screenEvidence = await evidence.route(ctx, {
        productId: product.product.id, roleProfileId: product.roles[0].id,
        text: "What am I looking at on this screen?", screen,
      });
      check("the live answer is grounded in screen plus the published catalog",
        screenEvidence.provenance.includes("live_screen") && !!screenEvidence.catalogVersionId);

      const spoken: string[] = [];
      const turnStarted = Date.now();
      let firstSentenceMs = 0;
      const agent = new Agent(
        box, new SessionMemory(), new BrainStore(product.product.id), product.product.name, [],
        async (text, currentScreen) => {
          const turnEvidence = await evidence.route(ctx, {
            productId: product.product.id, roleProfileId: product.roles[0].id,
            text, screen: currentScreen,
          });
          return {
            intent: turnEvidence.intent, system: evidenceToSystem(turnEvidence),
            workflow: turnEvidence.journey?.workflow, flowName: turnEvidence.journey?.name,
          };
        },
        observer,
      );
      await agent.handleUserMessage("What am I looking at on this screen?", (line) => {
        if (!firstSentenceMs) firstSentenceMs = Date.now() - turnStarted;
        spoken.push(line);
      });
      check("the AI employee answers naturally from the current screen", spoken.join(" ").trim().length > 10, spoken.join(" "));
      check("the first live sentence meets the conversational latency ceiling",
        firstSentenceMs > 0 && firstSentenceMs < 8_000, `${firstSentenceMs}ms`);
      console.log(`  ↳ live screen ${observationMs}ms; first sentence ${firstSentenceMs}ms`);
    } finally {
      if (started) await box.stop().catch(() => {});
    }
  }
  console.log(`\n✅ ${passed} autonomous live-product checks passed`);
} finally {
  await database.withTenant(ctx, (client) => client.query("DELETE FROM organizations WHERE id=$1", [ctx.organizationId]).then(() => undefined)).catch(() => {});
  await database.close();
}
