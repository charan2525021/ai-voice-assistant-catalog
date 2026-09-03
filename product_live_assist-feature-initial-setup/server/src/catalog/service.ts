import type { TenantContext } from "../domain/context.js";
import type { CatalogRepository, ProductRepository } from "../storage/contracts.js";
import type { ObjectStore } from "./object-store.js";
import type { RuntimeBundleCache } from "./cache.js";
import { compileRuntimeBundle, type RuntimeBundle } from "./runtime-bundle.js";
import { createHash } from "node:crypto";
import { emit } from "../events.js";

export class CatalogService {
  constructor(
    private readonly repository: CatalogRepository,
    private readonly objects: ObjectStore,
    private readonly cache: RuntimeBundleCache,
    private readonly products?: ProductRepository,
  ) {}

  async publish(ctx: TenantContext, catalogVersionId: string): Promise<RuntimeBundle> {
    const snapshot = await this.repository.get(ctx, catalogVersionId);
    if (!snapshot) throw new Error("catalog not found");
    const compiled = compileRuntimeBundle(snapshot);
    const minimumCoverage = Math.max(0, Math.min(1, Number(process.env.PUBLISH_MIN_COVERAGE ?? 0)));
    if (compiled.bundle.coverage.weighted < minimumCoverage) {
      throw new Error(`catalog coverage ${(compiled.bundle.coverage.weighted * 100).toFixed(1)}% is below the ${(minimumCoverage * 100).toFixed(1)}% publish threshold`);
    }
    const criticalImportance = Math.max(1, Number(process.env.PUBLISH_CRITICAL_IMPORTANCE ?? 3));
    const criticalGaps = snapshot.coverage.filter((item) => item.importance >= criticalImportance && item.status !== "verified");
    if (criticalGaps.length) throw new Error(`catalog has ${criticalGaps.length} unresolved critical coverage gap(s)`);
    if (this.products && process.env.PUBLISH_REQUIRE_ALL_ROLES !== "false") {
      const aggregate = await this.products.get(ctx, snapshot.catalog.productId);
      const required = aggregate?.roles.filter((role) => role.environmentId === snapshot.catalog.environmentId) ?? [];
      const verifiedRoles = new Set(snapshot.coverage.filter((item) => {
        if (item.status !== "verified") return false;
        try { return JSON.parse(item.dimensionKey).branch === "happy_path"; } catch { return false; }
      }).map((item) => item.roleProfileId));
      const missing = required.filter((role) => !verifiedRoles.has(role.id));
      if (missing.length) throw new Error(`catalog is missing verified journeys for role(s): ${missing.map((role) => role.name).join(", ")}`);
    }
    const key = `catalogs/${ctx.organizationId}/${catalogVersionId}/${compiled.checksum}.json`;
    await this.objects.put(key, compiled.json);
    await this.repository.publish(ctx, catalogVersionId, { key, checksum: compiled.checksum });
    // Publication is durable once the transaction above commits. A cache
    // outage must not turn a successful publish into a misleading API failure.
    await Promise.all([
      this.cache.set(ctx, compiled.bundle),
      this.cache.setActive(ctx, compiled.bundle.productId, compiled.bundle),
    ]).catch((error) => {
      console.warn("[catalog] published but cache warm failed", (error as Error).message);
    });
    emit("map.publish", { product: compiled.bundle.productId, status: "ok", data: {
      catalogVersionId: compiled.bundle.catalogVersionId,
      flowsPublished: compiled.bundle.journeys.map((journey) => journey.name),
      flowCount: compiled.bundle.journeys.length,
      executablePrograms: compiled.bundle.journeys.filter((journey) => journey.workflow.steps.length > 0).length,
      coverage: compiled.bundle.coverage,
    } });
    return compiled.bundle;
  }

  async activeBundle(ctx: TenantContext, productId: string): Promise<RuntimeBundle | null> {
    // This is the normal per-turn path: worker memory first, Redis second. No
    // relational query or graph traversal occurs while the customer is waiting.
    const active = await this.cache.getActive(ctx, productId).catch((error) => {
      console.warn("[catalog] active cache read failed", (error as Error).message);
      return null;
    });
    if (active) {
      if (active.organizationId !== ctx.organizationId || active.productId !== productId) {
        throw new Error("active catalog cache ownership mismatch");
      }
      return active;
    }
    const snapshot = await this.repository.getActive(ctx, productId);
    if (!snapshot) return null;
    const bundle = await this.bundle(ctx, snapshot.catalog.id);
    if (!bundle) return null;
    await this.cache.setActive(ctx, productId, bundle).catch(() => {});
    return bundle;
  }

  /** Load one immutable version; active sessions remain pinned across publishes. */
  async bundle(ctx: TenantContext, catalogVersionId: string): Promise<RuntimeBundle | null> {
    const cached = await this.cache.get(ctx, catalogVersionId).catch(() => null);
    if (cached) return cached;
    const snapshot = await this.repository.get(ctx, catalogVersionId);
    if (!snapshot || !["published", "retired"].includes(snapshot.catalog.status)) return null;
    let bundle: RuntimeBundle;
    if (snapshot.catalog.bundleKey && snapshot.catalog.bundleChecksum) {
      const bytes = await this.objects.get(snapshot.catalog.bundleKey);
      if (!bytes) throw new Error("published catalog artifact is missing");
      const checksum = createHash("sha256").update(bytes).digest("hex");
      if (checksum !== snapshot.catalog.bundleChecksum) throw new Error("published catalog artifact checksum mismatch");
      bundle = JSON.parse(Buffer.from(bytes).toString("utf8")) as RuntimeBundle;
      if (bundle.organizationId !== ctx.organizationId || bundle.productId !== snapshot.catalog.productId || bundle.catalogVersionId !== snapshot.catalog.id) {
        throw new Error("published catalog artifact ownership mismatch");
      }
    } else {
      // Compatibility for catalogs published before artifact metadata existed.
      bundle = compileRuntimeBundle(snapshot).bundle;
    }
    await this.cache.set(ctx, bundle).catch((error) => {
      console.warn("[catalog] cache warm failed", (error as Error).message);
    });
    return bundle;
  }
}
