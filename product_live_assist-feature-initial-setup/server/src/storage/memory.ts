import { createHash, randomUUID } from "node:crypto";
import type { TenantContext } from "../domain/context.js";
import type { CatalogVersion, CoverageItem, CredentialRef, EmbedGrant, JourneyVersion, Product, ProductEnvironment, RoleProfile, SalesPlay } from "../domain/catalog.js";
import type { CustomerSession, FeedbackSignal, JourneyCorrection, MappingJob, TrainingEvent } from "../domain/runtime.js";
import type { CatalogRepository, CatalogSnapshot, KnowledgeDocumentInput, MappedCatalogInput, MappingJobRepository, NewProduct, PlanningKnowledgeChunk, PlatformRepositories, ProductAggregate, ProductRepository, SessionRepository } from "./contracts.js";
import { durableJourneyApproved, durableJourneyChecksum } from "../catalog/review-policy.js";

const copy = <T>(value: T): T => structuredClone(value);
const now = () => new Date().toISOString();
const scoped = (organizationId: string, id: string) => `${organizationId}:${id}`;

/** Test/development implementation with the same tenant semantics as PostgreSQL. */
export class InMemoryPlatformRepository {
  private products = new Map<string, ProductAggregate>();
  private catalogs = new Map<string, CatalogSnapshot>();
  private sessions = new Map<string, CustomerSession>();
  private jobs = new Map<string, MappingJob>();
  private jobLeases = new Map<string, { owner: string; expiresAt: number }>();
  private jobArtifacts = new Map<string, { value: unknown; checksum: string }>();
  private credentials = new Map<string, CredentialRef>();
  private embedGrants = new Map<string, EmbedGrant>();
  private feedbackSignals = new Map<string, FeedbackSignal>();
  private trainingEvents = new Map<string, TrainingEvent>();
  private corrections = new Map<string, JourneyCorrection>();
  private planningKnowledge = new Map<string, PlanningKnowledgeChunk[]>();

  async list(ctx: TenantContext): Promise<ProductAggregate[]> {
    return [...this.products.values()].filter((value) => value.product.organizationId === ctx.organizationId).map(copy);
  }

  async getAny(ctx: TenantContext, id: string): Promise<CatalogSnapshot | CustomerSession | MappingJob | ProductAggregate | null> {
    const key = scoped(ctx.organizationId, id);
    return copy(this.products.get(key) ?? this.catalogs.get(key) ?? this.sessions.get(key) ?? this.jobs.get(key) ?? null);
  }

  async createProduct(ctx: TenantContext, input: NewProduct): Promise<ProductAggregate> {
    const timestamp = now();
    const product: Product = {
      id: randomUUID(), organizationId: ctx.organizationId, key: input.key, name: input.name,
      createdAt: timestamp, updatedAt: timestamp,
    };
    const environment: ProductEnvironment = {
      id: randomUUID(), organizationId: ctx.organizationId, productId: product.id,
      key: input.environment.key, name: input.environment.name, startUrl: input.environment.startUrl,
      productVersion: input.environment.productVersion, locale: input.environment.locale ?? "en-US",
      featureFlags: input.environment.featureFlags ?? {}, createdAt: timestamp, updatedAt: timestamp,
    };
    const role: RoleProfile = {
      id: randomUUID(), organizationId: ctx.organizationId, environmentId: environment.id,
      key: "default", name: "Default role", permissionHints: [], createdAt: timestamp, updatedAt: timestamp,
    };
    const value = { product, environments: [environment], roles: [role] };
    this.products.set(scoped(ctx.organizationId, product.id), copy(value));
    return copy(value);
  }

