import "dotenv/config";
import { randomUUID } from "node:crypto";
import { tenantContext } from "./domain/context.js";
import { Database } from "./storage/database.js";
import { postgresRepositories } from "./storage/postgres.js";
import { MemoryObjectStore } from "./catalog/object-store.js";
import { LayeredBundleCache, MemoryBundleCache, RedisBundleCache } from "./catalog/cache.js";
import { CatalogService } from "./catalog/service.js";
import { EvidenceRouter, evidenceToSystem } from "./runtime/evidence-router.js";
import { LiveBox } from "./livebox.js";
import { LiveScreenObserver } from "./runtime/screen-state.js";
import { LiveBoxActionDriver } from "./workflow/livebox-driver.js";
import { WorkflowExecutor } from "./workflow/executor.js";
import type { WorkflowDefinition } from "./workflow/schema.js";
import { Agent } from "./agent.js";
import { BrainStore } from "./knowledge/store.js";
import { SessionMemory } from "./knowledge/memory.js";

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
if (!databaseUrl || !redisUrl) throw new Error("DATABASE_URL and REDIS_URL are required for the live-product test");

// Public deterministic product: no account, seed data, or client-specific code.
const productUrl = process.env.LIVE_TEST_PRODUCT_URL ?? "https://demo.playwright.dev/todomvc/#/";
const uniqueTodo = `Aidan live verification ${randomUUID().slice(0, 8)}`;
const database = new Database(databaseUrl);
const repositories = postgresRepositories(database);
const sharedCache = new RedisBundleCache(redisUrl, 60);
const cache = new LayeredBundleCache(new MemoryBundleCache(), sharedCache);
const catalogs = new CatalogService(repositories.catalogs, new MemoryObjectStore(), cache, repositories.products);
const evidence = new EvidenceRouter(catalogs, repositories.knowledge);
const ctx = tenantContext({ organizationId: randomUUID(), actorId: randomUUID(), requestId: randomUUID() });
const box = new LiveBox({ startUrl: productUrl, auth: { mode: "none" } });
let started = false;
let passed = 0;
const check = (name: string, condition: boolean, detail = "") => {
  if (!condition) throw new Error(`failed: ${name}${detail ? ` (${detail})` : ""}`);
  passed++;
  console.log(`  ✓ ${name}`);
};

const workflow: WorkflowDefinition = {
  schemaVersion: 1,
  id: "add-onboarding-checklist--role-default",
  version: 1,
  name: "Add onboarding checklist",
  startUrl: productUrl,
  risk: "reversible_write",
  preconditions: [{ kind: "element_visible", target: { role: "textbox", accessibleName: "What needs to be done?" } }],
  steps: [{
    id: "add-todo", action: "fill", target: { role: "textbox", accessibleName: "What needs to be done?" },
    value: uniqueTodo, submit: true,
  }],
  postconditions: [{ kind: "text_visible", text: uniqueTodo }],
};

