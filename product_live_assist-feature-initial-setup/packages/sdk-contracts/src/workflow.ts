import type { JsonValue, RiskLevel } from "./common.js";
import { SDK_OBSERVATION_SCHEMA_VERSION, SDK_WORKFLOW_SCHEMA_VERSION } from "./constants.js";

export type StepCompatibilityClass =
  | "SDK_DIRECT"
  | "SDK_RESUMABLE_NAVIGATION"
  | "NEEDS_STABLE_MARKER"
  | "NEEDS_REGISTERED_TOOL"
  | "NEEDS_USER_GESTURE"
  | "NEEDS_FRAME_BRIDGE"
  | "EXTENSION_ONLY"
  | "HUMAN_ONLY"
  | "UNSUPPORTED";

export interface StepCompatibility {
  kind: "sable.step_compatibility";
  stepId: string;
  classification: StepCompatibilityClass;
  reason: string;
  requirements?: string[];
  verifiedAt?: string;
  verifiedSdkVersion?: string;
  /** SHA-256 hex digest of the exact browser bundle used by Gate 1. */
  verifiedSdkArtifactSha256?: string;
  verifiedApplicationBuild?: string;
}

interface RankedLocatorBase {
  rank: number;
  confidence?: number;
  exact?: boolean;
}

export type LocatorCandidate =
  | (RankedLocatorBase & { kind: "agent_id"; value: string })
  | (RankedLocatorBase & { kind: "aria_role_name"; role: string; name: string })
  | (RankedLocatorBase & { kind: "label"; text: string })
  | (RankedLocatorBase & { kind: "test_id"; value: string })
  | (RankedLocatorBase & { kind: "text"; text: string })
  | (RankedLocatorBase & { kind: "relationship"; withinControlId: string; role?: string; name?: string })
  | (RankedLocatorBase & { kind: "css_fallback"; selector: string });

export interface WorkflowTarget {
  controlId: string;
  screenId?: string;
  /** Inline fallbacks are for draft/replay compatibility; published catalogs should reference CatalogControl locators. */
  locators?: LocatorCandidate[];
}

export type InputValueType = "string" | "number" | "boolean" | "enum" | "json";

export interface JourneyInputProperty {
  type: InputValueType;
  description?: string;
  enum?: JsonValue[];
  default?: JsonValue;
  secret?: boolean;
  minimum?: number;
  maximum?: number;
  minimumLength?: number;
  maximumLength?: number;
  pattern?: string;
}

export interface JourneyInputSchema {
  kind: "sable.journey_input_schema";
  properties: Record<string, JourneyInputProperty>;
  required: string[];
  additionalProperties: false;
}

export type TemplateTransform = "trim" | "lowercase" | "uppercase" | "stringify";

export type TemplateValue =
  | { kind: "literal"; value: JsonValue }
  | { kind: "input_ref"; name: string; fallback?: JsonValue; transforms?: TemplateTransform[] }
  | { kind: "object"; properties: Record<string, TemplateValue> }
  | { kind: "array"; items: TemplateValue[] };

export type WorkflowAssertion =
  | { kind: "text_visible"; text: string }
  | { kind: "text_absent"; text: string }
  | { kind: "url_matches"; pattern: string }
  | { kind: "control_visible"; target: WorkflowTarget }
  | { kind: "control_enabled"; target: WorkflowTarget }
  | { kind: "screen_matches"; screenId: string; minimumConfidence?: number }
  | { kind: "screen_changed"; fromFingerprint?: string }
  | { kind: "list_changed"; fromSignature?: string }
  | { kind: "tool_check"; toolName: string; operation: string; input?: TemplateValue };

interface WorkflowStepBase {
  id: string;
  narration?: string;
  /** Optional approved recording for narration; the signed text remains the transcript and TTS fallback. */
  narrationAudioAssetId?: string;
  timeoutMs?: number;
  risk?: RiskLevel;
  optional?: boolean;
  compatibility: StepCompatibility;
}

export type ActionWorkflowStep =
  | (WorkflowStepBase & {
      kind: "action";
      action: "navigate";
      url: TemplateValue;
      /** Signed catalog authority for a read-only full-document handoff. */
      continuity?: {
        kind: "sable.cross_page_continuity";
        expectedScreenIds: string[];
        destinationOrigins: string[];
      };
    })
  | (WorkflowStepBase & { kind: "action"; action: "click"; target: WorkflowTarget })
  | (WorkflowStepBase & { kind: "action"; action: "fill"; target: WorkflowTarget; value: TemplateValue; submit?: boolean })
  | (WorkflowStepBase & { kind: "action"; action: "select"; target: WorkflowTarget; value: TemplateValue })
  | (WorkflowStepBase & { kind: "action"; action: "scroll"; direction: "up" | "down"; amount?: number; target?: WorkflowTarget })
  | (WorkflowStepBase & { kind: "action"; action: "keypress"; key: string; target?: WorkflowTarget })
  | (WorkflowStepBase & { kind: "action"; action: "hover"; target: WorkflowTarget })
  | (WorkflowStepBase & { kind: "action"; action: "drag"; source: WorkflowTarget; target: WorkflowTarget })
  | (WorkflowStepBase & { kind: "action"; action: "wait"; milliseconds?: number; until?: WorkflowAssertion })
  | (WorkflowStepBase & { kind: "action"; action: "tool_call"; toolName: string; input: TemplateValue });

export type WorkflowStep =
  | ActionWorkflowStep
  | (WorkflowStepBase & { kind: "assert"; assertion: WorkflowAssertion })
  | (WorkflowStepBase & { kind: "approval"; reason: string; then: WorkflowStep[] })
  | (WorkflowStepBase & { kind: "branch"; condition: WorkflowAssertion; then: WorkflowStep[]; otherwise?: WorkflowStep[] })
  | (WorkflowStepBase & { kind: "loop"; until: WorkflowAssertion; steps: WorkflowStep[]; maxIterations: number });

export interface WorkflowDefinition {
  kind: "sable.workflow";
  schemaVersion: typeof SDK_WORKFLOW_SCHEMA_VERSION;
  id: string;
  version: number;
  name: string;
  startUrl?: TemplateValue;
  risk: RiskLevel;
  preconditions: WorkflowAssertion[];
  steps: WorkflowStep[];
  postconditions: WorkflowAssertion[];
}

export interface ObservedElement {
  id: string;
  role: string;
  name: string;
  visible: boolean;
  enabled: boolean;
  value?: string;
  checked?: boolean;
  selected?: boolean;
  controlId?: string;
  privacyTags?: string[];
}

export interface ScreenObservation {
  kind: "sable.screen_observation";
  schemaVersion: typeof SDK_OBSERVATION_SCHEMA_VERSION;
  observationId: string;
  /** Monotonically increasing within one SDK session. */
  version: number;
  capturedAt: string;
  url: string;
  origin: string;
  title: string;
  fingerprint: string;
  /** Already redacted when transported outside the page. */
  visibleText?: string;
  elements: ObservedElement[];
  matchedScreenId?: string;
  matchConfidence?: number;
}

export interface ResolvedAction {
  kind: "sable.resolved_action";
  stepId: string;
  action: ActionWorkflowStep["action"];
  target?: WorkflowTarget;
  source?: WorkflowTarget;
  url?: string;
  value?: JsonValue;
  submit?: boolean;
  direction?: "up" | "down";
  amount?: number;
  key?: string;
  milliseconds?: number;
  until?: WorkflowAssertion;
  toolName?: string;
  input?: JsonValue;
}
