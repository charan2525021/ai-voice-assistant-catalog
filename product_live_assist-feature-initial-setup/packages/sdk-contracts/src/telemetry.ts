import type { JsonValue } from "./common.js";
import { SDK_TELEMETRY_SCHEMA_VERSION } from "./constants.js";
import type { StepCompatibilityClass } from "./workflow.js";

interface TelemetryEventBase {
  kind: "sable.sdk.telemetry_event";
  schemaVersion: typeof SDK_TELEMETRY_SCHEMA_VERSION;
  eventId: string;
  sequence: number;
  sessionId: string;
  installationId: string;
  catalogVersionId: string;
  occurredAt: string;
  durationMs?: number;
}

export type SdkTelemetryEvent =
  | (TelemetryEventBase & { type: "session.started" | "session.stopped"; reason?: string })
  | (TelemetryEventBase & { type: "catalog.loaded"; source: "network" | "cache"; version: number })
  | (TelemetryEventBase & { type: "screen.matched"; screenId?: string; confidence: number; fingerprint: string })
  | (TelemetryEventBase & {
      type: "element.resolved";
      controlId: string;
      locatorKind?: string;
      locatorRank?: number;
      candidateCount: number;
      ok: boolean;
      detail?: string;
    })
  | (TelemetryEventBase & {
      type: "action.completed";
      journeyId: string;
      stepId: string;
      action: string;
      compatibility: StepCompatibilityClass;
      ok: boolean;
      detail?: string;
    })
  | (TelemetryEventBase & {
      type: "journey.started" | "journey.completed" | "journey.failed";
      journeyId: string;
      completedSteps?: number;
      detail?: string;
    })
  | (TelemetryEventBase & { type: "approval.requested"; journeyId: string; stepId: string; risk: string })
  | (TelemetryEventBase & { type: "approval.resolved"; journeyId: string; stepId: string; approved: boolean })
  | (TelemetryEventBase & { type: "privacy.redacted"; ruleKind: string; count: number })
  | (TelemetryEventBase & { type: "transport.state"; state: "connecting" | "connected" | "disconnected" | "failed"; detail?: string })
  | (TelemetryEventBase & { type: "sdk.error"; code: string; message: string; context?: Record<string, JsonValue> });

export interface SdkTelemetryBatch {
  kind: "sable.sdk.telemetry_batch";
  schemaVersion: typeof SDK_TELEMETRY_SCHEMA_VERSION;
  batchId: string;
  sessionId: string;
  sentAt: string;
  events: SdkTelemetryEvent[];
}
