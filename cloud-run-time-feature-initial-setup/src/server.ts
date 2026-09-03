import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import {
  SDK_PROTOCOL_VERSION,
  assertValidSdkBootstrapRequest,
  assertValidSdkClientMessage,
  canonicalizeJson,
  type JsonValue,
  type RestoredCatalogNavigationCheckpoint,
  type RestoredJourneyCheckpoint,
  type RestoredTranscriptMessage,
  type SdkClientMessage,
  type SdkServerCommand,
  type SignedCatalogEnvelope,
  type WorkflowStep,
} from "@sable/sdk-contracts";
import type WebSocket from "ws";
import type { RuntimeConfig } from "./config.js";
import type { RuntimeContinuity, RuntimeSession, RuntimeStores, SpeechToTextSession } from "./contracts.js";
import type { Providers } from "./providers/index.js";
import { AudioSync, FileNarrationAudioCache, SpeechEngine, TurnManager, type SpeechContext } from "@sable/speech-core";
import { resolve } from "node:path";
import { TurnCoordinator, type CatalogNavigationAction, type ConversationState, type JourneyAction, type TurnRequest } from "./turn-coordinator.js";
import type { TurnPlan } from "./turn-planner.js";
import { createCredential, createId, credentialMatches, hashCredential, TokenSigner } from "./security.js";
import {
  DeterministicDemoDirector,
  isLikelyIntakeInterruption,
  type DemoExecutionInstruction,
  type GuidedDemoSessionState,
} from "./demo-director.js";
import { planDemoInterruption, turnPlanFromDemoInterruption, type DemoInterruptionPlan } from "./demo-interruption-planner.js";
import { retrieveDemoSalesPlays, type DemoSalesPlayGrounding } from "./demo-sales-play-retriever.js";
import { DemoInterruptionResponder, demoPlaybackTransitionText } from "./demo-interruption-responder.js";
import { resolveDemoSalesPlays } from "./demo-sales-play-retriever.js";

interface ControlState {
  socket: WebSocket;
  session: RuntimeSession;
  catalog: SignedCatalogEnvelope;
  conversation: ConversationState;
  transcript: RestoredTranscriptMessage[];
  continuityId?: string;
  continuityRevision: number;
  continuityStartedAt: string;
  readyUrl?: string;
  observation?: import("@sable/sdk-contracts").ScreenObservation;
  generation: number;
  busy?: AbortController;
  queuedTurn?: TurnRequest;
  pendingObservation?: { commandId: string; request: TurnRequest; plan: TurnPlan; purpose: "turn" | "presentation"; generation: number; timer: NodeJS.Timeout };
  pendingJourney?: { commandId: string; request: TurnRequest; plan: TurnPlan; action: JourneyAction; generation: number; completedStepIds: string[]; nextStepId?: string; paused: boolean; demoModuleId?: string };
  pendingCatalogNavigation?: { commandId: string; request: TurnRequest; plan: TurnPlan; action: CatalogNavigationAction; generation: number };
  pendingCatalogPlan?: RuntimeContinuity["pendingCatalogPlan"];
  pendingRestore?: RestoredJourneyCheckpoint;
  pendingCatalogNavigationRestore?: RestoredCatalogNavigationCheckpoint;
  authoritativePendingJourney?: RuntimeContinuity["pendingJourney"];
  authoritativePendingCatalogNavigation?: RuntimeContinuity["pendingCatalogNavigation"];
  continuityWrite?: Promise<void>;
  demoDirector?: DeterministicDemoDirector;
  demo?: GuidedDemoSessionState;
  demoClosingTimer?: NodeJS.Timeout;
  pendingDemoInterruption?: { request: TurnRequest; plan?: DemoInterruptionPlan; grounding?: DemoSalesPlayGrounding };
  demoPlanning?: AbortController;
  demoPlanningGeneration: number;
  pendingDemoObservation?: {
    commandId: string;
    request: TurnRequest;
    plan: DemoInterruptionPlan;
    grounding: DemoSalesPlayGrounding;
    generation: number;
    timer: NodeJS.Timeout;
  };
  /** Blocks stale narration between first confirmed speech and its accepted turn. */
  playbackBarrier?: { generation: number; turnId?: string };
}

interface VoiceState {
  socket: WebSocket;
  session: RuntimeSession;
  stt?: SpeechToTextSession;
  speech: SpeechEngine;
  sync: AudioSync;
  turns: TurnManager;
  outstandingSequences: Set<number>;
  playbackGeneration: number;
  interruptionActive: boolean;
}

function commandBase(sessionId: string) {
  return { schemaVersion: SDK_PROTOCOL_VERSION, commandId: createId("command"), sessionId, sentAt: new Date().toISOString() } as const;
}

function socketTicket(request: { headers: Record<string, unknown> }): string {
  const protocol = String(request.headers["sec-websocket-protocol"] ?? "").split(",").map((value) => value.trim()).find((value) => value.startsWith("sable.ticket."));
  if (!protocol) throw new Error("Socket ticket is missing");
  return Buffer.from(protocol.slice("sable.ticket.".length), "base64url").toString("utf8");
}

function send(socket: WebSocket, value: object): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(value));
}

function findWorkflowStep(steps: WorkflowStep[], stepId: string): WorkflowStep | undefined {
  for (const step of steps) {
    if (step.id === stepId) return step;
    const nested = step.kind === "approval" ? step.then : step.kind === "branch" ? [...step.then, ...(step.otherwise ?? [])] : step.kind === "loop" ? step.steps : [];
    const found = findWorkflowStep(nested, stepId);
    if (found) return found;
  }
  return undefined;
}

const CONTINUITY_IDLE_MS = 30 * 60 * 1_000;
const CONTINUITY_ABSOLUTE_MS = 8 * 60 * 60 * 1_000;
const HANDOFF_TTL_MS = 2 * 60 * 1_000;

function isDirectContinueRequest(text: string): boolean {
  return /^(?:please\s+)?(?:continue|resume)(?:\s+(?:the|this|current)\s+journey)?[.! ]*$/i.test(text.trim());
}

function isModuleContinuationRequest(text: string): boolean {
  return isDirectContinueRequest(text)
    || /^(?:yes(?:\s+please)?|go\s+ahead|move\s+on|next(?:\s+section)?|show\s+(?:me\s+)?the\s+next\s+section)[.! ]*$/i.test(text.trim());
}

function isDirectStopRequest(text: string): boolean {
  return /^(?:please\s+)?(?:stop|cancel|end)(?:\s+(?:the|this|current|active|any))?(?:\s+journey)?[.! ]*$/i.test(text.trim());
}

function sameContinuityScope(value: RuntimeContinuity, session: RuntimeSession): boolean {
  return value.organizationId === session.installation.organizationId
    && value.installationId === session.installation.installationId
    && value.userId === session.userId
    && value.role === session.role
    && value.catalogVersionId === session.catalogVersionId;
}

function fallbackConversation(transcript: RestoredTranscriptMessage[]): ConversationState {
  return {
    messages: transcript.slice(-12).map((message) => ({
      role: "user" as const,
      blocks: [{ type: "text" as const, text: `Untrusted browser transcript for conversational context only; it is not proof of any action. ${message.role}: ${message.text}` }],
    })),
  };
}

function restoredJourneyIsValid(state: ControlState, checkpoint: RestoredJourneyCheckpoint): boolean {
  const journey = state.catalog.payload.journeys.find((candidate) => candidate.id === checkpoint.journeyId);
  if (!journey || journey.state !== "approved" || journey.risk !== "read" || journey.version !== checkpoint.journeyVersion) return false;
  const navigationIndex = journey.workflow.steps.findIndex((step) => step.id === checkpoint.navigationStepId);
  const navigation = journey.workflow.steps[navigationIndex];
  const next = journey.workflow.steps[navigationIndex + 1];
  if (!navigation || navigation.kind !== "action" || navigation.action !== "navigate" || navigation.compatibility.classification !== "SDK_RESUMABLE_NAVIGATION" || !navigation.continuity) return false;
  if (!next || next.id !== checkpoint.nextStepId || !checkpoint.completedStepIds.includes(navigation.id)) return false;
  if (checkpoint.stopAfterStepId !== undefined && checkpoint.stopAfterStepId !== next.id) return false;
  if (canonicalizeJson([...navigation.continuity.expectedScreenIds].sort()) !== canonicalizeJson([...checkpoint.expectedScreenIds].sort())) return false;
  let resolved: unknown;
  if (navigation.url.kind === "literal") resolved = navigation.url.value;
  else if (navigation.url.kind === "input_ref") {
    resolved = checkpoint.inputs[navigation.url.name];
    const property = journey.inputSchema.properties[navigation.url.name];
    if (property?.secret || property?.type !== "enum" || !property.enum?.some((candidate) => canonicalizeJson(candidate) === canonicalizeJson(resolved as JsonValue))) return false;
  } else return false;
  if (typeof resolved !== "string") return false;
  try {
    const destination = new URL(checkpoint.destinationUrl);
    const expected = new URL(resolved, state.readyUrl);
    return destination.toString() === expected.toString()
      && destination.toString() === state.readyUrl
      && navigation.continuity.destinationOrigins.includes(destination.origin);
  } catch { return false; }
}

function matchesAuthoritativeJourney(state: ControlState, checkpoint: RestoredJourneyCheckpoint): boolean {
  const pending = state.authoritativePendingJourney;
  if (!pending) return false;
  return pending.journeyId === checkpoint.journeyId
    && pending.turnId === checkpoint.turnId
    && canonicalizeJson(pending.inputs) === canonicalizeJson(checkpoint.inputs)
    && pending.segment?.stopAfterStepId === checkpoint.stopAfterStepId;
}

function normalizedPageUrl(value: string): string {
  try { const url = new URL(value); return `${url.origin}${url.pathname}`.replace(/\/$/, ""); }
  catch { return ""; }
}

function restoredCatalogNavigationIsValid(
  state: ControlState,
  checkpoint: RestoredCatalogNavigationCheckpoint,
  bundle: import("@sable/runtime-core").RuntimeBundle,
  observation: import("@sable/sdk-contracts").ScreenObservation,
): boolean {
  const authoritative = state.authoritativePendingCatalogNavigation;
  if (!authoritative || authoritative.turnId !== checkpoint.turnId || authoritative.sourceScreenId !== checkpoint.sourceScreenId
    || authoritative.controlId !== checkpoint.controlId || authoritative.targetScreenId !== checkpoint.targetScreenId) return false;
  const control = state.catalog.payload.controls.find((candidate) => candidate.id === checkpoint.controlId && candidate.screenId === checkpoint.sourceScreenId && candidate.risk === "read");
  const target = state.catalog.payload.screens.find((candidate) => candidate.id === checkpoint.targetScreenId && (!candidate.roles?.length || candidate.roles.includes(state.session.role)));
  const transition = (bundle.transitions ?? []).find((candidate) => candidate.fromScreenKey === checkpoint.sourceScreenId && candidate.toScreenKey === checkpoint.targetScreenId
    && candidate.controlKey === checkpoint.controlId && candidate.reliability >= 0.9 && (!candidate.roleProfileId || candidate.roleProfileId === state.session.role));
  const runtimeTarget = (bundle.screens ?? []).find((candidate) => candidate.key === checkpoint.targetScreenId);
  return !!control && !!target && !!transition && !!runtimeTarget?.url
    && normalizedPageUrl(runtimeTarget.url) === normalizedPageUrl(checkpoint.destinationUrl)
    && checkpoint.destinationUrl === state.readyUrl
    && observation.matchedScreenId === checkpoint.targetScreenId;
}