  /** Mirrors the SQL cascade: the product, then everything versioned under it. */
  async removeProduct(ctx: TenantContext, productId: string): Promise<boolean> {
    const key = scoped(ctx.organizationId, productId);
    const existing = this.products.get(key);
    if (!existing) return false;
    this.products.delete(key);
    const environmentIds = new Set(existing.environments.map((e) => e.id));
    for (const [id, catalog] of this.catalogs) {
      if (catalog.catalog.productId === productId) this.catalogs.delete(id);
    }
    for (const [id, session] of this.sessions) {
      if (session.productId === productId || environmentIds.has(session.environmentId)) this.sessions.delete(id);
    }
    for (const [id, job] of this.jobs) {
      if (job.productId === productId) this.jobs.delete(id);
    }
    return true;
  }

  async createDraft(ctx: TenantContext, productId: string, environmentId: string): Promise<CatalogVersion> {
    const product = this.products.get(scoped(ctx.organizationId, productId));
    if (!product?.environments.some((environment) => environment.id === environmentId)) throw new Error("product environment not found");
    const existing = [...this.catalogs.values()].filter((value) => value.catalog.organizationId === ctx.organizationId && value.catalog.productId === productId);
    const timestamp = now();
    const catalog: CatalogVersion = {
      id: randomUUID(), organizationId: ctx.organizationId, productId, environmentId,
      version: Math.max(0, ...existing.map((value) => value.catalog.version)) + 1,
      status: "draft", schemaVersion: 1, createdAt: timestamp, updatedAt: timestamp,
    };
    const source = product.product.activeCatalogVersionId
      ? this.catalogs.get(scoped(ctx.organizationId, product.product.activeCatalogVersionId))
      : undefined;
    if (!source || source.catalog.environmentId !== environmentId) {
      this.catalogs.set(scoped(ctx.organizationId, catalog.id), { catalog, journeys: [], salesPlays: [], coverage: [], screens: [], transitions: [] });
      return copy(catalog);
    }
    const capabilityIds = new Map<string, string>();
    const customerJobIds = new Map<string, string>();
    const capabilityId = (old: string) => {
      const value = capabilityIds.get(old) ?? randomUUID();
      capabilityIds.set(old, value);
      return value;
    };
    const customerJobId = (old: string) => {
      const value = customerJobIds.get(old) ?? randomUUID();
      customerJobIds.set(old, value);
      return value;
    };
    const journeys = source.journeys.map((journey): JourneyVersion => ({
      ...copy(journey), id: randomUUID(), catalogVersionId: catalog.id,
      capabilityId: capabilityId(journey.capabilityId), customerJobId: customerJobId(journey.customerJobId),
      createdAt: timestamp, updatedAt: timestamp,
    }));
    const coverage = source.coverage.map((item): CoverageItem => ({
      ...copy(item), id: randomUUID(), catalogVersionId: catalog.id,
      customerJobId: customerJobId(item.customerJobId), createdAt: timestamp, updatedAt: timestamp,
    }));
    const salesPlays = source.salesPlays.filter((play) => play.approvalStatus === "approved").map((play): SalesPlay => ({
      ...copy(play), id: randomUUID(), catalogVersionId: catalog.id,
      capabilityIds: play.capabilityIds.map(capabilityId), createdAt: timestamp, updatedAt: timestamp,
    }));
    this.catalogs.set(scoped(ctx.organizationId, catalog.id), {
      catalog, journeys, salesPlays, coverage, screens: copy(source.screens), transitions: copy(source.transitions),
    });
    return copy(catalog);
  }

  async getOpenDraft(ctx: TenantContext, productId: string, environmentId: string): Promise<CatalogVersion | null> {
    const open = [...this.catalogs.values()]
      .map((value) => value.catalog)
      .filter((catalog) => catalog.organizationId === ctx.organizationId && catalog.productId === productId &&
        catalog.environmentId === environmentId && ["draft", "mapping", "verifying", "review"].includes(catalog.status))
      .sort((a, b) => b.version - a.version)[0];
    return copy(open ?? null);
  }

