import {
  canonicalizeJson,
  SDK_PROTOCOL_VERSION,
  type DemoControlAction,
  type JsonValue,
  type JourneyDefinition,
  type SdkClientMessage,
  type SdkServerCommand,
  type ToolDefinition,
  type WorkflowStep,
} from "@sable/sdk-contracts";
import {
  WorkflowExecutor,
  type ApprovalGate,
  type WorkflowPolicyGate,
  type WorkflowRunResult,
} from "@sable/workflow-core";
import { BrowserActionDriver, classifyBrowserNavigation, type BrowserDocumentNavigationRequest } from "./action-driver.js";
import { SessionBootstrapClient } from "./bootstrap.js";
import { SignedCatalogClient } from "./catalog.js";
import { SableSdkError } from "./errors.js";
import { DomScreenObserver } from "./observer.js";
import { PrivacyEngine } from "./privacy.js";
import type { AgentLifecycleState, SableAgent, SableAgentConfig, SableAgentEvent, SableAgentSnapshot } from "./public-types.js";
import { ScreenRecognizer } from "./recognizer.js";
import { RankedElementResolver } from "./resolver.js";
import { DeterministicSafetyPolicy, type ApprovalHandler, type ApprovalRequest } from "./safety.js";
import { TelemetryClient } from "./telemetry.js";
import { ToolRegistry } from "./tools.js";
import { WebSocketCommandTransport } from "./transport.js";
import { isRecord, normalizeSpace, randomId, sleep } from "./utils.js";
import { CloudVoiceClient } from "./voice.js";
import { GuidedDemoController, VerifiedDemoAudioPlayer, isAtomicDemoBoundary, isGuidedDemoActive, type GuidedDemoPlaybackCue, type GuidedDemoSnapshot } from "./guided-demo.js";
import { isHtmlAnchorElement } from "./dom.js";
import {
  BrowserContinuityStore,
  DEFAULT_REASONING_MESSAGES,
  attachHandoffToken,
  consumeContinuityHandoff,
  createContinuityHandoff,
  defaultContinuityStorage,
  scopeFromSession,
  takeHandoffToken,
  type ContinuityClearReason,
  type ContinuityJourneyCheckpoint,
} from "./continuity.js";

type ClientMessageBody = SdkClientMessage extends infer Message
  ? Message extends SdkClientMessage ? Omit<Message, "schemaVersion" | "messageId" | "sessionId" | "sentAt"> : never
  : never;

function endpoint(base: string, path: string): string {
  return new URL(path.replace(/^\//, ""), base.endsWith("/") ? base : `${base}/`).toString();
}

function guidedDemoStepDelay(step: WorkflowStep): number {
  void step;
  return 100;
}

function validateInputs(journey: JourneyDefinition, inputs: Record<string, JsonValue>): void {
  const schema = journey.inputSchema;
  for (const key of schema.required) if (!(key in inputs)) throw new SableSdkError("COMMAND_INVALID", `Journey input ${key} is required`);
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(inputs)) if (!(key in schema.properties)) throw new SableSdkError("COMMAND_INVALID", `Journey input ${key} is not declared`);
  }
  for (const [key, value] of Object.entries(inputs)) {
    const property = schema.properties[key];
    if (!property) continue;
    const typeOk = property.type === "json"
      || (property.type === "string" && typeof value === "string")
      || (property.type === "number" && typeof value === "number" && Number.isFinite(value))
      || (property.type === "boolean" && typeof value === "boolean")
      || (property.type === "enum" && !!property.enum?.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value)));
    if (!typeOk) throw new SableSdkError("COMMAND_INVALID", `Journey input ${key} has the wrong type`);
    if (typeof value === "string") {
      if (property.minimumLength !== undefined && value.length < property.minimumLength) throw new SableSdkError("COMMAND_INVALID", `Journey input ${key} is too short`);
      if (property.maximumLength !== undefined && value.length > property.maximumLength) throw new SableSdkError("COMMAND_INVALID", `Journey input ${key} is too long`);
      if (property.pattern) {
        try { if (!new RegExp(property.pattern).test(value)) throw new SableSdkError("COMMAND_INVALID", `Journey input ${key} has an invalid format`); }
        catch (error) { if (error instanceof SableSdkError) throw error; throw new SableSdkError("CATALOG_INVALID", `Journey input pattern for ${key} is invalid`); }
      }
    } else if (typeof value === "number") {
      if (property.minimum !== undefined && value < property.minimum) throw new SableSdkError("COMMAND_INVALID", `Journey input ${key} is too small`);
      if (property.maximum !== undefined && value > property.maximum) throw new SableSdkError("COMMAND_INVALID", `Journey input ${key} is too large`);
    }
  }
}

function toolForStep(step: WorkflowStep, tools: ToolDefinition[]): ToolDefinition | undefined {
  if (step.kind !== "action" || step.action !== "tool_call") return undefined;
  return tools.find((tool) => tool.name === step.toolName);
}

function indexSteps(steps: WorkflowStep[], target = new Map<string, WorkflowStep>()): Map<string, WorkflowStep> {
  for (const step of steps) {
    target.set(step.id, step);
    if (step.kind === "approval") indexSteps(step.then, target);
    else if (step.kind === "branch") {
      indexSteps(step.then, target);
      indexSteps(step.otherwise ?? [], target);
    } else if (step.kind === "loop") indexSteps(step.steps, target);
  }
  return target;
}

class RuntimeAgent implements SableAgent {
  private state: AgentLifecycleState = "initializing";
  private listeners = new Set<(event: SableAgentEvent) => void>();
  private observer?: DomScreenObserver;
  private recognizer?: ScreenRecognizer;
  private transport?: WebSocketCommandTransport;
  private telemetry?: TelemetryClient;
  private bootstrapClient?: SessionBootstrapClient;
  private tools?: ToolRegistry;
  private policy?: DeterministicSafetyPolicy;
  private resolver?: RankedElementResolver;
  private driver?: BrowserActionDriver;
  private executor?: WorkflowExecutor;
  private current: SableAgentSnapshot = { state: "initializing" };
  private activeController?: AbortController;
  private activeJourneyId?: string;
  private shutdownStarted?: Promise<void>;
  private sessionExpiryTimer?: number;
  private approvalHandler?: ApprovalHandler;
  private assistantText = new Map<string, string>();
  private voice?: CloudVoiceClient;
  private guidedDemo?: GuidedDemoController;
  private demoAudioPlayer?: VerifiedDemoAudioPlayer;
  private demoPlaybackController?: AbortController;
  private demoPlaybackQueue: Promise<void> = Promise.resolve();
  private demoPlaybackGeneration = 0;
  private activeCommandId?: string;
  private activeTurnId?: string;
  private pauseRequested = false;
  /** A finished journey whose closing cue has not yet yielded control to the cloud. */
  private pendingJourneyResult?: {
    command: Extract<SdkServerCommand, { kind: "sable.sdk.server.run_journey" }>;
    result: WorkflowRunResult;
  };
  private continuity?: BrowserContinuityStore;
  private pendingDocumentNavigation = false;
  private runningJourney?: {
    journey: JourneyDefinition;
    inputs: Record<string, JsonValue>;
    completedStepIds: Set<string>;
    topLevelIndex: number;
    stopAfterStepId?: string;
  };
  private pausedJourney?: {
    journeyId: string;
    catalogVersionId: string;
    inputs: Record<string, JsonValue>;
    completedStepIds: string[];
    nextStepId: string;
    nextStepIndex: number;
    stopAfterStepId?: string;
  };

