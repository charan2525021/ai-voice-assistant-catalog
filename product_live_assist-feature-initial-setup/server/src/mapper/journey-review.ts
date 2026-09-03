import { createHash } from "node:crypto";
import type { Journey, JourneyApprovalStatus, JourneyRevisionSnapshot } from "./types.js";

function executablePayload(journey: Journey) {
  return {
    goal: journey.goal,
    capability: journey.capability,
    entities: journey.entities,
    preconditions: journey.preconditions,
    startUrl: journey.startUrl,
    steps: journey.steps,
    postcondition: journey.postcondition,
    proof: journey.proof,
    evidence: journey.evidence,
    documentation: journey.documentation,
    meaning: journey.meaning,
  };
}

export function journeyRevisionChecksum(journey: Journey): string {
  return createHash("sha256").update(JSON.stringify(executablePayload(journey))).digest("hex");
}

function snapshot(journey: Journey, source: JourneyRevisionSnapshot["source"]): JourneyRevisionSnapshot {
  return {
    revision: journey.revision ?? 1,
    checksum: journey.revisionChecksum ?? journeyRevisionChecksum(journey),
    goal: journey.goal,
    capability: journey.capability,
    steps: structuredClone(journey.steps),
    postcondition: journey.postcondition,
    proof: journey.proof,
    evidence: structuredClone(journey.evidence),
    documentation: structuredClone(journey.documentation),
    status: journey.status,
    verificationRuns: structuredClone(journey.verificationRuns ?? []),
    failure: structuredClone(journey.failure),
    approval: structuredClone(journey.approval),
    createdAt: new Date().toISOString(),
    source,
  };
}

/** Turn a candidate into a new immutable revision awaiting human review. */
export function prepareJourneyRevision(
  candidate: Journey,
  previous?: Journey,
  source: JourneyRevisionSnapshot["source"] = previous ? "remap" : "autonomous",
): Journey {
  const revision = (previous?.revision ?? 0) + 1;
  const history = [
    ...(previous?.revisionHistory ?? []),
    ...(previous ? [snapshot(previous, previous.approval?.status === "rework_requested" ? "human_rework" : "remap")] : []),
  ].slice(-20);
  candidate.revision = revision;
  candidate.revisionHistory = history;
  candidate.revisionChecksum = journeyRevisionChecksum(candidate);
  candidate.approval = {
    status: "pending",
    revision,
    checksum: candidate.revisionChecksum,
  };
  return candidate;
}

export function reviewJourney(
  journey: Journey,
  status: JourneyApprovalStatus,
  reviewer: string,
  comment?: string,
  reworkInstruction?: string,
): Journey {
  const checksum = journeyRevisionChecksum(journey);
  journey.revision ??= 1;
  journey.revisionChecksum = checksum;
  journey.approval = {
    status,
    revision: journey.revision,
    checksum,
    reviewedBy: reviewer,
    reviewedAt: new Date().toISOString(),
    comment: comment?.trim() || undefined,
    reworkInstruction: reworkInstruction?.trim() || undefined,
  };
  return journey;
}

export function approvalIsCurrent(journey: Journey): boolean {
  return journey.approval?.status === "approved" &&
    journey.approval.revision === (journey.revision ?? 1) &&
    journey.approval.checksum === journeyRevisionChecksum(journey);
}