  async getActive(ctx: TenantContext, productId: string): Promise<CatalogSnapshot | null> {
    const product = this.products.get(scoped(ctx.organizationId, productId));
    if (!product?.product.activeCatalogVersionId) return null;
    return copy(this.catalogs.get(scoped(ctx.organizationId, product.product.activeCatalogVersionId)) ?? null);
  }

  async publish(ctx: TenantContext, catalogVersionId: string, bundle: { key: string; checksum: string }): Promise<CatalogVersion> {
    const snapshot = this.catalogs.get(scoped(ctx.organizationId, catalogVersionId));
    if (!snapshot) throw new Error("catalog not found");
    if (!snapshot.journeys.length) throw new Error("catalog has no verified journeys");
    if (snapshot.journeys.some((journey) => journey.verificationStatus !== "verified")) {
      throw new Error("catalog contains journeys that are not verified");
    }
    if (snapshot.journeys.some((journey) => !durableJourneyApproved(journey))) {
      throw new Error("catalog contains journeys awaiting human approval or changed after approval");
    }
    for (const other of this.catalogs.values()) {
      if (other.catalog.organizationId === ctx.organizationId && other.catalog.productId === snapshot.catalog.productId && other.catalog.status === "published") {
        other.catalog.status = "retired";
        other.catalog.updatedAt = now();
      }
    }
    snapshot.catalog = {
      ...snapshot.catalog, status: "published", bundleKey: bundle.key, bundleChecksum: bundle.checksum,
      publishedAt: now(), updatedAt: now(),
    };
    const product = this.products.get(scoped(ctx.organizationId, snapshot.catalog.productId));
    if (!product) throw new Error("product not found");
    product.product.activeCatalogVersionId = catalogVersionId;
    product.product.updatedAt = now();
    return copy(snapshot.catalog);
  }

  async saveJourney(ctx: TenantContext, value: JourneyVersion): Promise<void> {
    const snapshot = this.catalogs.get(scoped(ctx.organizationId, value.catalogVersionId));
    if (!snapshot) throw new Error("catalog not found");
    if (["published", "retired"].includes(snapshot.catalog.status)) throw new Error("catalog is immutable");
    const index = snapshot.journeys.findIndex((item) => item.id === value.id || item.journeyKey === value.journeyKey);
    if (index < 0) snapshot.journeys.push(copy(value)); else snapshot.journeys[index] = copy(value);
  }

  async reviewJourney(ctx: TenantContext, journeyVersionId: string, input: { decision: "approved" | "rejected" | "rework_requested"; comment?: string; instruction?: string }): Promise<JourneyVersion> {
    for (const snapshot of this.catalogs.values()) {
      if (snapshot.catalog.organizationId !== ctx.organizationId || ["published", "retired"].includes(snapshot.catalog.status)) continue;
      const journey = snapshot.journeys.find((item) => item.id === journeyVersionId);
      if (!journey) continue;
      if (input.decision === "approved" && journey.verificationStatus !== "verified") throw new Error("journey must be machine-verified before approval");
      const checksum = journey.revisionChecksum ?? durableJourneyChecksum(journey);
      journey.revision ??= 1;
      journey.revisionChecksum = checksum;
      journey.approvalStatus = input.decision;
      journey.approvedChecksum = input.decision === "approved" ? checksum : undefined;
      journey.reviewedBy = ctx.actorId;
      journey.reviewedAt = now();
      journey.reviewComment = input.comment;
      journey.updatedAt = now();
      return copy(journey);
    }
    throw new Error("journey not found or immutable");
  }

  async saveSalesPlay(ctx: TenantContext, value: SalesPlay): Promise<void> {
    const snapshot = this.catalogs.get(scoped(ctx.organizationId, value.catalogVersionId));
    if (!snapshot) throw new Error("catalog not found");
    if (["published", "retired"].includes(snapshot.catalog.status)) throw new Error("catalog is immutable");
    const index = snapshot.salesPlays.findIndex((item) => item.id === value.id);
    if (index < 0) snapshot.salesPlays.push(copy(value)); else snapshot.salesPlays[index] = copy(value);
  }

