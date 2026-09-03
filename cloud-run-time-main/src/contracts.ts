import type { JsonValue, RestoredCatalogNavigationCheckpoint, RestoredTranscriptMessage, SignedCatalogEnvelope } from "@sable/sdk-contracts";
import type { KnowledgeHit, RuntimeBundle, RuntimeScope } from "@sable/runtime-core";
import type { NeutralMessage } from "@sable/model-client";
import type { GuidedDemoSessionState } from "./demo-director.js";
import type { DemoInterruptionPlan } from "./demo-interruption-planner.js";
import type { DemoSalesPlayGrounding } from "./demo-sales-play-retriever.js";

export interface Installation {
  installationId: string;
  organizationId: string;
  productId: string;
  environmentId: string;
  credentialHash: string;
  allowedOrigins: string[];
  allowedRoles: string[];
  activeCatalogVersionId: string;
  guidedDemo?: { enabled: boolean };
  disabled?: boolean;
  voice?: Partial<{ languageCode: string; speaker: string; silenceTimeoutMs: number; minimumSpeechMs: number; maximumUtteranceMs: number; audioFrameMs: number; vadThreshold: number; autoStop: boolean; bargeIn: boolean; speakMode: "voice_turns" | "all" | "off"; stepNarration: boolean }>;
}

export interface KnowledgeChunk extends KnowledgeHit {
  tenantId: string;
  productId: string;
  catalogVersionId: string;
  embedding?: number[];
}
export interface RuntimeEvent { id: string; tenantId: string; installationId: string; sessionId?: string; type: string; occurredAt: string; detail?: Record<string, JsonValue>; }
export interface RuntimeSession { sessionId: string; installation: Installation; userId: string; role: string; origin: string; catalogVersionId: string; expiresAt: string; modality?: "text" | "voice"; guidedDemo?: GuidedDemoSessionState; }
export interface RuntimeContinuity {
  continuityId: string;
  organizationId: string;
  installationId: string;
  userId: string;
  role: string;
  catalogVersionId: string;
  messages: NeutralMessage[];
  transcript: RestoredTranscriptMessage[];
  guidedDemo?: GuidedDemoSessionState;
  pendingDemoInterruption?: {
    turnId: string;
    originalRequest: string;
    modality: "text" | "voice";
    plan?: DemoInterruptionPlan;
    grounding?: DemoSalesPlayGrounding;
  };
  pendingJourney?: {
    turnId: string;
    originalRequest: string;
    journeyId: string;
    inputs: Record<string, JsonValue>;
    presentationRequested: boolean;
    completedStepIds: string[];
    nextStepId?: string;
    segment?: { startStepId: string; stopAfterStepId: string };
    demoModuleId?: string;
  };
  pendingCatalogNavigation?: RestoredCatalogNavigationCheckpoint & {
    modality?: "text" | "voice";
    finalTargetScreenId?: string;
    remainingSteps?: Array<{ sourceScreenId: string; controlId: string; targetScreenId: string }>;
  };
  pendingCatalogPlan?: {
    turnId: string;
    originalRequest: string;
    modality: "text" | "voice";
    finalTargetScreenId: string;
    remainingSteps: Array<{ sourceScreenId: string; controlId: string; targetScreenId: string }>;
  };
  startedAt: string;
  updatedAt: string;
  expiresAt: string;
  revision: number;
}
export interface RuntimeHandoff {
  tokenHash: string;
  organizationId: string;
  installationId: string;
  userId: string;
  role: string;
  catalogVersionId: string;
  destinationOrigin: string;
  destinationUrl: string;
  snapshot: JsonValue;
  expiresAt: string;
}

export interface InstallationStore { get(installationId: string): Promise<Installation | undefined>; list(organizationId: string): Promise<Installation[]>; put(installation: Installation): Promise<void>; }
export interface RuntimeCatalogStore {
  get(versionId: string, installation: Installation): Promise<SignedCatalogEnvelope | undefined>;
  getBundle(scope: RuntimeScope): Promise<RuntimeBundle | undefined>;
}
export interface KnowledgeStore {
  search(scope: RuntimeScope, input: { query: string; embedding?: number[]; limit: number }): Promise<KnowledgeChunk[]>;
}
export interface SessionStore { put(session: RuntimeSession): Promise<void>; get(sessionId: string): Promise<RuntimeSession | undefined>; delete(sessionId: string): Promise<void>; }
export interface ContinuityStore {
  /** Compare-and-set when expectedRevision is supplied; false means a newer writer won. */
  put(value: RuntimeContinuity, expectedRevision?: number): Promise<boolean>;
  get(continuityId: string): Promise<RuntimeContinuity | undefined>;
  delete(continuityId: string): Promise<void>;
}
export interface HandoffStore { put(value: RuntimeHandoff): Promise<void>; consume(tokenHash: string): Promise<RuntimeHandoff | undefined>; }
export interface EventStore { append(event: RuntimeEvent): Promise<void>; }
export interface RuntimeStores { installations: InstallationStore; catalogs: RuntimeCatalogStore; knowledge: KnowledgeStore; sessions: SessionStore; continuities: ContinuityStore; handoffs: HandoffStore; events: EventStore; close(): Promise<void>; }

export interface SpeechToTextSession {
  push(pcm16: Buffer): void;
  finish(): void;
  cancel(): void;
}
export interface SpeechToTextProvider {
  open(options: {
    languageCode: string;
    sampleRate: 16_000;
    vocabulary?: string;
    onSpeechStart(): void;
    onPartial(text: string): void;
    onFinal(text: string, timing?: Record<string, number | null>): void;
    onNoSpeech(reason?: string): void;
    onError(error: Error): void;
  }): Promise<SpeechToTextSession>;
}
