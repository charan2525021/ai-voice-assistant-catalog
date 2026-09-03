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
  | (ClientMessageBase & { kind: "sable.sdk.client.user_turn"; turnId: string; text: string; modality: "text" | "voice" })
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
  | (ClientMessageBase & { kind: "sable.sdk.client.pong"; replyTo: string });

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
  | (ServerCommandBase & { kind: "sable.sdk.server.error"; code: string; message: string; retryable: boolean });

export type VoiceClientMessage =
  | { type: "voice.start"; languageCode: string; sampleRate: 16000; audioFrameMs: number }
  | { type: "voice.flush"; durationMs: number }
  | { type: "voice.cancel" }
  /** Browser acoustic evidence only. The server commits interruption after transcript validation. */
  | { type: "voice.barge_in" };

export type VoiceServerMessage =
  | { type: "voice.ready" }
  | { type: "voice.listen"; turnId: string }
  /** STT-side acoustic evidence. The SDK may soft-pause, but must not discard playback yet. */
  | { type: "speech.candidate"; source: "sidecar_vad" }
  /** Acknowledges browser acoustic evidence while STT continues collecting the utterance. */
  | { type: "speech.pending"; source: "browser_vad" }
  /** The final transcript passed echo/noise rejection and now authoritatively interrupts playback. */
  | { type: "speech.confirmed"; interrupted: boolean }
  | { type: "transcript.partial"; text: string }
  | { type: "transcript.final"; text: string; timing?: Record<string, number | null> }
  | { type: "voice.no_speech"; reason?: string }
  | { type: "voice.error"; message: string }
  | { type: "tts.chunk"; utteranceId: string; turnId: string; sequence: number; mime: string; base64Audio: string; text: string; gapMs: number; purpose: VoicePurpose; journeyId?: string; stepId?: string }
  | { type: "tts.end"; utteranceId: string; turnId: string; lastSequence: number | null; purpose: VoicePurpose }
  | { type: "tts.cancel"; reason: string };