  async getSalesPlay(ctx: TenantContext, id: string): Promise<SalesPlay | null> {
    for (const snapshot of this.catalogs.values()) {
      if (snapshot.catalog.organizationId !== ctx.organizationId) continue;
      const play = snapshot.salesPlays.find((item) => item.id === id);
      if (play) return copy(play);
    }
    return null;
  }

  async replaceCoverage(ctx: TenantContext, catalogVersionId: string, values: CoverageItem[]): Promise<void> {
    const snapshot = this.catalogs.get(scoped(ctx.organizationId, catalogVersionId));
    if (!snapshot) throw new Error("catalog not found");
    if (["published", "retired"].includes(snapshot.catalog.status)) throw new Error("catalog is immutable");
    snapshot.coverage = copy(values);
  }

  async replaceMappedCatalog(ctx: TenantContext, catalogVersionId: string, roleProfileId: string, value: MappedCatalogInput): Promise<void> {
    const snapshot = this.catalogs.get(scoped(ctx.organizationId, catalogVersionId));
    if (!snapshot) throw new Error("catalog not found");
    if (["published", "retired"].includes(snapshot.catalog.status)) throw new Error("catalog is immutable");
    const timestamp = now();
    const previousForRole = new Map(snapshot.journeys
      .filter((journey) => journey.roleProfileIds.includes(roleProfileId))
      .map((journey) => [journey.journeyKey, journey]));
    const retainedJourneys = snapshot.journeys.filter((journey) => !journey.roleProfileIds.includes(roleProfileId));
    const retainedCoverage = snapshot.coverage.filter((item) => item.roleProfileId !== roleProfileId);
    const retainedScreens = snapshot.screens.filter((screen) => screen.roleProfileId !== roleProfileId);
    const retainedTransitions = snapshot.transitions.filter((transition) => transition.roleProfileId !== roleProfileId);
    const mappedScreens = value.screens.map((screen) => ({
      key: screen.key, name: screen.name, url: screen.url, purpose: screen.purpose,
      fingerprint: screen.fingerprint, roleProfileId, controls: copy(screen.controls),
    }));
    const fingerprints = new Map(value.screens.map((screen) => [screen.key, screen.fingerprint]));
    const mappedTransitions = (value.transitions ?? []).map((transition) => ({
      fromScreenKey: transition.fromScreenKey, fromFingerprint: fingerprints.get(transition.fromScreenKey) ?? "",
      toScreenKey: transition.toScreenKey, toFingerprint: transition.toScreenKey ? fingerprints.get(transition.toScreenKey) : undefined,
      roleProfileId, controlKey: transition.controlKey, action: copy(transition.action), reliability: transition.reliability,
    }));
    const mappedJourneys = value.journeys.map((journey) => {
      const checksum = durableJourneyChecksum({ workflow: journey.workflow, evidence: journey.evidence });
      const previous = previousForRole.get(journey.key);
      const approvalCurrent = previous?.approvalStatus === "approved" && previous.approvedChecksum === checksum;
      return ({
      id: randomUUID(), organizationId: ctx.organizationId, catalogVersionId,
      journeyKey: journey.key, capabilityId: randomUUID(), customerJobId: randomUUID(),
      roleProfileIds: [roleProfileId], workflow: copy(journey.workflow), verificationStatus: "verified" as const,
      reliability: journey.reliability, evidence: copy(journey.evidence),
      revision: previous ? Number(previous.revision ?? 1) + (previous.revisionChecksum === checksum ? 0 : 1) : 1,
      revisionChecksum: checksum,
      approvalStatus: approvalCurrent ? "approved" as const : "pending" as const,
      approvedChecksum: approvalCurrent ? checksum : undefined,
      reviewedBy: approvalCurrent ? previous?.reviewedBy : undefined,
      reviewedAt: approvalCurrent ? previous?.reviewedAt : undefined,
      reviewComment: approvalCurrent ? previous?.reviewComment : undefined,
      verifiedAt: journey.verifiedAt ?? timestamp, createdAt: timestamp, updatedAt: timestamp,
    }); });
    const coverageBranches = ["happy_path", "validation", "permission", "empty_state", "error"] as const;
    const mappedCoverage = mappedJourneys.flatMap((journey, index) =>
      coverageBranches.map((branch): CoverageItem => {
        const happy = branch === "happy_path";
        const observed = happy ? undefined : value.journeys[index].coverage?.[branch];
        return {
          id: randomUUID(), organizationId: ctx.organizationId, catalogVersionId, roleProfileId,
          customerJobId: journey.customerJobId, dimensionKey: JSON.stringify({ state: "default", branch, locale: "default" }),
          depth: happy ? value.journeys[index].depth : (observed?.depth ?? 0), status: happy ? "verified" : (observed?.status ?? "blocked"),
          importance: happy ? 5 : 1, detail: happy ? "replayed successfully" : "not yet mapped",
          lastCheckedAt: happy ? timestamp : observed?.checkedAt,
          ...(happy ? {} : { detail: observed?.detail ?? "mapper did not return branch evidence" }),
          createdAt: timestamp, updatedAt: timestamp,
        };
      }),
    );
    snapshot.journeys = [...retainedJourneys, ...mappedJourneys];
    snapshot.coverage = [...retainedCoverage, ...mappedCoverage];
    snapshot.screens = [...retainedScreens, ...mappedScreens];
    snapshot.transitions = [...retainedTransitions, ...mappedTransitions];
    snapshot.catalog.status = "review";
    snapshot.catalog.updatedAt = timestamp;
  }

