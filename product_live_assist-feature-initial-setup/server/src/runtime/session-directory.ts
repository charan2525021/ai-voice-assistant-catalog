import { hostname } from "node:os";
import { createClient, type RedisClientType } from "redis";
import type { TenantContext } from "../domain/context.js";
import { tenantKey } from "../domain/context.js";

export interface ActiveSessionLocation {
  sessionId: string;
  organizationId: string;
  productId: string;
  catalogVersionId?: string;
  mode: "text" | "voice";
  workerId: string;
  wsUrl?: string;
  browserSessionId?: string;
  status: "starting" | "active" | "ending";
  updatedAt: string;
}

export interface SessionDirectory {
  register(ctx: TenantContext, value: ActiveSessionLocation): Promise<void>;
  locate(ctx: TenantContext, sessionId: string): Promise<ActiveSessionLocation | null>;
  touch(ctx: TenantContext, sessionId: string): Promise<void>;
  remove(ctx: TenantContext, sessionId: string): Promise<void>;
  close(): Promise<void>;
}

export const WORKER_ID = process.env.WORKER_ID ?? `${hostname()}-${process.pid}`;

export class MemorySessionDirectory implements SessionDirectory {
  private values = new Map<string, ActiveSessionLocation>();
  async register(ctx: TenantContext, value: ActiveSessionLocation): Promise<void> {
    if (ctx.organizationId !== value.organizationId) throw new Error("session tenant mismatch");
    this.values.set(tenantKey(ctx, "session", value.sessionId), structuredClone(value));
  }
  async locate(ctx: TenantContext, id: string): Promise<ActiveSessionLocation | null> {
    return structuredClone(this.values.get(tenantKey(ctx, "session", id)) ?? null);
  }
  async touch(ctx: TenantContext, id: string): Promise<void> {
    const value = this.values.get(tenantKey(ctx, "session", id));
    if (value) value.updatedAt = new Date().toISOString();
  }
  async remove(ctx: TenantContext, id: string): Promise<void> { this.values.delete(tenantKey(ctx, "session", id)); }
  async close(): Promise<void> {}
}

export class RedisSessionDirectory implements SessionDirectory {
  private readonly client: RedisClientType;
  private connecting?: Promise<unknown>;
  constructor(url = process.env.REDIS_URL ?? "redis://localhost:6379", private readonly ttlSeconds = 30 * 60) {
    this.client = createClient({ url });
    this.client.on("error", (error) => console.warn("[redis-session]", error.message));
  }
  private async ready() { if (!this.client.isReady) { this.connecting ??= this.client.connect(); await this.connecting; } }
  private key(ctx: TenantContext, id: string) { return `aidan:${tenantKey(ctx, "session", id)}`; }
  async register(ctx: TenantContext, value: ActiveSessionLocation): Promise<void> {
    if (ctx.organizationId !== value.organizationId) throw new Error("session tenant mismatch");
    await this.ready();
    await this.client.set(this.key(ctx, value.sessionId), JSON.stringify(value), { EX: this.ttlSeconds });
  }
  async locate(ctx: TenantContext, id: string): Promise<ActiveSessionLocation | null> {
    await this.ready();
    const raw = await this.client.get(this.key(ctx, id));
    return raw ? JSON.parse(raw) as ActiveSessionLocation : null;
  }
  async touch(ctx: TenantContext, id: string): Promise<void> {
    await this.ready();
    const key = this.key(ctx, id);
    const raw = await this.client.get(key);
    if (!raw) return;
    const value = JSON.parse(raw) as ActiveSessionLocation;
    value.updatedAt = new Date().toISOString();
    await this.client.set(key, JSON.stringify(value), { EX: this.ttlSeconds });
  }
  async remove(ctx: TenantContext, id: string): Promise<void> { await this.ready(); await this.client.del(this.key(ctx, id)); }
  async close(): Promise<void> { if (this.client.isOpen) await this.client.quit(); }
}

export function createSessionDirectory(): SessionDirectory {
  return process.env.REDIS_URL ? new RedisSessionDirectory(process.env.REDIS_URL) : new MemorySessionDirectory();
}
