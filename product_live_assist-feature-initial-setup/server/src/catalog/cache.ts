import { createClient, type RedisClientType } from "redis";
import type { TenantContext } from "../domain/context.js";
import { tenantKey } from "../domain/context.js";
import type { RuntimeBundle } from "./runtime-bundle.js";

export interface RuntimeBundleCache {
  get(ctx: TenantContext, catalogVersionId: string): Promise<RuntimeBundle | null>;
  set(ctx: TenantContext, bundle: RuntimeBundle): Promise<void>;
  delete(ctx: TenantContext, catalogVersionId: string): Promise<void>;
  getActive(ctx: TenantContext, productId: string): Promise<RuntimeBundle | null>;
  setActive(ctx: TenantContext, productId: string, bundle: RuntimeBundle): Promise<void>;
}

export class MemoryBundleCache implements RuntimeBundleCache {
  private values = new Map<string, { bundle: RuntimeBundle; touched: number }>();
  constructor(private readonly maximum = 100) {}
  async get(ctx: TenantContext, id: string): Promise<RuntimeBundle | null> {
    const key = tenantKey(ctx, "catalog", id);
    const hit = this.values.get(key);
    if (!hit) return null;
    hit.touched = Date.now();
    return hit.bundle;
  }
  async set(ctx: TenantContext, bundle: RuntimeBundle): Promise<void> {
    const key = tenantKey(ctx, "catalog", bundle.catalogVersionId);
    this.values.set(key, { bundle, touched: Date.now() });
    if (this.values.size > this.maximum) {
      const oldest = [...this.values.entries()].sort((a, b) => a[1].touched - b[1].touched)[0]?.[0];
      if (oldest) this.values.delete(oldest);
    }
  }
  async delete(ctx: TenantContext, id: string): Promise<void> { this.values.delete(tenantKey(ctx, "catalog", id)); }
  async getActive(ctx: TenantContext, productId: string): Promise<RuntimeBundle | null> {
    const hit = this.values.get(tenantKey(ctx, "active-catalog", productId));
    if (!hit) return null;
    hit.touched = Date.now();
    return hit.bundle;
  }
  async setActive(ctx: TenantContext, productId: string, bundle: RuntimeBundle): Promise<void> {
    this.values.set(tenantKey(ctx, "active-catalog", productId), { bundle, touched: Date.now() });
    if (this.values.size > this.maximum * 2) {
      const oldest = [...this.values.entries()].sort((a, b) => a[1].touched - b[1].touched)[0]?.[0];
      if (oldest) this.values.delete(oldest);
    }
  }
}

export class RedisBundleCache implements RuntimeBundleCache {
  private readonly client: RedisClientType;
  private connecting?: Promise<unknown>;
  constructor(url = process.env.REDIS_URL ?? "redis://localhost:6379", private readonly ttlSeconds = 3600) {
    this.client = createClient({ url });
    this.client.on("error", (error) => console.warn("[redis]", error.message));
  }
  private async ready(): Promise<void> {
    if (this.client.isReady) return;
    this.connecting ??= this.client.connect();
    await this.connecting;
  }
  private key(ctx: TenantContext, id: string) { return `aidan:${tenantKey(ctx, "catalog", id)}`; }
  async get(ctx: TenantContext, id: string): Promise<RuntimeBundle | null> {
    await this.ready();
    const raw = await this.client.get(this.key(ctx, id));
    return raw ? JSON.parse(raw) as RuntimeBundle : null;
  }
  async set(ctx: TenantContext, bundle: RuntimeBundle): Promise<void> {
    await this.ready();
    await this.client.set(this.key(ctx, bundle.catalogVersionId), JSON.stringify(bundle), { EX: this.ttlSeconds });
  }
  async delete(ctx: TenantContext, id: string): Promise<void> { await this.ready(); await this.client.del(this.key(ctx, id)); }
  async getActive(ctx: TenantContext, productId: string): Promise<RuntimeBundle | null> {
    await this.ready();
    const raw = await this.client.get(`aidan:${tenantKey(ctx, "active-catalog", productId)}`);
    return raw ? JSON.parse(raw) as RuntimeBundle : null;
  }
  async setActive(ctx: TenantContext, productId: string, bundle: RuntimeBundle): Promise<void> {
    await this.ready();
    await this.client.set(`aidan:${tenantKey(ctx, "active-catalog", productId)}`, JSON.stringify(bundle), { EX: this.ttlSeconds });
  }
  async close(): Promise<void> { if (this.client.isOpen) await this.client.quit(); }
}

/** Worker memory first, Redis second; immutable version keys avoid stale reads. */
export class LayeredBundleCache implements RuntimeBundleCache {
  constructor(private readonly local: RuntimeBundleCache, private readonly shared: RuntimeBundleCache) {}
  async get(ctx: TenantContext, id: string): Promise<RuntimeBundle | null> {
    const local = await this.local.get(ctx, id);
    if (local) return local;
    const shared = await this.shared.get(ctx, id);
    if (shared) await this.local.set(ctx, shared);
    return shared;
  }
  async set(ctx: TenantContext, bundle: RuntimeBundle): Promise<void> {
    await this.local.set(ctx, bundle);
    await this.shared.set(ctx, bundle);
  }
  async delete(ctx: TenantContext, id: string): Promise<void> { await Promise.all([this.local.delete(ctx, id), this.shared.delete(ctx, id)]); }
  async getActive(ctx: TenantContext, productId: string): Promise<RuntimeBundle | null> {
    // Active pointers are mutable even though bundle versions are immutable.
    // Ask the shared authority first so a worker cannot serve an old catalog
    // forever after another replica publishes a new version.
    const shared = await this.shared.getActive(ctx, productId).catch(() => null);
    if (shared) {
      await this.local.setActive(ctx, productId, shared);
      return shared;
    }
    return this.local.getActive(ctx, productId);
  }
  async setActive(ctx: TenantContext, productId: string, bundle: RuntimeBundle): Promise<void> {
    await this.local.setActive(ctx, productId, bundle);
    await this.shared.setActive(ctx, productId, bundle);
  }
}