  async enqueue(ctx: TenantContext, value: MappingJob): Promise<void> {
    if (value.organizationId !== ctx.organizationId) throw new Error("resource not found in this organization");
    this.jobs.set(scoped(ctx.organizationId, value.id), copy(value));
  }

  async claim(ctx: TenantContext, id: string, workerId: string, leaseSeconds: number): Promise<MappingJob | null> {
    const key = scoped(ctx.organizationId, id);
    const job = this.jobs.get(key);
    if (!job) return null;
    const lease = this.jobLeases.get(key);
    const reclaimable = job.status === "running" && (!lease || lease.owner === workerId || lease.expiresAt <= Date.now());
    if (job.status !== "queued" && !reclaimable) return null;
    const claimed = { ...job, status: "running" as const, attempts: job.attempts + 1, updatedAt: now() };
    this.jobs.set(key, copy(claimed));
    this.jobLeases.set(key, { owner: workerId, expiresAt: Date.now() + leaseSeconds * 1000 });
    return copy(claimed);
  }

  async checkpoint(ctx: TenantContext, value: MappingJob, lease?: { owner: string; seconds: number }): Promise<void> {
    const key = scoped(ctx.organizationId, value.id);
    if (!this.jobs.has(key)) throw new Error("mapping job not found");
    const currentLease = this.jobLeases.get(key);
    if (lease && (!currentLease || currentLease.owner !== lease.owner)) throw new Error("mapping job lease was lost");
    this.jobs.set(key, copy(value));
    if (value.status === "running" && lease) {
      this.jobLeases.set(key, { owner: lease.owner, expiresAt: Date.now() + lease.seconds * 1000 });
    } else if (value.status !== "running") {
      this.jobLeases.delete(key);
    }
  }

