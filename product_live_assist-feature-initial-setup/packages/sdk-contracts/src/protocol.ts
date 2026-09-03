import type { JsonValue, RiskLevel } from "./common.js";
import { SDK_PROTOCOL_VERSION } from "./constants.js";
import type { CatalogDigest, SignedCatalogEnvelope } from "./catalog.js";
import type { ScreenObservation } from "./workflow.js";

export interface SdkCapabilities {
  domObservation: true;
  shadowDom: boolean;
  sameOriginFrames: boolean;
  frameBridge: boolean;
  registeredTools: string[];
  voice: boolean;
  screenshots: boolean;
}

export interface SdkBootstrapRequest {
  kind: "sable.sdk.bootstrap.request";
  schemaVersion: typeof SDK_PROTOCOL_VERSION;
  requestId: string;
  installationId: string;
  identityToken: string;
  sdk: {
    version: string;
    protocolVersion: typeof SDK_PROTOCOL_VERSION;
    distribution: "script" | "npm";
  };
  page: {
    origin: string;
    url: string;
    locale: string;
    timezone?: string;
    referrerOrigin?: string;
  };
  capabilities: SdkCapabilities;
}

export interface SessionDescriptor {
  kind: "sable.sdk.session";
  schemaVersion: typeof SDK_PROTOCOL_VERSION;
  sessionId: string;
  /** Stable opaque server-issued ID for this user + installation + role + catalog scope. */
  continuityId: string;
  installationId: string;
  organizationId: string;
  productId: string;
  environmentId: string;
  roleProfileId: string;
  userId: string;
  origin: string;
  catalogVersionId: string;
  sessionToken: string;
  expiresAt: string;
}

export type CatalogDelivery =
  | { kind: "inline"; envelope: SignedCatalogEnvelope }
  | { kind: "remote"; url: string; digest: CatalogDigest; keyId: string };

export interface SdkBootstrapResponse {
  kind: "sable.sdk.bootstrap.response";
  schemaVersion: typeof SDK_PROTOCOL_VERSION;
  requestId: string;
  serverTime: string;
  session: SessionDescriptor;
  catalog: CatalogDelivery;
  transport: {
    websocketUrl: string;
    /** Single-use and intentionally separate from the session bearer token. */
    oneTimeTicket: string;
    expiresAt: string;
  };
  /** Present only when both the installation and this SDK support cloud voice. */
  voiceTransport?: {
    websocketUrl: string;
    oneTimeTicket: string;
    expiresAt: string;
    languageCode: string;
    sampleRate: 16000;
    silenceTimeoutMs: number;
    minimumSpeechMs: number;
    maximumUtteranceMs: number;
    audioFrameMs: number;
    /** Float RMS threshold used by the browser's local voice-activity detector. */
    vadThreshold: number;
    audioWaitCapMs: number;
    autoStop: boolean;
    bargeIn: boolean;
    speakMode: "voice_turns" | "all" | "off";
    stepNarration: boolean;
  };
  /** `disabled` means the SDK must stop locally and perform no further actions. */
  killSwitch: {
    disabled: boolean;
    reason?: string;
  };
}

interface ClientMessageBase {
  schemaVersion: typeof SDK_PROTOCOL_VERSION;
  messageId: string;
  sessionId: string;
  sentAt: string;
}

export type DemoControlAction = "start" | "continue" | "retry" | "skip" | "stop";
export type DemoPhase = "idle" | "intake" | "playing" | "pausing" | "paused" | "answering" | "awaiting_resume" | "closing" | "completed" | "stopped";
export type VoicePurpose = "answer" | "acknowledgement" | "journey_step" | "result" | "demo";

