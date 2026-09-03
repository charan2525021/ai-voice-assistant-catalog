import "dotenv/config";
import { randomUUID } from "node:crypto";
import { tenantContext } from "../domain/context.js";
import type { MappingJob } from "../domain/runtime.js";
import { RedisBundleCache } from "../catalog/cache.js";
import type { RuntimeBundle } from "../catalog/runtime-bundle.js";
import { RedisMappingQueue } from "../mapping/queue.js";
import { RedisSessionDirectory } from "./session-directory.js";

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error("REDIS_URL is required for the Redis integration test");

const ctx = tenantContext({ organizationId: randomUUID(), actorId: randomUUID(), requestId: randomUUID() });
const other = tenantContext({ organizationId: randomUUID(), actorId: randomUUID(), requestId: randomUUID() });
const cacheA = new RedisBundleCache(redisUrl, 60);
const cacheB = new RedisBundleCache(redisUrl, 60);
const directoryA = new RedisSessionDirectory(redisUrl, 60);
const directoryB = new RedisSessionDirectory(redisUrl, 60);
const queueA = new RedisMappingQueue(redisUrl);
const queueB = new RedisMappingQueue(redisUrl);
let passed = 0;
const check = (name: string, condition: boolean) => {
  if (!condition) throw new Error(`failed: ${name}`);
  passed++;
  console.log(`  ✓ ${name}`);
};

const timestamp = new Date().toISOString();
const productId = randomUUID();
const catalogVersionId = randomUUID();
const bundle: RuntimeBundle = {
  schemaVersion: 1, organizationId: ctx.organizationId, productId,
  environmentId: randomUUID(), catalogVersionId, catalogVersion: 1, generatedAt: timestamp,
  journeys: [], salesPlays: [], coverage: { weighted: 0, verified: 0, total: 0, unknown: 0 },
};
const job: MappingJob = {
  id: randomUUID(), organizationId: ctx.organizationId, productId, environmentId: bundle.environmentId,
  catalogVersionId, status: "queued", stage: "preflight", cursor: {}, attempts: 0,
  createdAt: timestamp, updatedAt: timestamp,
};
const sessionId = randomUUID();

try {
  await cacheA.set(ctx, bundle);
  await cacheA.setActive(ctx, productId, bundle);
  check("a second replica reads an immutable runtime bundle", (await cacheB.get(ctx, catalogVersionId))?.catalogVersionId === catalogVersionId);
  check("a second replica observes the shared active catalog pointer", (await cacheB.getActive(ctx, productId))?.catalogVersionId === catalogVersionId);

  await directoryA.register(ctx, {
    sessionId, organizationId: ctx.organizationId, productId, catalogVersionId, mode: "text",
    workerId: "worker-a", wsUrl: "wss://worker-a.example/ws", browserSessionId: "steel-session-1",
    status: "active", updatedAt: timestamp,
  });
  const located = await directoryB.locate(ctx, sessionId);
  check("another worker can locate the live session owner and managed browser", located?.workerId === "worker-a" &&
    located.browserSessionId === "steel-session-1");
  check("session routing remains tenant isolated", (await directoryB.locate(other, sessionId)) === null);

  await queueA.enqueue(ctx, job);
  const claimed = await queueB.next();
  check("mapping work is visible to a different worker", claimed?.jobId === job.id && claimed.organizationId === ctx.organizationId);
  check("queued work remains recoverable until durable completion", (await queueA.next())?.jobId === job.id);
  if (claimed) await queueB.complete(claimed);
  check("completed mapping work is removed", await queueA.next() === null);
  console.log(`\n✅ ${passed} Redis coordination checks passed`);
} finally {
  await cacheA.delete(ctx, catalogVersionId).catch(() => {});
  await directoryA.remove(ctx, sessionId).catch(() => {});
  await Promise.all([
    cacheA.close(), cacheB.close(), directoryA.close(), directoryB.close(), queueA.close(), queueB.close(),
  ].map((operation) => operation.catch(() => {})));
}