try {
  await database.withTenant(ctx, (client) => client.query(
    "INSERT INTO organizations(id,slug,name) VALUES($1,$2,'Aidan live product test')",
    [ctx.organizationId, `live-test-${ctx.organizationId}`],
  ).then(() => undefined));
  const product = await repositories.products.create(ctx, {
    key: `todomvc-${randomUUID().slice(0, 8)}`, name: "TodoMVC",
    environment: { key: "public-demo", name: "Public demo", startUrl: productUrl },
  });
  const role = product.roles[0];
  const draft = await repositories.catalogs.createDraft(ctx, product.product.id, product.environments[0].id);
  await repositories.catalogs.replaceMappedCatalog(ctx, draft.id, role.id, {
    screens: [{
      key: "todos", name: "Todos", url: productUrl, purpose: "Manage a todo list", fingerprint: "mapped-todos",
      controls: [{ key: "new-todo", role: "textbox", accessibleName: "What needs to be done?" }],
    }],
    transitions: [{
      fromScreenKey: "todos", controlKey: "new-todo", action: { action: "fill", submit: true }, reliability: 1,
    }],
    journeys: [{
      key: workflow.id, goal: workflow.name, capabilityKey: "todo-management", capabilityName: "Todo management",
      workflow, reliability: 1, evidence: { source: "live-product-test", replayed: true }, depth: 5,
    }],
  });
  const bundle = await catalogs.publish(ctx, draft.id);
  check("a role-complete durable catalog publishes", bundle.journeys.length === 1 && bundle.coverage.weighted >= 0.5);

  const routed = await evidence.route(ctx, {
    productId: product.product.id, roleProfileId: role.id, text: "Add an onboarding checklist",
  });
  check("the live request selects the published verified journey", routed.journey?.key === workflow.id);

  const session = await box.start();
  started = true;
  const observer = new LiveScreenObserver(session.sessionId, box);
  const before = await observer.observe(false);
  check("the real product screen is captured with semantic controls",
    before.url.startsWith(new URL(productUrl).origin) && before.controls.some((control) => control.role === "textbox"),
    `${before.url}; controls=${before.controls.length}`);

  const executionStarted = Date.now();
  const result = await new WorkflowExecutor(new LiveBoxActionDriver(box, session.sessionId, undefined, undefined, observer))
    .execute(routed.journey!.workflow);
  const executionMs = Date.now() - executionStarted;
  check("the product-neutral executor completes the live journey", result.ok, result.error);
  check("the live product confirms the requested result", await box.hasText(uniqueTodo));
  check("the screen state advances after the product mutation", (result.finalScreen?.version ?? 0) > before.version);

  const grounded = await evidence.route(ctx, {
    productId: product.product.id, roleProfileId: role.id,
    text: "What am I looking at on this screen?", screen: result.finalScreen,
  });
  check("the post-action answer is grounded in both screen and catalog",
    grounded.provenance.includes("live_screen") && grounded.provenance.includes("verified_journey") &&
      (grounded.screen?.visibleText.includes(uniqueTodo) ?? false));

  if (process.env.LIVE_TEST_MODEL === "true") {
    const modelScreen = await observer.observe(false);
    check("the model turn receives the current visible product text", modelScreen.visibleText.includes(uniqueTodo), modelScreen.visibleText);
    const spoken: string[] = [];
    const turnStarted = Date.now();
    let firstSentenceMs = 0;
    const agent = new Agent(
      box, new SessionMemory(), new BrainStore(product.product.id), product.product.name, [],
      async (text, screen) => {
        const turnEvidence = await evidence.route(ctx, {
          productId: product.product.id, roleProfileId: role.id, text, screen,
        });
        return {
          intent: turnEvidence.intent, system: evidenceToSystem(turnEvidence),
          workflow: turnEvidence.journey?.workflow, flowName: turnEvidence.journey?.name,
        };
      },
      observer,
    );
    await agent.handleUserMessage("Read the visible todo item that starts with Aidan.", (line) => {
      if (!firstSentenceMs) firstSentenceMs = Date.now() - turnStarted;
      spoken.push(line);
    });
    check("the configured conversational model answers from the live screen",
      spoken.join(" ").toLowerCase().includes("aidan live verification"), spoken.join(" "));
    check("the live response begins within the conversational latency ceiling", firstSentenceMs > 0 && firstSentenceMs < 8_000, `${firstSentenceMs}ms`);
    console.log(`  ↳ first model sentence in ${firstSentenceMs}ms`);
  }

  console.log(`\n✅ ${passed} live-product checks passed (${executionMs}ms verified workflow)`);
} finally {
  if (started) await box.stop().catch(() => {});
  await database.withTenant(ctx, (client) => client.query(
    "DELETE FROM organizations WHERE id=$1", [ctx.organizationId],
  ).then(() => undefined)).catch(() => {});
  await sharedCache.close().catch(() => {});
  await database.close();
}