export interface RestoredTranscriptMessage {
  key: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

export interface RestoredJourneyCheckpoint {
  journeyId: string;
  journeyVersion: number;
  turnId: string;
  originalRequest: string;
  inputs: Record<string, JsonValue>;
  completedStepIds: string[];
  nextStepId: string;
  navigationStepId: string;
  destinationUrl: string;
  expectedScreenIds: string[];
  stopAfterStepId?: string;
}

export interface RestoredCatalogNavigationCheckpoint {
  turnId: string;
  originalRequest: string;
  sourceScreenId: string;
  controlId: string;
  targetScreenId: string;
  destinationUrl: string;
}

/**
 * Dynamic-mode types. Only used when the signed-catalog planner returned no
 * matching journey AND the installation opted into dynamic fallback. The
 * signed-catalog path never sees any of these types.
 *
 * A "dynamic tool" is a bounded browser primitive the runtime may request the
 * SDK to execute against the live DOM. The target is described semantically —
 * never as a CSS selector, XPath, or coordinates. The SDK resolves the target
 * locally through a ranked strategy chain and refuses to act below a confidence
 * threshold. Destructive dynamic tools go through the same approval bridge the
 * signed-catalog path uses.
 */
export type DynamicToolKind =
  | "click"
  | "fill"
  | "select"
  | "check"
  | "uncheck"
  | "hover"
  | "scroll"
  | "navigate"
  | "wait"
  | "read";

export interface DynamicToolTarget {
  /** data-testid / data-test-id / data-qa value declared by the host app. */
  testId?: string;
  ariaLabel?: string;
  /** ARIA role or computed role (`button`, `link`, `textbox`, ...). */
  role?: string;
  /** Computed accessible name for the element. */
  accessibleName?: string;
  /** Direct visible text content the user would see. */
  text?: string;
  /** Optional: a stable UIMap element ID sent by the SDK in the last snapshot. */
  elementId?: string;
}

export interface UIMapElement {
  /** Stable within one snapshot; the SDK does not persist across snapshots. */
  id: string;
  role: string;
  label?: string;
  accessibleName?: string;
  testId?: string;
  text?: string;
  placeholder?: string;
  /** Semantic path — for example `/main/form/input[1]`. Never a CSS selector. */
  path: string;
  /** True when the SDK's privacy engine masked or refused to capture the value. */
  sensitive?: boolean;
  editable?: boolean;
  visible: boolean;
}

export interface UIMapSnapshot {
  /** Full URL including protocol + host (best-effort; a bounded string). */
  url: string;
  /** Pathname only, without query or fragment. */
  path: string;
  title?: string;
  /** Interactive-first, size-capped by the SDK before sending. */
  elements: UIMapElement[];
  capturedAt: string;
}

/**
 * Result the SDK sends back after executing one server-requested dynamic tool.
 * `matchedElement.confidence` is on 0..1 for observability; the SDK refuses to
 * act below a threshold and returns `success=false` with a `CONTROL_NOT_FOUND`
 * error in that case.
 */
export interface DynamicToolResult {
  commandId: string;
  turnId: string;
  stepId: string;
  success: boolean;
  data?: JsonValue;
  error?: { code: string; message: string };
  matchedElement?: {
    role?: string;
    label?: string;
    testId?: string;
    strategy: "testId" | "ariaLabel" | "roleName" | "labelFuzzy" | "text" | "elementId";
    confidence: number;
  };
  durationMs: number;
}

export type SdkClientMessage =
  | (ClientMessageBase & { kind: "sable.sdk.client.ready"; catalogVersionId: string; currentUrl: string })
  | (ClientMessageBase & { kind: "sable.sdk.client.demo_control"; action: DemoControlAction })
  | (ClientMessageBase & {
      kind: "sable.sdk.client.restore_context";
      continuityId: string;
      transcript: RestoredTranscriptMessage[];
      journey?: RestoredJourneyCheckpoint;
      catalogNavigation?: RestoredCatalogNavigationCheckpoint;
    })
  | (ClientMessageBase & { kind: "sable.sdk.client.user_turn"; turnId: string; text: string; modality: "text" | "voice"; uiMap?: UIMapSnapshot })
  | (ClientMessageBase & { kind: "sable.sdk.client.observation"; observation: ScreenObservation; reason: "initial" | "changed" | "requested"; replyToCommandId?: string; turnId?: string })
  | (ClientMessageBase & {
      kind: "sable.sdk.client.journey_result";
      commandId: string;
      journeyId: string;
      ok: boolean;
      completedSteps: number;
      failedStepId?: string;
      detail?: string;
    })
  | (ClientMessageBase & { kind: "sable.sdk.client.catalog_navigation_result"; commandId: string; ok: boolean; detail?: string })
  | (ClientMessageBase & { kind: "sable.sdk.client.approval_result"; commandId: string; approved: boolean })
  | (ClientMessageBase & { kind: "sable.sdk.client.journey_progress"; commandId: string; journeyId: string; stepId: string; phase: "started" | "completed" | "failed" | "paused"; detail?: string })
  | (ClientMessageBase & { kind: "sable.sdk.client.journey_narration"; commandId: string; journeyId: string; stepId: string; turnId: string; utteranceId: string })
  | (ClientMessageBase & {
      kind: "sable.sdk.client.demo_narration";
      cueKind: "greeting" | "question" | "module_introduction" | "module_completion" | "module_failure" | "closing";
      turnId: string;
      utteranceId: string;
      moduleId?: string;
      questionId?: string;
    })
  | (ClientMessageBase & { kind: "sable.sdk.client.audio_playback"; utteranceId: string; turnId: string; sequence: number; state: "started" | "ended" | "cancelled" | "failed"; detail?: string })
  | (ClientMessageBase & { kind: "sable.sdk.client.interrupt"; reason: "user" | "navigation" | "logout" | "page_hidden" })
  | (ClientMessageBase & { kind: "sable.sdk.client.pong"; replyTo: string })
  | (ClientMessageBase & { kind: "sable.sdk.client.dynamic_tool_result"; result: DynamicToolResult });

interface ServerCommandBase {
  schemaVersion: typeof SDK_PROTOCOL_VERSION;
  commandId: string;
  sessionId: string;
  sentAt: string;
}

/**
 * Deliberately contains journey/tool identifiers, never selectors, executable
 * JavaScript, or unrestricted primitive browser actions.
 */
export type SdkServerCommand =
  | (ServerCommandBase & { kind: "sable.sdk.server.assistant_delta"; turnId: string; text: string })
  | (ServerCommandBase & {
      kind: "sable.sdk.server.assistant_final";
      turnId: string;
      text: string;
      suggestedJourneyIds?: string[];
    })
  | (ServerCommandBase & {
      kind: "sable.sdk.server.run_journey";
      turnId: string;
      catalogVersionId: string;
      journeyId: string;
      inputs: Record<string, JsonValue>;
      /** Optional signed top-level step window for one catalog-authorized action. */
      segment?: { startStepId: string; stopAfterStepId: string };
      /** A checkpoint previously emitted by this same SDK session. */
      resume?: { completedStepIds: string[]; nextStepId: string };
    })
  | (ServerCommandBase & {
      kind: "sable.sdk.server.run_catalog_navigation";
      turnId: string;
      catalogVersionId: string;
      sourceScreenId: string;
      controlId: string;
      targetScreenId: string;
    })
  | (ServerCommandBase & { kind: "sable.sdk.server.clear_catalog_navigation" })
  | (ServerCommandBase & {
      kind: "sable.sdk.server.restore_state";
      continuityId: string;
      revision: number;
      transcript: RestoredTranscriptMessage[];
    })
  | (ServerCommandBase & { kind: "sable.sdk.server.request_observation"; reason: string; turnId?: string })
  | (ServerCommandBase & { kind: "sable.sdk.server.pause_journey"; journeyId: string; reason: string })
  | (ServerCommandBase & { kind: "sable.sdk.server.stop_journey"; reason: string })
  | (ServerCommandBase & {
      kind: "sable.sdk.server.request_approval";
      journeyId: string;
      stepId: string;
      risk: RiskLevel;
      title: string;
      description: string;
    })
  | (ServerCommandBase & { kind: "sable.sdk.server.catalog_updated"; catalogVersionId: string; reloadRequired: boolean })
  | (ServerCommandBase & { kind: "sable.sdk.server.session_policy"; sdkDisabled: boolean; reason?: string })
  | (ServerCommandBase & {
      kind: "sable.sdk.server.demo_state";
      phase: DemoPhase;
      activeModuleId?: string;
      activeQuestionId?: string;
      canStart: boolean;
      canContinue: boolean;
      canRetry: boolean;
      canSkip: boolean;
      canStop: boolean;
    })
  | (ServerCommandBase & {
      kind: "sable.sdk.server.speak";
      turnId: string;
      text: string;
      voice?: string;
    })
  | (ServerCommandBase & { kind: "sable.sdk.server.ping" })
  | (ServerCommandBase & { kind: "sable.sdk.server.error"; code: string; message: string; retryable: boolean })
  | (ServerCommandBase & {
      kind: "sable.sdk.server.execute_dynamic_tool";
      turnId: string;
      stepId: string;
      tool: DynamicToolKind;
      target?: DynamicToolTarget;
      arguments: Record<string, JsonValue>;
      risk: RiskLevel;
      requiresConfirmation: boolean;
      reasoning?: string;
      title?: string;
    });

export type VoiceClientMessage =
  | { type: "voice.start"; languageCode: string; sampleRate: 16000; audioFrameMs: number }
  | { type: "voice.flush"; durationMs: number }
  | { type: "voice.cancel" };

export type VoiceServerMessage =
  | { type: "voice.ready" }
  | { type: "voice.listen"; turnId: string }
  | { type: "speech.start"; interrupted: boolean }
  | { type: "transcript.partial"; text: string }
  | { type: "transcript.final"; text: string; timing?: Record<string, number | null> }
  | { type: "voice.no_speech"; reason?: string }
  | { type: "voice.error"; message: string }
  | { type: "tts.chunk"; utteranceId: string; turnId: string; sequence: number; mime: string; base64Audio: string; text: string; gapMs: number; purpose: VoicePurpose; journeyId?: string; stepId?: string }
  | { type: "tts.end"; utteranceId: string; turnId: string; lastSequence: number | null; purpose: VoicePurpose }
  | { type: "tts.cancel"; reason: string };