export async function buildServer(config: RuntimeConfig, stores: RuntimeStores, providers: Providers): Promise<FastifyInstance> {
  const app = Fastify({ logger: { redact: ["req.headers.authorization", "req.query.ticket", "body.identityToken"] }, bodyLimit: 256 * 1024 });
  await app.register(websocket);
  const signer = new TokenSigner(config.tokenSigningSecret);
  const coordinator = new TurnCoordinator(config, stores, providers.model, providers.embedQuery);
  const demoInterruptionResponder = new DemoInterruptionResponder(providers.model);
  const narrationCache = new FileNarrationAudioCache(resolve("data/tts"));
  const usedTickets = new Set<string>();
  const controls = new Map<string, ControlState>();
  const continuityOwners = new Map<string, string>();
  const voices = new Map<string, VoiceState>();
  let activeConnections = 0;
  let completedTurns = 0;

  const persistContinuity = async (state: ControlState): Promise<boolean> => {
    if (!state.continuityId) return false;
    const continuityId = state.continuityId;
    const messages = structuredClone(state.conversation.messages);
    const transcript = structuredClone(state.transcript.slice(-100));
    const pendingJourney = state.pendingJourney ? {
        turnId: state.pendingJourney.request.turnId,
        originalRequest: state.pendingJourney.request.text,
        journeyId: state.pendingJourney.action.journeyId,
        inputs: structuredClone(state.pendingJourney.action.inputs),
        presentationRequested: state.pendingJourney.plan.presentationRequested,
        completedStepIds: [...state.pendingJourney.completedStepIds],
        ...(state.pendingJourney.nextStepId ? { nextStepId: state.pendingJourney.nextStepId } : {}),
        ...(state.pendingJourney.action.segment ? { segment: structuredClone(state.pendingJourney.action.segment) } : {}),
        ...(state.pendingJourney.demoModuleId ? { demoModuleId: state.pendingJourney.demoModuleId } : {}),
      } : structuredClone(state.authoritativePendingJourney);
    const pendingCatalogNavigation = state.pendingCatalogNavigation
      ? {
          turnId: state.pendingCatalogNavigation.request.turnId,
          originalRequest: state.pendingCatalogNavigation.request.text,
          sourceScreenId: state.pendingCatalogNavigation.action.sourceScreenId,
          controlId: state.pendingCatalogNavigation.action.controlId,
          targetScreenId: state.pendingCatalogNavigation.action.targetScreenId,
          destinationUrl: "",
          modality: state.pendingCatalogNavigation.request.modality,
          finalTargetScreenId: state.pendingCatalogNavigation.action.steps.at(-1)?.targetScreenId ?? state.pendingCatalogNavigation.action.targetScreenId,
          remainingSteps: structuredClone(state.pendingCatalogNavigation.action.steps.slice(1)),
        }
      : structuredClone(state.authoritativePendingCatalogNavigation);
    const pendingCatalogPlan = structuredClone(state.pendingCatalogPlan);
    const pendingDemoInterruption = state.pendingDemoInterruption ? {
      turnId: state.pendingDemoInterruption.request.turnId,
      originalRequest: state.pendingDemoInterruption.request.text,
      modality: state.pendingDemoInterruption.request.modality,
      ...(state.pendingDemoInterruption.plan ? { plan: structuredClone(state.pendingDemoInterruption.plan) } : {}),
      ...(state.pendingDemoInterruption.grounding ? { grounding: structuredClone(state.pendingDemoInterruption.grounding) } : {}),
    } : undefined;
    const previousWrite = state.continuityWrite ?? Promise.resolve();
    let written = true;
    const nextWrite = previousWrite.catch(() => undefined).then(async () => {
      if (state.continuityId !== continuityId) { written = false; return; }
      const now = Date.now();
      const started = Date.parse(state.continuityStartedAt);
      const expiresAt = new Date(Math.min(started + CONTINUITY_ABSOLUTE_MS, now + CONTINUITY_IDLE_MS)).toISOString();
      const expectedRevision = state.continuityRevision;
      const nextRevision = expectedRevision + 1;
      const saved = await stores.continuities.put({
        continuityId,
        organizationId: state.session.installation.organizationId,
        installationId: state.session.installation.installationId,
        userId: state.session.userId,
        role: state.session.role,
        catalogVersionId: state.session.catalogVersionId,
        messages,
        transcript,
        ...(state.demo ? { guidedDemo: structuredClone(state.demo) } : {}),
        ...(pendingDemoInterruption ? { pendingDemoInterruption } : {}),
        ...(pendingJourney ? { pendingJourney } : {}),
        ...(pendingCatalogNavigation ? { pendingCatalogNavigation } : {}),
        ...(pendingCatalogPlan ? { pendingCatalogPlan } : {}),
        startedAt: state.continuityStartedAt,
        updatedAt: new Date(now).toISOString(),
        expiresAt,
        revision: nextRevision,
      }, expectedRevision);
      if (!saved) {
        written = false;
        state.continuityId = undefined;
        send(state.socket, { ...commandBase(state.session.sessionId), kind: "sable.sdk.server.error", code: "CONTINUITY_STALE", message: "This tab is no longer the active Sable session", retryable: true });
        state.socket.close(4001, "newer tab owns continuity");
        return;
      }
      state.continuityRevision = nextRevision;
    });
    state.continuityWrite = nextWrite;
    await nextWrite;
    return written;
  };

  app.options("*", async (request, reply) => {
    const origin = String(request.headers.origin ?? "");
    reply.headers({ "access-control-allow-origin": origin, "access-control-allow-methods": "GET,POST,DELETE,OPTIONS", "access-control-allow-headers": "content-type,authorization", vary: "Origin" }).code(204).send();
  });
  app.addHook("onSend", async (request, reply, payload) => {
    const origin = request.headers.origin;
    if (typeof origin === "string") reply.headers({ "access-control-allow-origin": origin, "access-control-allow-credentials": "false", vary: "Origin", "cache-control": "no-store" });
    return payload;
  });

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/readyz", async (_request, reply) => {
    try { if (config.runtimeStore === "postgres") await stores.installations.get("__readiness__"); return { ready: true, store: config.runtimeStore }; }
    catch (error) { return reply.code(503).send({ ready: false, error: error instanceof Error ? error.message : "store unavailable" }); }
  });
  app.get("/metrics", async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${config.tokenSigningSecret}`) return reply.code(401).send("unauthorized\n");
    return reply.type("text/plain").send(`sable_runtime_connections ${activeConnections}\nsable_runtime_completed_turns ${completedTurns}\n`);
  });

  const requireAdmin = (authorization: unknown): boolean => !!config.adminApiKey && authorization === `Bearer ${config.adminApiKey}`;
  const publicInstallation = (value: RuntimeSession["installation"]) => { const { credentialHash: _secret, ...safe } = value; return safe; };
  app.get("/api/v3/sdk/installations", async (request, reply) => {
    if (!requireAdmin(request.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
    const organizationId = String((request.query as { organizationId?: string }).organizationId ?? "");
    return { installations: (await stores.installations.list(organizationId)).map(publicInstallation) };
  });
  app.post("/api/v3/sdk/installations", async (request, reply) => {
    if (!requireAdmin(request.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
    const body = request.body as { organizationId?: string; productId?: string; environmentId?: string; allowedOrigins?: string[]; allowedRoles?: string[]; activeCatalogVersionId?: string; guidedDemo?: { enabled?: unknown } };
    if (!body.organizationId || !body.productId || !body.environmentId || !body.activeCatalogVersionId || !Array.isArray(body.allowedOrigins) || !Array.isArray(body.allowedRoles)) return reply.code(400).send({ error: "installation scope is incomplete" });
    if (body.guidedDemo !== undefined && typeof body.guidedDemo?.enabled !== "boolean") return reply.code(400).send({ error: "guidedDemo.enabled must be a boolean" });
    const allowedOrigins = body.allowedOrigins.map((origin) => new URL(origin).origin);
    const credential = createCredential();
    const installation = { installationId: createId("installation"), organizationId: body.organizationId, productId: body.productId, environmentId: body.environmentId, credentialHash: hashCredential(credential), allowedOrigins, allowedRoles: body.allowedRoles, activeCatalogVersionId: body.activeCatalogVersionId, ...(body.guidedDemo ? { guidedDemo: { enabled: body.guidedDemo.enabled as boolean } } : {}) };
    await stores.installations.put(installation);
    return reply.code(201).send({ installation: publicInstallation(installation), credential });
  });
  app.post("/api/v3/sdk/installations/:id/rotate", async (request, reply) => {
    if (!requireAdmin(request.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
    const installation = await stores.installations.get((request.params as { id: string }).id);
    if (!installation) return reply.code(404).send({ error: "not found" });
    const credential = createCredential(); await stores.installations.put({ ...installation, credentialHash: hashCredential(credential) });
    return { installation: publicInstallation(installation), credential };
  });
  app.post("/api/v3/sdk/installations/:id/guided-demo", async (request, reply) => {
    if (!requireAdmin(request.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
    const installation = await stores.installations.get((request.params as { id: string }).id);
    if (!installation) return reply.code(404).send({ error: "not found" });
    const enabled = (request.body as { enabled?: unknown })?.enabled;
    if (typeof enabled !== "boolean") return reply.code(400).send({ error: "enabled must be a boolean" });
    const updated = { ...installation, guidedDemo: { enabled } };
    await stores.installations.put(updated);
    return { installation: publicInstallation(updated) };
  });
  app.delete("/api/v3/sdk/installations/:id", async (request, reply) => {
    if (!requireAdmin(request.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
    const installation = await stores.installations.get((request.params as { id: string }).id);
    if (!installation) return reply.code(404).send({ error: "not found" });
    await stores.installations.put({ ...installation, disabled: true });
    return reply.code(204).send();
  });
  app.get("/api/v3/sdk/installations/:id/report", async (request, reply) => {
    if (!requireAdmin(request.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
    const installation = await stores.installations.get((request.params as { id: string }).id);
    if (!installation) return reply.code(404).send({ error: "not found" });
    return { installation: publicInstallation(installation), runtimeStore: config.runtimeStore, providers: config.providers, activeSessions: [...controls.values()].filter((state) => state.session.installation.installationId === installation.installationId).length };
  });

  app.post("/api/v3/sdk/identity-tokens", async (request, reply) => {
    const body = request.body as { installationId?: string; userId?: string; roleProfileId?: string; origin?: string };
    const installationId = String(body.installationId ?? "");
    const installation = await stores.installations.get(installationId);
    const credential = String(request.headers.authorization ?? "").replace(/^SableInstallation\s+/i, "");
    if (!installation || installation.disabled || !credentialMatches(credential, installation.credentialHash)) return reply.code(401).send({ error: { code: "INVALID_INSTALLATION_CREDENTIAL", message: "Installation credential is invalid" } });
    const origin = String(body.origin ?? "");
    const role = String(body.roleProfileId ?? "");
    if (!installation.allowedOrigins.includes(origin) || !installation.allowedRoles.includes(role)) return reply.code(403).send({ error: { code: "SCOPE_NOT_ALLOWED", message: "Origin or role is not allowed" } });
    const exp = Date.now() + config.session.identityTtlMs;
    const identityToken = signer.sign({ purpose: "identity", sub: String(body.userId ?? ""), exp, installationId, role, origin });
    return { identityToken, expiresAt: new Date(exp).toISOString() };
  });

  app.post("/api/v3/sdk/sessions", async (request, reply) => {
    try {
      const bootstrap = assertValidSdkBootstrapRequest(request.body);
      const identity = signer.verify(bootstrap.identityToken, "identity") as ReturnType<TokenSigner["verify"]> & { installationId: string; role: string; origin: string };
      const installation = await stores.installations.get(bootstrap.installationId);
      const headerOrigin = String(request.headers.origin ?? "");
      if (!installation || installation.disabled || identity.installationId !== installation.installationId) throw new Error("Installation is unavailable");
      if (identity.origin !== bootstrap.page.origin || identity.origin !== headerOrigin || new URL(bootstrap.page.url).origin !== identity.origin) throw new Error("Browser origin does not match identity");
      if (!installation.allowedRoles.includes(identity.role) || !installation.allowedOrigins.includes(identity.origin)) throw new Error("Identity scope is no longer allowed");
      const catalog = await stores.catalogs.get(installation.activeCatalogVersionId, installation);
      if (!catalog) return reply.code(409).send({ error: { code: "NO_PUBLISHED_CATALOG", message: "No signed runtime catalog is available" } });
      const sessionId = createId("session");
      const continuityId = signer.opaqueId("continuity", installation.installationId, installation.organizationId, installation.productId, installation.environmentId, identity.sub, identity.role, installation.activeCatalogVersionId);
      const expires = Date.now() + config.session.sessionTtlMs;
      const session: RuntimeSession = { sessionId, installation, userId: identity.sub, role: identity.role, origin: identity.origin, catalogVersionId: installation.activeCatalogVersionId, expiresAt: new Date(expires).toISOString() };
      await stores.sessions.put(session);
      const controlExpires = Date.now() + config.session.ticketTtlMs;
      const voiceExpires = Date.now() + config.session.ticketTtlMs;
      const controlTicket = signer.sign({ purpose: "control_ticket", sub: sessionId, exp: controlExpires });
      const voiceTicket = signer.sign({ purpose: "voice_ticket", sub: sessionId, exp: voiceExpires });
      const sessionToken = signer.sign({ purpose: "session", sub: sessionId, exp: expires });
      const wsBase = new URL(config.publicApiUrl); wsBase.protocol = wsBase.protocol === "https:" ? "wss:" : "ws:";
      const tenantVoice = installation.voice ?? {};
      return {
        kind: "sable.sdk.bootstrap.response", schemaVersion: SDK_PROTOCOL_VERSION, requestId: bootstrap.requestId, serverTime: new Date().toISOString(),
        session: { kind: "sable.sdk.session", schemaVersion: SDK_PROTOCOL_VERSION, sessionId, continuityId, installationId: installation.installationId, organizationId: installation.organizationId, productId: installation.productId, environmentId: installation.environmentId, roleProfileId: identity.role, userId: identity.sub, origin: identity.origin, catalogVersionId: installation.activeCatalogVersionId, sessionToken, expiresAt: session.expiresAt },
        catalog: { kind: "inline", envelope: catalog },
        transport: { websocketUrl: new URL("/ws/sdk", wsBase).toString(), oneTimeTicket: controlTicket, expiresAt: new Date(controlExpires).toISOString() },
        voiceTransport: bootstrap.capabilities.voice ? {
          websocketUrl: new URL("/ws/sdk/voice", wsBase).toString(), oneTimeTicket: voiceTicket, expiresAt: new Date(voiceExpires).toISOString(),
          languageCode: tenantVoice.languageCode ?? config.voice.languageCode, sampleRate: 16_000,
          silenceTimeoutMs: Math.min(config.voice.silenceTimeoutMs, tenantVoice.silenceTimeoutMs ?? config.voice.silenceTimeoutMs),
          minimumSpeechMs: Math.max(config.voice.minimumSpeechMs, tenantVoice.minimumSpeechMs ?? config.voice.minimumSpeechMs),
          maximumUtteranceMs: Math.min(config.voice.maximumUtteranceMs, tenantVoice.maximumUtteranceMs ?? config.voice.maximumUtteranceMs),
          audioFrameMs: tenantVoice.audioFrameMs ?? config.voice.audioFrameMs,
          vadThreshold: Math.max(config.voice.vadThreshold, tenantVoice.vadThreshold ?? config.voice.vadThreshold),
          audioWaitCapMs: config.voice.audioWaitCapMs,
          autoStop: config.voice.autoStop && (tenantVoice.autoStop ?? true), bargeIn: config.voice.bargeIn && (tenantVoice.bargeIn ?? true),
          speakMode: tenantVoice.speakMode ?? config.voice.speakMode, stepNarration: config.voice.stepNarration && (tenantVoice.stepNarration ?? true),
        } : undefined,
        killSwitch: { disabled: false },
      };
    } catch (error) { return reply.code(401).send({ error: { code: "INVALID_IDENTITY", message: error instanceof Error ? error.message : "Invalid identity" } }); }
  });

  const authenticateSession = async (authorization: unknown) => {
    const token = String(authorization ?? "").replace(/^Bearer\s+/i, "");
    const claims = signer.verify(token, "session");
    const session = await stores.sessions.get(claims.sub);
    if (!session || Date.parse(session.expiresAt) <= Date.now()) throw new Error("Session is unavailable");
    return session;
  };

  app.get("/api/v3/sdk/catalog", async (request, reply) => {
    try { const session = await authenticateSession(request.headers.authorization); return await stores.catalogs.get(session.catalogVersionId, session.installation); }
    catch { return reply.code(401).send({ error: "unauthorized" }); }
  });
  app.post("/api/v3/sdk/handoffs", async (request, reply) => {
    try {
      const session = await authenticateSession(request.headers.authorization);
      const body = request.body as { snapshot?: Record<string, unknown>; destinationUrl?: string };
      const snapshot = body.snapshot;
      if (!snapshot || JSON.stringify(snapshot).length > 256 * 1_024) throw new Error("Continuity snapshot is missing or too large");
      const destination = new URL(String(body.destinationUrl ?? ""));
      if (!session.installation.allowedOrigins.includes(destination.origin)) throw new Error("Destination origin is not approved for this installation");
      if (snapshot.installationId !== session.installation.installationId
        || snapshot.organizationId !== session.installation.organizationId
        || snapshot.productId !== session.installation.productId
        || snapshot.environmentId !== session.installation.environmentId
        || snapshot.userId !== session.userId
        || snapshot.roleProfileId !== session.role
        || snapshot.catalogVersionId !== session.catalogVersionId
        || snapshot.origin !== session.origin) throw new Error("Continuity snapshot scope does not match this session");
      const journey = snapshot.journey && typeof snapshot.journey === "object" ? snapshot.journey as Record<string, unknown> : undefined;
      const protocolJourney = journey ? Object.fromEntries(Object.entries(journey).filter(([key]) => key !== "nextStepIndex")) : undefined;
      const transcript = Array.isArray(snapshot.transcript) ? snapshot.transcript : [];
      if (transcript.length > 100) throw new Error("Continuity transcript is too large");
      const validated = assertValidSdkClientMessage({
        kind: "sable.sdk.client.restore_context", schemaVersion: SDK_PROTOCOL_VERSION,
        messageId: "handoff-validation", sessionId: session.sessionId, sentAt: new Date().toISOString(),
        continuityId: snapshot.continuityId,
        transcript: transcript.slice(-12),
        ...(protocolJourney ? { journey: protocolJourney } : {}),
      } as unknown);
      if (validated.kind !== "sable.sdk.client.restore_context" || !validated.journey || validated.journey.destinationUrl !== destination.toString()) throw new Error("Handoff must contain a valid destination journey");
      const authoritative = await stores.continuities.get(validated.continuityId);
      const pending = authoritative && sameContinuityScope(authoritative, session) ? authoritative.pendingJourney : undefined;
      if (!pending || pending.journeyId !== validated.journey.journeyId || pending.turnId !== validated.journey.turnId
        || canonicalizeJson(pending.inputs) !== canonicalizeJson(validated.journey.inputs)) {
        throw new Error("Handoff does not match an authoritative server journey checkpoint");
      }
      const token = createId("handoff");
      const tokenHash = hashCredential(token);
      const expiresAt = new Date(Date.now() + HANDOFF_TTL_MS).toISOString();
      const transferred = { ...snapshot, origin: destination.origin, updatedAt: new Date().toISOString() } as JsonValue;
      await stores.handoffs.put({
        tokenHash, organizationId: session.installation.organizationId, installationId: session.installation.installationId,
        userId: session.userId, role: session.role, catalogVersionId: session.catalogVersionId,
        destinationOrigin: destination.origin, destinationUrl: destination.toString(), snapshot: transferred, expiresAt,
      });
      return reply.code(201).send({ token, expiresAt });
    } catch (error) { return reply.code(400).send({ error: { code: "HANDOFF_REJECTED", message: error instanceof Error ? error.message : "Handoff rejected" } }); }
  });
  app.post("/api/v3/sdk/handoffs/consume", async (request, reply) => {
    try {
      const session = await authenticateSession(request.headers.authorization);
      const body = request.body as { token?: string; destinationUrl?: string };
      const destination = new URL(String(body.destinationUrl ?? ""));
      const handoff = await stores.handoffs.consume(hashCredential(String(body.token ?? "")));
      if (!handoff) throw new Error("Handoff is invalid, expired, or already used");
      if (handoff.organizationId !== session.installation.organizationId
        || handoff.installationId !== session.installation.installationId
        || handoff.userId !== session.userId
        || handoff.role !== session.role
        || handoff.catalogVersionId !== session.catalogVersionId
        || handoff.destinationOrigin !== session.origin
        || handoff.destinationUrl !== destination.toString()
        || String(request.headers.origin ?? "") !== destination.origin) throw new Error("Handoff destination or identity does not match");
      return { snapshot: handoff.snapshot };
    } catch (error) { return reply.code(400).send({ error: { code: "HANDOFF_REJECTED", message: error instanceof Error ? error.message : "Handoff rejected" } }); }
  });
  app.post("/api/v3/sdk/events", async (request, reply) => {
    try {
      const session = await authenticateSession(request.headers.authorization);
      const values = Array.isArray((request.body as { events?: unknown[] })?.events) ? (request.body as { events: unknown[] }).events.slice(0, 100) : [];
      await Promise.all(values.map((value) => stores.events.append({ id: createId("event"), tenantId: session.installation.organizationId, installationId: session.installation.installationId, sessionId: session.sessionId, type: "sdk.telemetry", occurredAt: new Date().toISOString(), detail: { event: JSON.stringify(value).slice(0, 5_000) } })));
      return reply.code(202).send({ accepted: values.length });
    } catch { return reply.code(401).send({ error: "unauthorized" }); }
  });
  app.delete("/api/v3/sdk/session", async (request, reply) => {
    try { const session = await authenticateSession(request.headers.authorization); controls.get(session.sessionId)?.socket.close(1000, "session ended"); await stores.sessions.delete(session.sessionId); return reply.code(204).send(); }
    catch { return reply.code(204).send(); }
  });

  const shouldSpeak = (state: ControlState, request: TurnRequest) => {
    const mode = state.session.installation.voice?.speakMode ?? config.voice.speakMode;
    return mode === "all" || (mode === "voice_turns" && request.modality === "voice");
  };

  const releasePlaybackBarrier = (state: ControlState, turnId: string): boolean => {
    const barrier = state.playbackBarrier;
    if (!barrier) return true;
    if (barrier.turnId !== turnId) return false;
    const voice = voices.get(state.session.sessionId);
    if (voice) send(voice.socket, { type: "tts.resume", generation: barrier.generation, turnId });
    state.playbackBarrier = undefined;
    return true;
  };

  const emitFinal = (state: ControlState, request: TurnRequest, text: string) => {
    send(state.socket, { ...commandBase(state.session.sessionId), kind: "sable.sdk.server.assistant_final", turnId: request.turnId, text });
    const key = `assistant:${request.turnId}`;
    const entry: RestoredTranscriptMessage = { key, role: "assistant", text: text.slice(0, 10_000), createdAt: new Date().toISOString() };
    const existing = state.transcript.findIndex((message) => message.key === key);
    if (existing >= 0) state.transcript[existing] = entry; else state.transcript.push(entry);
    void persistContinuity(state).catch(() => undefined);
    if (shouldSpeak(state, request)) send(state.socket, { ...commandBase(state.session.sessionId), kind: "sable.sdk.server.speak", turnId: request.turnId, text, voice: state.session.installation.voice?.speaker ?? config.voice.speaker });
    completedTurns++;
  };

  const speakLines = async (
    state: ControlState,
    request: TurnRequest,
    lines: string[],
    purpose: SpeechContext["purpose"],
    identifiers: { utteranceId?: string; journeyId?: string; stepId?: string } = {},
    cacheCatalogNarration = false,
  ): Promise<number | null> => {
    const voice = voices.get(state.session.sessionId);
    const utteranceId = identifiers.utteranceId ?? createId("utterance");
    if (!voice || !lines.length) return null;
    if (!releasePlaybackBarrier(state, request.turnId)) {
      send(voice.socket, { type: "tts.end", utteranceId, turnId: request.turnId, lastSequence: null, purpose });
      return null;
    }
    const mode = state.session.installation.voice?.speakMode ?? config.voice.speakMode;
    const narratedCatalog = (purpose === "journey_step" || purpose === "demo")
      && mode !== "off"
      && (state.session.installation.voice?.stepNarration ?? config.voice.stepNarration);
    if (!shouldSpeak(state, request) && !narratedCatalog) {
      send(voice.socket, { type: "tts.end", utteranceId, turnId: request.turnId, lastSequence: null, purpose });
      return null;
    }
    // Keep the already-open microphone session armed while speech plays. The
    // browser's echo cancellation and TurnManager's transcript echo filter
    // prevent our own audio from becoming a user turn; genuine speech can now
    // reach onSpeechStart and cancel playback immediately.
    send(voice.socket, { type: "voice.listen", turnId: request.turnId });
    const context: SpeechContext = { utteranceId, turnId: request.turnId, purpose, ...(identifiers.journeyId ? { journeyId: identifiers.journeyId } : {}), ...(identifiers.stepId ? { stepId: identifiers.stepId } : {}) };
    const tasks = lines.map((line) => voice.speech.say(line, context, cacheCatalogNarration ? { cache: "catalog" } : {}));
    try {
      const sequences = (await Promise.all(tasks)).filter((value): value is number => value !== null);
      const lastSequence = sequences.length ? Math.max(...sequences) : null;
      send(voice.socket, { type: "tts.end", utteranceId, turnId: request.turnId, lastSequence, purpose });
      return lastSequence;
    } catch (error) {
      send(voice.socket, { type: "voice.error", message: `Text-to-speech unavailable: ${(error as Error).message}` });
      return null;
    }
  };

  const resolveDemoNarration = (
    state: ControlState,
    message: Extract<SdkClientMessage, { kind: "sable.sdk.client.demo_narration" }>,
  ): string => {
    const profile = state.demoDirector?.profile;
    const demo = state.demo;
    if (!profile || !demo) throw new Error("Guided-demo narration is not enabled for this session");
    if (message.cueKind === "greeting") {
      if (demo.phase !== "intake") throw new Error("The greeting is no longer active");
      return profile.greeting.text;
    }
    if (message.cueKind === "question") {
      if (demo.phase !== "intake" || !message.questionId || message.questionId !== demo.activeQuestionId) throw new Error("The requested intake question is not active");
      const question = profile.questions.find((candidate) => candidate.id === message.questionId);
      if (!question) throw new Error("The requested intake question is not in the signed profile");
      return question.prompt.text;
    }
    if (message.cueKind === "closing") {
      if (demo.phase !== "closing") throw new Error("The closing cue is not active");
      return profile.closing.text;
    }
    if (!message.moduleId || message.moduleId !== demo.activeModuleId || demo.phase !== "playing") throw new Error("The requested module narration is not active");
    const module = profile.modules.find((candidate) => candidate.id === message.moduleId);
    if (!module || state.pendingJourney?.demoModuleId !== module.id) throw new Error("The requested module narration does not match the pending signed journey");
    if (message.cueKind === "module_introduction") return module.introduction.text;
    if (message.cueKind === "module_completion") return module.completion.text;
    if (message.cueKind === "module_failure") return module.failureMessage.text;
    throw new Error("Unsupported guided-demo narration cue");
  };

  const answerIntakeInterruption = async (state: ControlState, request: TurnRequest): Promise<void> => {
    const profile = state.demoDirector?.profile;
    const demo = state.demo;
    const question = profile?.questions.find((candidate) => candidate.id === demo?.activeQuestionId);
    if (!profile || !demo || demo.phase !== "intake" || !question) throw new Error("The guided demo is not waiting for an intake answer");

    const plan: DemoInterruptionPlan = {
      intent: "product_question",
      responseMode: "answer",
      taskControl: "side_question",
      playbackDirective: "remain_paused",
      needsFreshObservation: false,
      needsKnowledge: true,
      actionRequested: false,
      presentationRequested: false,
      journeyInputs: {},
      policyAdjustments: ["Intake questions remain unanswered while an obvious prospect question is handled."],
    };
    const grounding = retrieveDemoSalesPlays(plan, { catalog: state.catalog, demo, requestText: request.text });
    const plays = resolveDemoSalesPlays(state.catalog, grounding);
    const requestedModule = profile.modules.find((module) => {
      const query = request.text.toLocaleLowerCase("en");
      return query.includes(module.id.toLocaleLowerCase("en")) || query.includes(module.name.toLocaleLowerCase("en"));
    });

    let baseAnswer: string;
    try {
      baseAnswer = await demoInterruptionResponder.answer({
        session: state.session,
        catalog: state.catalog,
        demo,
        request,
        plan,
        plays,
        transcript: state.transcript,
      });
    } catch {
      // The demo remains useful if the wording model is unavailable. The
      // fallback is still restricted to signed catalog content.
      baseAnswer = plays[0]?.content
        ?? (requestedModule ? `${requestedModule.name} is a guided section of this demo. ${requestedModule.introduction.text}` : undefined)
        ?? "The approved demo material does not establish a reliable answer to that question yet.";
    }

    const answer = `${baseAnswer.trim()} Before we continue, ${question.prompt.text}`.replace(/\s+/g, " ").trim();
    emitFinal(state, request, answer);
    const lastSequence = await speakLines(state, request, [answer], "demo");
    await inviteNextVoiceTurn(state, request, lastSequence);
    await stores.events.append({
      id: createId("event"),
      tenantId: state.session.installation.organizationId,
      installationId: state.session.installation.installationId,
      sessionId: state.session.sessionId,
      type: "guided_demo.intake_interruption_answered",
      occurredAt: new Date().toISOString(),
      detail: { playIds: grounding.selectedPlayIds, activeQuestionId: question.id },
    });
  };

  /**
   * The original demo kept one microphone session alive and resumed listening
   * only after its playback queue had actually drained. Preserve that contract:
   * the browser never guesses from a timeout or from "audio was sent".
   */
  const inviteNextVoiceTurn = async (state: ControlState, request: TurnRequest, lastSequence: number | null): Promise<void> => {
    const voice = voices.get(state.session.sessionId);
    if (!voice) return;
    // Audio drain is a notification, not session-state work. Do not hold the
    // serialized control queue while waiting for the browser acknowledgement;
    // a barge-in or newer turn must still be accepted during playback.
    void voice.sync.waitFor(lastSequence).then(() => {
      if (voices.get(state.session.sessionId) === voice) send(voice.socket, { type: "voice.listen", turnId: request.turnId });
    });
  };

  const sendDemoState = (state: ControlState): void => {
    if (!state.demoDirector || !state.demo) return;
    send(state.socket, {
      ...commandBase(state.session.sessionId),
      kind: "sable.sdk.server.demo_state",
      ...state.demoDirector.view(state.demo),
    });
  };

  const inviteModuleContinuation = async (state: ControlState, request: TurnRequest): Promise<void> => {
    const director = state.demoDirector;
    const demo = state.demo;
    if (!director || !demo || demo.phase !== "awaiting_resume" || demo.resumeReason !== "module_complete" || !demo.activeModuleId) return;
    const current = director.profile.modules.find((module) => module.id === demo.activeModuleId);
    const nextId = demo.playlistModuleIds[demo.moduleIndex + 1];
    const next = director.profile.modules.find((module) => module.id === nextId);
    if (!current || !next) return;
    const answer = `Would you like me to continue to ${next.name}, or do you have questions about ${current.name}?`;
    emitFinal(state, request, answer);
    const lastSequence = await speakLines(state, request, [answer], "demo");
    await inviteNextVoiceTurn(state, request, lastSequence);
  };

  const persistDemoState = async (state: ControlState, value: GuidedDemoSessionState): Promise<void> => {
    state.demo = structuredClone(value);
    state.session.guidedDemo = structuredClone(value);
    await stores.sessions.put(state.session);
    await persistContinuity(state);
    sendDemoState(state);
    await stores.events.append({
      id: createId("event"),
      tenantId: state.session.installation.organizationId,
      installationId: state.session.installation.installationId,
      sessionId: state.session.sessionId,
      type: "guided_demo.state",
      occurredAt: new Date().toISOString(),
      // Captured lead answers are intentionally excluded from event telemetry.
      detail: {
        phase: value.phase,
        ...(value.personaId ? { personaId: value.personaId } : {}),
        ...(value.activeModuleId ? { activeModuleId: value.activeModuleId } : {}),
        ...(value.activeQuestionId ? { activeQuestionId: value.activeQuestionId } : {}),
      },
    });
  };

  const scheduleDemoClosing = (state: ControlState): void => {
    if (!state.demoDirector || state.demo?.phase !== "closing") return;
    if (state.demoClosingTimer) clearTimeout(state.demoClosingTimer);
    const closing = state.demoDirector.profile.closing;
    const asset = closing.audioAssetId
      ? state.catalog.payload.demoAudioAssets?.find((candidate) => candidate.id === closing.audioAssetId)
      : undefined;
    // Cloud state uses signed duration metadata as its reconnect-safe fallback.
    // The SDK processes server commands serially and Phase 6 now awaits the
    // closing cue, so the browser cannot expose Completed before that cue ends.
    const readingMs = Math.max(1_000, closing.text.trim().split(/\s+/).length * 350);
    const delayMs = Math.min(15_000, Math.max(500, asset?.durationMs ?? readingMs) + 250);
    const expectedUpdatedAt = state.demo.updatedAt;
    state.demoClosingTimer = setTimeout(() => {
      state.demoClosingTimer = undefined;
      if (!state.demoDirector || state.demo?.phase !== "closing" || state.demo.updatedAt !== expectedUpdatedAt) return;
      const completed = state.demoDirector.completeClosing(state.demo);
      void persistDemoState(state, completed.state).catch(() => undefined);
    }, delayMs);
    state.demoClosingTimer.unref();
  };

  const runDemoModule = async (state: ControlState, instruction: Extract<DemoExecutionInstruction, { kind: "run" | "resume" }>): Promise<void> => {
    const director = state.demoDirector;
    const demo = state.demo;
    if (!director || !demo) return;
    const approved = director.activeJourney(demo);
    if (!approved || approved.moduleId !== instruction.moduleId) {
      const failed = director.journeyResult(demo, false);
      await persistDemoState(state, failed.state);
      send(state.socket, { ...commandBase(state.session.sessionId), kind: "sable.sdk.server.error", code: "DEMO_JOURNEY_UNAVAILABLE", message: "The signed demo module does not resolve to an approved demo-safe journey for this role", retryable: false });
      return;
    }
    if (instruction.kind === "resume" && instruction.checkpoint.journeyId !== approved.journey.id) {
      throw new Error("The requested demo checkpoint does not match the active signed journey");
    }
    const existing = instruction.kind === "resume" ? state.pendingJourney : undefined;
    const restored = instruction.kind === "resume" && state.authoritativePendingJourney?.demoModuleId === approved.moduleId
      ? state.authoritativePendingJourney
      : undefined;
    const request: TurnRequest = existing?.demoModuleId === approved.moduleId
      ? existing.request
      : restored
        ? { turnId: restored.turnId, text: restored.originalRequest, modality: state.session.modality ?? "text" }
        : { turnId: createId("demo-turn"), text: `Guided demo module: ${approved.moduleId}`, modality: state.session.modality ?? "text" };
    const plan: TurnPlan = {
      intent: "action",
      mode: "execute",
      taskControl: instruction.kind === "resume" ? "continue" : "none",
      needsFreshObservation: false,
      needsKnowledge: false,
      actionRequested: true,
      presentationRequested: false,
      journeyId: approved.journey.id,
      journeyInputs: approved.inputs,
    };
    const action: JourneyAction = { journeyId: approved.journey.id, inputs: approved.inputs, acknowledgement: `Playing ${approved.moduleId}.` };
    const commandId = createId("demo-journey");
    const generation = ++state.generation;
    state.pendingJourney = {
      commandId,
      request,
      plan,
      action,
      generation,
      completedStepIds: instruction.kind === "resume" ? [...instruction.checkpoint.completedStepIds] : [],
      ...(instruction.kind === "resume" ? { nextStepId: instruction.checkpoint.nextStepId } : {}),
      paused: false,
      demoModuleId: approved.moduleId,
    };
    state.authoritativePendingJourney = undefined;
    await persistContinuity(state);
    send(state.socket, {
      schemaVersion: SDK_PROTOCOL_VERSION,
      commandId,
      sessionId: state.session.sessionId,
      sentAt: new Date().toISOString(),
      kind: "sable.sdk.server.run_journey",
      turnId: request.turnId,
      catalogVersionId: state.session.catalogVersionId,
      journeyId: approved.journey.id,
      inputs: approved.inputs,
      ...(instruction.kind === "resume" ? { resume: { completedStepIds: instruction.checkpoint.completedStepIds, nextStepId: instruction.checkpoint.nextStepId } } : {}),
    });
  };

  const applyDemoPlaybackDirective = async (
    state: ControlState,
    request: TurnRequest,
    plan: DemoInterruptionPlan,
    lastSequence: number | null,
    generation: number,
  ): Promise<void> => {
    const director = state.demoDirector;
    if (!director || !state.demo || state.demo.phase !== "answering") return;
    const voice = voices.get(state.session.sessionId);
    if (request.modality === "voice" && voice) await voice.sync.waitFor(lastSequence);
    if (state.demoPlanningGeneration !== generation || state.pendingDemoInterruption?.request.turnId !== request.turnId) return;

    const awaiting = director.finishInterruptionAnswer(state.demo);
    state.pendingDemoInterruption = undefined;
    if (plan.playbackDirective === "remain_paused") {
      await persistDemoState(state, awaiting.state);
      if (request.modality === "voice" && voice) send(voice.socket, { type: "voice.listen", turnId: request.turnId });
      return;
    }
    if (plan.playbackDirective === "resume_after_answer" || plan.playbackDirective === "resume_now") {
      const resumed = director.control(awaiting.state, "continue");
      await persistDemoState(state, resumed.state);
      if (resumed.instruction.kind === "run" || resumed.instruction.kind === "resume") await runDemoModule(state, resumed.instruction);
      else if (resumed.state.phase === "closing") scheduleDemoClosing(state);
      return;
    }
    if (plan.playbackDirective === "stop") {
      state.pendingJourney = undefined;
      state.authoritativePendingJourney = undefined;
      const stopped = director.control(awaiting.state, "stop");
      await persistDemoState(state, stopped.state);
      send(state.socket, { ...commandBase(state.session.sessionId), kind: "sable.sdk.server.stop_journey", reason: "Guided demo stopped after the interruption answer" });
      return;
    }
    if (plan.playbackDirective === "replace_module" && plan.requestedModuleId) {
      // The browser still owns the paused checkpoint. Explicitly abandon it
      // before starting the different approved module.
      state.pendingJourney = undefined;
      state.authoritativePendingJourney = undefined;
      send(state.socket, { ...commandBase(state.session.sessionId), kind: "sable.sdk.server.stop_journey", reason: "Switching to another approved guided-demo module" });
      const replacement = director.replaceAfterInterruption(awaiting.state, plan.requestedModuleId);
      await persistDemoState(state, replacement.state);
      if (replacement.instruction.kind === "run") await runDemoModule(state, replacement.instruction);
    }
  };

  const answerPlannedDemoInterruption = async (
    state: ControlState,
    request: TurnRequest,
    plan: DemoInterruptionPlan,
    grounding: DemoSalesPlayGrounding,
    generation: number,
    observation?: import("@sable/sdk-contracts").ScreenObservation,
    fixedAnswer?: string,
  ): Promise<void> => {
    const controller = state.demoPlanning;
    if (!controller || controller.signal.aborted || !state.demoDirector || state.demo?.phase !== "answering") return;
    let answerAlreadyRecorded = false;
    let baseAnswer = fixedAnswer;
    if (!baseAnswer && plan.responseMode === "navigate" && plan.playbackDirective !== "replace_module") {
      const turnPlan = turnPlanFromDemoInterruption(plan);
      const result = await coordinator.run(
        state.session,
        state.catalog,
        state.conversation,
        request,
        turnPlan,
        observation ?? state.observation,
        { signal: controller.signal },
      );
      if (controller.signal.aborted || state.demoPlanningGeneration !== generation || state.pendingDemoInterruption?.request.turnId !== request.turnId) return;
      answerAlreadyRecorded = true;
      if (result.catalogNavigation) {
        emitFinal(state, request, result.answer);
        const lastSequence = await speakLines(state, request, [result.answer], "acknowledgement");
        const voice = voices.get(state.session.sessionId);
        if (request.modality === "voice" && voice) await voice.sync.waitFor(lastSequence);
        if (controller.signal.aborted || state.demoPlanningGeneration !== generation || state.pendingDemoInterruption?.request.turnId !== request.turnId) return;
        const commandId = createId("demo-navigation");
        state.pendingCatalogNavigation = { commandId, request, plan: turnPlan, action: result.catalogNavigation, generation: state.generation };
        await persistContinuity(state);
        send(state.socket, {
          schemaVersion: SDK_PROTOCOL_VERSION,
          commandId,
          sessionId: state.session.sessionId,
          sentAt: new Date().toISOString(),
          kind: "sable.sdk.server.run_catalog_navigation",
          turnId: request.turnId,
          catalogVersionId: state.session.catalogVersionId,
          sourceScreenId: result.catalogNavigation.sourceScreenId,
          controlId: result.catalogNavigation.controlId,
          targetScreenId: result.catalogNavigation.targetScreenId,
        });
        return;
      }
      // The full planner was used, but deterministic catalog policy found no
      // executable mapped route. Preserve its grounded limitation as the
      // answer and leave the interrupted module resumable.
      baseAnswer = result.answer;
    }
    const directControl = plan.intent === "action" && !plan.unavailableReason && !plan.needsKnowledge;
    const streamedSpeech: Promise<number | null>[] = [];
    const voice = voices.get(state.session.sessionId);
    const utteranceId = createId("utterance");
    if (!baseAnswer && directControl) baseAnswer = "Of course.";
    if (!baseAnswer) {
      const plays = resolveDemoSalesPlays(state.catalog, grounding);
      baseAnswer = await demoInterruptionResponder.answer({
        session: state.session,
        catalog: state.catalog,
        demo: state.demo,
        request,
        plan,
        plays,
        transcript: state.transcript,
        ...(observation ? { observation } : {}),
      }, {
        signal: controller.signal,
        onSentence: (sentence) => {
          send(state.socket, { ...commandBase(state.session.sessionId), kind: "sable.sdk.server.assistant_delta", turnId: request.turnId, text: sentence });
          if (voice && shouldSpeak(state, request) && releasePlaybackBarrier(state, request.turnId)) streamedSpeech.push(voice.speech.say(sentence, { utteranceId, turnId: request.turnId, purpose: "answer" }));
        },
      });
    }
    if (controller.signal.aborted || state.demoPlanningGeneration !== generation || state.pendingDemoInterruption?.request.turnId !== request.turnId) return;
    const transitionOptions = {
      moduleCompletedDuringInterruption: state.demo.moduleCompletedDuringInterruption === true || state.demo.resumeReason === "module_complete",
      journeyFailed: state.demo.resumeReason === "failure",
      activeModuleId: state.demo.activeModuleId,
      nextModuleId: state.demo.playlistModuleIds[state.demo.moduleIndex + 1],
    };
    const answer = `${baseAnswer.trim()} ${demoPlaybackTransitionText(plan, state.catalog, transitionOptions)}`.replace(/\s+/g, " ").trim();
    if (!answerAlreadyRecorded) recordControlExchange(state, request, answer);
    emitFinal(state, request, answer);
    let lastSequence: number | null = null;
    if (!streamedSpeech.length) {
      lastSequence = await speakLines(state, request, [answer], "answer", { utteranceId });
    } else {
      // The streamed model sentences were already synthesized. Speak only the
      // deterministic transition sentence after them.
      const transitionSequence = voice && shouldSpeak(state, request) && releasePlaybackBarrier(state, request.turnId)
        ? voice.speech.say(demoPlaybackTransitionText(plan, state.catalog, transitionOptions), { utteranceId, turnId: request.turnId, purpose: "answer" })
        : Promise.resolve(null);
      try {
        const sequences = (await Promise.all([...streamedSpeech, transitionSequence])).filter((value): value is number => value !== null);
        lastSequence = sequences.length ? Math.max(...sequences) : null;
        if (voice) send(voice.socket, { type: "tts.end", utteranceId, turnId: request.turnId, lastSequence, purpose: "answer" });
      } catch (error) {
        if (voice) send(voice.socket, { type: "voice.error", message: `Text-to-speech unavailable: ${(error as Error).message}` });
      }
    }
    await applyDemoPlaybackDirective(state, request, plan, lastSequence, generation);
    await stores.events.append({
      id: createId("event"),
      tenantId: state.session.installation.organizationId,
      installationId: state.session.installation.installationId,
      sessionId: state.session.sessionId,
      type: "guided_demo.interruption_answered",
      occurredAt: new Date().toISOString(),
      detail: {
        intent: plan.intent,
        playbackDirective: plan.playbackDirective,
        playIds: grounding.selectedPlayIds,
        usedFreshObservation: !!observation,
      },
    });
  };

  const requestDemoObservation = (
    state: ControlState,
    request: TurnRequest,
    plan: DemoInterruptionPlan,
    grounding: DemoSalesPlayGrounding,
    generation: number,
  ): void => {
    if (state.pendingDemoObservation) clearTimeout(state.pendingDemoObservation.timer);
    const commandId = createId("demo-observation");
    const timer = setTimeout(() => {
      const pending = state.pendingDemoObservation;
      if (!pending || pending.commandId !== commandId || state.demoPlanningGeneration !== generation) return;
      state.pendingDemoObservation = undefined;
      void answerPlannedDemoInterruption(
        state,
        request,
        { ...plan, playbackDirective: "remain_paused", needsFreshObservation: false, policyAdjustments: [...plan.policyAdjustments, "The fresh screen observation timed out, so automatic resume was disabled."] },
        grounding,
        generation,
        undefined,
        "I couldn’t read a fresh view of the screen, so I can’t answer that accurately yet.",
      ).finally(() => { if (state.demoPlanningGeneration === generation) state.demoPlanning = undefined; });
    }, config.retrieval.observationTimeoutMs);
    timer.unref();
    state.pendingDemoObservation = { commandId, request, plan, grounding, generation, timer };
    send(state.socket, {
      schemaVersion: SDK_PROTOCOL_VERSION,
      commandId,
      sessionId: state.session.sessionId,
      sentAt: new Date().toISOString(),
      kind: "sable.sdk.server.request_observation",
      turnId: request.turnId,
      reason: "A fresh privacy-filtered screen view is required for this guided-demo interruption",
    });
  };

  const planPausedDemoInterruption = async (state: ControlState): Promise<void> => {
    const director = state.demoDirector;
    const pending = state.pendingDemoInterruption;
    if (!director || !state.demo || !pending) return;
    const generation = ++state.demoPlanningGeneration;
    state.demoPlanning?.abort();
    if (state.pendingDemoObservation) {
      clearTimeout(state.pendingDemoObservation.timer);
      state.pendingDemoObservation = undefined;
    }
    const controller = new AbortController();
    state.demoPlanning = controller;
    try {
      if (state.demo.phase === "answering") {
        const reset = director.finishInterruptionAnswer(state.demo);
        state.demo = reset.state;
      }
      const positionVerified = state.demo.phase === "awaiting_resume"
        && (state.demo.resumeReason === "failure"
          || state.demo.resumeReason === "module_complete"
          || (state.demo.resumeReason === "interruption" && (!!state.demo.checkpoint || !!state.demo.moduleCompletedDuringInterruption)));
      // Meaning can be classified while the SDK is still finishing its current
      // atomic browser action. Browser execution remains gated on a verified
      // checkpoint or terminal journey result below.
      if (state.demo.phase !== "pausing" && !positionVerified) return;
      const activeModule = director.profile.modules.find((module) => module.id === state.demo?.activeModuleId);
      if (!activeModule) throw new Error("The active guided-demo module is unavailable");
      const nextModuleId = state.demo.playlistModuleIds[state.demo.moduleIndex + 1];
      const nextModule = director.profile.modules.find((module) => module.id === nextModuleId);
      const journeyOutcome = state.demo.resumeReason === "failure"
        ? "failed"
        : state.demo.resumeReason === "module_complete" || state.demo.moduleCompletedDuringInterruption
          ? "completed"
          : state.demo.phase === "playing"
            ? "running"
            : "paused";
      const turnPlan = await coordinator.plan(state.session, state.catalog, state.conversation, pending.request, {
        signal: controller.signal,
        activeJourney: {
          journeyId: activeModule.journeyId,
          journeyName: activeModule.name,
          paused: true,
        },
        demoRuntimeState: {
          phase: state.demo.phase,
          activeModule: { id: activeModule.id, name: activeModule.name, journeyId: activeModule.journeyId },
          journeyOutcome,
          ...(state.demo.resumeReason ? { resumeReason: state.demo.resumeReason } : {}),
          checkpointAvailable: !!state.demo.checkpoint,
          moduleCompletedDuringInterruption: state.demo.moduleCompletedDuringInterruption === true,
          ...(nextModule ? { nextModule: { id: nextModule.id, name: nextModule.name, journeyId: nextModule.journeyId } } : {}),
          ...(state.observation?.matchedScreenId ? {
            currentScreen: {
              id: state.observation.matchedScreenId,
              ...(state.observation.matchConfidence !== undefined ? { confidence: state.observation.matchConfidence } : {}),
            },
          } : {}),
          pendingInterruption: true,
        },
      });
      const plan = planDemoInterruption(turnPlan, {
        session: state.session,
        catalog: state.catalog,
        demo: state.demo,
        request: pending.request,
        transcript: state.transcript,
        currentScreenId: state.observation?.matchedScreenId,
      });
      if (controller.signal.aborted || state.demoPlanningGeneration !== generation || state.pendingDemoInterruption?.request.turnId !== pending.request.turnId) return;
      const grounding = retrieveDemoSalesPlays(plan, {
        catalog: state.catalog,
        demo: state.demo,
        requestText: pending.request.text,
      });
      state.pendingDemoInterruption = { request: pending.request, plan, grounding };
      await persistContinuity(state);
      await stores.events.append({
        id: createId("event"),
        tenantId: state.session.installation.organizationId,
        installationId: state.session.installation.installationId,
        sessionId: state.session.sessionId,
        type: "guided_demo.interruption_planned",
        occurredAt: new Date().toISOString(),
        detail: {
          intent: plan.intent,
          responseMode: plan.responseMode,
          taskControl: plan.taskControl,
          playbackDirective: plan.playbackDirective,
          needsKnowledge: plan.needsKnowledge,
          needsFreshObservation: plan.needsFreshObservation,
          playMode: grounding.playMode,
          selectedPlayIds: grounding.selectedPlayIds,
          policyAdjustmentCount: plan.policyAdjustments.length,
          ...(plan.requestedModuleId ? { requestedModuleId: plan.requestedModuleId } : {}),
          ...(plan.answerSubjectModuleId ? { answerSubjectModuleId: plan.answerSubjectModuleId } : {}),
        },
      });
      // Planning is intentionally early, but answering and applying playback
      // directives wait until the browser reports an authoritative position.
      if (state.demo.phase === "pausing") return;
      const answering = director.beginInterruptionAnswer(state.demo);
      await persistDemoState(state, answering.state);
      if (plan.needsFreshObservation) requestDemoObservation(state, pending.request, plan, grounding, generation);
      else await answerPlannedDemoInterruption(state, pending.request, plan, grounding, generation);
    } catch (error) {
      if (controller.signal.aborted || state.demoPlanningGeneration !== generation) return;
      if (state.demo?.phase === "answering") {
        const awaiting = director.finishInterruptionAnswer(state.demo);
        await persistDemoState(state, awaiting.state);
      }
      send(state.socket, {
        ...commandBase(state.session.sessionId),
        kind: "sable.sdk.server.error",
        code: "DEMO_INTERRUPTION_FAILED",
        message: error instanceof Error ? error.message : "The demo interruption could not be planned or answered safely",
        retryable: true,
      });
    } finally {
      if (state.demoPlanningGeneration === generation && !state.pendingDemoObservation) state.demoPlanning = undefined;
    }
  };

  const continuePersistedDemoInterruption = async (state: ControlState): Promise<void> => {
    const pending = state.pendingDemoInterruption;
    const director = state.demoDirector;
    if (!pending?.plan || !director || !state.demo || !["answering", "awaiting_resume"].includes(state.demo.phase)) return;
    if (state.demo.phase === "awaiting_resume") {
      const positionVerified = state.demo.resumeReason === "failure"
        || state.demo.resumeReason === "module_complete"
        || (state.demo.resumeReason === "interruption" && (!!state.demo.checkpoint || !!state.demo.moduleCompletedDuringInterruption));
      if (!positionVerified) return;
      const answering = director.beginInterruptionAnswer(state.demo);
      await persistDemoState(state, answering.state);
    }
    const grounding = pending.grounding ?? retrieveDemoSalesPlays(pending.plan, {
      catalog: state.catalog,
      demo: state.demo!,
      requestText: pending.request.text,
    });
    state.pendingDemoInterruption = { ...pending, grounding };
    const generation = ++state.demoPlanningGeneration;
    state.demoPlanning?.abort();
    const controller = new AbortController();
    state.demoPlanning = controller;
    if (pending.plan.needsFreshObservation) {
      requestDemoObservation(state, pending.request, pending.plan, grounding, generation);
      return;
    }
    try {
      await answerPlannedDemoInterruption(state, pending.request, pending.plan, grounding, generation);
    } finally {
      if (state.demoPlanningGeneration === generation) state.demoPlanning = undefined;
    }
  };

  const requestFreshObservation = (state: ControlState, request: TurnRequest, plan: TurnPlan, purpose: "turn" | "presentation", generation: number): void => {
    const commandId = createId("observation");
    const timer = setTimeout(() => {
      if (state.pendingObservation?.commandId !== commandId || state.generation !== generation) return;
      state.pendingObservation = undefined;
      const text = purpose === "presentation"
        ? "I reached the requested area, but I could not read a fresh view of it in time. Please try again."
        : "I could not read a fresh view of this page in time. Please try again.";
      emitFinal(state, request, text);
      void speakLines(state, request, [text], "answer")
        .then((lastSequence) => inviteNextVoiceTurn(state, request, lastSequence));
    }, config.retrieval.observationTimeoutMs);
    timer.unref();
    state.pendingObservation = { commandId, request, plan, purpose, generation, timer };
    send(state.socket, { schemaVersion: SDK_PROTOCOL_VERSION, commandId, sessionId: state.session.sessionId, sentAt: new Date().toISOString(), kind: "sable.sdk.server.request_observation", turnId: request.turnId, reason: purpose === "presentation" ? "Explain the section after verified SDK navigation" : "A fresh privacy-filtered DOM observation is required for this turn" });
  };

  const resumeRestoredJourney = (state: ControlState, observation: import("@sable/sdk-contracts").ScreenObservation): void => {
    const checkpoint = state.pendingRestore;
    if (!checkpoint) return;
    state.pendingRestore = undefined;
    if (!restoredJourneyIsValid(state, checkpoint) || !matchesAuthoritativeJourney(state, checkpoint) || !observation.matchedScreenId || !checkpoint.expectedScreenIds.includes(observation.matchedScreenId)) {
      send(state.socket, { ...commandBase(state.session.sessionId), kind: "sable.sdk.server.error", code: "CONTINUITY_REJECTED", message: "The destination page did not match the saved read-only journey", retryable: false });
      return;
    }
    const authoritative = state.authoritativePendingJourney;
    const presentationRequested = authoritative?.presentationRequested ?? false;
    const generation = ++state.generation;
    const request: TurnRequest = { turnId: checkpoint.turnId, text: checkpoint.originalRequest, modality: "text" };
    const action: JourneyAction = { journeyId: checkpoint.journeyId, inputs: checkpoint.inputs, acknowledgement: "Continuing on the verified destination page.", ...(authoritative?.segment ? { segment: authoritative.segment } : {}) };
    const plan: TurnPlan = {
      intent: "action", mode: presentationRequested ? "execute_then_observe_and_answer" : "execute",
      taskControl: "none",
      needsFreshObservation: false, needsKnowledge: presentationRequested,
      actionRequested: true, presentationRequested, journeyId: checkpoint.journeyId, journeyInputs: checkpoint.inputs,
    };
    const commandId = createId("journey");
    state.pendingJourney = {
      commandId,
      request,
      plan,
      action,
      generation,
      completedStepIds: [...checkpoint.completedStepIds],
      nextStepId: checkpoint.nextStepId,
      paused: false,
      ...(authoritative?.demoModuleId ? { demoModuleId: authoritative.demoModuleId } : {}),
    };
    state.authoritativePendingJourney = undefined;
    send(state.socket, {
      schemaVersion: SDK_PROTOCOL_VERSION, commandId, sessionId: state.session.sessionId, sentAt: new Date().toISOString(),
      kind: "sable.sdk.server.run_journey", turnId: checkpoint.turnId, catalogVersionId: state.session.catalogVersionId,
      journeyId: checkpoint.journeyId, inputs: checkpoint.inputs,
      ...(action.segment ? { segment: action.segment } : {}),
      resume: { completedStepIds: checkpoint.completedStepIds, nextStepId: checkpoint.nextStepId },
    });
  };

  const finishRestoredCatalogNavigation = async (state: ControlState, observation: import("@sable/sdk-contracts").ScreenObservation): Promise<void> => {
    const checkpoint = state.pendingCatalogNavigationRestore;
    if (!checkpoint) return;
    state.pendingCatalogNavigationRestore = undefined;
    const bundle = await stores.catalogs.getBundle({
      organizationId: state.session.installation.organizationId,
      productId: state.session.installation.productId,
      roleProfileId: state.session.role,
      catalogVersionId: state.session.catalogVersionId,
    });
    if (!bundle || !restoredCatalogNavigationIsValid(state, checkpoint, bundle, observation)) {
      state.authoritativePendingCatalogNavigation = undefined;
      send(state.socket, { ...commandBase(state.session.sessionId), kind: "sable.sdk.server.clear_catalog_navigation" });
      send(state.socket, { ...commandBase(state.session.sessionId), kind: "sable.sdk.server.error", code: "CONTINUITY_REJECTED", message: "The destination did not match the trained catalog transition", retryable: false });
      await persistContinuity(state);
      return;
    }
    const authoritative = state.authoritativePendingCatalogNavigation;
    state.authoritativePendingCatalogNavigation = undefined;
    const targetName = state.catalog.payload.screens.find((candidate) => candidate.id === checkpoint.targetScreenId)?.name ?? checkpoint.targetScreenId;
    const request: TurnRequest = { turnId: checkpoint.turnId, text: checkpoint.originalRequest, modality: authoritative?.modality ?? "text" };
    const remainingSteps = authoritative?.remainingSteps ?? [];
    if (remainingSteps.length) {
      const next = remainingSteps[0];
      const finalTargetScreenId = authoritative?.finalTargetScreenId ?? remainingSteps.at(-1)?.targetScreenId ?? next?.targetScreenId;
      if (!next || next.sourceScreenId !== checkpoint.targetScreenId || !finalTargetScreenId) {
        send(state.socket, { ...commandBase(state.session.sessionId), kind: "sable.sdk.server.clear_catalog_navigation" });
        send(state.socket, { ...commandBase(state.session.sessionId), kind: "sable.sdk.server.error", code: "CONTINUITY_REJECTED", message: "The remaining catalog plan did not join the verified destination", retryable: false });
        await persistContinuity(state);
        return;
      }
      state.pendingCatalogPlan = {
        turnId: checkpoint.turnId,
        originalRequest: checkpoint.originalRequest,
        modality: request.modality,
        finalTargetScreenId,
        remainingSteps: structuredClone(remainingSteps),
      };
      send(state.socket, { ...commandBase(state.session.sessionId), kind: "sable.sdk.server.clear_catalog_navigation" });
      const answer = `${targetName} is open and verified. Say continue for the next catalog-approved step, or ask me to stop or do something else.`;
      emitFinal(state, request, answer);
      await persistContinuity(state);
      const lastSequence = await speakLines(state, request, [answer], "result");
      await inviteNextVoiceTurn(state, request, lastSequence);
      return;
    }
    const answer = `Done — I opened ${targetName} and verified the destination screen.`;
    state.conversation.messages.push({ role: "assistant", blocks: [{ type: "text", text: answer }] });
    state.conversation.messages = state.conversation.messages.slice(-config.reasoning.maxHistory);
    emitFinal(state, request, answer);
    send(state.socket, { ...commandBase(state.session.sessionId), kind: "sable.sdk.server.clear_catalog_navigation" });
    await persistContinuity(state);
  };

  const recordControlExchange = (state: ControlState, request: TurnRequest, answer: string): void => {
    state.conversation.messages.push(
      { role: "user", blocks: [{ type: "text", text: request.text.trim() }] },
      { role: "assistant", blocks: [{ type: "text", text: answer }] },
    );
    state.conversation.messages = state.conversation.messages.slice(-config.reasoning.maxHistory);
  };

  const stopPendingJourney = async (state: ControlState, reason: string): Promise<boolean> => {
    if (!state.pendingJourney && !state.authoritativePendingJourney && !state.pendingRestore && !state.pendingCatalogNavigation && !state.authoritativePendingCatalogNavigation && !state.pendingCatalogNavigationRestore && !state.pendingCatalogPlan) return false;
    state.pendingJourney = undefined;
    state.authoritativePendingJourney = undefined;
    state.pendingRestore = undefined;
    state.pendingCatalogNavigation = undefined;
    state.authoritativePendingCatalogNavigation = undefined;
    state.pendingCatalogNavigationRestore = undefined;
    state.pendingCatalogPlan = undefined;
    state.queuedTurn = undefined;
    send(state.socket, { ...commandBase(state.session.sessionId), kind: "sable.sdk.server.stop_journey", reason });
    await persistContinuity(state);
    return true;
  };

  const answerControlTurn = async (state: ControlState, request: TurnRequest, answer: string): Promise<void> => {
    recordControlExchange(state, request, answer);
    emitFinal(state, request, answer);
    const lastSequence = await speakLines(state, request, [answer], "answer");
    await inviteNextVoiceTurn(state, request, lastSequence);
  };

  const continueCatalogPlan = async (state: ControlState): Promise<boolean> => {
    const pending = state.pendingCatalogPlan;
    const first = pending?.remainingSteps[0];
    if (!pending || !first) return false;
    if (state.observation?.matchedScreenId !== first.sourceScreenId) {
      await stopPendingJourney(state, "The current page no longer matches the paused catalog plan");
      const request: TurnRequest = { turnId: pending.turnId, text: pending.originalRequest, modality: pending.modality };
      await answerControlTurn(state, request, "I stopped the plan because the current page no longer matches its next trained step.");
      return true;
    }
    const request: TurnRequest = { turnId: pending.turnId, text: pending.originalRequest, modality: pending.modality };
    const plan: TurnPlan = {
      intent: "action", mode: "navigate", taskControl: "continue", needsFreshObservation: false, needsKnowledge: false,
      actionRequested: true, presentationRequested: false, navigationTargetScreenId: pending.finalTargetScreenId, journeyInputs: {},
    };
    const action: CatalogNavigationAction = { ...first, steps: structuredClone(pending.remainingSteps), acknowledgement: "Continuing with the next verified catalog step." };
    const commandId = createId("catalog-plan");
    state.pendingCatalogPlan = undefined;
    state.pendingCatalogNavigation = { commandId, request, plan, action, generation: state.generation };
    await persistContinuity(state);
    send(state.socket, {
      schemaVersion: SDK_PROTOCOL_VERSION, commandId, sessionId: state.session.sessionId, sentAt: new Date().toISOString(),
      kind: "sable.sdk.server.run_catalog_navigation", turnId: request.turnId, catalogVersionId: state.session.catalogVersionId,
      sourceScreenId: first.sourceScreenId, controlId: first.controlId, targetScreenId: first.targetScreenId,
    });
    return true;
  };

  const resolveTurn = async (state: ControlState, request: TurnRequest, observation?: import("@sable/sdk-contracts").ScreenObservation, existingPlan?: TurnPlan, generation = state.generation) => {
    if (isDirectStopRequest(request.text) && (state.pendingJourney || state.pendingCatalogPlan)) {
      const stoppedJourney = !!state.pendingJourney;
      await stopPendingJourney(state, "Stopped by the user");
      await answerControlTurn(state, request, stoppedJourney ? "Stopped the current journey." : "Stopped the current plan.");
      return;
    }
    if (isDirectContinueRequest(request.text) && await continueCatalogPlan(state)) return;
    if (isDirectContinueRequest(request.text) && state.pendingJourney?.paused && state.pendingJourney.nextStepId) {
      const pending = state.pendingJourney;
      const commandId = createId("journey");
      // Continue is a control turn, not a replacement for the request that
      // selected the journey. Preserve that request so any post-navigation
      // explanation answers the user's original question.
      state.pendingJourney = { ...pending, commandId, generation, paused: false };
      send(state.socket, { schemaVersion: SDK_PROTOCOL_VERSION, commandId, sessionId: state.session.sessionId, sentAt: new Date().toISOString(), kind: "sable.sdk.server.run_journey", turnId: pending.request.turnId, catalogVersionId: state.session.catalogVersionId, journeyId: pending.action.journeyId, inputs: pending.action.inputs, ...(pending.action.segment ? { segment: pending.action.segment } : {}), resume: { completedStepIds: pending.completedStepIds, nextStepId: pending.nextStepId } });
      return;
    }
    const activeJourney = state.pendingJourney ? {
      journeyId: state.pendingJourney.action.journeyId,
      journeyName: state.catalog.payload.journeys.find((journey) => journey.id === state.pendingJourney?.action.journeyId)?.name ?? state.pendingJourney.action.journeyId,
      paused: state.pendingJourney.paused,
    } : state.pendingCatalogPlan ? {
      journeyId: `catalog-plan:${state.pendingCatalogPlan.finalTargetScreenId}`,
      journeyName: `catalog plan to ${state.catalog.payload.screens.find((screen) => screen.id === state.pendingCatalogPlan?.finalTargetScreenId)?.name ?? state.pendingCatalogPlan.finalTargetScreenId}`,
      paused: true,
    } : undefined;
    const plan = existingPlan ?? await coordinator.plan(state.session, state.catalog, state.conversation, request, { activeJourney });
    if (state.generation !== generation) return;
    if ((state.pendingJourney || state.pendingCatalogPlan) && plan.taskControl === "stop") {
      const stoppedJourney = !!state.pendingJourney;
      await stopPendingJourney(state, "Stopped by the user");
      await answerControlTurn(state, request, stoppedJourney ? "Stopped the current journey." : "Stopped the current plan.");
      return;
    }
    if (state.pendingJourney?.paused && state.pendingJourney.nextStepId && plan.taskControl === "continue") {
      const pending = state.pendingJourney;
      const commandId = createId("journey");
      state.pendingJourney = { ...pending, commandId, generation, paused: false };
      send(state.socket, { schemaVersion: SDK_PROTOCOL_VERSION, commandId, sessionId: state.session.sessionId, sentAt: new Date().toISOString(), kind: "sable.sdk.server.run_journey", turnId: pending.request.turnId, catalogVersionId: state.session.catalogVersionId, journeyId: pending.action.journeyId, inputs: pending.action.inputs, ...(pending.action.segment ? { segment: pending.action.segment } : {}), resume: { completedStepIds: pending.completedStepIds, nextStepId: pending.nextStepId } });
      return;
    }
    if ((state.pendingJourney || state.pendingCatalogPlan) && plan.taskControl === "replace") {
      await stopPendingJourney(state, "Replaced by a newer user request");
    }
    if (!observation && plan.needsFreshObservation) {
      requestFreshObservation(state, request, plan, "turn", generation);
      return;
    }
    state.busy?.abort();
    const controller = new AbortController();
    state.busy = controller;
    state.session.modality = request.modality;
    const streamed: string[] = [];
    const voice = voices.get(state.session.sessionId);
    const utteranceId = createId("utterance");
    const streamedSpeech: Promise<number | null>[] = [];
    voice?.turns.beginThinking();
    const result = await coordinator.run(state.session, state.catalog, state.conversation, request, plan, observation ?? state.observation, {
      signal: controller.signal,
      onSentence: (sentence) => {
        streamed.push(sentence);
        send(state.socket, { ...commandBase(state.session.sessionId), kind: "sable.sdk.server.assistant_delta", turnId: request.turnId, text: sentence });
        if (voice && shouldSpeak(state, request)) {
          if (releasePlaybackBarrier(state, request.turnId)) streamedSpeech.push(voice.speech.say(sentence, { utteranceId, turnId: request.turnId, purpose: "answer" }));
        }
      },
    });
    if (controller.signal.aborted || state.busy !== controller || state.generation !== generation) return;
    emitFinal(state, request, result.answer);
    let lastSequence: number | null;
    if (result.action || result.catalogNavigation || !streamedSpeech.length) {
      lastSequence = await speakLines(state, request, [result.answer], result.action || result.catalogNavigation ? "acknowledgement" : "answer", { utteranceId });
    } else {
      try {
        const sequences = (await Promise.all(streamedSpeech)).filter((value): value is number => value !== null);
        lastSequence = sequences.length ? Math.max(...sequences) : null;
        if (voice) send(voice.socket, { type: "tts.end", utteranceId, turnId: request.turnId, lastSequence, purpose: "answer" });
      } catch (error) {
        lastSequence = null;
        if (voice) send(voice.socket, { type: "voice.error", message: `Text-to-speech unavailable: ${(error as Error).message}` });
      }
    }
    if (!result.action && !result.catalogNavigation) {
      if (state.busy === controller) state.busy = undefined;
      await inviteNextVoiceTurn(state, request, lastSequence);
      return;
    }
    if (voice) await voice.sync.waitFor(lastSequence);
    if (controller.signal.aborted || state.busy !== controller || state.generation !== generation) return;
    state.busy = undefined;
    const commandId = createId("journey");
    if (result.catalogNavigation) {
      state.pendingCatalogNavigation = { commandId, request, plan, action: result.catalogNavigation, generation };
      await persistContinuity(state);
      send(state.socket, {
        schemaVersion: SDK_PROTOCOL_VERSION, commandId, sessionId: state.session.sessionId, sentAt: new Date().toISOString(),
        kind: "sable.sdk.server.run_catalog_navigation", turnId: request.turnId, catalogVersionId: state.session.catalogVersionId,
        sourceScreenId: result.catalogNavigation.sourceScreenId, controlId: result.catalogNavigation.controlId, targetScreenId: result.catalogNavigation.targetScreenId,
      });
      return;
    }
    const journeyAction = result.action;
    if (!journeyAction) return;
    state.pendingJourney = { commandId, request, plan, action: journeyAction, generation, completedStepIds: [], paused: false };
    await persistContinuity(state);
    send(state.socket, { schemaVersion: SDK_PROTOCOL_VERSION, commandId, sessionId: state.session.sessionId, sentAt: new Date().toISOString(), kind: "sable.sdk.server.run_journey", turnId: request.turnId, catalogVersionId: state.session.catalogVersionId, journeyId: journeyAction.journeyId, inputs: journeyAction.inputs, ...(journeyAction.segment ? { segment: journeyAction.segment } : {}) });
  };

  const resolvePresentation = async (state: ControlState, request: TurnRequest, plan: TurnPlan, observation: import("@sable/sdk-contracts").ScreenObservation, generation: number) => {
    if (state.generation !== generation) return;
    state.busy?.abort();
    const controller = new AbortController();
    state.busy = controller;
    state.session.modality = request.modality;
    const voice = voices.get(state.session.sessionId);
    const utteranceId = createId("utterance");
    const streamedSpeech: Promise<number | null>[] = [];
    voice?.turns.beginThinking();
    const result = await coordinator.explainAfterPresentation(state.session, state.conversation, request, plan, observation, {
      signal: controller.signal,
      onSentence: (sentence) => {
        send(state.socket, { ...commandBase(state.session.sessionId), kind: "sable.sdk.server.assistant_delta", turnId: request.turnId, text: sentence });
        if (voice && shouldSpeak(state, request) && releasePlaybackBarrier(state, request.turnId)) streamedSpeech.push(voice.speech.say(sentence, { utteranceId, turnId: request.turnId, purpose: "answer" }));
      },
    });
    if (controller.signal.aborted || state.busy !== controller || state.generation !== generation) return;
    emitFinal(state, request, result.answer);
    let lastSequence: number | null = null;
    if (!streamedSpeech.length) lastSequence = await speakLines(state, request, [result.answer], "answer", { utteranceId });
    else {
      try {
        const sequences = (await Promise.all(streamedSpeech)).filter((value): value is number => value !== null);
        lastSequence = sequences.length ? Math.max(...sequences) : null;
        if (voice) send(voice.socket, { type: "tts.end", utteranceId, turnId: request.turnId, lastSequence, purpose: "answer" });
      } catch (error) {
        if (voice) send(voice.socket, { type: "voice.error", message: `Text-to-speech unavailable: ${(error as Error).message}` });
      }
    }
    if (state.busy === controller) state.busy = undefined;
    await inviteNextVoiceTurn(state, request, lastSequence);
  };

  app.get("/ws/sdk", { websocket: true }, (socket, request) => {
    try {
      const token = socketTicket(request as never);
      if (usedTickets.has(token)) throw new Error("Ticket was already used");
      const claims = signer.verify(token, "control_ticket"); usedTickets.add(token);
      const earlyMessages: string[] = [];
      let handleText = (text: string) => { earlyMessages.push(text); };
      socket.on("message", (raw) => handleText(raw.toString()));
      void (async () => {
        const session = await stores.sessions.get(claims.sub); if (!session) throw new Error("Session not found");
        const catalog = await stores.catalogs.get(session.catalogVersionId, session.installation); if (!catalog) throw new Error("Catalog not found");
        const demoDirector = session.installation.guidedDemo?.enabled === true && catalog.payload.demoProfile
          ? new DeterministicDemoDirector(catalog, session.role)
          : undefined;
        const state: ControlState = {
          socket,
          session,
          catalog,
          conversation: { messages: [] },
          transcript: [],
          continuityStartedAt: new Date().toISOString(),
          continuityRevision: 0,
          generation: 0,
          demoPlanningGeneration: 0,
          ...(demoDirector ? { demoDirector, demo: demoDirector.restore(session.guidedDemo) } : {}),
        }; controls.set(session.sessionId, state); activeConnections++;
        const beginTurn = async (turn: TurnRequest) => {
          state.generation += 1;
          const generation = state.generation;
          state.busy?.abort();
          if (state.pendingObservation) {
            clearTimeout(state.pendingObservation.timer);
            state.pendingObservation = undefined;
          }
          await resolveTurn(state, turn, undefined, undefined, generation);
        };
        const processText = async (text: string) => {
          let voiceRequest: TurnRequest | undefined;
          try {
            if (text.length > 256_000) throw new Error("Message too large");
            const message = assertValidSdkClientMessage(JSON.parse(text)) as SdkClientMessage;
            if (message.sessionId !== session.sessionId) throw new Error("Wrong session");
            if (message.kind === "sable.sdk.client.ready") {
              if (message.catalogVersionId !== session.catalogVersionId || new URL(message.currentUrl).origin !== session.origin) throw new Error("Ready scope does not match session");
              state.readyUrl = new URL(message.currentUrl).toString();
              sendDemoState(state);
              if (state.demo?.phase === "closing") scheduleDemoClosing(state);
            }
            else if (message.kind === "sable.sdk.client.demo_control") {
              if (!state.demoDirector || !state.demo) throw new Error("Guided demo is not enabled for this installation and signed catalog");
              const transition = state.demoDirector.control(state.demo, message.action);
              state.demoPlanning?.abort();
              state.demoPlanningGeneration += 1;
              if (state.pendingDemoObservation) { clearTimeout(state.pendingDemoObservation.timer); state.pendingDemoObservation = undefined; }
              state.pendingDemoInterruption = undefined;
              if (state.demoClosingTimer) { clearTimeout(state.demoClosingTimer); state.demoClosingTimer = undefined; }
              const abandonsPausedJourney = (message.action === "retry" || message.action === "skip") && !!state.pendingJourney?.paused;
              if (abandonsPausedJourney) {
                state.pendingJourney = undefined;
                state.authoritativePendingJourney = undefined;
              }
              if (transition.instruction.kind === "stop") {
                state.pendingJourney = undefined;
                state.authoritativePendingJourney = undefined;
                state.queuedTurn = undefined;
              }
              await persistDemoState(state, transition.state);
              if (abandonsPausedJourney) {
                send(socket, { ...commandBase(session.sessionId), kind: "sable.sdk.server.stop_journey", reason: message.action === "retry" ? "Restarting the guided-demo module" : "Skipping the paused guided-demo module" });
              }
              if (transition.instruction.kind === "run" || transition.instruction.kind === "resume") {
                await runDemoModule(state, transition.instruction);
              } else if (transition.instruction.kind === "stop") {
                send(socket, { ...commandBase(session.sessionId), kind: "sable.sdk.server.stop_journey", reason: "Guided demo stopped by the user" });
                await persistContinuity(state);
              } else if (transition.state.phase === "closing") scheduleDemoClosing(state);
            }
            else if (message.kind === "sable.sdk.client.restore_context") {
              if (state.continuityId && state.continuityId !== message.continuityId) throw new Error("Continuity ID cannot change within one socket");
              const expectedContinuityId = signer.opaqueId("continuity", session.installation.installationId, session.installation.organizationId, session.installation.productId, session.installation.environmentId, session.userId, session.role, session.catalogVersionId);
              if (message.continuityId !== expectedContinuityId) throw new Error("Continuity ID does not belong to this authenticated scope");
              const previousOwnerId = continuityOwners.get(message.continuityId);
              if (previousOwnerId && previousOwnerId !== session.sessionId) {
                const previousOwner = controls.get(previousOwnerId);
                if (previousOwner) {
                  previousOwner.continuityId = undefined;
                  await previousOwner.continuityWrite?.catch(() => undefined);
                  send(previousOwner.socket, { ...commandBase(previousOwner.session.sessionId), kind: "sable.sdk.server.error", code: "SESSION_REPLACED", message: "Sable continued in a newer tab", retryable: true });
                  previousOwner.socket.close(4001, "newer tab owns continuity");
                }
              }
              continuityOwners.set(message.continuityId, session.sessionId);
              const stored = await stores.continuities.get(message.continuityId);
              state.continuityId = message.continuityId;
              if (stored && sameContinuityScope(stored, session)) {
                state.conversation = { messages: structuredClone(stored.messages) };
                state.transcript = structuredClone(stored.transcript);
                state.continuityStartedAt = stored.startedAt;
                state.continuityRevision = stored.revision;
                state.authoritativePendingJourney = structuredClone(stored.pendingJourney);
                state.authoritativePendingCatalogNavigation = structuredClone(stored.pendingCatalogNavigation);
                state.pendingCatalogPlan = structuredClone(stored.pendingCatalogPlan);
                state.pendingDemoInterruption = stored.pendingDemoInterruption ? {
                  request: {
                    turnId: stored.pendingDemoInterruption.turnId,
                    text: stored.pendingDemoInterruption.originalRequest,
                    modality: stored.pendingDemoInterruption.modality,
                  },
                  ...(stored.pendingDemoInterruption.plan ? { plan: structuredClone(stored.pendingDemoInterruption.plan) } : {}),
                  ...(stored.pendingDemoInterruption.grounding ? { grounding: structuredClone(stored.pendingDemoInterruption.grounding) } : {}),
                } : undefined;
                if (state.demoDirector) {
                  state.demo = state.demoDirector.restore(stored.guidedDemo ?? session.guidedDemo);
                  state.session.guidedDemo = structuredClone(state.demo);
                  await stores.sessions.put(state.session);
                }
              } else {
                state.conversation = fallbackConversation(message.transcript);
                state.transcript = structuredClone(message.transcript);
              }
              if (message.journey) {
                if (!state.readyUrl || !restoredJourneyIsValid(state, message.journey) || !matchesAuthoritativeJourney(state, message.journey)) throw new Error("Restored journey did not pass signed catalog or server checkpoint checks");
                if (state.demo?.phase === "awaiting_resume" && state.demo.checkpoint) {
                  const checkpoint = state.demo.checkpoint;
                  if (checkpoint.journeyId !== message.journey.journeyId || checkpoint.nextStepId !== message.journey.nextStepId
                    || canonicalizeJson(checkpoint.completedStepIds) !== canonicalizeJson(message.journey.completedStepIds)) {
                    throw new Error("Restored SDK checkpoint does not match the guided-demo interruption checkpoint");
                  }
                } else state.pendingRestore = structuredClone(message.journey);
              }
              if (message.catalogNavigation) {
                state.pendingCatalogNavigationRestore = structuredClone(message.catalogNavigation);
              }
              const saved = await persistContinuity(state);
              if (saved && state.continuityId) send(socket, {
                ...commandBase(session.sessionId),
                kind: "sable.sdk.server.restore_state",
                continuityId: state.continuityId,
                revision: state.continuityRevision,
                transcript: structuredClone(state.transcript.slice(-100)),
              });
              sendDemoState(state);
              if (state.demo?.phase === "closing") scheduleDemoClosing(state);
              if (state.pendingRestore && state.observation) resumeRestoredJourney(state, state.observation);
              if (state.pendingCatalogNavigationRestore && state.observation) await finishRestoredCatalogNavigation(state, state.observation);
              if (state.demo?.phase === "awaiting_resume" && ["interruption", "module_complete", "failure"].includes(state.demo.resumeReason ?? "") && state.pendingDemoInterruption && !state.pendingDemoInterruption.plan) {
                await planPausedDemoInterruption(state);
              } else if (state.pendingDemoInterruption?.plan && ["answering", "awaiting_resume"].includes(state.demo?.phase ?? "")) {
                await continuePersistedDemoInterruption(state);
              }
            }
            else if (message.kind === "sable.sdk.client.user_turn") {
              voiceRequest = { turnId: message.turnId, text: message.text, modality: message.modality };
              if (state.playbackBarrier && !state.playbackBarrier.turnId) state.playbackBarrier.turnId = message.turnId;
              const key = `user:${message.turnId}`;
              if (!state.transcript.some((entry) => entry.key === key)) state.transcript.push({ key, role: "user", text: message.text, createdAt: message.sentAt });
              if (state.demoDirector && state.demo && !["idle", "completed", "stopped"].includes(state.demo.phase)) {
                if (state.demo.phase === "intake") {
                  if (isLikelyIntakeInterruption(message.text)) {
                    await answerIntakeInterruption(state, voiceRequest);
                  } else {
                    releasePlaybackBarrier(state, voiceRequest.turnId);
                    const transition = state.demoDirector.captureIntake(state.demo, message.text);
                    await persistDemoState(state, transition.state);
                    if (transition.instruction.kind === "run" || transition.instruction.kind === "resume") await runDemoModule(state, transition.instruction);
                    else if (transition.state.phase === "closing") scheduleDemoClosing(state);
                  }
                } else if (state.demo.phase === "playing" && state.pendingJourney && !state.pendingJourney.paused) {
                  state.pendingDemoInterruption = { request: voiceRequest };
                  const transition = state.demoDirector.beginInterruption(state.demo);
                  await persistDemoState(state, transition.state);
                  send(socket, { ...commandBase(session.sessionId), kind: "sable.sdk.server.pause_journey", journeyId: state.pendingJourney.action.journeyId, reason: "Guided-demo interruption is waiting at the next atomic boundary" });
                  await planPausedDemoInterruption(state);
                } else if (state.demo.phase === "pausing") {
                  state.pendingDemoInterruption = { request: voiceRequest };
                  await persistContinuity(state);
                  await planPausedDemoInterruption(state);
                } else if (state.demo.phase === "awaiting_resume" && state.demo.resumeReason === "module_complete" && isModuleContinuationRequest(message.text)) {
                  releasePlaybackBarrier(state, voiceRequest.turnId);
                  const transition = state.demoDirector.control(state.demo, "continue");
                  await persistDemoState(state, transition.state);
                  if (transition.instruction.kind === "run" || transition.instruction.kind === "resume") await runDemoModule(state, transition.instruction);
                  else if (transition.state.phase === "closing") scheduleDemoClosing(state);
                } else if ((state.demo.phase === "awaiting_resume" && ["interruption", "module_complete", "failure"].includes(state.demo.resumeReason ?? "")) || state.demo.phase === "answering") {
                  state.pendingDemoInterruption = { request: voiceRequest };
                  await planPausedDemoInterruption(state);
                } else {
                  const answer = state.demo.phase === "awaiting_resume"
                    ? "The guided demo is paused. Choose Continue, Retry, Skip, or Stop."
                    : "I am safely pausing the guided demo before handling that interruption.";
                  await answerControlTurn(state, voiceRequest, answer);
                  await persistContinuity(state);
                }
              } else if (state.pendingJourney && !state.pendingJourney.paused) {
                // Keep only the newest interruption. The SDK will finish the
                // current atomic action and pause before the next step.
                state.queuedTurn = voiceRequest;
                send(socket, { ...commandBase(session.sessionId), kind: "sable.sdk.server.pause_journey", journeyId: state.pendingJourney.action.journeyId, reason: "A newer user turn is waiting" });
              } else await beginTurn(voiceRequest);
            }
            else if (message.kind === "sable.sdk.client.observation") {
              state.observation = message.observation;
              if (state.pendingRestore) resumeRestoredJourney(state, message.observation);
              if (state.pendingCatalogNavigationRestore) await finishRestoredCatalogNavigation(state, message.observation);
              if (state.pendingDemoObservation && message.reason === "requested" && message.replyToCommandId === state.pendingDemoObservation.commandId && message.turnId === state.pendingDemoObservation.request.turnId) {
                const pending = state.pendingDemoObservation;
                clearTimeout(pending.timer);
                state.pendingDemoObservation = undefined;
                try {
                  await answerPlannedDemoInterruption(state, pending.request, pending.plan, pending.grounding, pending.generation, message.observation);
                } finally {
                  if (state.demoPlanningGeneration === pending.generation) state.demoPlanning = undefined;
                }
              } else if (state.pendingObservation && message.reason === "requested" && message.replyToCommandId === state.pendingObservation.commandId && message.turnId === state.pendingObservation.request.turnId) {
                const pending = state.pendingObservation;
                voiceRequest = pending.request;
                clearTimeout(pending.timer);
                state.pendingObservation = undefined;
                if (pending.purpose === "presentation") await resolvePresentation(state, pending.request, pending.plan, message.observation, pending.generation);
                else await resolveTurn(state, pending.request, message.observation, pending.plan, pending.generation);
              }
            } else if (message.kind === "sable.sdk.client.demo_narration") {
              const narration = resolveDemoNarration(state, message);
              const narrationRequest: TurnRequest = { turnId: message.turnId, text: narration, modality: state.session.modality ?? "text" };
              const lastSequence = await speakLines(
                state,
                narrationRequest,
                [narration],
                "demo",
                { utteranceId: message.utteranceId, ...(message.moduleId ? { journeyId: state.pendingJourney?.action.journeyId } : {}) },
                true,
              );
              await inviteNextVoiceTurn(state, narrationRequest, lastSequence);
            } else if (message.kind === "sable.sdk.client.journey_narration") {
              const pending = state.pendingJourney;
              if (!pending || message.commandId !== pending.commandId || message.journeyId !== pending.action.journeyId || message.turnId !== pending.request.turnId) throw new Error("Narration request does not match the pending approved journey");
              const journey = state.catalog.payload.journeys.find((candidate) => candidate.id === message.journeyId && candidate.state === "approved");
              const step = journey ? findWorkflowStep(journey.workflow.steps, message.stepId) : undefined;
              if (!step?.narration) {
                const voice = voices.get(session.sessionId);
                if (voice) {
                  send(voice.socket, { type: "tts.end", utteranceId: message.utteranceId, turnId: message.turnId, lastSequence: null, purpose: "journey_step" });
                  send(voice.socket, { type: "voice.listen", turnId: message.turnId });
                }
              } else {
                const lastSequence = await speakLines(state, pending.request, [step.narration], "journey_step", { utteranceId: message.utteranceId, journeyId: message.journeyId, stepId: message.stepId }, true);
                await inviteNextVoiceTurn(state, pending.request, lastSequence);
              }
            } else if (message.kind === "sable.sdk.client.catalog_navigation_result" && state.pendingCatalogNavigation && message.commandId === state.pendingCatalogNavigation.commandId) {
              const pending = state.pendingCatalogNavigation;
              state.pendingCatalogNavigation = undefined;
              state.authoritativePendingCatalogNavigation = undefined;
              const demoPending = state.pendingDemoInterruption;
              if (demoPending?.plan?.responseMode === "navigate"
                && demoPending.request.turnId === pending.request.turnId
                && state.demoDirector && state.demo?.phase === "answering") {
                const transitionOptions = {
                  moduleCompletedDuringInterruption: state.demo.moduleCompletedDuringInterruption === true || state.demo.resumeReason === "module_complete",
                  activeModuleId: state.demo.activeModuleId,
                  nextModuleId: state.demo.playlistModuleIds[state.demo.moduleIndex + 1],
                };
                const resultText = message.ok
                  ? "Done — I verified that navigation."
                  : `I couldn't navigate safely. ${message.detail ?? "The trained transition was not verified."}`;
                const answer = `${resultText} ${demoPlaybackTransitionText(demoPending.plan, state.catalog, transitionOptions)}`.replace(/\s+/g, " ").trim();
                emitFinal(state, pending.request, answer);
                const lastSequence = await speakLines(state, pending.request, [answer], "result");
                await applyDemoPlaybackDirective(state, pending.request, demoPending.plan, lastSequence, state.demoPlanningGeneration);
                await persistContinuity(state);
                return;
              }
              const answer = message.ok ? "Done — I verified that navigation." : `I couldn't navigate safely. ${message.detail ?? "The trained transition was not verified."}`;
              emitFinal(state, pending.request, answer);
              await persistContinuity(state);
              const lastSequence = await speakLines(state, pending.request, [answer], "result");
              await inviteNextVoiceTurn(state, pending.request, lastSequence);
            } else if (message.kind === "sable.sdk.client.journey_result" && state.pendingJourney && message.commandId === state.pendingJourney.commandId && message.journeyId === state.pendingJourney.action.journeyId) {
              const pending = state.pendingJourney; state.pendingJourney = undefined;
              state.authoritativePendingJourney = undefined;
              if (pending.demoModuleId && state.demoDirector && state.demo) {
                const completedDuringInterruption = message.ok && state.demo.phase === "pausing" && !!state.pendingDemoInterruption;
                const transition = completedDuringInterruption
                  ? state.demoDirector.completeModuleDuringInterruption(state.demo, message.journeyId)
                  : state.demoDirector.journeyResult(state.demo, message.ok);
                await persistDemoState(state, transition.state);
                if (completedDuringInterruption) {
                  if (state.pendingDemoInterruption?.plan) await continuePersistedDemoInterruption(state);
                  else await planPausedDemoInterruption(state);
                  return;
                }
                if (transition.instruction.kind === "run" || transition.instruction.kind === "resume") await runDemoModule(state, transition.instruction);
                else if (transition.state.phase === "closing") scheduleDemoClosing(state);
                else if (message.ok && transition.state.resumeReason === "module_complete") await inviteModuleContinuation(state, pending.request);
                return;
              }
              const queued = state.queuedTurn; state.queuedTurn = undefined;
              if (queued) {
                coordinator.recordJourneyResult(state.conversation, pending.action, { ok: message.ok, completedSteps: message.completedSteps, detail: message.detail });
                void persistContinuity(state).catch(() => undefined);
                await beginTurn(queued);
              } else if (pending.generation !== state.generation) {
                coordinator.recordJourneyResult(state.conversation, pending.action, { ok: message.ok, completedSteps: message.completedSteps, detail: message.detail });
                void persistContinuity(state).catch(() => undefined);
              } else if (message.ok && pending.plan.presentationRequested) {
                coordinator.recordJourneyResult(state.conversation, pending.action, { ok: true, completedSteps: message.completedSteps, detail: message.detail });
                void persistContinuity(state).catch(() => undefined);
                requestFreshObservation(state, pending.request, pending.plan, "presentation", pending.generation);
              } else {
                const text = coordinator.noteJourneyResult(state.conversation, pending.action, { ok: message.ok, completedSteps: message.completedSteps, detail: message.detail });
                emitFinal(state, pending.request, text);
                const lastSequence = await speakLines(state, pending.request, [text], "result");
                await inviteNextVoiceTurn(state, pending.request, lastSequence);
              }
            } else if (message.kind === "sable.sdk.client.interrupt") {
              state.busy?.abort();
              if (state.demoDirector && state.demo && !["idle", "completed", "stopped"].includes(state.demo.phase)) {
                state.demoPlanning?.abort();
                state.demoPlanningGeneration += 1;
                if (state.pendingDemoObservation) { clearTimeout(state.pendingDemoObservation.timer); state.pendingDemoObservation = undefined; }
                state.pendingDemoInterruption = undefined;
                if (state.demoClosingTimer) { clearTimeout(state.demoClosingTimer); state.demoClosingTimer = undefined; }
                const stopped = state.demoDirector.control(state.demo, "stop");
                await persistDemoState(state, stopped.state);
              }
              if (message.reason === "logout" && state.continuityId) {
                await state.continuityWrite?.catch(() => undefined);
                await stores.continuities.delete(state.continuityId);
                state.continuityId = undefined;
                state.transcript = [];
                state.conversation = { messages: [] };
              }
              const voice = voices.get(session.sessionId);
              voice?.speech.interrupt();
              const stoppedPending = await stopPendingJourney(state, `SDK interruption: ${message.reason}`);
              if (!stoppedPending) send(socket, { ...commandBase(session.sessionId), kind: "sable.sdk.server.stop_journey", reason: message.reason });
            }
            else if (message.kind === "sable.sdk.client.journey_progress" || message.kind === "sable.sdk.client.audio_playback") {
              if (message.kind === "sable.sdk.client.journey_progress" && state.pendingJourney && message.commandId === state.pendingJourney.commandId) {
                if (message.phase === "completed" && !state.pendingJourney.completedStepIds.includes(message.stepId)) state.pendingJourney.completedStepIds.push(message.stepId);
                if (message.phase === "paused") {
                  state.pendingJourney.paused = true;
                  state.pendingJourney.nextStepId = message.stepId;
                  // Local browser VAD can reach an atomic boundary before STT
                  // has finalized the user's words. Preserve that checkpoint
                  // now; semantic planning begins when the final turn arrives.
                  if (state.pendingJourney.demoModuleId && state.demoDirector && state.demo?.phase === "playing") {
                    const pausing = state.demoDirector.beginInterruption(state.demo);
                    const transition = state.demoDirector.checkpointInterruption(pausing.state, {
                      journeyId: state.pendingJourney.action.journeyId,
                      completedStepIds: state.pendingJourney.completedStepIds,
                      nextStepId: message.stepId,
                    });
                    await persistDemoState(state, transition.state);
                  }
                  if (state.pendingJourney.demoModuleId && state.demoDirector && state.demo?.phase === "pausing") {
                    const transition = state.demoDirector.checkpointInterruption(state.demo, {
                      journeyId: state.pendingJourney.action.journeyId,
                      completedStepIds: state.pendingJourney.completedStepIds,
                      nextStepId: message.stepId,
                    });
                    await persistDemoState(state, transition.state);
                    if (state.pendingDemoInterruption?.plan) await continuePersistedDemoInterruption(state);
                    else await planPausedDemoInterruption(state);
                  } else {
                    const queued = state.queuedTurn; state.queuedTurn = undefined;
                    if (queued) await beginTurn(queued);
                  }
                }
                void persistContinuity(state).catch(() => undefined);
              }
              if (message.kind === "sable.sdk.client.audio_playback") {
                const voice = voices.get(session.sessionId);
                if (message.state === "ended") {
                  voice?.sync.notePlayed(message.sequence);
                  voice?.outstandingSequences.delete(message.sequence);
                  if (voice?.outstandingSequences.size === 0) voice.turns.noteAudioDrained();
                } else if (message.state === "cancelled" || message.state === "failed") {
                  voice?.sync.noteDrained();
                  voice?.outstandingSequences.clear();
                  voice?.turns.noteAudioDrained();
                }
              }
              await stores.events.append({ id: createId("event"), tenantId: session.installation.organizationId, installationId: session.installation.installationId, sessionId: session.sessionId, type: message.kind, occurredAt: new Date().toISOString(), detail: { state: "phase" in message ? message.phase : message.state } });
            }
          } catch (error) {
            state.busy = undefined;
            const message = error instanceof Error ? error.message : "Turn failed";
            send(socket, { ...commandBase(session.sessionId), kind: "sable.sdk.server.error", code: "TURN_FAILED", message, retryable: true });
            if (voiceRequest?.modality === "voice") {
              const lastSequence = await speakLines(state, voiceRequest, [`I couldn't continue: ${message}`], "answer");
              await inviteNextVoiceTurn(state, voiceRequest, lastSequence);
            }
          }
        };
        // A session is an actor: apply one client event at a time so an awaited
        // persistence/model call cannot race a journey result or interruption.
        let controlQueue = Promise.resolve();
        handleText = (text) => {
          // Playback acknowledgements resolve waits owned by the event already
          // at the head of the queue, so they are the intentional fast lane.
          // They only update voice counters and cannot mutate journey state.
          try {
            const envelope = JSON.parse(text) as { kind?: string };
            if (envelope.kind === "sable.sdk.client.audio_playback") {
              void processText(text);
              return;
            }
          } catch { /* processText returns the protocol error in queue order. */ }
          controlQueue = controlQueue.then(() => processText(text)).catch(() => undefined);
        };
        for (const text of earlyMessages.splice(0)) handleText(text);
        socket.on("close", () => {
          state.busy?.abort();
          state.demoPlanning?.abort();
          if (state.pendingDemoObservation) clearTimeout(state.pendingDemoObservation.timer);
          if (state.pendingObservation) clearTimeout(state.pendingObservation.timer);
          if (state.demoClosingTimer) clearTimeout(state.demoClosingTimer);
          if (state.continuityId && continuityOwners.get(state.continuityId) === session.sessionId) {
            continuityOwners.delete(state.continuityId);
          }
          controls.delete(session.sessionId);
          activeConnections--;
        });
      })().catch(() => socket.close(1008, "unauthorized"));
    } catch { socket.close(1008, "unauthorized"); }
  });

  app.get("/ws/sdk/voice", { websocket: true }, (socket, request) => {
    try {
      const token = socketTicket(request as never); if (usedTickets.has(token)) throw new Error("Ticket was already used");
      const claims = signer.verify(token, "voice_ticket"); usedTickets.add(token);
      const earlyFrames: { raw: Buffer; binary: boolean }[] = [];
      let handleFrame = (raw: Buffer, binary: boolean) => { earlyFrames.push({ raw, binary }); };
      socket.on("message", (raw, binary) => handleFrame(Buffer.from(raw as Buffer), binary));
      void stores.sessions.get(claims.sub).then((session) => {
        if (!session) return socket.close(1008, "session not found");
        let state: VoiceState;
        const sync = new AudioSync(config.voice.audioWaitCapMs);
        const speech = new SpeechEngine(
          session.installation.productId,
          { language: session.installation.voice?.languageCode ?? config.voice.languageCode, speaker: session.installation.voice?.speaker ?? config.voice.speaker },
          providers.tts,
          (audio) => {
            state.turns.noteSpoken(audio.text);
            state.turns.noteAudioSent(audio.purpose === "acknowledgement");
            state.outstandingSequences.add(audio.sequence);
            send(socket, { type: "tts.chunk", generation: state.playbackGeneration, ...audio });
          },
          { betweenSentencesMs: config.voice.betweenSentencesMs, afterQuestionMs: config.voice.afterQuestionMs },
          narrationCache,
        );
        const activateInterruptionBarrier = () => {
          if (!state.interruptionActive) {
            state.interruptionActive = true;
            state.playbackGeneration += 1;
            const control = controls.get(session.sessionId);
            if (control) {
              control.playbackBarrier = { generation: state.playbackGeneration };
              control.busy?.abort();
              control.demoPlanning?.abort();
              control.demoPlanningGeneration += 1;
              if (control.pendingDemoObservation) {
                clearTimeout(control.pendingDemoObservation.timer);
                control.pendingDemoObservation = undefined;
              }
              if (control.pendingObservation) {
                clearTimeout(control.pendingObservation.timer);
                control.pendingObservation = undefined;
              }
              if (control.demoClosingTimer) {
                clearTimeout(control.demoClosingTimer);
                control.demoClosingTimer = undefined;
              }
            }
          }
          send(socket, { type: "tts.cancel", reason: "barge_in", generation: state.playbackGeneration });
          sync.reset();
          state.outstandingSequences.clear();
          speech.interrupt();
        };
        const turns = new TurnManager({
          stopAudio: activateInterruptionBarrier,
          cancelSpeech: () => speech.interrupt(),
        }, { echoWindowMs: 12_000, yieldCooldownMs: 6_000 });
        state = { socket, session, speech, sync, turns, outstandingSequences: new Set(), playbackGeneration: 0, interruptionActive: false };
        voices.set(session.sessionId, state);
        let bytes = 0;
        activeConnections++;
        const processFrame = async (raw: Buffer, binary: boolean) => {
          try {
            if (binary) { bytes += raw.length; if (bytes > config.session.maximumAudioBytes) throw new Error("Audio limit exceeded"); state.stt?.push(raw); return; }
            const message = JSON.parse(raw.toString()) as { type?: string };
            if (message.type === "voice.start") {
              bytes = 0;
              if (state.stt) return;
              state.interruptionActive = false;
              let openedSession: SpeechToTextSession | undefined;
              const releaseSession = () => {
                if (state.stt !== openedSession) return false;
                state.stt = undefined;
                openedSession?.cancel();
                return true;
              };
              openedSession = await providers.stt.open({
                languageCode: session.installation.voice?.languageCode ?? config.voice.languageCode,
                sampleRate: 16_000,
                vocabulary: session.installation.productId,
                onSpeechStart: () => {
                  // Local sidecar VAD is intentionally non-destructive. It is
                  // useful early evidence, but loudspeaker echo can trigger it.
                  // The browser may soft-pause while STT continues collecting.
                  send(socket, { type: "speech.candidate", source: "sidecar_vad" });
                },
                onPartial: (text) => send(socket, { type: "transcript.partial", text }),
                onFinal: (text, timing) => {
                  if (!releaseSession()) return;
                  const accepted = turns.acceptTranscript(text);
                  if (accepted.accept) {
                    // A completed transcript that survived echo rejection is
                    // the one authority allowed to destroy old playback and
                    // pause the journey. Confirm first so the SDK can commit
                    // its reversible local pause before cancellation arrives.
                    const wasSpeaking = turns.isSpeaking;
                    send(socket, { type: "speech.confirmed", interrupted: wasSpeaking });
                    const interruption = turns.onUserVoice();
                    if (!interruption.interrupted) activateInterruptionBarrier();
                    send(socket, { type: "transcript.final", text, timing });
                  } else send(socket, { type: "voice.no_speech", reason: accepted.reason });
                },
                onNoSpeech: (reason) => {
                  if (!releaseSession()) return;
                  // A no-speech result rejects only the current reversible VAD
                  // candidate. It must not release a barrier owned by an
                  // earlier accepted turn on the separate control socket.
                  send(socket, { type: "voice.no_speech", reason });
                },
                onError: (error) => { if (releaseSession()) send(socket, { type: "voice.error", message: error.message }); },
              });
              state.stt = openedSession;
              send(socket, { type: "voice.ready" });
            } else if (message.type === "voice.barge_in") {
              // Browser VAD has survived the short post-pause echo probe, but
              // remains acoustic evidence. Keep the player resumable until the
              // final transcript is accepted above.
              send(socket, { type: "speech.pending", source: "browser_vad" });
            } else if (message.type === "voice.flush") state.stt?.finish();
            else if (message.type === "voice.cancel") { state.stt?.cancel(); state.stt = undefined; }
          } catch (error) { state.stt?.cancel(); state.stt = undefined; send(socket, { type: "voice.error", message: error instanceof Error ? error.message : "Voice failed" }); }
        };
        // Keep voice.start ahead of the binary frames that follow it. Without
        // this queue, opening the sidecar yields and the first spoken audio is
        // silently discarded while state.stt is still undefined.
        let voiceQueue = Promise.resolve();
        handleFrame = (raw, binary) => {
          voiceQueue = voiceQueue.then(() => processFrame(raw, binary)).catch(() => undefined);
        };
        for (const frame of earlyFrames.splice(0)) handleFrame(frame.raw, frame.binary);
        socket.on("close", () => { state.stt?.cancel(); state.speech.interrupt(); state.sync.reset(); voices.delete(session.sessionId); activeConnections--; });
      }).catch(() => socket.close(1011, "store unavailable"));
    } catch { socket.close(1008, "unauthorized"); }
  });

  app.addHook("onClose", async () => {
    for (const state of controls.values()) state.socket.close(1001);
    for (const state of voices.values()) state.socket.close(1001);
    await stores.close();
  });
  return app;
}
