import assert from "node:assert/strict";
import test from "node:test";
import { SDK_PROTOCOL_VERSION, type SignedCatalogEnvelope } from "@sable/sdk-contracts";
import type { RuntimeBundle } from "@sable/runtime-core";
import WebSocket from "ws";
import { loadConfig } from "../src/config.js";
import type { Providers } from "../src/providers/index.js";
import { buildServer } from "../src/server.js";
import { hashCredential } from "../src/security.js";
import { MemoryStores } from "../src/stores/memory.js";

const ticketProtocol = (ticket: string) => `sable.ticket.${Buffer.from(ticket).toString("base64url")}`;

function nextMessage(socket: WebSocket, kind: string, timeoutMs = 3_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${kind}`)), timeoutMs);
    socket.on("message", function listener(raw) {
      const value = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (value.kind !== kind && value.type !== kind) return;
      clearTimeout(timer);
      socket.off("message", listener);
      resolve(value);
    });
  });
}

function demoPhaseSequence(socket: WebSocket, expected: string[], timeoutMs = 3_000): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const values: Record<string, unknown>[] = [];
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for demo phases ${expected.join(" -> ")}`)), timeoutMs);
    socket.on("message", function listener(raw) {
      const value = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (value.kind !== "sable.sdk.server.demo_state" || value.phase !== expected[values.length]) return;
      values.push(value);
      if (values.length !== expected.length) return;
      clearTimeout(timer);
      socket.off("message", listener);
      resolve(values);
    });
  });
}

function message(sessionId: string, kind: string, values: Record<string, unknown> = {}) {
  return {
    kind,
    schemaVersion: SDK_PROTOCOL_VERSION,
    messageId: `${kind}-${Math.random().toString(36).slice(2)}`,
    sessionId,
    sentAt: new Date().toISOString(),
    ...values,
  };
}

