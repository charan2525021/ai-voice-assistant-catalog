import { randomUUID } from "node:crypto";
import type { CoverageItem } from "../domain/catalog.js";

export interface CoverageDimension {
  roleProfileId: string;
  customerJobId: string;
  state: string;
  branch: "happy_path" | "validation" | "permission" | "empty_state" | "error";
  featureFlags?: Record<string, boolean | string | number>;
  locale?: string;
}

export interface CoverageSummary {
  weightedCoverage: number;
  verified: number;
  discovered: number;
  broken: number;
  blocked: number;
  unknown: number;
  total: number;
  next: CoverageItem[];
}

export function coverageDimensionKey(value: CoverageDimension): string {
  const flags = Object.entries(value.featureFlags ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({ state: value.state, branch: value.branch, flags, locale: value.locale ?? "default" });
}

export function newCoverageItem(input: {
  organizationId: string;
  catalogVersionId: string;
  dimension: CoverageDimension;
  importance: number;
}): CoverageItem {
  const timestamp = new Date().toISOString();
  return {
    id: randomUUID(), organizationId: input.organizationId, catalogVersionId: input.catalogVersionId,
    roleProfileId: input.dimension.roleProfileId, customerJobId: input.dimension.customerJobId,
    dimensionKey: coverageDimensionKey(input.dimension), depth: 0, status: "unknown",
    importance: input.importance, createdAt: timestamp, updatedAt: timestamp,
  };
}

/** The mapper spends its next unit of work on high-value, shallow, unhealthy gaps. */
export function summarizeCoverage(items: CoverageItem[], nextLimit = 20): CoverageSummary {
  const totalWeight = items.reduce((sum, item) => sum + item.importance, 0);
  const earnedWeight = items.reduce((sum, item) => {
    if (item.status !== "verified") return sum;
    return sum + item.importance * (item.depth / 5);
  }, 0);
  const count = (status: CoverageItem["status"]) => items.filter((item) => item.status === status).length;
  const priority = (item: CoverageItem) => {
    const health = item.status === "broken" ? 3 : item.status === "unknown" ? 2 : item.status === "blocked" ? 0.5 : 1;
    return item.importance * health * (6 - item.depth);
  };
  return {
    weightedCoverage: totalWeight ? earnedWeight / totalWeight : 0,
    verified: count("verified"), discovered: count("discovered"), broken: count("broken"),
    blocked: count("blocked"), unknown: count("unknown"), total: items.length,
    next: [...items].filter((item) => item.status !== "verified" || item.depth < 5).sort((a, b) => priority(b) - priority(a)).slice(0, nextLimit),
  };
}

export function coverageReached(items: CoverageItem[], target: number): boolean {
  return summarizeCoverage(items, 0).weightedCoverage >= Math.max(0, Math.min(1, target));
}