  constructor(private readonly config: SableAgentConfig, private readonly onShutdown: () => void) {
    this.approvalHandler = config.approvalHandler;
  }

  async initialize(): Promise<this> {
    const bootstrapAbort = new AbortController();
    const handoffToken = takeHandoffToken();
    try {
      this.bootstrapClient = new SessionBootstrapClient({
        apiBaseUrl: this.config.apiBaseUrl,
        installationId: this.config.installationId,
        tokenProvider: this.config.tokenProvider,
        distribution: this.config.distribution ?? "npm",
        registeredTools: (this.config.tools ?? []).map((tool) => tool.definition.name),
        voice: this.config.voice ?? false,
        frameBridge: this.config.frameBridge ?? false,
        fetcher: this.config.fetcher,
        signal: bootstrapAbort.signal,
      });
      const bootstrap = await this.bootstrapClient.create();
      const catalogClient = new SignedCatalogClient(this.config.catalogTrustKeys, undefined, this.config.fetcher);
      const loaded = await catalogClient.load({
        source: bootstrap.catalog,
        sessionToken: bootstrap.session.sessionToken,
        expectedCatalogVersionId: bootstrap.session.catalogVersionId,
        expectedScope: {
          organizationId: bootstrap.session.organizationId,
          productId: bootstrap.session.productId,
          environmentId: bootstrap.session.environmentId,
          roleProfileId: bootstrap.session.roleProfileId,
          origin: bootstrap.session.origin,
        },
        signal: bootstrapAbort.signal,
      });
      const catalog = loaded.catalog;
      this.guidedDemo = new GuidedDemoController(catalog);
      if (this.config.demoRecordingLoader) this.demoAudioPlayer = new VerifiedDemoAudioPlayer(this.config.demoRecordingLoader);
      const continuityStorage = this.config.continuity === false ? undefined : this.config.continuity?.storage ?? defaultContinuityStorage();
      if (continuityStorage) {
        this.continuity = new BrowserContinuityStore(scopeFromSession(bootstrap.session), continuityStorage, this.config.continuity || {}, bootstrap.session.continuityId);
        if (handoffToken) {
          try {
            const transferred = await consumeContinuityHandoff(
              this.config.apiBaseUrl,
              bootstrap.session.sessionToken,
              handoffToken,
              globalThis.location.href,
              this.config.fetcher,
            );
            this.continuity.replace(transferred);
          } catch (error) {
            this.emit({ type: "continuity", state: "resume_failed", detail: error instanceof Error ? error.message : "Cross-origin handoff failed" });
          }
        }
        const restored = this.continuity.load();
        if (restored.cleared) this.emit({ type: "continuity", state: "cleared", detail: restored.cleared });
      }
      const privacy = new PrivacyEngine(catalog.privacyPolicy, this.config.privacy);
      this.tools = new ToolRegistry(catalog.tools);
      for (const tool of this.config.tools ?? []) this.tools.register(tool);
      this.policy = new DeterministicSafetyPolicy(this.config.safety);
      this.installApprovalBridge();
      this.telemetry = new TelemetryClient({
        endpoint: endpoint(this.config.apiBaseUrl, "api/v3/sdk/events"),
        session: bootstrap.session,
        policy: catalog.telemetryPolicy,
        privacy,
        fetcher: this.config.fetcher,
      });
      this.observer = new DomScreenObserver(privacy);
      const recognizer = new ScreenRecognizer(catalog);
      this.recognizer = recognizer;
      const resolver = new RankedElementResolver(catalog, privacy, document, (resolution) => {
        this.telemetry?.record({ type: "element.resolved", ...resolution });
      });
      this.resolver = resolver;
      this.driver = new BrowserActionDriver(this.observer, resolver, recognizer, this.tools, privacy, {
        onBeforeDocumentNavigation: (request) => this.prepareDocumentNavigation(request),
      });
      this.executor = new WorkflowExecutor(this.driver);
      this.transport = new WebSocketCommandTransport({
        websocketUrl: bootstrap.transport.websocketUrl,
        oneTimeTicket: bootstrap.transport.oneTimeTicket,
        ticketExpiresAt: bootstrap.transport.expiresAt,
        session: bootstrap.session,
        privacy,
        webSocketFactory: this.config.webSocketFactory,
      });
      this.transport.onCommand((command) => this.handleCommand(command));
      this.transport.onState((state, detail) => {
        this.telemetry?.record({ type: "transport.state", state: state === "closed" ? "disconnected" : state === "idle" ? "disconnected" : state, detail });
        if ((state === "disconnected" || state === "failed") && (this.state === "ready" || this.state === "busy")) {
          this.activeController?.abort("transport disconnected");
          const message = detail || "Live assistant connection was lost; reinitialize to continue";
          this.setState("failed", message);
          this.emit({ type: "error", code: "TRANSPORT_FAILED", message, retryable: true });
        }
      });
      await this.transport.connect(bootstrapAbort.signal);
      this.observer.start();
      this.observer.subscribe((observation) => {
        const enriched = recognizer.enrich(observation);
        this.emit({ type: "observation", observation: enriched });
        this.telemetry?.record({ type: "screen.matched", screenId: enriched.matchedScreenId, confidence: enriched.matchConfidence ?? 0, fingerprint: observation.fingerprint });
        if (this.transport?.state === "connected") this.transport.send(this.message({
          kind: "sable.sdk.client.observation",
          observation: enriched,
          reason: "changed",
        }));
      });
      const initialObservation = await this.observer.observe();
      const initial = recognizer.enrich(initialObservation);
      this.current = {
        state: "ready",
        session: bootstrap.session,
        catalog,
        voiceAvailable: !!bootstrap.voiceTransport,
        demo: this.guidedDemo.snapshot(),
      };
      const restored = this.continuity ? (this.continuity.current() ?? this.continuity.ensure()) : undefined;
      if (restored?.journey) {
        const checkpoint = restored.journey;
        const journey = catalog.journeys.find((candidate) => candidate.id === checkpoint.journeyId && candidate.version === checkpoint.journeyVersion && candidate.state === "approved");
        const correctDestination = checkpoint.destinationUrl === initial.url;
        const correctScreen = !!initial.matchedScreenId && checkpoint.expectedScreenIds.includes(initial.matchedScreenId);
        const nextStep = journey && indexSteps(journey.workflow.steps).get(checkpoint.nextStepId);
        if (journey && journey.risk === "read" && correctDestination && correctScreen && nextStep) {
          this.pausedJourney = {
            journeyId: checkpoint.journeyId,
            catalogVersionId: bootstrap.session.catalogVersionId,
            inputs: structuredClone(checkpoint.inputs),
            completedStepIds: [...checkpoint.completedStepIds],
            nextStepId: checkpoint.nextStepId,
            nextStepIndex: checkpoint.nextStepIndex,
            ...(checkpoint.stopAfterStepId ? { stopAfterStepId: checkpoint.stopAfterStepId } : {}),
          };
        } else {
          this.continuity?.setJourney(undefined);
          this.emit({ type: "continuity", state: "resume_failed", journeyId: checkpoint.journeyId, detail: "Destination page, catalog, or screen did not match the saved journey" });
        }
      }
      if (restored?.catalogNavigation) {
        const checkpoint = restored.catalogNavigation;
        const control = catalog.controls.find((candidate) => candidate.id === checkpoint.controlId && candidate.screenId === checkpoint.sourceScreenId && candidate.risk === "read");
        const target = catalog.screens.find((candidate) => candidate.id === checkpoint.targetScreenId && (!candidate.roles?.length || candidate.roles.includes(bootstrap.session.roleProfileId)));
        const valid = !!control && !!target && checkpoint.destinationUrl === initial.url
          && initial.matchedScreenId === checkpoint.targetScreenId
          && recognizer.destinationMatchesScreen(checkpoint.targetScreenId, checkpoint.destinationUrl);
        if (!valid) {
          this.continuity?.setCatalogNavigation(undefined);
          this.emit({ type: "continuity", state: "resume_failed", detail: "Catalog navigation destination did not match the saved trained screen" });
        }
      }
      if (bootstrap.voiceTransport) {
        this.voice = new CloudVoiceClient(bootstrap.voiceTransport, {
          onState: (state, detail, sessionActive) => this.emit({ type: "voice", state, sessionActive, detail }),
          onTranscript: (text, final) => {
            this.emit({ type: "voice", state: final ? "processing" : "listening", sessionActive: this.voice?.active ?? false, text, final });
            if (final && text.trim()) this.sendMessage(text, "voice");
          },
          onPlayback: (value) => {
            if (this.transport?.state !== "connected") return;
            this.transport.send(this.message({ kind: "sable.sdk.client.audio_playback", ...value }));
          },
          onBargeIn: () => {
            // The 120 ms browser VAD signal already stopped streamed TTS.
            // Pause the guided journey locally at its next atomic boundary as
            // well, without waiting for STT endpointing or a final transcript.
            this.requestDemoPause();
          },
        }, this.config.webSocketFactory);
        // Connect while the bootstrap ticket is fresh; microphone permission is
        // still requested only after the user explicitly taps the mic.
        await this.voice.connect(bootstrapAbort.signal);
      }
      this.setState("ready", "Ready");
      this.telemetry.record({ type: "catalog.loaded", source: loaded.source, version: catalog.manifest.version });
      this.telemetry.record({ type: "session.started" });
      this.telemetry.record({ type: "screen.matched", screenId: initial.matchedScreenId, confidence: initial.matchConfidence ?? 0, fingerprint: initial.fingerprint });
      this.emit({ type: "observation", observation: initial });
      this.transport.send(this.message({
        kind: "sable.sdk.client.ready",
        catalogVersionId: catalog.manifest.catalogVersionId,
        currentUrl: initial.url,
      }));
      if (restored) {
        const journey = this.pausedJourney && restored.journey ? {
          journeyId: restored.journey.journeyId,
          journeyVersion: restored.journey.journeyVersion,
          turnId: restored.journey.turnId,
          originalRequest: restored.journey.originalRequest,
          inputs: restored.journey.inputs,
          completedStepIds: restored.journey.completedStepIds,
          nextStepId: restored.journey.nextStepId,
          navigationStepId: restored.journey.navigationStepId,
          destinationUrl: restored.journey.destinationUrl,
          expectedScreenIds: restored.journey.expectedScreenIds,
          ...(restored.journey.stopAfterStepId ? { stopAfterStepId: restored.journey.stopAfterStepId } : {}),
        } : undefined;
        const catalogNavigation = restored.catalogNavigation && this.continuity?.current()?.catalogNavigation
          ? structuredClone(restored.catalogNavigation)
          : undefined;
        this.transport.send(this.message({
          kind: "sable.sdk.client.restore_context",
          continuityId: restored.continuityId,
          transcript: restored.transcript.slice(-DEFAULT_REASONING_MESSAGES),
          ...(journey ? { journey } : {}),
          ...(catalogNavigation ? { catalogNavigation } : {}),
        }));
        this.emit({ type: "continuity", state: "restored", messageCount: restored.transcript.length, journeyId: journey?.journeyId });
      }
      this.transport.send(this.message({ kind: "sable.sdk.client.observation", observation: initial, reason: "initial" }));
      const expiresIn = Math.max(0, Date.parse(bootstrap.session.expiresAt) - Date.now());
      this.sessionExpiryTimer = globalThis.setTimeout(() => {
        this.activeController?.abort("session expired");
        this.clearContinuity("expired");
        this.setState("disabled", "Session expired; refresh authentication to continue");
        this.transport?.close(1000, "session expired");
      }, Math.min(expiresIn, 2_147_483_647));
      return this;
    } catch (error) {
      bootstrapAbort.abort();
      this.setState("failed", error instanceof Error ? error.message : String(error));
      await this.cleanup(false, false);
      throw error;
    }
  }

