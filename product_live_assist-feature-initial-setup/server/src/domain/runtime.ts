import type { OwnedEntity } from "./catalog.js";

export interface CustomerSession extends OwnedEntity {
  productId: string;
  environmentId: string;
  roleProfileId: string;
  catalogVersionId: string;
  mode: "text" | "voice";
  status: "starting" | "active" | "ended" | "failed";
  lastSeenAt: string;
  memory: Record<string, unknown>;
  /** Managed-browser handle and fencing lease for crash recovery. */
  browserSessionId?: string;
  workerId?: string;
  recoveryLeaseExpiresAt?: string;
}

export interface MappingJob extends OwnedEntity {
  productId: string;
  environmentId: string;
  catalogVersionId: string;
  status: "queued" | "running" | "waiting_for_human" | "completed" | "failed" | "cancelled";
  stage: string;
  cursor: Record<string, unknown>;
  attempts: number;
  error?: string;
}

export interface TrainingEvent extends OwnedEntity {
  productId: string;
  catalogVersionId?: string;
  mappingJobId?: string;
  journeyVersionId?: string;
  eventType: string;
  actorType: "agent" | "human" | "system";
  actorId: string;
  payload: Record<string, unknown>;
}

export interface JourneyCorrection extends OwnedEntity {
  productId: string;
  catalogVersionId: string;
  journeyVersionId: string;
  instruction: string;
  constraints: Record<string, unknown>;
  status: "pending" | "running" | "applied" | "failed" | "cancelled";
  requestedBy: string;
}

export interface FeedbackSignal extends OwnedEntity {
  productId: string;
  catalogVersionId: string;
  sessionId?: string;
  kind: "unanswered_question" | "journey_failure" | "correction" | "friction" | "positive_engagement";
  content: string;
  metadata: Record<string, unknown>;
}
