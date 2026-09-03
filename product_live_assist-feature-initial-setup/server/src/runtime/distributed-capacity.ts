import { createClient, type RedisClientType } from "redis";
import { AtCapacity, MAX_DEMOS, MAX_MAPPINGS, type Kind } from "../capacity.js";

const TTL_MS = Number(process.env.SESSION_IDLE_MS ?? 15 * 60_000);

const ACQUIRE = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local running = redis.call('ZCARD', KEYS[1])
if redis.call('ZSCORE', KEYS[1], ARGV[4]) then
  redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[5]))
  return -1 * running
end
if running >= tonumber(ARGV[3]) then return running end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[5]))
return -1 * (running + 1)
`;

/**
 * Cluster-wide admission control. Local capacity still owns browser cleanup;
 * this coordinator prevents every replica from independently admitting up to
 * the full fleet limit.
 */
export class DistributedCapacity {
  private readonly client?: RedisClientType;
  private connecting?: Promise<unknown>;

  constructor(url?: string) {
    if (url) {
      this.client = createClient({ url });
      this.client.on("error", (error) => console.warn("[redis-capacity]", error.message));
    }
  }

  private key(kind: Kind): string { return `aidan:capacity:${kind}`; }
  private limit(kind: Kind): number { return kind === "demo" ? MAX_DEMOS : MAX_MAPPINGS; }
  private async ready(): Promise<RedisClientType | null> {
    if (!this.client) return null;
    if (!this.client.isReady) {
      this.connecting ??= this.client.connect();
      await this.connecting;
    }
    return this.client;
  }

  async acquire(kind: Kind, id: string): Promise<void> {
    const client = await this.ready();
    if (!client) return;
    const now = Date.now();
    const limit = this.limit(kind);
    const result = Number(await client.eval(ACQUIRE, {
      keys: [this.key(kind)],
      arguments: [String(now), String(now + TTL_MS), String(limit), id, String(TTL_MS * 2)],
    }));
    if (result >= 0) throw new AtCapacity(kind, result, limit);
  }

  async renew(kind: Kind, id: string): Promise<void> {
    const client = await this.ready();
    if (!client) return;
    await client.zAdd(this.key(kind), [{ score: Date.now() + TTL_MS, value: id }], { XX: true });
  }

  async release(id: string): Promise<void> {
    const client = await this.ready();
    if (!client) return;
    await Promise.all([client.zRem(this.key("demo"), id), client.zRem(this.key("mapping"), id)]);
  }

  async close(): Promise<void> {
    if (this.client?.isOpen) await this.client.quit();
  }
}

export const distributedCapacity = new DistributedCapacity(process.env.REDIS_URL);
