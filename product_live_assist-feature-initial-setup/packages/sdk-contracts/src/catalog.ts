import type { CatalogChannel, JsonValue, RiskLevel, SdkVersionRange } from "./common.js";
import { SDK_CATALOG_SCHEMA_VERSION, SDK_PROTOCOL_VERSION } from "./constants.js";
import type {
  JourneyInputSchema,
  LocatorCandidate,
  StepCompatibility,
  WorkflowAssertion,
  WorkflowDefinition,
} from "./workflow.js";

export type ScreenAnchor =
  | { kind: "route"; pattern: string; weight: number }
  | { kind: "title"; text: string; weight: number }
  | { kind: "text"; text: string; weight: number }
  | { kind: "control"; controlId: string; weight: number }
  | { kind: "dom_marker"; attribute: string; value: string; weight: number };

export interface ScreenVariant {
  id: string;
  locale?: string;
  viewport?: {
    minimumWidth?: number;
    maximumWidth?: number;
  };
  anchors: ScreenAnchor[];
  minimumConfidence: number;
}

export interface CatalogScreen {
  kind: "sable.catalog.screen";
  id: string;
  name: string;
  roles?: string[];
  variants: ScreenVariant[];
  privacyTags?: string[];
}

export interface CatalogControl {
  kind: "sable.catalog.control";
  id: string;
  screenId: string;
  name: string;
  /** Signed, user-facing explanation produced by training; never executable instructions. */
  description?: string;
  behavior?: {
    kind: "navigation" | "reversible_change" | "form_submission" | "external_side_effect" | "destructive" | "unknown";
    summary: string;
  };
  risk: RiskLevel;
  locators: LocatorCandidate[];
  frame?: {
    kind: "same_origin" | "bridge_required";
    name?: string;
  };
  shadow?: {
    kind: "open" | "closed";
    hostControlId?: string;
  };
  privacyTags?: string[];
}

export interface JourneySourceCitation {
  kind: "document" | "exploration" | "human";
  sourceId: string;
  title?: string;
  section?: string;
  chunkId?: string;
}

export interface JourneyDefinition {
  kind: "sable.catalog.journey";
  id: string;
  version: number;
  name: string;
  description?: string;
  intents: string[];
  roles: string[];
  risk: RiskLevel;
  inputSchema: JourneyInputSchema;
  workflow: WorkflowDefinition;
  compatibility: StepCompatibility[];
  state: "draft" | "verified" | "approved" | "retired";
  /** Explicit opt-in for use by the deterministic guided-demo orchestrator. */
  demoSafe?: boolean;
  reliability?: number;
  sourceCitations?: JourneySourceCitation[];
  manualHandoff?: {
    reason: string;
    instructions: string[];
  };
}

export interface DemoUtterance {
  /** Signed transcript text and the fallback input when an approved recording is unavailable. */
  text: string;
  audioAssetId?: string;
}

export interface DemoAudioAsset {
  id: string;
  mime: "audio/mpeg" | "audio/wav";
  /** Lowercase SHA-256 hex digest of the approved audio bytes. */
  sha256: string;
  durationMs?: number;
}

export interface DemoQuestion {
  id: string;
  captureKey: string;
  prompt: DemoUtterance;
}

export interface DemoPersona {
  id: string;
  name: string;
  description: string;
  classifierSignals?: string[];
}

export interface DemoModule {
  id: string;
  name: string;
  journeyId: string;
  introduction: DemoUtterance;
  completion: DemoUtterance;
  failureMessage: DemoUtterance;
}

export interface DemoProfile {
  id: string;
  version: number;
  greeting: DemoUtterance;
  questions: DemoQuestion[];
  intake: {
    genericQuestionIds: [string, string];
    personaQuestionByPersonaId: Record<string, string>;
  };
  personas: DemoPersona[];
  modules: DemoModule[];
  defaultPlaylistModuleIds: string[];
  playlistModuleIdsByPersonaId: Record<string, string[]>;
  closing: DemoUtterance;
}

export type SalesPlayKind =
  | "product_answer"
  | "value_proposition"
  | "objection_response"
  | "proof"
  | "positioning"
  | "discovery_question"
  | "next_best_action";