  snapshot(): Readonly<SableAgentSnapshot> {
    return {
      ...this.current,
      state: this.state,
      activeJourneyId: this.activeJourneyId,
      ...(this.guidedDemo ? { demo: this.guidedDemo.snapshot() } : {}),
    };
  }

  subscribe(listener: (event: SableAgentEvent) => void): () => void {
    this.listeners.add(listener);
    listener({ type: "state", state: this.state });
    return () => this.listeners.delete(listener);
  }

  sendMessage(text: string, modality: "text" | "voice" = "text"): void {
    const normalized = normalizeSpace(text);
    if (!normalized || normalized.length > 10_000) throw new SableSdkError("COMMAND_INVALID", "Message must contain 1–10,000 characters");
    this.ensureUsable();
    this.requestDemoPause();
    const turnId = randomId("turn");
    this.continuity?.appendMessage({ key: `user:${turnId}`, role: "user", text: normalized });
    this.transport?.send(this.message({ kind: "sable.sdk.client.user_turn", turnId, text: normalized, modality }));
    // Preserve WebSocket order: the cloud must see the user's interruption
    // before it sees that the journey completed underneath the closing cue.
    this.flushPendingJourneyResult();
  }

  async startVoice(): Promise<void> {
    this.ensureUsable();
    if (!this.voice) throw new SableSdkError("POLICY_BLOCKED", "Voice is not enabled for this installation");
    if (this.config.voice !== true) throw new SableSdkError("POLICY_BLOCKED", "Built-in voice was not enabled by the host");
    // During a journey, barge-in pauses at the next top-level step boundary.
    // It does not abort the action currently in flight.
    const activeDemo = isGuidedDemoActive(this.guidedDemo?.snapshot());
    const demoPauseRequested = this.requestDemoPause();
    if (this.activeController) {
      if (!demoPauseRequested) this.pauseRequested = true;
    } else if (!demoPauseRequested && !activeDemo) this.stopLocal("user", true);
    try { await this.voice.start(); }
    catch (error) { this.pauseRequested = false; throw error; }
  }

  async stopVoice(): Promise<void> {
    await this.voice?.stop(true);
  }

  cancelSpeech(): void {
    this.voice?.cancelPlayback();
  }

  controlDemo(action: DemoControlAction): void {
    this.ensureUsable();
    if (!this.guidedDemo || !this.guidedDemo.snapshot().enabled) throw new SableSdkError("POLICY_BLOCKED", "Guided demo is not available in this signed catalog");
    let snapshot: GuidedDemoSnapshot;
    try {
      if (action === "start") this.voice?.unlockPlayback();
      snapshot = this.guidedDemo.request(action);
    }
    catch (error) { throw new SableSdkError("POLICY_BLOCKED", error instanceof Error ? error.message : String(error)); }
    this.updateDemo(snapshot);
    if (action === "stop") {
      this.demoPlaybackGeneration += 1;
      this.demoPlaybackController?.abort("guided demo stopped");
      this.cancelSpeech();
      this.activeController?.abort("guided demo stopped");
      this.pauseRequested = false;
      this.pausedJourney = undefined;
    }
    this.transport?.send(this.message({ kind: "sable.sdk.client.demo_control", action }));
  }

