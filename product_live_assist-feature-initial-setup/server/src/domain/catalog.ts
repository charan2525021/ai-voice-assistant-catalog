import type { WorkflowDefinition } from "../workflow/schema.js";

export type CatalogStatus = "draft" | "mapping" | "verifying" | "review" | "published" | "retired";
export type VerificationStatus = "unverified" | "verified" | "broken" | "inconclusive";
export type JourneyApprovalStatus = "pending" | "approved" | "rejected" | "rework_requested";

export interface OwnedEntity {
  id: string;
  organizationId: string;
  createdAt: string;
  updatedAt: string;
}

export interface Product extends OwnedEntity {
  key: string;
  name: string;
  activeCatalogVersionId?: string;
}

export interface ProductEnvironment extends OwnedEntity {
  productId: string;
  key: string;
  name: string;
  startUrl: string;
  productVersion?: string;
  locale: string;
  featureFlags: Record<string, boolean | string | number>;
  resetAdapterType?: string;
}

export interface RoleProfile extends OwnedEntity {
  environmentId: string;
  key: string;
  name: string;
  credentialRefId?: string;
  permissionHints: string[];
}

/** Pointer only. Secret material lives in the configured secret provider. */
export interface CredentialRef extends OwnedEntity {
  provider: string;
  secretPath: string;
  metadata: Record<string, string>;
  expiresAt?: string;
}

/** Revocable public access to one product and one mapped role. */
export interface EmbedGrant extends OwnedEntity {
  productId: string;
  roleProfileId: string;
  allowedOrigins: string[];
  expiresAt: string;
  revokedAt?: string;
}

export interface CatalogVersion extends OwnedEntity {
  productId: string;
  environmentId: string;
  version: number;
  status: CatalogStatus;
  schemaVersion: number;
  bundleKey?: string;
  bundleChecksum?: string;
  publishedAt?: string;
}

export interface Capability extends OwnedEntity {
  catalogVersionId: string;
  key: string;
  name: string;
  description: string;
  importance: number;
}

export interface CustomerJob extends OwnedEntity {
  catalogVersionId: string;
  capabilityId: string;
  key: string;
  goal: string;
  outcome: string;
  importance: number;
  source: "documentation" | "analytics" | "sales_expert" | "mapper" | "customer_feedback" | "manual";
}

export interface ScreenType extends OwnedEntity {
  catalogVersionId: string;
  key: string;
  name: string;
  urlTemplate?: string;
  purpose?: string;
  fingerprintHints: Record<string, unknown>;
}

export interface JourneyVersion extends OwnedEntity {
  catalogVersionId: string;
  journeyKey: string;
  capabilityId: string;
  customerJobId: string;
  roleProfileIds: string[];
  workflow: WorkflowDefinition;
  verificationStatus: VerificationStatus;
  reliability: number;
  verifiedAt?: string;
  evidence: Record<string, unknown>;
  revision?: number;
  revisionChecksum?: string;
  approvalStatus?: JourneyApprovalStatus;
  approvedChecksum?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewComment?: string;
  supersedesJourneyVersionId?: string;
}

export type SalesPlayKind = "discovery" | "value_proposition" | "objection" | "proof_moment" | "next_best_action" | "positioning";

export interface SalesPlay extends OwnedEntity {
  catalogVersionId: string;
  kind: SalesPlayKind;
  title: string;
  content: string;
  personaKeys: string[];
  capabilityIds: string[];
  journeyKeys: string[];
  signalKeywords: string[];
  sourceDocumentId?: string;
  approvalStatus: "draft" | "approved" | "rejected";
  approvedBy?: string;
  approvedAt?: string;
}

export interface CoverageItem extends OwnedEntity {
  catalogVersionId: string;
  roleProfileId: string;
  customerJobId: string;
  dimensionKey: string;
  depth: 0 | 1 | 2 | 3 | 4 | 5;
  status: "unknown" | "discovered" | "verified" | "broken" | "blocked";
  importance: number;
  lastCheckedAt?: string;
  detail?: string;
}