/** Approved sales-call knowledge. It can support wording or suggestions but does not grant action authority. */
export interface CatalogSalesPlay {
  id: string;
  kind: SalesPlayKind;
  title: string;
  content: string;
  personaIds: string[];
  capabilityIds: string[];
  journeyIds: string[];
  signalPhrases: string[];
  captureKey?: string;
  suggestedJourneyId?: string;
  requiresConfirmation?: true;
}

export type PrivacyRule =
  | { kind: "selector"; selector: string; action: "exclude" | "redact"; replacement?: string }
  | { kind: "input_type"; inputType: string; action: "exclude" | "redact"; replacement?: string }
  | { kind: "attribute"; attribute: string; value?: string; action: "exclude" | "redact"; replacement?: string }
  | { kind: "text_pattern"; pattern: string; flags?: string; action: "redact"; replacement?: string };

export interface PrivacyPolicy {
  kind: "sable.catalog.privacy_policy";
  schemaVersion: typeof SDK_CATALOG_SCHEMA_VERSION;
  defaultTextTreatment: "allow" | "redact";
  screenshots: "disabled" | "consent_required" | "enabled";
  excludedRoutes: string[];
  rules: PrivacyRule[];
  maximumVisibleTextChars: number;
  allowElementValues: boolean;
}

export interface ToolDefinition {
  kind: "sable.catalog.tool";
  schemaVersion: typeof SDK_CATALOG_SCHEMA_VERSION;
  name: string;
  description: string;
  inputSchema: JourneyInputSchema;
  outputSchema?: JsonValue;
  risk: RiskLevel;
  confirmation: "never" | "policy" | "always";
  availability: "optional" | "required";
  timeoutMs: number;
  verification?: WorkflowAssertion[];
}

export type TelemetryEventType =
  | "session.started"
  | "session.stopped"
  | "catalog.loaded"
  | "screen.matched"
  | "element.resolved"
  | "action.completed"
  | "journey.started"
  | "journey.completed"
  | "journey.failed"
  | "approval.requested"
  | "approval.resolved"
  | "privacy.redacted"
  | "transport.state"
  | "sdk.error";

export interface TelemetryPolicy {
  kind: "sable.catalog.telemetry_policy";
  schemaVersion: typeof SDK_CATALOG_SCHEMA_VERSION;
  enabled: boolean;
  sampleRate: number;
  allowedEvents: TelemetryEventType[];
  batchMaximumEvents: number;
  flushIntervalMs: number;
  includeVisibleText: false;
  includeElementValues: false;
}

export interface CatalogManifest {
  kind: "sable.catalog.manifest";
  schemaVersion: typeof SDK_CATALOG_SCHEMA_VERSION;
  protocolVersion: typeof SDK_PROTOCOL_VERSION;
  catalogId: string;
  catalogVersionId: string;
  version: number;
  organizationId: string;
  productId: string;
  environmentId: string;
  roleProfileId: string;
  channel: CatalogChannel;
  issuedAt: string;
  expiresAt?: string;
  supportedSdk: SdkVersionRange;
  applicationBuildHints?: string[];
  publishedBy?: string;
}

export interface SdkCatalog {
  kind: "sable.sdk_catalog";
  schemaVersion: typeof SDK_CATALOG_SCHEMA_VERSION;
  manifest: CatalogManifest;
  screens: CatalogScreen[];
  controls: CatalogControl[];
  journeys: JourneyDefinition[];
  demoAudioAssets?: DemoAudioAsset[];
  demoProfile?: DemoProfile;
  salesPlays?: CatalogSalesPlay[];
  tools: ToolDefinition[];
  privacyPolicy: PrivacyPolicy;
  telemetryPolicy: TelemetryPolicy;
}

export interface CatalogDigest {
  algorithm: "SHA-256";
  encoding: "base64url";
  value: string;
}

export interface CatalogSignature {
  kind: "sable.catalog_signature";
  algorithm: "ES256" | "Ed25519";
  keyId: string;
  encoding: "base64url";
  /** Unpadded base64url raw signature bytes. */
  value: string;
  signedAt: string;
}

/**
 * The signature and digest cover the RFC 8785 canonical UTF-8 JSON bytes of
 * `payload`. Structural validation does not perform cryptographic verification.
 */
export interface SignedCatalogEnvelope {
  kind: "sable.signed_catalog";
  schemaVersion: typeof SDK_CATALOG_SCHEMA_VERSION;
  payload: SdkCatalog;
  digest: CatalogDigest;
  signature: CatalogSignature;
}