  async observe() {
    this.ensureUsable();
    if (!this.observer || !this.recognizer) throw new Error("observer is not ready");
    return this.recognizer.enrich(await this.observer.observe());
  }

  async runJourney(journeyId: string, inputs: Record<string, JsonValue> = {}, startAt = 0, resumedCompletedStepIds: string[] = [], endAtExclusive?: number, stopAfterStepId?: string): Promise<WorkflowRunResult> {
    this.ensureUsable();
    if (this.activeController) throw new SableSdkError("POLICY_BLOCKED", "Another journey is already running");
    const catalog = this.current.catalog;
    if (!catalog) throw new Error("catalog is not ready");
    const journey = catalog?.journeys.find((candidate) => candidate.id === journeyId);
    if (!journey || journey.state !== "approved") throw new SableSdkError("JOURNEY_NOT_FOUND", `Approved journey ${journeyId} is not in the pinned catalog`);
    if (this.current.session && journey.roles.length && !journey.roles.includes(this.current.session.roleProfileId)) {
      throw new SableSdkError("POLICY_BLOCKED", "Journey is not approved for this user's role");
    }
    validateInputs(journey, inputs);
    if (!this.executor || !this.driver || !this.policy || !this.tools) throw new Error("journey runtime is not ready");
    this.activeController = new AbortController();
    this.pauseRequested = false;
    this.activeJourneyId = journeyId;
    this.driver.setJourneyContext(journeyId);
    const stepsById = indexSteps(journey.workflow.steps);
    const completedStepIds = new Set(resumedCompletedStepIds);
    this.runningJourney = { journey, inputs: structuredClone(inputs), completedStepIds, topLevelIndex: startAt, ...(stopAfterStepId ? { stopAfterStepId } : {}) };
    this.setState("busy", `Running ${journey.name}`);
    this.emit({ type: "journey", journeyId, state: "started" });
    this.telemetry?.record({ type: "journey.started", journeyId });

    const policy: WorkflowPolicyGate = {
      authorize: async (context) => {
        const decision = await this.policy!.authorize(context.step, context.workflow);
        if (!decision.allowed) return decision;
        const tool = toolForStep(context.step, catalog.tools);
        if (context.step.compatibility.classification === "NEEDS_REGISTERED_TOOL") {
          if (!tool || !this.tools!.has(tool.name)) return { allowed: false, reason: context.step.compatibility.reason || "Required client tool is not registered" };
        }
        if (context.step.kind !== "approval" && !context.approvalGranted && this.policy!.shouldConfirm(context.step, context.workflow, tool)) {
          return {
            allowed: true,
            requiresApproval: true,
            approvalReason: context.step.narration || `Allow ${context.workflow.name} to continue?`,
          };
        }
        return { allowed: true };
      },
    };
    const approvals: ApprovalGate = {
      request: (context, signal) => this.policy!.confirm(context.step, context.workflow, context.reason, signal),
    };
    try {
      const result = await this.executor.execute(journey.workflow, {
        inputs,
        signal: this.activeController.signal,
        policy,
        approvals,
        telemetry: {
          record: (event) => {
            if (!["step_started", "step_completed", "step_failed"].includes(event.type) || !event.stepId) return;
            const step = stepsById.get(event.stepId);
            if (!step) return;
            if (event.type === "step_completed") completedStepIds.add(step.id);
            if (this.activeCommandId && this.transport?.state === "connected") {
              this.transport.send(this.message({
                kind: "sable.sdk.client.journey_progress", commandId: this.activeCommandId,
                journeyId, stepId: step.id,
                phase: event.type === "step_started" ? "started" : event.type === "step_completed" ? "completed" : "failed",
                detail: event.detail,
              }));
            }
            if (step.kind === "action" && event.type !== "step_started") this.telemetry?.record({
              type: "action.completed", journeyId, stepId: step.id, action: step.action,
              compatibility: step.compatibility.classification,
              ok: event.type === "step_completed", detail: event.detail,
            });
          },
        },
        startAt,
        ...(endAtExclusive === undefined ? {} : { endAtExclusive }),
        onStep: async (step, topLevelIndex) => {
          if (this.runningJourney) this.runningJourney.topLevelIndex = topLevelIndex;
          // Nested steps belong to one atomic top-level block. Resuming at a
          // nested ID would rerun its parent branch/loop and could repeat UI
          // actions, so a checkpoint is created only before a top-level step.
          const isTopLevelBoundary = isAtomicDemoBoundary(journey.workflow.steps, step, topLevelIndex);
          if (this.pauseRequested && isTopLevelBoundary) {
            this.pauseRequested = false;
            this.pausedJourney = {
              journeyId,
              catalogVersionId: this.current.session!.catalogVersionId,
              inputs: structuredClone(inputs),
              completedStepIds: [...completedStepIds],
              nextStepId: step.id,
              nextStepIndex: topLevelIndex,
              ...(this.runningJourney?.stopAfterStepId ? { stopAfterStepId: this.runningJourney.stopAfterStepId } : {}),
            };
            if (this.guidedDemo?.snapshot().phase === "pausing") {
              try {
                this.updateDemo(this.guidedDemo.checkpointJourney({
                  journeyId,
                  catalogVersionId: this.current.session!.catalogVersionId,
                  completedStepIds: [...completedStepIds],
                  nextStepId: step.id,
                  nextStepIndex: topLevelIndex,
                }));
              } catch (error) {
                this.emit({ type: "error", code: "DEMO_CHECKPOINT_INVALID", message: error instanceof Error ? error.message : String(error), retryable: false });
              }
            }
            if (this.activeCommandId && this.transport?.state === "connected") this.transport.send(this.message({
              kind: "sable.sdk.client.journey_progress", commandId: this.activeCommandId,
              journeyId, stepId: step.id, phase: "paused", detail: "Paused for user interruption",
            }));
            this.activeController?.abort("paused for voice");
            return;
          }
        },
        onStepCompleted: async (step, topLevelIndex) => {
          if (isGuidedDemoActive(this.guidedDemo?.snapshot())) {
            await sleep(guidedDemoStepDelay(step), this.activeController?.signal);
          }
          // The original voice pipeline's AudioSync contract remains the source
          // of truth: narration waits for real browser playback. The important
          // ordering change is that catalog narration is requested only after
          // the SDK action/assertion has completed successfully, so Sable never
          // explains a destination before the browser has moved there.
          if (step.narration && this.voice && this.activeCommandId && this.activeTurnId && this.transport?.state === "connected") {
            const utteranceId = randomId("utterance");
            const played = this.voice.waitForUtterance(utteranceId);
            // The narration is signed catalog content already available to the
            // SDK. Emit the exact same text that is about to be synthesized so
            // the visible transcript and spoken walkthrough cannot diverge.
            this.emit({
              type: "narration",
              turnId: this.activeTurnId,
              journeyId,
              stepId: step.id,
              text: step.narration,
            });
            this.continuity?.appendMessage({
              key: `assistant:${this.activeTurnId}:journey:${journeyId}:${step.id}`,
              role: "assistant",
              text: step.narration,
            });
            this.transport.send(this.message({
              kind: "sable.sdk.client.journey_narration",
              commandId: this.activeCommandId,
              journeyId,
              stepId: step.id,
              turnId: this.activeTurnId,
              utteranceId,
            }));
            const outcome = await played;
            if (outcome === "failed") throw new Error(`Narration audio failed for step ${step.id}`);
            if (outcome === "interrupted" && !this.activeController?.signal.aborted) {
              // The browser action finished, but its explanation did not. Do
              // not let "audio was cancelled" masquerade as "step narrated".
              // Resume from the owning top-level block so the signed narration
              // is offered again instead of completing or advancing silently.
              const resumeStep = journey.workflow.steps[topLevelIndex] ?? step;
              completedStepIds.delete(step.id);
              completedStepIds.delete(resumeStep.id);
              this.pauseRequested = false;
              this.pausedJourney = {
                journeyId,
                catalogVersionId: this.current.session!.catalogVersionId,
                inputs: structuredClone(inputs),
                completedStepIds: [...completedStepIds],
                nextStepId: resumeStep.id,
                nextStepIndex: topLevelIndex,
                ...(this.runningJourney?.stopAfterStepId ? { stopAfterStepId: this.runningJourney.stopAfterStepId } : {}),
              };
              if (this.guidedDemo?.snapshot().phase === "pausing") {
                this.updateDemo(this.guidedDemo.checkpointJourney({
                  journeyId,
                  catalogVersionId: this.current.session!.catalogVersionId,
                  completedStepIds: [...completedStepIds],
                  nextStepId: resumeStep.id,
                  nextStepIndex: topLevelIndex,
                }));
              }
              if (this.activeCommandId && this.transport?.state === "connected") this.transport.send(this.message({
                kind: "sable.sdk.client.journey_progress", commandId: this.activeCommandId,
                journeyId, stepId: resumeStep.id, phase: "paused", detail: "Narration interrupted by accepted user speech",
              }));
              this.activeController?.abort("narration interrupted by voice");
            }
          }
        },
        maxExecutedSteps: 200,
        maxLoopIterations: 20,
        maxDurationMs: 120_000,
      });
      if (this.pausedJourney?.journeyId === journeyId && this.activeController.signal.aborted) {
        this.emit({ type: "journey", journeyId, state: "paused", result, detail: "Paused. Say or press Continue when ready." });
        return result;
      }
      if (this.pendingDocumentNavigation) {
        this.emit({ type: "journey", journeyId, state: "paused", result, detail: "Continuing on the destination page" });
        return result;
      }
      if (result.ok) this.pausedJourney = undefined;
      if (result.ok) this.continuity?.setJourney(undefined);
      const state = result.ok ? "completed" : this.activeController.signal.aborted ? "stopped" : "failed";
      this.emit({ type: "journey", journeyId, state, result, detail: result.error });
      this.telemetry?.record({
        type: result.ok ? "journey.completed" : "journey.failed",
        journeyId,
        completedSteps: result.completedSteps,
        detail: result.error,
      });
      return result;
    } finally {
      this.runningJourney = undefined;
      this.activeController = undefined;
      this.activeJourneyId = undefined;
      if (!(["disabled", "failed", "shutdown"] as AgentLifecycleState[]).includes(this.state)) this.setState("ready", "Ready");
    }
  }

