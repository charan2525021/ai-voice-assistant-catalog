import { createClient, type RedisClientType } from "redis";
import type { TenantContext } from "../domain/context.js";
import type { MappingJob } from "../domain/runtime.js";

export interface MappingQueueItem {
  organizationId: string;
  jobId: string;
}

export interface MappingQueue {
  enqueue(ctx: TenantContext, job: MappingJob): Promise<void>;
  next(): Promise<MappingQueueItem | null>;
  defer(item: MappingQueueItem, delayMs: number): Promise<void>;
  complete(item: MappingQueueItem): Promise<void>;
  close(): Promise<void>;
}

const member = (item: MappingQueueItem) => JSON.stringify(item);

/** Durable scheduling: members remain in the sorted set while a worker owns them. */
export class RedisMappingQueue implements MappingQueue {
  private readonly client: RedisClientType;
  private connecting?: Promise<unknown>;
  private readonly key = "aidan:mapping:queue";
  constructor(url: string) {
    this.client = createClient({ url });
    this.client.on("error", (error) => console.warn("[mapping-queue]", error.message));
  }
  private async ready() {
    if (!this.client.isReady) { this.connecting ??= this.client.connect(); await this.connecting; }
  }
  async enqueue(ctx: TenantContext, job: MappingJob): Promise<void> {
    await this.ready();
    await this.client.zAdd(this.key, [{ score: Date.now(), value: member({ organizationId: ctx.organizationId, jobId: job.id }) }]);
  }
  async next(): Promise<MappingQueueItem | null> {
    await this.ready();
    const values = await this.client.zRangeByScore(this.key, 0, Date.now(), { LIMIT: { offset: 0, count: 1 } });
    if (!values[0]) return null;
    try { return JSON.parse(values[0]) as MappingQueueItem; }
    catch { await this.client.zRem(this.key, values[0]); return null; }
  }
  async defer(item: MappingQueueItem, delayMs: number): Promise<void> {
    await this.ready();
    await this.client.zAdd(this.key, [{ score: Date.now() + Math.max(100, delayMs), value: member(item) }]);
  }
  async complete(item: MappingQueueItem): Promise<void> { await this.ready(); await this.client.zRem(this.key, member(item)); }
  async close(): Promise<void> { if (this.client.isOpen) await this.client.quit(); }
}

export class MemoryMappingQueue implements MappingQueue {
  private values = new Map<string, { item: MappingQueueItem; at: number }>();
  async enqueue(ctx: TenantContext, job: MappingJob): Promise<void> {
    const item = { organizationId: ctx.organizationId, jobId: job.id };
    this.values.set(member(item), { item, at: Date.now() });
  }
  async next(): Promise<MappingQueueItem | null> {
    return [...this.values.values()].filter((value) => value.at <= Date.now()).sort((a, b) => a.at - b.at)[0]?.item ?? null;
  }
  async defer(item: MappingQueueItem, delayMs: number): Promise<void> {
    this.values.set(member(item), { item, at: Date.now() + Math.max(100, delayMs) });
  }
  async complete(item: MappingQueueItem): Promise<void> { this.values.delete(member(item)); }
  async close(): Promise<void> {}
}

export function createMappingQueue(redisUrl = process.env.REDIS_URL): MappingQueue {
  return redisUrl ? new RedisMappingQueue(redisUrl) : new MemoryMappingQueue();
}
