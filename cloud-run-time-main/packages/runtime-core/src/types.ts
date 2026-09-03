import type { ScreenObservation } from "@sable/sdk-contracts";

export type RuntimeIntent = "screen_question" | "how_to" | "action" | "product_question" | "objection" | "conversation";

export interface RuntimeScope {
  organizationId: string;
  productId: string;
  roleProfileId: string;
  catalogVersionId: string;
}

export interface RuntimeJourney {
  key: string;
  name: string;
  roleProfileIds: string[];
  intentPhrases: string[];
  workflow: RuntimeWorkflowDefinition;
  reliability: number;
  screenFingerprints?: string[];
  screenKeys?: string[];
}

/** Immutable workflow evidence emitted by the existing trainer. */
export interface RuntimeWorkflowDefinition {
  schemaVersion: 1;
  id: string;
  version: number;
  name: string;
  startUrl?: string;
  risk: "read" | "reversible_write" | "external_side_effect" | "destructive";
  preconditions: Record<string, unknown>[];
  steps: Array<{ id: string; action: string; say?: string; [key: string]: unknown }>;
  postconditions: Record<string, unknown>[];
}

export interface RuntimeScreenState {
  key: string;
  name: string;
  url?: string;
  purpose?: string;
  fingerprint: string;
  roleProfileId?: string;
  controls: { key: string; role?: string; accessibleName?: string; risk?: string }[];
}

export interface RuntimeTransition {
  fromScreenKey: string;
  fromFingerprint: string;
  toScreenKey?: string;
  toFingerprint?: string;
  roleProfileId?: string;
  controlKey?: string;
  action: Record<string, unknown>;
  reliability: number;
}

export interface RuntimeSalesPlay {
  id: string;
  kind: string;
  content: string;
  personaKeys: string[];
  capabilityIds: string[];
  journeyKeys: string[];
  signalKeywords: string[];
}

export interface RuntimeBundle {
  schemaVersion: 1;
  organizationId: string;
  productId: string;
  environmentId: string;
  catalogVersionId: string;
  catalogVersion: number;
  generatedAt: string;
  journeys: RuntimeJourney[];
  salesPlays: RuntimeSalesPlay[];
  screens?: RuntimeScreenState[];
  transitions?: RuntimeTransition[];
  coverage: { weighted: number; verified: number; total: number; unknown: number };
}

export interface KnowledgeHit {
  id: string;
  title: string;
  section: string;
  content: string;
  source: string;
  trust: "official" | "marketing" | "community" | "sales_expert";
  score: number;
}

export interface RuntimeCatalogReader {
  getBundle(scope: RuntimeScope): Promise<RuntimeBundle | undefined>;
}

export interface RuntimeKnowledgeSearch {
  search(scope: RuntimeScope, input: { query: string; embedding?: number[]; limit: number }): Promise<KnowledgeHit[]>;
}

export interface EvidenceEventSink {
  emit(type: "retrieve.context", detail: Record<string, unknown>): void;
}

export interface EvidenceSet {
  intent: RuntimeIntent;
  catalogVersionId: string;
  screen?: ScreenObservation;
  /** Query-focused, privacy-filtered excerpt from the live screen. */
  screenExcerpt?: string;
  journey?: RuntimeJourney;
  knowledge: KnowledgeHit[];
  salesPlays: RuntimeSalesPlay[];
  matchedScreen?: RuntimeScreenState;
  /** Catalog controls that were also observed as visible in the live DOM. */
  matchedControls: RuntimeScreenState["controls"];
  nextTransitions: RuntimeTransition[];
  unavailableReason?: string;
  provenance: ("live_screen" | "verified_journey" | "product_knowledge" | "approved_sales_play")[];
}

export interface EvidenceRoutingPlan {
  intent: RuntimeIntent;
  needsKnowledge: boolean;
  journeyId?: string;
  unavailableReason?: string;
}