  private async prepareDocumentNavigation(request: BrowserDocumentNavigationRequest): Promise<string | false> {
    const running = this.runningJourney;
    const session = this.current.session;
    if (!running || !session || !this.continuity) return false;
    if (running.journey.risk !== "read") return false;
    const step = running.journey.workflow.steps[running.topLevelIndex];
    if (!step || step.id !== request.action.stepId || step.kind !== "action" || step.action !== "navigate") return false;
    if (step.compatibility.classification !== "SDK_RESUMABLE_NAVIGATION" || !step.continuity) return false;
    const destination = new URL(request.destinationUrl);
    if (!step.continuity.destinationOrigins.includes(destination.origin)) return false;
    const nextStep = running.journey.workflow.steps[running.topLevelIndex + 1];
    if (!nextStep) return false;
    for (const [name, property] of Object.entries(running.journey.inputSchema.properties)) {
      if (property.secret && running.inputs[name] !== undefined) return false;
    }
    const transcript = this.continuity.messages();
    const originalRequest = [...transcript].reverse().find((message) => message.role === "user")?.text ?? `Continue ${running.journey.name}`;
    const turnId = this.activeTurnId ?? randomId("turn");
    const completedStepIds = [...new Set([...running.completedStepIds, step.id])];
    const checkpoint: ContinuityJourneyCheckpoint = {
      journeyId: running.journey.id,
      journeyVersion: running.journey.version,
      turnId,
      originalRequest,
      inputs: structuredClone(running.inputs),
      completedStepIds,
      nextStepId: nextStep.id,
      nextStepIndex: running.topLevelIndex + 1,
      navigationStepId: step.id,
      destinationUrl: destination.toString(),
      expectedScreenIds: [...step.continuity.expectedScreenIds],
      ...(running.stopAfterStepId ? { stopAfterStepId: running.stopAfterStepId } : {}),
    };
    this.pausedJourney = {
      journeyId: checkpoint.journeyId,
      catalogVersionId: session.catalogVersionId,
      inputs: structuredClone(checkpoint.inputs),
      completedStepIds: [...checkpoint.completedStepIds],
      nextStepId: checkpoint.nextStepId,
      nextStepIndex: checkpoint.nextStepIndex,
      ...(checkpoint.stopAfterStepId ? { stopAfterStepId: checkpoint.stopAfterStepId } : {}),
    };
    this.continuity.setJourney(checkpoint);
    this.pendingDocumentNavigation = true;
    this.emit({ type: "continuity", state: "navigation_preparing", journeyId: checkpoint.journeyId, detail: request.classification });
    this.cancelSpeech();
    await this.voice?.stop(true);
    let preparedUrl = destination.toString();
    if (request.classification === "cross_origin") {
      const snapshot = this.continuity.current();
      if (!snapshot) return false;
      try {
        const token = await createContinuityHandoff(
          this.config.apiBaseUrl,
          session.sessionToken,
          snapshot,
          destination.toString(),
          this.config.fetcher,
        );
        preparedUrl = attachHandoffToken(destination.toString(), token);
      } catch (error) {
        this.pendingDocumentNavigation = false;
        this.continuity.setJourney(undefined);
        this.emit({ type: "continuity", state: "resume_failed", journeyId: checkpoint.journeyId, detail: error instanceof Error ? error.message : "Cross-origin handoff failed" });
        return false;
      }
    }
    globalThis.setTimeout(() => this.activeController?.abort("document navigation"), 0);
    return preparedUrl;
  }

  registerTool(tool: import("./tools.js").RegisteredTool): () => void {
    if (!this.tools) throw new Error("SDK must finish initialization before tools can be registered");
    return this.tools.register(tool);
  }

  setApprovalHandler(handler: ApprovalHandler | undefined): void {
    this.approvalHandler = handler;
    this.installApprovalBridge();
  }

  getTranscript() {
    return this.continuity?.messages() ?? [];
  }

  clearContinuity(reason: ContinuityClearReason = "user"): void {
    this.pausedJourney = undefined;
    this.continuity?.clear(reason);
    this.emit({ type: "continuity", state: "cleared", detail: reason });
  }

  stop(reason: "user" | "navigation" | "logout" | "page_hidden" = "user"): void {
    this.stopLocal(reason, true);
  }

  private stopLocal(reason: "user" | "navigation" | "logout" | "page_hidden", notifyServer: boolean): void {
    if (reason === "logout") this.clearContinuity("logout");
    this.activeController?.abort(reason);
    if (notifyServer && this.transport?.state === "connected") this.transport.send(this.message({ kind: "sable.sdk.client.interrupt", reason }));
    if (this.activeController) this.setState("stopped", "Stopped");
  }

