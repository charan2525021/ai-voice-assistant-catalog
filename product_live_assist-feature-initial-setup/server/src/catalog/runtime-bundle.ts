import { createHash } from "node:crypto";
import type { CatalogSnapshot } from "../storage/contracts.js";
import type { WorkflowDefinition } from "../workflow/schema.js";
import { assertValidWorkflow } from "../workflow/schema.js";
import { summarizeCoverage } from "../mapping/coverage.js";
import { durableJourneyApproved } from "./review-policy.js";

export interface RuntimeJourney {
  key: string;
  name: string;
  roleProfileIds: string[];
  intentPhrases: string[];
  workflow: WorkflowDefinition;
  reliability: number;
  screenFingerprints?: string[];
  screenKeys?: string[];
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
  /** Optional for bundles published before screen-graph runtime support. */
  screens?: RuntimeScreenState[];
  transitions?: RuntimeTransition[];
  coverage: { weighted: number; verified: number; total: number; unknown: number };
}

function intentPhrases(name: string): string[] {
  const goal = name.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  return [...new Set([goal, `how do i ${goal}`, `show me how to ${goal}`, `can you ${goal}`])];
}

export function compileRuntimeBundle(snapshot: CatalogSnapshot): { bundle: RuntimeBundle; json: string; checksum: string } {
  for (const journey of snapshot.journeys.filter(durableJourneyApproved)) {
    assertValidWorkflow(journey.workflow);
  }
  const coverage = summarizeCoverage(snapshot.coverage, 0);
  const bundle: RuntimeBundle = {
    schemaVersion: 1,
    organizationId: snapshot.catalog.organizationId,
    productId: snapshot.catalog.productId,
    environmentId: snapshot.catalog.environmentId,
    catalogVersionId: snapshot.catalog.id,
    catalogVersion: snapshot.catalog.version,
    generatedAt: new Date().toISOString(),
    journeys: snapshot.journeys
      .filter(durableJourneyApproved)
      .map((journey) => ({
        key: journey.journeyKey,
        name: journey.workflow.name,
        roleProfileIds: journey.roleProfileIds,
        intentPhrases: intentPhrases(journey.workflow.name),
        workflow: journey.workflow,
        reliability: journey.reliability,
        screenFingerprints: Array.isArray(journey.evidence.screenFingerprints)
          ? journey.evidence.screenFingerprints.filter((value): value is string => typeof value === "string")
          : [],
        screenKeys: Array.isArray(journey.evidence.screenKeys)
          ? journey.evidence.screenKeys.filter((value): value is string => typeof value === "string")
          : [],
      })),
    salesPlays: snapshot.salesPlays
      .filter((play) => play.approvalStatus === "approved")
      .map((play) => ({
        id: play.id, kind: play.kind, content: play.content, personaKeys: play.personaKeys,
        capabilityIds: play.capabilityIds, journeyKeys: play.journeyKeys, signalKeywords: play.signalKeywords,
      })),
    screens: snapshot.screens,
    transitions: snapshot.transitions,
    coverage: {
      weighted: coverage.weightedCoverage,
      verified: coverage.verified,
      total: coverage.total,
      unknown: coverage.unknown,
    },
  };
  const json = JSON.stringify(bundle);
  return { bundle, json, checksum: createHash("sha256").update(json).digest("hex") };
}