async function labeled<T>(promise: Promise<T>, label: string): Promise<T> {
  try { return await promise; }
  catch (error) { throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
}

function demoCatalog(includeFollowupModule = false): SignedCatalogEnvelope {
  const followupJourney = {
    kind: "sable.catalog.journey",
    id: "show-followup",
    version: 1,
    name: "Follow-up walkthrough",
    intents: [],
    roles: ["member"],
    risk: "read",
    inputSchema: { kind: "sable.journey_input_schema", properties: {}, required: [], additionalProperties: false },
    workflow: { kind: "sable.workflow", version: 1, risk: "read", preconditions: [], steps: [], postconditions: [] },
    compatibility: [],
    state: "approved",
    demoSafe: true,
  };
  return {
    payload: {
      manifest: { catalogVersionId: "v1" },
      journeys: [{
        kind: "sable.catalog.journey",
        id: "show-reports",
        version: 1,
        name: "Reports walkthrough",
        intents: [],
        roles: ["member"],
        risk: "read",
        inputSchema: { kind: "sable.journey_input_schema", properties: {}, required: [], additionalProperties: false },
        workflow: { kind: "sable.workflow", version: 1, risk: "read", preconditions: [], steps: [], postconditions: [] },
        compatibility: [],
        state: "approved",
        demoSafe: true,
      }, ...(includeFollowupModule ? [followupJourney] : [])],
      demoProfile: {
        id: "niroggyan-demo",
        version: 1,
        greeting: { text: "Welcome to Niroggyan." },
        questions: [
          { id: "role", captureKey: "lead.role", prompt: { text: "What kind of organisation are you from?" } },
          { id: "goal", captureKey: "lead.goal", prompt: { text: "What would you like to see?" } },
          { id: "volume", captureKey: "lead.volume", prompt: { text: "How many reports do you handle?" } },
        ],
        intake: { genericQuestionIds: ["role", "goal"], personaQuestionByPersonaId: { lab: "volume" } },
        personas: [{ id: "lab", name: "Lab", description: "Diagnostic laboratory", classifierSignals: ["laboratory"] }],
        modules: [{
          id: "reports",
          name: "Reports",
          journeyId: "show-reports",
          introduction: { text: "Let me show reports." },
          completion: { text: "Reports are complete." },
          failureMessage: { text: "Reports could not be shown safely." },
        }, ...(includeFollowupModule ? [{
          id: "followup",
          name: "Follow-up",
          journeyId: "show-followup",
          introduction: { text: "Let me show the next relevant part." },
          completion: { text: "The follow-up is complete." },
          failureMessage: { text: "The follow-up could not be shown safely." },
        }] : [])],
        defaultPlaylistModuleIds: includeFollowupModule ? ["reports", "followup"] : ["reports"],
        playlistModuleIdsByPersonaId: { lab: includeFollowupModule ? ["reports", "followup"] : ["reports"] },
        closing: { text: "Thank you." },
      },
      salesPlays: [{
        id: "reports-included",
        kind: "product_answer",
        title: "Reports package inclusion",
        content: "The approved package includes patient-friendly smart reports.",
        personaIds: ["lab"],
        capabilityIds: [],
        journeyIds: ["show-reports"],
        signalPhrases: ["included in the product"],
      }],
    },
  } as unknown as SignedCatalogEnvelope;
}

function demoBundle(includeFollowupModule = false): RuntimeBundle {
  const journey = (key: string, name: string) => ({
    key,
    name,
    roleProfileIds: ["member"],
    intentPhrases: [name.toLowerCase()],
    reliability: 1,
    workflow: { schemaVersion: 1 as const, id: key, version: 1, name, risk: "read" as const, preconditions: [], steps: [], postconditions: [] },
  });
  return {
    schemaVersion: 1,
    organizationId: "tenant",
    productId: "niroggyan",
    environmentId: "test",
    catalogVersionId: "v1",
    catalogVersion: 1,
    generatedAt: new Date().toISOString(),
    journeys: [journey("show-reports", "Reports walkthrough"), ...(includeFollowupModule ? [journey("show-followup", "Follow-up walkthrough")] : [])],
    salesPlays: [],
    screens: [],
    transitions: [],
    coverage: { weighted: 1, verified: 1, total: 1, unknown: 0 },
  };
}

test("signed demo cues use cloud TTS and an intake question is answered without corrupting lead data", async () => {
  const credential = "server-only-installation-secret";
  const installation = {
    installationId: "spoken-demo-installation",
    organizationId: "tenant",
    productId: "niroggyan",
    environmentId: "test",
    credentialHash: hashCredential(credential),
    allowedOrigins: ["https://client.test"],
    allowedRoles: ["member"],
    activeCatalogVersionId: "v1",
    guidedDemo: { enabled: true },
    voice: { languageCode: "en-IN", speaker: "test", speakMode: "voice_turns" as const, stepNarration: true },
  };
  let plannerCalls = 0;
  let responderCalls = 0;
  const providers: Providers = {
    model: {
      label: "intake-answer-test",
      step: async (_system, _messages, tools) => {
        if (tools.some((tool) => tool.name === "submit_demo_interruption_plan")) plannerCalls += 1;
        responderCalls += 1;
        return { texts: ["The overview explains NirogGyan and its main brochure value."], toolCalls: [], done: true };
      },
    },
    stt: { open: async () => ({ push() {}, finish() {}, cancel() {} }) },
    tts: { id: "sarvam", defaultSpeaker: "test", maxChars: 450, synthesize: async () => ({ bytes: Buffer.alloc(64), mime: "audio/wav" }) },
  };
  const app = await buildServer(loadConfig({
    TOKEN_SIGNING_SECRET: "12345678901234567890123456789012",
    PUBLIC_API_URL: "http://127.0.0.1",
  }), new MemoryStores([installation], [demoCatalog()], [], []).asRuntimeStores(), providers);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const identity = await app.inject({
    method: "POST",
    url: "/api/v3/sdk/identity-tokens",
    headers: { authorization: `SableInstallation ${credential}` },
    payload: { installationId: installation.installationId, userId: "lead-spoken", roleProfileId: "member", origin: "https://client.test" },
  });
  const bootstrap = await app.inject({
    method: "POST",
    url: "/api/v3/sdk/sessions",
    headers: { origin: "https://client.test" },
    payload: {
      kind: "sable.sdk.bootstrap.request",
      schemaVersion: SDK_PROTOCOL_VERSION,
      requestId: "spoken-demo-bootstrap",
      installationId: installation.installationId,
      identityToken: identity.json().identityToken,
      sdk: { version: "0.1.0", protocolVersion: SDK_PROTOCOL_VERSION, distribution: "script" },
      page: { origin: "https://client.test", url: "https://client.test/app", locale: "en-IN" },
      capabilities: { domObservation: true, shadowDom: true, sameOriginFrames: true, frameBridge: false, registeredTools: [], voice: true, screenshots: false },
    },
  });
  assert.equal(bootstrap.statusCode, 200, bootstrap.body);
  const bootstrapValue = bootstrap.json();
  const sessionId = bootstrapValue.session.sessionId as string;
  const socketBase = address.replace("http:", "ws:");
  const voice = new WebSocket(new URL("/ws/sdk/voice", socketBase).toString(), [ticketProtocol(bootstrapValue.voiceTransport.oneTimeTicket)]);
  const control = new WebSocket(new URL("/ws/sdk", socketBase).toString(), [ticketProtocol(bootstrapValue.transport.oneTimeTicket)]);
  await Promise.all([
    new Promise<void>((resolve, reject) => { voice.once("open", resolve); voice.once("error", reject); }),
    new Promise<void>((resolve, reject) => { control.once("open", resolve); control.once("error", reject); }),
  ]);

  let statePromise = nextMessage(control, "sable.sdk.server.demo_state");
  control.send(JSON.stringify(message(sessionId, "sable.sdk.client.ready", { catalogVersionId: "v1", currentUrl: "https://client.test/app" })));
  assert.equal((await statePromise).phase, "idle");
  statePromise = nextMessage(control, "sable.sdk.server.demo_state");
  control.send(JSON.stringify(message(sessionId, "sable.sdk.client.demo_control", { action: "start" })));
  assert.equal((await statePromise).activeQuestionId, "role");

  const listenDuringGreeting = nextMessage(voice, "voice.listen");
  let audioPromise = nextMessage(voice, "tts.chunk");
  let endPromise = nextMessage(voice, "tts.end");
  control.send(JSON.stringify(message(sessionId, "sable.sdk.client.demo_narration", {
    cueKind: "greeting", turnId: "demo:greeting", utteranceId: "utterance-greeting",
  })));
  const greetingAudio = await audioPromise;
  const greetingEnd = await endPromise;
  assert.equal((await listenDuringGreeting).turnId, "demo:greeting");
  assert.equal(greetingAudio.text, "Welcome to Niroggyan.");
  assert.equal(greetingEnd.purpose, "demo");
  const listenAfterGreeting = nextMessage(voice, "voice.listen");
  control.send(JSON.stringify(message(sessionId, "sable.sdk.client.audio_playback", {
    utteranceId: "utterance-greeting", turnId: "demo:greeting", sequence: greetingEnd.lastSequence, state: "ended",
  })));
  assert.equal((await listenAfterGreeting).turnId, "demo:greeting");

  const finalPromise = nextMessage(control, "sable.sdk.server.assistant_final");
  audioPromise = nextMessage(voice, "tts.chunk");
  endPromise = nextMessage(voice, "tts.end");
  control.send(JSON.stringify(message(sessionId, "sable.sdk.client.user_turn", {
    turnId: "intake-question", text: "what is overview", modality: "text",
  })));
  const answer = await finalPromise;
  assert.match(String(answer.text), /overview explains NirogGyan/i);
  assert.match(String(answer.text), /what kind of organisation/i);
  assert.match(String((await audioPromise).text), /overview explains NirogGyan/i);
  await endPromise;
  assert.equal(plannerCalls, 0);
  assert.equal(responderCalls, 1);

  statePromise = nextMessage(control, "sable.sdk.server.demo_state");
  control.send(JSON.stringify(message(sessionId, "sable.sdk.client.user_turn", {
    turnId: "real-role-answer", text: "I operate a laboratory", modality: "text",
  })));
  const nextState = await statePromise;
  assert.equal(nextState.activeQuestionId, "goal");

  voice.close();
  control.close();
  await Promise.all([
    new Promise<void>((resolve) => voice.once("close", () => resolve())),
    new Promise<void>((resolve) => control.once("close", () => resolve())),
  ]);
  await app.close();
});

test("guided demo plans interruptions immediately but answers only after a verified browser position", async () => {
  const credential = "server-only-installation-secret";
  const installation = {
    installationId: "demo-installation",
    organizationId: "tenant",
    productId: "niroggyan",
    environmentId: "test",
    credentialHash: hashCredential(credential),
    allowedOrigins: ["https://client.test"],
    allowedRoles: ["member"],
    activeCatalogVersionId: "v1",
    guidedDemo: { enabled: true },
  };
  const memory = new MemoryStores([installation], [demoCatalog(true)], [demoBundle(true)], []);
  const stores = memory.asRuntimeStores();
  let demoPlannerCalls = 0;
  let demoResponderCalls = 0;
  const responderSystems: string[] = [];
  const providers: Providers = {
    model: {
      label: "bounded-demo-planner",
      step: async (system, _messages, tools) => {
        if (tools.some((tool) => tool.name === "submit_turn_plan")) {
          demoPlannerCalls += 1;
          return { texts: [], toolCalls: [{ id: `demo-plan-${demoPlannerCalls}`, name: "submit_turn_plan", args: {
            intent: demoPlannerCalls === 1 ? "screen_question" : demoPlannerCalls === 3 ? "action" : "product_question",
            responseStrategy: demoPlannerCalls === 1 ? "respond_observe_then_answer" : "respond_answer",
            journeyDisposition: "journey_side_question",
            target: { kind: "journey", id: "show-reports" },
            journeyInputsJson: "{}",
            clarification: "",
          } }], done: true };
        }
        demoResponderCalls += 1;
        responderSystems.push(system);
        return { texts: [demoResponderCalls === 1
          ? "This view shows the patient-friendly report explanation."
          : demoResponderCalls === 2
            ? "Yes. Patient-friendly smart reports are included in the approved package."
            : "NirogGyan makes technical reports easier for patients to understand."], toolCalls: [], done: true };
      },
    },
    stt: { open: async () => ({ push() {}, finish() {}, cancel() {} }) },
    tts: { id: "sarvam", defaultSpeaker: "test", maxChars: 450, synthesize: async () => ({ bytes: Buffer.alloc(64), mime: "audio/wav" }) },
  };
  const app = await buildServer(loadConfig({
    TOKEN_SIGNING_SECRET: "12345678901234567890123456789012",
    PUBLIC_API_URL: "http://127.0.0.1",
  }), stores, providers);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const identity = await app.inject({
    method: "POST",
    url: "/api/v3/sdk/identity-tokens",
    headers: { authorization: `SableInstallation ${credential}` },
    payload: { installationId: installation.installationId, userId: "lead-1", roleProfileId: "member", origin: "https://client.test" },
  });
  const bootstrap = await app.inject({
    method: "POST",
    url: "/api/v3/sdk/sessions",
    headers: { origin: "https://client.test" },
    payload: {
      kind: "sable.sdk.bootstrap.request",
      schemaVersion: SDK_PROTOCOL_VERSION,
      requestId: "demo-bootstrap",
      installationId: installation.installationId,
      identityToken: identity.json().identityToken,
      sdk: { version: "0.1.0", protocolVersion: SDK_PROTOCOL_VERSION, distribution: "script" },
      page: { origin: "https://client.test", url: "https://client.test/app", locale: "en-IN" },
      capabilities: { domObservation: true, shadowDom: true, sameOriginFrames: true, frameBridge: false, registeredTools: [], voice: false, screenshots: false },
    },
  });
  assert.equal(bootstrap.statusCode, 200, bootstrap.body);
  const bootstrapValue = bootstrap.json();
  const sessionId = bootstrapValue.session.sessionId as string;
  const socket = new WebSocket(new URL("/ws/sdk", address.replace("http:", "ws:")).toString(), [ticketProtocol(bootstrapValue.transport.oneTimeTicket)]);
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });

  let statePromise = nextMessage(socket, "sable.sdk.server.demo_state");
  socket.send(JSON.stringify(message(sessionId, "sable.sdk.client.ready", { catalogVersionId: "v1", currentUrl: "https://client.test/app" })));
  let demoState = await statePromise;
  assert.equal(demoState.phase, "idle");
  assert.equal(demoState.canStart, true);

  const restorePromise = nextMessage(socket, "sable.sdk.server.restore_state");
  statePromise = nextMessage(socket, "sable.sdk.server.demo_state");
  socket.send(JSON.stringify(message(sessionId, "sable.sdk.client.restore_context", {
    continuityId: bootstrapValue.session.continuityId,
    transcript: [],
  })));
  await restorePromise;
  assert.equal((await statePromise).phase, "idle");

  statePromise = nextMessage(socket, "sable.sdk.server.demo_state");
  socket.send(JSON.stringify(message(sessionId, "sable.sdk.client.demo_control", { action: "start" })));
  demoState = await statePromise;
  assert.equal(demoState.phase, "intake");
  assert.equal(demoState.activeQuestionId, "role");

  statePromise = nextMessage(socket, "sable.sdk.server.demo_state");
  socket.send(JSON.stringify(message(sessionId, "sable.sdk.client.user_turn", { turnId: "answer-role", text: "I operate a laboratory", modality: "text" })));
  demoState = await statePromise;
  assert.equal(demoState.activeQuestionId, "goal");

  statePromise = nextMessage(socket, "sable.sdk.server.demo_state");
  socket.send(JSON.stringify(message(sessionId, "sable.sdk.client.user_turn", { turnId: "answer-goal", text: "Show me reports", modality: "text" })));
  demoState = await statePromise;
  assert.equal(demoState.activeQuestionId, "volume");

  statePromise = nextMessage(socket, "sable.sdk.server.demo_state");
  let runPromise = nextMessage(socket, "sable.sdk.server.run_journey");
  socket.send(JSON.stringify(message(sessionId, "sable.sdk.client.user_turn", { turnId: "answer-volume", text: "500 per day", modality: "text" })));
  demoState = await statePromise;
  const firstRun = await labeled(runPromise, "initial reports run");
  assert.equal(demoState.phase, "playing");
  assert.equal(demoState.activeModuleId, "reports");
  assert.equal(firstRun.journeyId, "show-reports");
  assert.equal(demoPlannerCalls, 0);
  assert.equal(demoResponderCalls, 0);

  statePromise = nextMessage(socket, "sable.sdk.server.demo_state");
  const pausePromise = nextMessage(socket, "sable.sdk.server.pause_journey");
  socket.send(JSON.stringify(message(sessionId, "sable.sdk.client.user_turn", { turnId: "interrupt", text: "What does this mean?", modality: "text" })));
  demoState = await statePromise;
  await pausePromise;
  assert.equal(demoState.phase, "pausing");
  assert.equal(demoPlannerCalls, 1);
  assert.equal(demoResponderCalls, 0);

  const firstPlanningPhases = demoPhaseSequence(socket, ["awaiting_resume", "answering"]);
  const observationRequest = nextMessage(socket, "sable.sdk.server.request_observation");
  socket.send(JSON.stringify(message(sessionId, "sable.sdk.client.journey_progress", {
    commandId: firstRun.commandId,
    journeyId: "show-reports",
    stepId: "next-safe-step",
    phase: "paused",
  })));
  const firstPhases = await firstPlanningPhases;
  demoState = firstPhases.at(-1)!;
  assert.equal(demoState.phase, "answering");
  const requestedObservation = await observationRequest;
  assert.equal(demoPlannerCalls, 1);
  assert.equal(demoResponderCalls, 0);
  const plannedContinuity = await stores.continuities.get(bootstrapValue.session.continuityId);
  assert.equal(plannedContinuity?.pendingDemoInterruption?.plan?.intent, "screen_question");
  assert.equal(plannedContinuity?.pendingDemoInterruption?.plan?.needsFreshObservation, true);
  assert.equal(plannedContinuity?.pendingDemoInterruption?.grounding?.playMode, "none");
  assert.deepEqual(plannedContinuity?.pendingDemoInterruption?.grounding?.selectedPlayIds, []);

  const screenAnswer = nextMessage(socket, "sable.sdk.server.assistant_final");
  const screenResumeState = nextMessage(socket, "sable.sdk.server.demo_state");
  socket.send(JSON.stringify(message(sessionId, "sable.sdk.client.observation", {
    reason: "requested",
    replyToCommandId: requestedObservation.commandId,
    turnId: "interrupt",
    observation: {
      kind: "sable.screen_observation", schemaVersion: 1, observationId: "reports-observation", version: 1,
      capturedAt: new Date().toISOString(), url: "https://client.test/app", origin: "https://client.test",
      title: "Smart Reports", fingerprint: "reports", visibleText: "Patient-friendly report explanation and highlighted health result.", elements: [], matchedScreenId: "reports-screen",
    },
  })));
  assert.match(String((await screenAnswer).text), /patient-friendly report explanation/i);
  assert.match(String((await screenAnswer).text), /would you like me to continue Reports/i);
  assert.equal((await screenResumeState).phase, "awaiting_resume");
  statePromise = nextMessage(socket, "sable.sdk.server.demo_state");
  runPromise = nextMessage(socket, "sable.sdk.server.run_journey");
  socket.send(JSON.stringify(message(sessionId, "sable.sdk.client.demo_control", { action: "continue" })));
  assert.equal((await statePromise).phase, "playing");
  const resumedAfterScreenAnswer = await labeled(runPromise, "resume after screen answer");
  assert.deepEqual(resumedAfterScreenAnswer.resume, { completedStepIds: [], nextStepId: "next-safe-step" });
  assert.equal(demoResponderCalls, 1);
  assert.match(responderSystems[0] ?? "", /Patient-friendly report explanation/);

  // Browser VAD can pause at an atomic boundary before STT finalizes the turn.
  // The checkpoint is retained without planning until the words arrive.
  statePromise = nextMessage(socket, "sable.sdk.server.demo_state");
  socket.send(JSON.stringify(message(sessionId, "sable.sdk.client.journey_progress", {
    commandId: resumedAfterScreenAnswer.commandId,
    journeyId: "show-reports",
    stepId: "next-product-step",
    phase: "paused",
  })));
  assert.equal((await statePromise).phase, "awaiting_resume");
  assert.equal(demoPlannerCalls, 1);

  // The finalized product question now retrieves the approved signed play,
  // answers, and waits for confirmation before resuming.
  const productPhases = demoPhaseSequence(socket, ["answering", "awaiting_resume"]);
  const productAnswer = nextMessage(socket, "sable.sdk.server.assistant_final");
  socket.send(JSON.stringify(message(sessionId, "sable.sdk.client.user_turn", { turnId: "product-interrupt", text: "Is this included in the product?", modality: "text" })));
  assert.equal((await productPhases).at(-1)?.phase, "awaiting_resume");
  assert.match(String((await productAnswer).text), /included in the approved package/i);
  statePromise = nextMessage(socket, "sable.sdk.server.demo_state");
  runPromise = nextMessage(socket, "sable.sdk.server.run_journey");
  socket.send(JSON.stringify(message(sessionId, "sable.sdk.client.demo_control", { action: "continue" })));
  assert.equal((await statePromise).phase, "playing");
  const resumedAfterProductAnswer = await labeled(runPromise, "resume after product answer");
  assert.deepEqual(resumedAfterProductAnswer.resume, { completedStepIds: [], nextStepId: "next-product-step" });
  assert.equal(demoPlannerCalls, 2);
  assert.equal(demoResponderCalls, 2);
  assert.match(responderSystems[1] ?? "", /reports-included/);

  // A direct pause request is handled without another response-model call and
  // remains paused until an explicit Continue control arrives.
  statePromise = nextMessage(socket, "sable.sdk.server.demo_state");
  const thirdPausePromise = nextMessage(socket, "sable.sdk.server.pause_journey");
  socket.send(JSON.stringify(message(sessionId, "sable.sdk.client.user_turn", { turnId: "pause-interrupt", text: "Pause once more", modality: "text" })));
  assert.equal((await statePromise).phase, "pausing");
  await thirdPausePromise;
  const pausedAnswerPhases = demoPhaseSequence(socket, ["awaiting_resume", "answering", "awaiting_resume"]);
  const pausedAnswer = nextMessage(socket, "sable.sdk.server.assistant_final");
  socket.send(JSON.stringify(message(sessionId, "sable.sdk.client.journey_progress", {
    commandId: resumedAfterProductAnswer.commandId,
    journeyId: "show-reports",
    stepId: "next-pause-step",
    phase: "paused",
  })));
  assert.equal((await pausedAnswerPhases).at(-1)?.phase, "awaiting_resume");
  assert.match(String((await pausedAnswer).text), /keep the demo paused/i);
  assert.equal(demoPlannerCalls, 3);
  assert.equal(demoResponderCalls, 2);

  statePromise = nextMessage(socket, "sable.sdk.server.demo_state");
  runPromise = nextMessage(socket, "sable.sdk.server.run_journey");
  socket.send(JSON.stringify(message(sessionId, "sable.sdk.client.demo_control", { action: "continue" })));
  demoState = await statePromise;
  const resumed = await labeled(runPromise, "resume after explicit continue");
  assert.equal(demoState.phase, "playing");
  assert.deepEqual(resumed.resume, { completedStepIds: [], nextStepId: "next-pause-step" });
  assert.equal(demoPlannerCalls, 3);
  assert.equal(demoResponderCalls, 2);

  // If the final step wins the race against the pause request, the prospect's
  // question is still planned and answered before the next module begins.
  statePromise = nextMessage(socket, "sable.sdk.server.demo_state");
  const terminalPausePromise = nextMessage(socket, "sable.sdk.server.pause_journey");
  socket.send(JSON.stringify(message(sessionId, "sable.sdk.client.user_turn", {
    turnId: "terminal-interrupt",
    text: "What exactly does NirogGyan do?",
    modality: "text",
  })));
  assert.equal((await statePromise).phase, "pausing");
  await terminalPausePromise;

  const terminalAnswerPhases = demoPhaseSequence(socket, ["awaiting_resume", "answering", "awaiting_resume"]);
  const terminalAnswer = nextMessage(socket, "sable.sdk.server.assistant_final");
  socket.send(JSON.stringify(message(sessionId, "sable.sdk.client.journey_result", {
    commandId: resumed.commandId,
    journeyId: "show-reports",
    ok: true,
    completedSteps: 1,
  })));
  assert.equal((await terminalAnswerPhases).at(-1)?.phase, "awaiting_resume");
  assert.match(String((await terminalAnswer).text), /easier for patients to understand/i);
  assert.match(String((await terminalAnswer).text), /continue to Follow-up/i);
  statePromise = nextMessage(socket, "sable.sdk.server.demo_state");
  runPromise = nextMessage(socket, "sable.sdk.server.run_journey");
  socket.send(JSON.stringify(message(sessionId, "sable.sdk.client.demo_control", { action: "continue" })));
  assert.equal((await statePromise).phase, "playing");
  const followupRun = await labeled(runPromise, "advance after terminal interruption answer");
  assert.equal(followupRun.journeyId, "show-followup");
  assert.equal(followupRun.resume, undefined);
  assert.equal(demoPlannerCalls, 4);
  assert.equal(demoResponderCalls, 3);

  statePromise = nextMessage(socket, "sable.sdk.server.demo_state");
  socket.send(JSON.stringify(message(sessionId, "sable.sdk.client.journey_result", {
    commandId: followupRun.commandId,
    journeyId: "show-followup",
    ok: true,
    completedSteps: 1,
  })));
  demoState = await statePromise;
  assert.equal(demoState.phase, "closing");

  demoState = await nextMessage(socket, "sable.sdk.server.demo_state", 4_000);
  assert.equal(demoState.phase, "completed");
  assert.equal(demoPlannerCalls, 4);
  assert.equal(demoResponderCalls, 3);
  const storedSession = await stores.sessions.get(sessionId);
  assert.equal(storedSession?.guidedDemo?.answers["lead.role"], "I operate a laboratory");
  assert.equal(storedSession?.guidedDemo?.phase, "completed");
  const storedContinuity = await stores.continuities.get(bootstrapValue.session.continuityId);
  assert.equal(storedContinuity?.guidedDemo?.answers["lead.volume"], "500 per day");
  assert.equal(storedContinuity?.guidedDemo?.phase, "completed");

  socket.close();
  await new Promise<void>((resolve) => socket.once("close", () => resolve()));

  // A signed profile is capability only. Turning off installation entitlement
  // must prevent a later session from starting the demo.
  await stores.installations.put({ ...installation, guidedDemo: { enabled: false } });
  const disabledIdentity = await app.inject({
    method: "POST",
    url: "/api/v3/sdk/identity-tokens",
    headers: { authorization: `SableInstallation ${credential}` },
    payload: { installationId: installation.installationId, userId: "lead-2", roleProfileId: "member", origin: "https://client.test" },
  });
  const disabledBootstrap = await app.inject({
    method: "POST",
    url: "/api/v3/sdk/sessions",
    headers: { origin: "https://client.test" },
    payload: {
      kind: "sable.sdk.bootstrap.request",
      schemaVersion: SDK_PROTOCOL_VERSION,
      requestId: "disabled-demo-bootstrap",
      installationId: installation.installationId,
      identityToken: disabledIdentity.json().identityToken,
      sdk: { version: "0.1.0", protocolVersion: SDK_PROTOCOL_VERSION, distribution: "script" },
      page: { origin: "https://client.test", url: "https://client.test/app", locale: "en-IN" },
      capabilities: { domObservation: true, shadowDom: true, sameOriginFrames: true, frameBridge: false, registeredTools: [], voice: false, screenshots: false },
    },
  });
  const disabledValue = disabledBootstrap.json();
  const disabledSocket = new WebSocket(new URL("/ws/sdk", address.replace("http:", "ws:")).toString(), [ticketProtocol(disabledValue.transport.oneTimeTicket)]);
  await new Promise<void>((resolve, reject) => { disabledSocket.once("open", resolve); disabledSocket.once("error", reject); });
  disabledSocket.send(JSON.stringify(message(disabledValue.session.sessionId, "sable.sdk.client.ready", { catalogVersionId: "v1", currentUrl: "https://client.test/app" })));
  const disabledError = nextMessage(disabledSocket, "sable.sdk.server.error");
  disabledSocket.send(JSON.stringify(message(disabledValue.session.sessionId, "sable.sdk.client.demo_control", { action: "start" })));
  assert.match(String((await disabledError).message), /not enabled/);
  assert.equal(demoPlannerCalls, 4);
  assert.equal(demoResponderCalls, 3);
  disabledSocket.close();
  await new Promise<void>((resolve) => disabledSocket.once("close", () => resolve()));
  await app.close();
});