  async controlJob(ctx: TenantContext, id: string, action: "pause" | "resume" | "cancel"): Promise<MappingJob> {
    const key = scoped(ctx.organizationId, id);
    const job = this.jobs.get(key);
    if (!job) throw new Error("mapping job not found");
    if (action === "pause") {
      if (!["queued", "running"].includes(job.status)) throw new Error(`cannot pause a ${job.status} job`);
      job.status = "waiting_for_human";
    } else if (action === "resume") {
      if (job.status !== "waiting_for_human") throw new Error(`cannot resume a ${job.status} job`);
      job.status = "queued";
    } else {
      if (["completed", "failed", "cancelled"].includes(job.status)) throw new Error(`cannot cancel a ${job.status} job`);
      job.status = "cancelled";
    }
    job.cursor = { ...job.cursor, control: { action, actorId: ctx.actorId, at: now() } };
    job.updatedAt = now();
    this.jobLeases.delete(key);
    return copy(job);
  }

  async appendTraining(ctx: TenantContext, value: TrainingEvent): Promise<void> {
    if (value.organizationId !== ctx.organizationId) throw new Error("resource not found in this organization");
    this.trainingEvents.set(scoped(ctx.organizationId, value.id), copy(value));
  }

  async listTraining(ctx: TenantContext, productId: string, limit = 500): Promise<TrainingEvent[]> {
    return [...this.trainingEvents.values()]
      .filter((value) => value.organizationId === ctx.organizationId && value.productId === productId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(1, Math.min(2000, limit))).map(copy);
  }

  async saveCorrection(ctx: TenantContext, value: JourneyCorrection): Promise<void> {
    if (value.organizationId !== ctx.organizationId) throw new Error("resource not found in this organization");
    this.corrections.set(scoped(ctx.organizationId, value.id), copy(value));
  }

