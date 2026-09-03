import type { CatalogVersion, CoverageItem, CredentialRef, EmbedGrant, JourneyApprovalStatus, JourneyVersion, Product, ProductEnvironment, RoleProfile, SalesPlay } from "../domain/catalog.js";
import type { CustomerSession, FeedbackSignal, JourneyCorrection, MappingJob, TrainingEvent } from "../domain/runtime.js";
import type { TenantContext } from "../domain/context.js";

export interface NewProduct {
  key: string;
  name: string;
  environment: {
    key: string;
    name: string;
    startUrl: string;
    productVersion?: string;
    locale?: string;
    featureFlags?: Record<string, boolean | string | number>;
  };
}

export interface ProductAggregate {
  product: Product;
  environments: ProductEnvironment[];
  roles: RoleProfile[];
}

export interface CatalogScreenState {
  key: string;
  name: string;
  url?: string;
  purpose?: string;
  fingerprint: string;
  roleProfileId?: string;
  controls: { key: string; role?: string; accessibleName?: string; risk?: string }[];
}

export interface CatalogTransition {
  fromScreenKey: string;
  fromFingerprint: string;
  toScreenKey?: string;
  toFingerprint?: string;
  roleProfileId?: string;
  controlKey?: string;
  action: Record<string, unknown>;
  reliability: number;
}

export interface CatalogSnapshot {
  catalog: CatalogVersion;
  journeys: JourneyVersion[];
  salesPlays: SalesPlay[];
  coverage: CoverageItem[];
  screens: CatalogScreenState[];
  transitions: CatalogTransition[];
}

export interface MappedCatalogInput {
  screens: {
    key: string; name: string; url: string; purpose: string; fingerprint: string;
    controls: { key: string; role?: string; accessibleName?: string }[];
  }[];
  transitions?: {
    fromScreenKey: string;
    toScreenKey?: string;
    controlKey?: string;
    action: Record<string, unknown>;
    reliability: number;
  }[];
  journeys: {
    key: string; goal: string; capabilityKey: string; capabilityName: string;
    workflow: import("../workflow/schema.js").WorkflowDefinition;
    reliability: number; verifiedAt?: string; evidence: Record<string, unknown>;
    depth: 1 | 2 | 3 | 4 | 5;
    coverage?: Partial<Record<"validation" | "permission" | "empty_state" | "error", {
      status: CoverageItem["status"];
      depth: CoverageItem["depth"];
      detail: string;
      checkedAt?: string;
    }>>;
  }[];
}

export interface ProductRepository {
  list(ctx: TenantContext): Promise<ProductAggregate[]>;
  get(ctx: TenantContext, productId: string): Promise<ProductAggregate | null>;
  create(ctx: TenantContext, input: NewProduct): Promise<ProductAggregate>;
  /**
   * Delete a product and everything versioned beneath it. Returns false when the
   * product does not exist (or belongs to another tenant), so a caller can tell
   * "removed" from "was never here" instead of reporting a hopeful success.
   */
  remove(ctx: TenantContext, productId: string): Promise<boolean>;
}

export interface CatalogRepository {
  createDraft(ctx: TenantContext, productId: string, environmentId: string): Promise<CatalogVersion>;
  /** New role-mapping jobs join the current build instead of allocating isolated drafts. */
  getOpenDraft(ctx: TenantContext, productId: string, environmentId: string): Promise<CatalogVersion | null>;
  get(ctx: TenantContext, catalogVersionId: string): Promise<CatalogSnapshot | null>;
  getActive(ctx: TenantContext, productId: string): Promise<CatalogSnapshot | null>;
  publish(ctx: TenantContext, catalogVersionId: string, bundle: { key: string; checksum: string }): Promise<CatalogVersion>;
  getSalesPlay(ctx: TenantContext, id: string): Promise<SalesPlay | null>;
  saveJourney(ctx: TenantContext, value: JourneyVersion): Promise<void>;
  reviewJourney(ctx: TenantContext, journeyVersionId: string, input: {
    decision: Exclude<JourneyApprovalStatus, "pending">;
    comment?: string;
    instruction?: string;
  }): Promise<JourneyVersion>;
  saveSalesPlay(ctx: TenantContext, value: SalesPlay): Promise<void>;
  replaceCoverage(ctx: TenantContext, catalogVersionId: string, values: CoverageItem[]): Promise<void>;
  replaceMappedCatalog(ctx: TenantContext, catalogVersionId: string, roleProfileId: string, value: MappedCatalogInput): Promise<void>;
}