  shutdown(): Promise<void> {
    this.shutdownStarted ??= this.cleanup(true);
    return this.shutdownStarted;
  }

  private async handleCommand(command: SdkServerCommand): Promise<void> {
    if (command.kind === "sable.sdk.server.ping") {
      this.transport?.send(this.message({ kind: "sable.sdk.client.pong", replyTo: command.commandId }));
      return;
    }
    if (command.kind === "sable.sdk.server.assistant_delta") {
      const prior = this.assistantText.get(command.turnId) ?? "";
      const separator = prior && command.text && !/\s$/.test(prior) && !/^\s/.test(command.text) ? " " : "";
      const text = `${prior}${separator}${command.text}`;
      this.assistantText.set(command.turnId, text);
      this.emit({ type: "assistant", turnId: command.turnId, text, partial: true });
      return;
    }
    if (command.kind === "sable.sdk.server.assistant_final") {
      this.assistantText.delete(command.turnId);
      this.continuity?.appendMessage({ key: `assistant:${command.turnId}`, role: "assistant", text: command.text });
      this.emit({ type: "assistant", turnId: command.turnId, text: command.text, partial: false });
      return;
    }
    if (command.kind === "sable.sdk.server.restore_state") {
      if (command.continuityId !== this.current.session?.continuityId) {
        this.emit({ type: "error", code: "CONTINUITY_SCOPE_MISMATCH", message: "Server continuity scope did not match this session", retryable: false });
        return;
      }
      this.continuity?.replaceTranscript(command.transcript, command.revision);
      this.emit({
        type: "continuity",
        state: "restored",
        messageCount: command.transcript.length,
        transcript: structuredClone(command.transcript),
      });
      return;
    }
    if (command.kind === "sable.sdk.server.demo_state") {
      if (!this.guidedDemo) return;
      try {
        const update = this.guidedDemo.applyServerState(command);
        this.updateDemo(update.snapshot);
        // Server commands are processed in order. Waiting here guarantees that
        // a signed greeting, question, module introduction, or closing finishes
        // before a following journey command can change the visible product.
        for (const cue of update.cues) await this.queueDemoCue(cue);
        if (["stopped", "completed"].includes(update.snapshot.phase)) {
          this.demoPlaybackGeneration += 1;
          this.demoPlaybackController?.abort(`guided demo ${update.snapshot.phase}`);
          this.cancelSpeech();
        }
      } catch (error) {
        this.emit({ type: "error", code: "DEMO_STATE_INVALID", message: error instanceof Error ? error.message : String(error), retryable: false });
      }
      return;
    }
    if (command.kind === "sable.sdk.server.request_observation") {
      const observation = await this.observe();
      this.transport?.send(this.message({
        kind: "sable.sdk.client.observation", observation, reason: "requested",
        replyToCommandId: command.commandId, turnId: command.turnId,
      }));
      return;
    }
    if (command.kind === "sable.sdk.server.run_catalog_navigation") {
      const fail = (detail: string) => this.transport?.send(this.message({ kind: "sable.sdk.client.catalog_navigation_result", commandId: command.commandId, ok: false, detail }));
      const catalog = this.current.catalog;
      const session = this.current.session;
      if (!catalog || !session || !this.resolver || !this.recognizer || !this.continuity) { fail("Catalog navigation is not ready"); return; }
      if (command.catalogVersionId !== session.catalogVersionId) { fail("Command catalog version is not pinned to this session"); return; }
      if (this.activeController || this.pausedJourney) { fail("Another journey is already active"); return; }
      const control = catalog.controls.find((candidate) => candidate.id === command.controlId);
      const target = catalog.screens.find((candidate) => candidate.id === command.targetScreenId);
      if (!control || control.risk !== "read" || control.screenId !== command.sourceScreenId || !target || (target.roles?.length && !target.roles.includes(session.roleProfileId))) {
        fail("Requested IDs are not an approved read-only catalog navigation"); return;
      }
      const observation = await this.observe();
      if (observation.matchedScreenId !== command.sourceScreenId) { fail("Current screen does not match the trained source screen"); return; }
      let element: HTMLElement;
      try { element = this.resolver.resolve({ controlId: control.id, screenId: control.screenId }).element; }
      catch (error) { fail(error instanceof Error ? error.message : "The trained control could not be resolved"); return; }
      if (!isHtmlAnchorElement(element) || !element.href || element.hasAttribute("download") || (element.target && element.target !== "_self")) {
        fail("The trained control is not a same-window navigation link"); return;
      }
      const destination = new URL(element.href, observation.url);
      if (destination.origin !== session.origin || classifyBrowserNavigation(observation.url, destination.toString()) !== "full_page") {
        fail("Phase 4 permits only same-origin full-page read-only navigation"); return;
      }
      if (!this.recognizer.destinationMatchesScreen(command.targetScreenId, destination.toString())) {
        fail("The resolved link does not point to the trained destination screen"); return;
      }
      const originalRequest = [...this.continuity.messages()].reverse().find((message) => message.role === "user")?.text ?? `Open ${target.name}`;
      this.continuity.setJourney(undefined);
      this.continuity.setCatalogNavigation({
        turnId: command.turnId, originalRequest, sourceScreenId: command.sourceScreenId,
        controlId: command.controlId, targetScreenId: command.targetScreenId, destinationUrl: destination.toString(),
      });
      this.setState("busy", `Opening ${target.name}`);
      this.cancelSpeech();
      await this.voice?.stop(true);
      globalThis.location.assign(destination.toString());
      return;
    }
    if (command.kind === "sable.sdk.server.clear_catalog_navigation") {
      this.continuity?.setCatalogNavigation(undefined);
      return;
    }
    if (command.kind === "sable.sdk.server.run_journey") {
      if (command.catalogVersionId !== this.current.session?.catalogVersionId) {
        this.sendJourneyResult(command, { ok: false, completedSteps: 0, error: "Command catalog version is not pinned to this session", events: [] });
        return;
      }
      const demoBeforeRun = this.guidedDemo?.snapshot();
      const activeDemo = !!demoBeforeRun?.enabled && !["idle", "completed", "stopped"].includes(demoBeforeRun.phase);
      if (activeDemo && !this.guidedDemo?.canRunActiveModuleJourney(command.journeyId)) {
        this.sendJourneyResult(command, { ok: false, completedSteps: 0, error: "Journey is not the approved demo-safe journey for the active signed module", events: [] });
        return;
      }
      let startAt = 0;
      let completedStepIds: string[] = [];
      let endAtExclusive: number | undefined;
      let stopAfterStepId: string | undefined;
      if (command.segment) {
        const journey = this.current.catalog?.journeys.find((candidate) => candidate.id === command.journeyId);
        const startIndex = journey?.workflow.steps.findIndex((step) => step.id === command.segment!.startStepId) ?? -1;
        const stopIndex = journey?.workflow.steps.findIndex((step) => step.id === command.segment!.stopAfterStepId) ?? -1;
        const start = journey?.workflow.steps[startIndex];
        const stop = journey?.workflow.steps[stopIndex];
        const previous = journey?.workflow.steps[startIndex - 1];
        const stopAssertion = stop?.kind === "assert" ? stop.assertion : undefined;
        const originalSourceAssertion = startIndex === 0
          ? journey?.workflow.preconditions.find((assertion) => assertion.kind === "screen_matches")
          : previous?.kind === "assert"
            ? previous.assertion
            : undefined;
        const sourceAssertion = command.resume && stopAssertion ? stopAssertion : originalSourceAssertion;
        const bounded = !!journey && journey.state === "approved" && journey.risk === "read"
          && startIndex >= 0 && stopIndex === startIndex + 1
          && start?.kind === "action" && (start.risk ?? "read") === "read"
          && !["EXTENSION_ONLY", "HUMAN_ONLY", "UNSUPPORTED"].includes(start.compatibility.classification)
          && stopAssertion?.kind === "screen_matches"
          && originalSourceAssertion?.kind === "screen_matches" && sourceAssertion?.kind === "screen_matches"
          && (start.action !== "navigate" || (!!start.continuity && stopAssertion?.kind === "screen_matches" && start.continuity.expectedScreenIds.includes(stopAssertion.screenId)));
        if (!bounded || !sourceAssertion || !this.driver) {
          this.sendJourneyResult(command, { ok: false, completedSteps: 0, error: "Requested catalog step window is not an approved read-only navigation", events: [] });
          return;
        }
        const sourceMatches = await this.driver.check(sourceAssertion).catch(() => false);
        if (!sourceMatches) {
          this.sendJourneyResult(command, { ok: false, completedSteps: 0, error: "Current screen does not match the approved source screen for this action", events: [] });
          return;
        }
        startAt = startIndex;
        endAtExclusive = stopIndex + 1;
        stopAfterStepId = command.segment.stopAfterStepId;
      }
      if (command.resume) {
        const checkpoint = this.pausedJourney;
        const valid = checkpoint && checkpoint.journeyId === command.journeyId && checkpoint.catalogVersionId === command.catalogVersionId
          && checkpoint.nextStepId === command.resume.nextStepId
          && checkpoint.stopAfterStepId === command.segment?.stopAfterStepId
          && canonicalizeJson(checkpoint.inputs) === canonicalizeJson(command.inputs)
          && canonicalizeJson(checkpoint.completedStepIds) === canonicalizeJson(command.resume.completedStepIds);
        if (!valid) {
          this.sendJourneyResult(command, { ok: false, completedSteps: 0, error: "Resume checkpoint is not valid for this SDK session", events: [] });
          return;
        }
        startAt = checkpoint.nextStepIndex;
        completedStepIds = checkpoint.completedStepIds;
        this.pausedJourney = undefined;
      } else if (this.pausedJourney) {
        this.sendJourneyResult(command, { ok: false, completedSteps: 0, error: "A paused journey must be continued or stopped first", events: [] });
        return;
      }
      this.activeCommandId = command.commandId;
      this.activeTurnId = command.turnId;
      const result = await this.runJourney(command.journeyId, command.inputs, startAt, completedStepIds, endAtExclusive, stopAfterStepId).catch((error): WorkflowRunResult => ({
        ok: false, completedSteps: 0, error: error instanceof Error ? error.message : String(error), events: [],
      }));
      this.activeCommandId = undefined;
      this.activeTurnId = undefined;
      if (this.hasPausedJourney(command.journeyId)) return;
      // Speech may arrive after the final atomic step, leaving no next step at
      // which to emit a normal checkpoint. The cloud still owns that user turn:
      // suppress stale completion narration, clear the local pause request, and
      // report the successful result so it can answer before advancing modules.
      const completedDuringInterruption = result.ok
        && (this.pauseRequested || this.guidedDemo?.snapshot().phase === "pausing");
      if (completedDuringInterruption) {
        this.pauseRequested = false;
        this.sendJourneyResult(command, result);
        return;
      }
      if (demoBeforeRun?.activeModuleId && this.guidedDemo?.snapshot().pendingAction !== "stop") {
        const cue = result.ok
          ? this.guidedDemo?.moduleCompletion(demoBeforeRun.activeModuleId)
          : this.guidedDemo?.moduleFailure(demoBeforeRun.activeModuleId);
        // Do not report the module result until its completion/failure cue has
        // finished. The cloud therefore advances the playlist only after the
        // prospect hears the natural transition.
        this.pendingJourneyResult = { command, result };
        if (cue) await this.queueDemoCue(cue);
        this.flushPendingJourneyResult(command.commandId);
        return;
      }
      this.sendJourneyResult(command, result);
      return;
    }
    if (command.kind === "sable.sdk.server.stop_journey") {
      const stoppedJourneyId = this.activeJourneyId ?? this.pausedJourney?.journeyId;
      this.pauseRequested = false;
      this.pausedJourney = undefined;
      this.continuity?.setJourney(undefined);
      this.stopLocal("user", false);
      if (stoppedJourneyId) {
        this.emit({ type: "journey", journeyId: stoppedJourneyId, state: "stopped", detail: command.reason });
      }
      return;
    }
    if (command.kind === "sable.sdk.server.pause_journey") {
      if (this.activeController && this.activeJourneyId === command.journeyId) {
        if (!this.requestDemoPause()) this.pauseRequested = true;
      }
      return;
    }
    if (command.kind === "sable.sdk.server.request_approval") {
      const approved = await this.requestServerApproval(command);
      this.transport?.send(this.message({ kind: "sable.sdk.client.approval_result", commandId: command.commandId, approved }));
      return;
    }
    if (command.kind === "sable.sdk.server.catalog_updated") {
      this.emit({ type: "catalog_update", catalogVersionId: command.catalogVersionId, reloadRequired: command.reloadRequired });
      if (command.catalogVersionId !== this.current.session?.catalogVersionId) this.clearContinuity("catalog_changed");
      if (command.reloadRequired) this.stop("navigation");
      return;
    }
    if (command.kind === "sable.sdk.server.session_policy" && command.sdkDisabled) {
      this.activeController?.abort("SDK disabled");
      this.setState("disabled", command.reason || "SDK disabled");
      this.transport?.close(1000, "SDK disabled");
      return;
    }
    if (command.kind === "sable.sdk.server.speak") {
      this.emit({ type: "speak", turnId: command.turnId, text: command.text, voice: command.voice });
      return;
    }
    if (command.kind === "sable.sdk.server.error") {
      if (command.code === "CONTINUITY_REJECTED") {
        this.pausedJourney = undefined;
        this.continuity?.setJourney(undefined);
        this.emit({ type: "continuity", state: "resume_failed", detail: command.message });
      }
      this.emit({ type: "error", code: command.code, message: command.message, retryable: command.retryable });
    }
  }

