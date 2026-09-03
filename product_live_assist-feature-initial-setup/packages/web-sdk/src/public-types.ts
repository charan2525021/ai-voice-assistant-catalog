import type {
  DemoControlAction,
  JsonValue,
  ScreenObservation,
  SdkCatalog,
  SessionDescriptor,
} from "@sable/sdk-contracts";
import type { WorkflowRunResult } from "@sable/workflow-core";
import type { CatalogTrustKey } from "./catalog.js";
import type { PrivacyOverrides } from "./privacy.js";
import type { ApprovalHandler, ApprovalRequest, SafetyOptions } from "./safety.js";
import type { RegisteredTool } from "./tools.js";
import type { TokenProvider } from "./bootstrap.js";
import type { ContinuityClearReason, ContinuityOptions, ContinuityTranscriptMessage } from "./continuity.js";
import type { GuidedDemoPlaybackRequest, GuidedDemoRecordingLoader, GuidedDemoSnapshot } from "./guided-demo.js";

export type AgentLifecycleState = "initializing" | "ready" | "busy" | "stopped" | "disabled" | "failed" | "shutdown";

export type SableAgentEvent =
  | { type: "state"; state: AgentLifecycleState; detail?: string }
  | { type: "assistant"; turnId: string; text: string; partial: boolean }
  | { type: "narration"; turnId: string; journeyId: string; stepId: string; text: string }
  | { type: "demo"; snapshot: GuidedDemoSnapshot }
  | { type: "demo_utterance"; request: GuidedDemoPlaybackRequest }
  | { type: "observation"; observation: ScreenObservation }
  | { type: "journey"; journeyId: string; state: "started" | "paused" | "completed" | "failed" | "stopped"; result?: WorkflowRunResult; detail?: string }
  | { type: "approval"; phase: "requested" | "resolved"; request: ApprovalRequest; approved?: boolean }
  | { type: "speak"; turnId: string; text: string; voice?: string }
  | { type: "voice"; state: "idle" | "connecting" | "listening" | "processing" | "speaking" | "failed"; sessionActive: boolean; text?: string; final?: boolean; detail?: string }
  | { type: "catalog_update"; catalogVersionId: string; reloadRequired: boolean }
  | { type: "continuity"; state: "restored" | "cleared" | "navigation_preparing" | "resumed" | "resume_failed"; detail?: string; messageCount?: number; journeyId?: string; transcript?: ContinuityTranscriptMessage[] }
  | { type: "error"; code: string; message: string; retryable?: boolean };

export interface SableAgentSnapshot {
  state: AgentLifecycleState;
  session?: SessionDescriptor;
  catalog?: SdkCatalog;
  activeJourneyId?: string;
  voiceAvailable?: boolean;
  demo?: GuidedDemoSnapshot;
}

export interface SableAgentConfig {
  installationId: string;
  apiBaseUrl: string;
  tokenProvider: TokenProvider;
  catalogTrustKeys: CatalogTrustKey[];
  distribution?: "script" | "npm";
  tools?: RegisteredTool[];
  privacy?: PrivacyOverrides;
  safety?: SafetyOptions;
  approvalHandler?: ApprovalHandler;
  /** Enables Sable's built-in cloud voice. Custom UI hooks may still override capture/playback. */
  voice?: boolean;
  frameBridge?: boolean;
  fetcher?: typeof fetch;
  webSocketFactory?: (url: string, protocols: string[]) => WebSocket;
  /** Supplies recording bytes; the SDK verifies their signed SHA-256 digest before playback. */
  demoRecordingLoader?: GuidedDemoRecordingLoader;
  /** Same-browser cross-page and cross-tab continuity. Set false to disable; defaults to localStorage when available. */
  continuity?: false | ContinuityOptions;
  /**
   * Dynamic-mode UIMap streaming. When enabled (default), the SDK builds a
   * bounded semantic snapshot of visible interactive elements on each user
   * turn and includes it in the outgoing `user_turn` message. The cloud
   * runtime uses it only when the signed-catalog planner returns no match
   * AND the installation opts into dynamic fallback. Set false to disable
   * — the SDK will not send UIMaps and will refuse `execute_dynamic_tool`
   * commands even if the runtime issues them.
   */
  dynamicMode?: boolean;
}

export interface SableAgent {
  snapshot(): Readonly<SableAgentSnapshot>;
  subscribe(listener: (event: SableAgentEvent) => void): () => void;
  sendMessage(text: string, modality?: "text" | "voice"): void;
  startVoice(): Promise<void>;
  stopVoice(): Promise<void>;
  cancelSpeech(): void;
  controlDemo(action: DemoControlAction): void;
  observe(): Promise<ScreenObservation>;
  runJourney(journeyId: string, inputs?: Record<string, JsonValue>): Promise<WorkflowRunResult>;
  registerTool(tool: RegisteredTool): () => void;
  setApprovalHandler(handler: ApprovalHandler | undefined): void;
  getTranscript(): ContinuityTranscriptMessage[];
  clearContinuity(reason?: ContinuityClearReason): void;
  stop(reason?: "user" | "navigation" | "logout" | "page_hidden"): void;
  shutdown(): Promise<void>;
}