export interface SessionRepository {
  create(ctx: TenantContext, value: CustomerSession): Promise<void>;
  get(ctx: TenantContext, id: string): Promise<CustomerSession | null>;
  update(ctx: TenantContext, value: CustomerSession): Promise<void>;
  /** Atomically fence recovery to one worker after the previous lease expires. */
  claimRecovery(ctx: TenantContext, id: string, workerId: string, leaseSeconds: number): Promise<CustomerSession | null>;
}

export interface MappingJobRepository {
  enqueue(ctx: TenantContext, value: MappingJob): Promise<void>;
  get(ctx: TenantContext, id: string): Promise<MappingJob | null>;
  /** Atomically lease a queued or abandoned job to one worker. */
  claim(ctx: TenantContext, id: string, workerId: string, leaseSeconds: number): Promise<MappingJob | null>;
  checkpoint(ctx: TenantContext, value: MappingJob, lease?: { owner: string; seconds: number }): Promise<void>;
  /** Human control is persisted, so another worker/process cannot ignore it. */
  control(ctx: TenantContext, id: string, action: "pause" | "resume" | "cancel"): Promise<MappingJob>;
  saveArtifact(ctx: TenantContext, jobId: string, key: string, value: unknown): Promise<{ checksum: string }>;
  getArtifact<T>(ctx: TenantContext, jobId: string, key: string): Promise<T | null>;
}

export interface TrainingRepository {
  append(ctx: TenantContext, value: TrainingEvent): Promise<void>;
  list(ctx: TenantContext, productId: string, limit?: number): Promise<TrainingEvent[]>;
  saveCorrection(ctx: TenantContext, value: JourneyCorrection): Promise<void>;
  listCorrections(ctx: TenantContext, productId: string): Promise<JourneyCorrection[]>;
}

export interface FeedbackRepository {
  save(ctx: TenantContext, value: FeedbackSignal): Promise<void>;
  listForProduct(ctx: TenantContext, productId: string, limit?: number): Promise<FeedbackSignal[]>;
}

export interface KnowledgeHit {
  id: string;
  title: string;
  section: string;
  content: string;
  source: string;
  trust: string;
  score: number;
}

export interface KnowledgeDocumentInput {
  productId: string;
  sourceType: string;
  uri: string;
  trust: "official" | "marketing" | "community" | "sales_expert";
  externalKey: string;
  title: string;
  contentHash: string;
  sourceModifiedAt?: string;
  chunks: { title: string; section: string; content: string; embedding?: number[]; metadata?: Record<string, unknown> }[];
}

export interface PlanningKnowledgeChunk {
  id: string;
  title: string;
  section: string;
  content: string;
  source: string;
  trust: "official" | "marketing" | "community" | "sales_expert";
  metadata?: Record<string, unknown>;
}

export interface KnowledgeRepository {
  ingestDocument(ctx: TenantContext, input: KnowledgeDocumentInput): Promise<{
    documentId: string; versionId: string; chunks: number; chunkIds?: string[];
  }>;
  search(ctx: TenantContext, input: {
    productId: string;
    catalogVersionId: string;
    query: string;
    embedding?: number[];
    limit?: number;
  }): Promise<KnowledgeHit[]>;
  /** Latest tenant-scoped source chunks for offline mapping, never the live hot path. */
  listForPlanning(ctx: TenantContext, productId: string, limit?: number): Promise<PlanningKnowledgeChunk[]>;
}

export interface AccessRepository {
  saveCredentialRef(ctx: TenantContext, value: CredentialRef): Promise<void>;
  getCredentialRef(ctx: TenantContext, id: string): Promise<CredentialRef | null>;
  saveRoleProfile(ctx: TenantContext, value: RoleProfile): Promise<void>;
  listRoleProfiles(ctx: TenantContext, environmentId: string): Promise<RoleProfile[]>;
  saveEmbedGrant(ctx: TenantContext, value: EmbedGrant): Promise<void>;
  getEmbedGrant(ctx: TenantContext, id: string): Promise<EmbedGrant | null>;
  revokeEmbedGrant(ctx: TenantContext, id: string): Promise<void>;
}

export interface PlatformRepositories {
  products: ProductRepository;
  catalogs: CatalogRepository;
  sessions: SessionRepository;
  mappingJobs: MappingJobRepository;
  training: TrainingRepository;
  feedback: FeedbackRepository;
  knowledge: KnowledgeRepository;
  access: AccessRepository;
}