  private updateDemo(snapshot: GuidedDemoSnapshot): void {
    this.current = { ...this.current, demo: snapshot };
    this.emit({ type: "demo", snapshot });
  }

  /** Requests a pause but deliberately leaves the in-flight atomic step alone. */
  private requestDemoPause(): boolean {
    const snapshot = this.guidedDemo?.beginInterruption();
    if (!snapshot) return false;
    this.demoPlaybackGeneration += 1;
    this.demoPlaybackController?.abort("guided demo interrupted");
    this.cancelSpeech();
    this.pauseRequested = true;
    this.updateDemo(snapshot);
    return true;
  }

  private queueDemoCue(cue: GuidedDemoPlaybackCue): Promise<void> {
    const generation = this.demoPlaybackGeneration;
    this.demoPlaybackQueue = this.demoPlaybackQueue
      .catch(() => undefined)
      .then(async () => {
        if (generation !== this.demoPlaybackGeneration) return;
        await this.playDemoCue(cue);
      });
    return this.demoPlaybackQueue;
  }

  private async playDemoCue(cue: GuidedDemoPlaybackCue): Promise<void> {
    const request = { ...cue, text: cue.utterance.text };
    this.continuity?.appendMessage({ key: `assistant:demo:${cue.key}`, role: "assistant", text: cue.utterance.text });
    this.emit({ type: "demo_utterance", request });
    let recordingPlayed = false;
    const controller = new AbortController();
    this.demoPlaybackController = controller;
    if (cue.audioAsset && this.demoAudioPlayer) {
      try {
        recordingPlayed = await this.demoAudioPlayer.play(request, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) {
          this.emit({ type: "error", code: "DEMO_RECORDING_FAILED", message: error instanceof Error ? error.message : String(error), retryable: true });
        }
      }
    }
    if (!recordingPlayed && !controller.signal.aborted) {
      const turnId = `demo:${cue.key}`;
      // When built-in cloud voice is present, request synthesis of the
      // server-resolved signed cue and wait for actual browser playback. The
      // browser sends identifiers only; it cannot substitute arbitrary text.
      if (this.voice && this.transport?.state === "connected") {
        const utteranceId = randomId("utterance");
        const played = this.voice.waitForUtterance(utteranceId);
        this.transport.send(this.message({
          kind: "sable.sdk.client.demo_narration",
          cueKind: cue.kind,
          turnId,
          utteranceId,
          ...(cue.moduleId ? { moduleId: cue.moduleId } : {}),
          ...(cue.questionId ? { questionId: cue.questionId } : {}),
        }));
        const outcome = await played;
        if (outcome === "failed") throw new Error(`Demo narration audio failed for ${cue.key}`);
        if (outcome === "interrupted") return;
      } else {
        // A custom host can still provide its own speech bridge.
        this.emit({ type: "speak", turnId, text: cue.utterance.text });
      }
    }
    if (cue.kind === "module_completion" && !controller.signal.aborted) await sleep(100, controller.signal);
    if (this.demoPlaybackController === controller) this.demoPlaybackController = undefined;
  }