  async listCorrections(ctx: TenantContext, productId: string): Promise<JourneyCorrection[]> {
    return [...this.corrections.values()]
      .filter((value) => value.organizationId === ctx.organizationId && value.productId === productId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(copy);
  }

  async saveArtifact(ctx: TenantContext, jobId: string, key: string, value: unknown): Promise<{ checksum: string }> {
    if (!this.jobs.has(scoped(ctx.organizationId, jobId))) throw new Error("mapping job not found");
    const checksum = createHash("sha256").update(JSON.stringify(value)).digest("hex");
    this.jobArtifacts.set(scoped(ctx.organizationId, `${jobId}:${key}`), { value: copy(value), checksum });
    return { checksum };
  }

  async getArtifact<T>(ctx: TenantContext, jobId: string, key: string): Promise<T | null> {
    return copy((this.jobArtifacts.get(scoped(ctx.organizationId, `${jobId}:${key}`))?.value as T | undefined) ?? null);
  }

  async update(ctx: TenantContext, value: CustomerSession): Promise<void> {
    const key = scoped(ctx.organizationId, value.id);
    if (!this.sessions.has(key)) throw new Error("session not found");
    this.sessions.set(key, copy(value));
  }

  async claimRecovery(ctx: TenantContext, id: string, workerId: string, leaseSeconds: number): Promise<CustomerSession | null> {
    const key = scoped(ctx.organizationId, id);
    const value = this.sessions.get(key);
    if (!value || value.status !== "active") return null;
    const lease = value.recoveryLeaseExpiresAt ? Date.parse(value.recoveryLeaseExpiresAt) : 0;
    if (value.workerId && value.workerId !== workerId && lease > Date.now()) return null;
    value.workerId = workerId;
    value.recoveryLeaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    value.updatedAt = now();
    return copy(value);
  }

  async saveCredentialRef(ctx: TenantContext, value: CredentialRef): Promise<void> {
    if (value.organizationId !== ctx.organizationId) throw new Error("resource not found in this organization");
    this.credentials.set(scoped(ctx.organizationId, value.id), copy(value));
  }
  async getCredentialRef(ctx: TenantContext, id: string): Promise<CredentialRef | null> {
    return copy(this.credentials.get(scoped(ctx.organizationId, id)) ?? null);
  }
  async saveRoleProfile(ctx: TenantContext, value: RoleProfile): Promise<void> {
    const aggregate = [...this.products.values()].find((product) =>
      product.product.organizationId === ctx.organizationId && product.environments.some((environment) => environment.id === value.environmentId));
    if (!aggregate) throw new Error("environment not found");
    const index = aggregate.roles.findIndex((role) => role.id === value.id || role.key === value.key);
    if (index < 0) aggregate.roles.push(copy(value)); else aggregate.roles[index] = copy(value);
  }
  async listRoleProfiles(ctx: TenantContext, environmentId: string): Promise<RoleProfile[]> {
    const aggregate = [...this.products.values()].find((product) =>
      product.product.organizationId === ctx.organizationId && product.environments.some((environment) => environment.id === environmentId));
    return copy(aggregate?.roles ?? []);
  }
  async saveEmbedGrant(ctx: TenantContext, value: EmbedGrant): Promise<void> {
    if (value.organizationId !== ctx.organizationId) throw new Error("resource not found in this organization");
    this.embedGrants.set(scoped(ctx.organizationId, value.id), copy(value));
  }
  async getEmbedGrant(ctx: TenantContext, id: string): Promise<EmbedGrant | null> {
    return copy(this.embedGrants.get(scoped(ctx.organizationId, id)) ?? null);
  }
  async revokeEmbedGrant(ctx: TenantContext, id: string): Promise<void> {
    const grant = this.embedGrants.get(scoped(ctx.organizationId, id));
    if (!grant) throw new Error("embed grant not found");
    grant.revokedAt = now(); grant.updatedAt = now();
  }

  async createSession(ctx: TenantContext, value: CustomerSession): Promise<void> {
    if (value.organizationId !== ctx.organizationId) throw new Error("resource not found in this organization");
    this.sessions.set(scoped(ctx.organizationId, value.id), copy(value));
  }

  async saveFeedback(ctx: TenantContext, value: FeedbackSignal): Promise<void> {
    if (value.organizationId !== ctx.organizationId) throw new Error("resource not found in this organization");
    this.feedbackSignals.set(scoped(ctx.organizationId, value.id), copy(value));
  }

  async listFeedback(ctx: TenantContext, productId: string, limit = 100): Promise<FeedbackSignal[]> {
    return [...this.feedbackSignals.values()]
      .filter((value) => value.organizationId === ctx.organizationId && value.productId === productId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(1, Math.min(1000, limit)))
      .map(copy);
  }

  async ingestKnowledge(ctx: TenantContext, input: KnowledgeDocumentInput) {
    const product = this.products.get(scoped(ctx.organizationId, input.productId));
    if (!product) throw new Error("product not found");
    const key = scoped(ctx.organizationId, input.productId);
    const retained = (this.planningKnowledge.get(key) ?? []).filter((chunk) => chunk.source !== input.uri);
    const rows: PlanningKnowledgeChunk[] = input.chunks.map((chunk, index) => ({
      id: `${input.externalKey}:${index}`, title: chunk.title, section: chunk.section,
      content: chunk.content, source: input.uri, trust: input.trust, metadata: chunk.metadata,
    }));
    this.planningKnowledge.set(key, [...retained, ...rows]);
    return { documentId: input.externalKey, versionId: input.contentHash, chunks: rows.length, chunkIds: rows.map((row) => row.id) };
  }

  async listPlanningKnowledge(ctx: TenantContext, productId: string, limit = 10000): Promise<PlanningKnowledgeChunk[]> {
    return copy((this.planningKnowledge.get(scoped(ctx.organizationId, productId)) ?? []).slice(0, Math.max(1, limit)));
  }
}

// TypeScript cannot express two repository interfaces that both name get/create
// with different values on one object. Expose small typed façades for consumers.
export function memoryRepositories(store = new InMemoryPlatformRepository()): PlatformRepositories {
  return {
    products: {
      list: (ctx) => store.list(ctx),
      get: (ctx, id) => store.getAny(ctx, id) as Promise<ProductAggregate | null>,
      create: (ctx, input) => store.createProduct(ctx, input),
      remove: (ctx, id) => store.removeProduct(ctx, id),
    },
    catalogs: {
      createDraft: (ctx, productId, environmentId) => store.createDraft(ctx, productId, environmentId),
      getOpenDraft: (ctx, productId, environmentId) => store.getOpenDraft(ctx, productId, environmentId),
      get: (ctx, id) => store.getAny(ctx, id) as Promise<CatalogSnapshot | null>,
      getActive: (ctx, productId) => store.getActive(ctx, productId),
      publish: (ctx, id, bundle) => store.publish(ctx, id, bundle),
      getSalesPlay: (ctx, id) => store.getSalesPlay(ctx, id),
      saveJourney: (ctx, value) => store.saveJourney(ctx, value),
      reviewJourney: (ctx, id, input) => store.reviewJourney(ctx, id, input),
      saveSalesPlay: (ctx, value) => store.saveSalesPlay(ctx, value),
      replaceCoverage: (ctx, id, values) => store.replaceCoverage(ctx, id, values),
      replaceMappedCatalog: (ctx, id, roleId, value) => store.replaceMappedCatalog(ctx, id, roleId, value),
    },
    sessions: {
      create: (ctx, value) => store.createSession(ctx, value),
      get: (ctx, id) => store.getAny(ctx, id) as Promise<CustomerSession | null>,
      update: (ctx, value) => store.update(ctx, value),
      claimRecovery: (ctx, id, workerId, leaseSeconds) => store.claimRecovery(ctx, id, workerId, leaseSeconds),
    },
    mappingJobs: {
      enqueue: (ctx, value) => store.enqueue(ctx, value),
      get: (ctx, id) => store.getAny(ctx, id) as Promise<MappingJob | null>,
      claim: (ctx, id, workerId, leaseSeconds) => store.claim(ctx, id, workerId, leaseSeconds),
      checkpoint: (ctx, value, lease) => store.checkpoint(ctx, value, lease),
      control: (ctx, id, action) => store.controlJob(ctx, id, action),
      saveArtifact: (ctx, jobId, key, value) => store.saveArtifact(ctx, jobId, key, value),
      getArtifact: (ctx, jobId, key) => store.getArtifact(ctx, jobId, key),
    },
    training: {
      append: (ctx, value) => store.appendTraining(ctx, value),
      list: (ctx, productId, limit) => store.listTraining(ctx, productId, limit),
      saveCorrection: (ctx, value) => store.saveCorrection(ctx, value),
      listCorrections: (ctx, productId) => store.listCorrections(ctx, productId),
    },
    feedback: {
      save: (ctx, value) => store.saveFeedback(ctx, value),
      listForProduct: (ctx, productId, limit) => store.listFeedback(ctx, productId, limit),
    },
    knowledge: {
      ingestDocument: (ctx, input) => store.ingestKnowledge(ctx, input),
      search: async () => [],
      listForPlanning: (ctx, productId, limit) => store.listPlanningKnowledge(ctx, productId, limit),
    },
    access: {
      saveCredentialRef: (ctx, value) => store.saveCredentialRef(ctx, value),
      getCredentialRef: (ctx, id) => store.getCredentialRef(ctx, id),
      saveRoleProfile: (ctx, value) => store.saveRoleProfile(ctx, value),
      listRoleProfiles: (ctx, environmentId) => store.listRoleProfiles(ctx, environmentId),
      saveEmbedGrant: (ctx, value) => store.saveEmbedGrant(ctx, value),
      getEmbedGrant: (ctx, id) => store.getEmbedGrant(ctx, id),
      revokeEmbedGrant: (ctx, id) => store.revokeEmbedGrant(ctx, id),
    },
  };
}
