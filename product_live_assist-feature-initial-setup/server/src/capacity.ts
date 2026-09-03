import { emit } from "./events.js";

/**
 * Admission control for browsers.
 *
 * Every demo session and every mapping run drives a real Chromium — roughly
 * 250-400MB resident once a SPA is loaded. Nothing bounded how many could exist
 * at once, so a handful of concurrent demos (or one enthusiastic load test) would
 * take the host down. Worse, an abandoned session never released anything: the
 * websocket closes, nobody calls DELETE, and the browser lives until restart.
 *
 * Two mechanisms, because they fail differently:
 *  - a **semaphore** caps how many can run at once, and refuses politely at the
 *    limit rather than queueing forever behind a demo nobody is watching;
 *  - a **lease** must be renewed, so a browser whose owner vanished is reclaimed
 *    instead of leaking.
 *
 * Deliberately in-process. Real horizontal scale needs this in Redis
 * (ENTERPRISE_PLAN.md P0-4); the interface is the same either way.
 */

export const MAX_DEMOS = Number(process.env.MAX_CONCURRENT_DEMOS ?? 4);
export const MAX_MAPPINGS = Number(process.env.MAX_CONCURRENT_MAPPINGS ?? 1);
/** A lease not renewed within this window is presumed abandoned. */
const LEASE_TTL_MS = Number(process.env.SESSION_IDLE_MS ?? 15 * 60_000);

export type Kind = "demo" | "mapping";

interface Lease {
  id: string;
  kind: Kind;
  product: string;
  acquiredAt: number;
  renewedAt: number;
  release: () => Promise<void>;
}

const leases = new Map<string, Lease>();

const countOf = (kind: Kind) => [...leases.values()].filter((l) => l.kind === kind).length;
const limitOf = (kind: Kind) => (kind === "demo" ? MAX_DEMOS : MAX_MAPPINGS);

export class AtCapacity extends Error {
  constructor(
    readonly kind: Kind,
    readonly running: number,
    readonly limit: number,
  ) {
    super(
      kind === "demo"
        ? `All ${limit} demo slots are in use right now. A slot frees up as soon as one finishes — try again in a moment.`
        : `Another product is being mapped right now (limit ${limit}). Mapping is resource-heavy, so it runs one at a time.`,
    );
    this.name = "AtCapacity";
  }
}

/**
 * Take a slot, or throw `AtCapacity`.
 *
 * `release` is the caller's own teardown — it is stored rather than called by the
 * caller alone, so the reaper can perform it for an abandoned lease.
 */
export function acquire(kind: Kind, id: string, product: string, release: () => Promise<void>): void {
  const running = countOf(kind);
  const limit = limitOf(kind);
  if (running >= limit) {
    emit("capacity.rejected", { product, status: "error", data: { kind, running, limit } });
    throw new AtCapacity(kind, running, limit);
  }
  const now = Date.now();
  leases.set(id, { id, kind, product, acquiredAt: now, renewedAt: now, release });
  emit("capacity.acquired", { product, status: "ok", data: { kind, running: running + 1, limit } });
}

/** Keep a lease alive. Called on real activity, not on a timer. */
export function renew(id: string): void {
  const l = leases.get(id);
  if (l) l.renewedAt = Date.now();
}

export function release(id: string): void {
  leases.delete(id);
}

export function stats() {
  return {
    demos: { running: countOf("demo"), limit: MAX_DEMOS },
    mappings: { running: countOf("mapping"), limit: MAX_MAPPINGS },
    oldestAgeSec: leases.size ? Math.round((Date.now() - Math.min(...[...leases.values()].map((l) => l.acquiredAt))) / 1000) : 0,
  };
}

/**
 * Reclaim abandoned leases.
 *
 * A prospect who closes the tab mid-demo is the normal case, not the exception —
 * without this, every such visit permanently costs a browser.
 */
setInterval(async () => {
  const now = Date.now();
  for (const l of [...leases.values()]) {
    if (now - l.renewedAt < LEASE_TTL_MS) continue;
    leases.delete(l.id);
    const idleMin = Math.round((now - l.renewedAt) / 60000);
    console.log(`[capacity] reclaiming idle ${l.kind} "${l.id}" (${idleMin}m idle, product ${l.product})`);
    emit("capacity.reclaimed", { product: l.product, status: "ok", data: { kind: l.kind, idleMin } });
    await l.release().catch((e) => console.warn(`[capacity] release failed for ${l.id}: ${e.message}`));
  }
}, 60_000).unref?.();