  private message<T extends ClientMessageBody>(value: T): SdkClientMessage {
    if (!this.current.session) throw new Error("SDK session is not ready");
    return {
      ...value,
      schemaVersion: SDK_PROTOCOL_VERSION,
      messageId: randomId("message"),
      sessionId: this.current.session.sessionId,
      sentAt: new Date().toISOString(),
    } as unknown as SdkClientMessage;
  }

  private sendJourneyResult(command: Extract<SdkServerCommand, { kind: "sable.sdk.server.run_journey" }>, result: WorkflowRunResult): void {
    this.transport?.send(this.message({
      kind: "sable.sdk.client.journey_result",
      commandId: command.commandId,
      journeyId: command.journeyId,
      ok: result.ok,
      completedSteps: result.completedSteps,
      failedStepId: result.failedStepId,
      detail: result.error,
    }));
  }

  /** Sends a staged terminal result once, including when barge-in cancels its closing cue. */
  private flushPendingJourneyResult(commandId?: string): boolean {
    const pending = this.pendingJourneyResult;
    if (!pending || (commandId && pending.command.commandId !== commandId)) return false;
    this.pendingJourneyResult = undefined;
    this.pauseRequested = false;
    this.sendJourneyResult(pending.command, pending.result);
    return true;
  }

  private async requestServerApproval(command: Extract<SdkServerCommand, { kind: "sable.sdk.server.request_approval" }>): Promise<boolean> {
    if (!this.approvalHandler || !this.current.catalog) return false;
    const journey = this.current.catalog.journeys.find((candidate) => candidate.id === command.journeyId);
    const request: ApprovalRequest = {
      requestId: command.commandId,
      reason: command.description,
      journeyId: command.journeyId,
      journeyName: journey?.name ?? command.title,
      stepId: command.stepId,
      risk: command.risk,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    return this.approvalHandler(request);
  }

  private installApprovalBridge(): void {
    this.policy?.setApprovalHandler(async (request, signal) => {
      this.emit({ type: "approval", phase: "requested", request });
      this.telemetry?.record({ type: "approval.requested", journeyId: request.journeyId, stepId: request.stepId, risk: request.risk });
      const approved = this.approvalHandler ? await this.approvalHandler(request, signal) : false;
      this.emit({ type: "approval", phase: "resolved", request, approved });
      this.telemetry?.record({ type: "approval.resolved", journeyId: request.journeyId, stepId: request.stepId, approved });
      return approved;
    });
  }

  private setState(state: AgentLifecycleState, detail?: string): void {
    this.state = state;
    this.current = { ...this.current, state };
    this.emit({ type: "state", state, detail });
  }

  private emit(event: SableAgentEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* Host callbacks cannot break the SDK. */ }
    }
  }

  private ensureUsable(): void {
    if (!["ready", "busy"].includes(this.state)) throw new SableSdkError("POLICY_BLOCKED", `SDK cannot act while ${this.state}`);
  }

  private hasPausedJourney(journeyId: string): boolean {
    return this.pausedJourney?.journeyId === journeyId;
  }

  private async cleanup(notifyServer: boolean, markShutdown = true): Promise<void> {
    this.activeController?.abort("shutdown");
    this.activeController = undefined;
    this.demoPlaybackGeneration += 1;
    this.demoPlaybackController?.abort("shutdown");
    this.demoPlaybackController = undefined;
    this.observer?.stop();
    if (this.sessionExpiryTimer !== undefined) globalThis.clearTimeout(this.sessionExpiryTimer);
    this.sessionExpiryTimer = undefined;
    const session = this.current.session;
    if (this.telemetry) {
      this.telemetry.record({ type: "session.stopped", reason: "shutdown" });
      await this.telemetry.stop();
    }
    this.transport?.close(1000, "SDK shutdown");
    await this.voice?.close();
    if (notifyServer && session && this.bootstrapClient) await this.bootstrapClient.close(session.sessionToken);
    if (markShutdown) this.setState("shutdown", "Shut down");
    this.onShutdown();
  }
}

const REGISTRY_KEY = Symbol.for("sable.web-sdk.instances");
interface RegistryEntry {
  promise: Promise<SableAgent>;
  configurationKey: string;
}
type SdkGlobal = typeof globalThis & { [REGISTRY_KEY]?: Map<string, RegistryEntry> };

function registry(): Map<string, RegistryEntry> {
  const global = globalThis as SdkGlobal;
  global[REGISTRY_KEY] ??= new Map();
  return global[REGISTRY_KEY]!;
}

/** Idempotent by installation ID, including concurrent initialization calls. */
export function createSableAgent(config: SableAgentConfig): Promise<SableAgent> {
  if (!config.installationId?.trim()) return Promise.reject(new Error("installationId is required"));
  const instances = registry();
  let apiOrigin: string;
  try { apiOrigin = new URL(config.apiBaseUrl, globalThis.location?.href).origin; }
  catch { return Promise.reject(new Error("apiBaseUrl is invalid")); }
  const configurationKey = JSON.stringify({
    apiOrigin,
    trust: config.catalogTrustKeys.map((key) => `${key.keyId}:${key.algorithm}`).sort(),
    distribution: config.distribution ?? "npm",
  });
  const existing = instances.get(config.installationId);
  if (existing) {
    if (existing.configurationKey !== configurationKey) return Promise.reject(new Error("installationId is already initialized with different security settings"));
    return existing.promise;
  }
  const runtime = new RuntimeAgent(config, () => instances.delete(config.installationId));
  const pending = runtime.initialize().catch((error) => {
    instances.delete(config.installationId);
    throw error;
  });
  instances.set(config.installationId, { promise: pending, configurationKey });
  return pending;
}

export const init = createSableAgent;

export async function shutdownSableAgent(installationId: string): Promise<void> {
  const entry = registry().get(installationId);
  if (entry) await (await entry.promise).shutdown();
}
