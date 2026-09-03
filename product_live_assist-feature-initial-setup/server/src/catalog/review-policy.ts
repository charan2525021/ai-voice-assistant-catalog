import { createHash } from "node:crypto";
import type { JourneyVersion } from "../domain/catalog.js";

export function durableJourneyChecksum(journey: Pick<JourneyVersion, "workflow" | "evidence">): string {
  return createHash("sha256").update(JSON.stringify({ workflow: journey.workflow, evidence: journey.evidence })).digest("hex");
}

export function durableJourneyApproved(journey: JourneyVersion): boolean {
  const checksum = journey.revisionChecksum ?? durableJourneyChecksum(journey);
  return journey.verificationStatus === "verified" &&
    journey.approvalStatus === "approved" &&
    journey.approvedChecksum === checksum;
}
