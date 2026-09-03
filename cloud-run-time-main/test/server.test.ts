import assert from "node:assert/strict";
import test from "node:test";
import { SDK_PROTOCOL_VERSION, type SignedCatalogEnvelope } from "@sable/sdk-contracts";
import WebSocket from "ws";
import type { RuntimeBundle } from "@sable/runtime-core";
import { loadConfig } from "../src/config.js";
import type { SpeechToTextProvider } from "../src/contracts.js";
import type { Providers } from "../src/providers/index.js";
import { buildServer } from "../src/server.js";
import { hashCredential } from "../src/security.js";
import { MemoryStores } from "../src/stores/memory.js";

const ticketProtocol = (ticket: string) => `sable.ticket.${Buffer.from(ticket).toString("base64url")}`;
const nextSocketMessage = (socket: WebSocket, expectedType: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${expectedType}`)), 2_000);
  socket.on("message", function listener(raw) {
    const value = JSON.parse(raw.toString()) as Record<string, unknown>;
    if (value.type !== expectedType && value.kind !== expectedType) return;
    clearTimeout(timer);
    socket.off("message", listener);
    resolve(value);
  });
});

test("installation creation stores guided demo as an opt-in flag", async () => {
  const stores = new MemoryStores([], [], [], []).asRuntimeStores();
  const providers: Providers = {
    model: { label: "test", step: async () => ({ texts: [], toolCalls: [], done: true }) },
    stt: { open: async () => ({ push() {}, finish() {}, cancel() {} }) },
    tts: { id: "sarvam", defaultSpeaker: "test", maxChars: 450, synthesize: async () => ({ bytes: Buffer.alloc(64), mime: "audio/wav" }) },
  };
  const app = await buildServer(loadConfig({
    TOKEN_SIGNING_SECRET: "12345678901234567890123456789012",
    PUBLIC_API_URL: "https://runtime.test",
    ADMIN_API_KEY: "admin-secret",
  }), stores, providers);
  const payload = {
    organizationId: "tenant",
    productId: "product",
    environmentId: "test",
    allowedOrigins: ["https://client.test/path"],
    allowedRoles: ["member"],
    activeCatalogVersionId: "v1",
    guidedDemo: { enabled: true },
  };
  const created = await app.inject({ method: "POST", url: "/api/v3/sdk/installations", headers: { authorization: "Bearer admin-secret" }, payload });
  assert.equal(created.statusCode, 201, created.body);
  assert.deepEqual(created.json().installation.guidedDemo, { enabled: true });
  assert.deepEqual(created.json().installation.allowedOrigins, ["https://client.test"]);
  const stored = await stores.installations.get(created.json().installation.installationId);
  assert.deepEqual(stored?.guidedDemo, { enabled: true });

  const toggled = await app.inject({ method: "POST", url: `/api/v3/sdk/installations/${created.json().installation.installationId}/guided-demo`, headers: { authorization: "Bearer admin-secret" }, payload: { enabled: false } });
  assert.equal(toggled.statusCode, 200, toggled.body);
  assert.deepEqual(toggled.json().installation.guidedDemo, { enabled: false });
  assert.deepEqual((await stores.installations.get(created.json().installation.installationId))?.guidedDemo, { enabled: false });

  const invalid = await app.inject({ method: "POST", url: "/api/v3/sdk/installations", headers: { authorization: "Bearer admin-secret" }, payload: { ...payload, guidedDemo: { enabled: "yes" } } });
  assert.equal(invalid.statusCode, 400);
  await app.close();
});

test("identity exchange and SDK bootstrap keep credentials out of the browser response", async () => {
  const credential = "server-only-installation-secret";
  const installation = { installationId: "sample", organizationId: "tenant", productId: "product", environmentId: "test", credentialHash: hashCredential(credential), allowedOrigins: ["https://client.test"], allowedRoles: ["member"], activeCatalogVersionId: "v1" };
  const envelope = { payload: { manifest: { catalogVersionId: "v1" } } } as unknown as SignedCatalogEnvelope;
  const stores = new MemoryStores([installation], [envelope], [], []).asRuntimeStores();
  const providers: Providers = {
    model: { label: "test", step: async () => ({ texts: ["hello"], toolCalls: [], done: true }) },
    stt: { open: async () => ({ push() {}, finish() {}, cancel() {} }) },
    tts: { id: "sarvam", defaultSpeaker: "test", maxChars: 450, synthesize: async () => ({ bytes: Buffer.alloc(64), mime: "audio/wav" }) },
  };
  const app = await buildServer(loadConfig({ TOKEN_SIGNING_SECRET: "12345678901234567890123456789012", PUBLIC_API_URL: "https://runtime.test" }), stores, providers);
  const identity = await app.inject({ method: "POST", url: "/api/v3/sdk/identity-tokens", headers: { authorization: `SableInstallation ${credential}` }, payload: { installationId: "sample", userId: "u1", roleProfileId: "member", origin: "https://client.test" } });
  assert.equal(identity.statusCode, 200);
  const identityToken = identity.json().identityToken as string;
  assert.ok(identityToken);
  assert.equal(identity.body.includes(credential), false);
  const bootstrap = await app.inject({ method: "POST", url: "/api/v3/sdk/sessions", headers: { origin: "https://client.test" }, payload: { kind: "sable.sdk.bootstrap.request", schemaVersion: SDK_PROTOCOL_VERSION, requestId: "request-1", installationId: "sample", identityToken, sdk: { version: "0.1.0", protocolVersion: SDK_PROTOCOL_VERSION, distribution: "script" }, page: { origin: "https://client.test", url: "https://client.test/app", locale: "en-IN" }, capabilities: { domObservation: true, shadowDom: true, sameOriginFrames: true, frameBridge: false, registeredTools: [], voice: true, screenshots: false } } });
  assert.equal(bootstrap.statusCode, 200, bootstrap.body);
  const value = bootstrap.json();
  assert.equal(value.catalog.kind, "inline");
  assert.equal(value.voiceTransport.sampleRate, 16000);
  assert.equal(value.voiceTransport.silenceTimeoutMs, 800);
  assert.equal(value.voiceTransport.vadThreshold, 0.02);
  assert.equal(JSON.stringify(value).includes(credential), false);
  await app.close();
});

test("a finalized STT stream is released so the same SDK session can record again", async () => {
  const credential = "server-only-installation-secret";
  const installation = { installationId: "sample", organizationId: "tenant", productId: "product", environmentId: "test", credentialHash: hashCredential(credential), allowedOrigins: ["https://client.test"], allowedRoles: ["member"], activeCatalogVersionId: "v1" };
  const envelope = { payload: { manifest: { catalogVersionId: "v1" } } } as unknown as SignedCatalogEnvelope;
  const stores = new MemoryStores([installation], [envelope], [], []).asRuntimeStores();
  const opened: Parameters<SpeechToTextProvider["open"]>[0][] = [];
  let cancellations = 0;
  const providers: Providers = {
    model: { label: "test", step: async () => ({ texts: ["hello"], toolCalls: [], done: true }) },
    stt: { open: async (options) => { opened.push(options); return { push() {}, finish() {}, cancel() { cancellations++; } }; } },
    tts: { id: "sarvam", defaultSpeaker: "test", maxChars: 450, synthesize: async () => ({ bytes: Buffer.alloc(64), mime: "audio/wav" }) },
  };
  const app = await buildServer(loadConfig({ TOKEN_SIGNING_SECRET: "12345678901234567890123456789012", PUBLIC_API_URL: "http://127.0.0.1" }), stores, providers);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const identity = await app.inject({ method: "POST", url: "/api/v3/sdk/identity-tokens", headers: { authorization: `SableInstallation ${credential}` }, payload: { installationId: "sample", userId: "u1", roleProfileId: "member", origin: "https://client.test" } });
  const bootstrap = await app.inject({ method: "POST", url: "/api/v3/sdk/sessions", headers: { origin: "https://client.test" }, payload: { kind: "sable.sdk.bootstrap.request", schemaVersion: SDK_PROTOCOL_VERSION, requestId: "request-repeat", installationId: "sample", identityToken: identity.json().identityToken, sdk: { version: "0.1.0", protocolVersion: SDK_PROTOCOL_VERSION, distribution: "script" }, page: { origin: "https://client.test", url: "https://client.test/app", locale: "en-IN" }, capabilities: { domObservation: true, shadowDom: true, sameOriginFrames: true, frameBridge: false, registeredTools: [], voice: true, screenshots: false } } });
  const ticket = bootstrap.json().voiceTransport.oneTimeTicket as string;
  const socketUrl = new URL("/ws/sdk/voice", address.replace("http:", "ws:")).toString();
  const socket = new WebSocket(socketUrl, [ticketProtocol(ticket)]);
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });

  let ready = nextSocketMessage(socket, "voice.ready");
  socket.send(JSON.stringify({ type: "voice.start" }));
  await ready;
  assert.equal(opened.length, 1);
  const final = nextSocketMessage(socket, "transcript.final");
  opened[0].onFinal("first request");
  await final;
  assert.equal(cancellations, 1);

  ready = nextSocketMessage(socket, "voice.ready");
  socket.send(JSON.stringify({ type: "voice.start" }));
  await ready;
  assert.equal(opened.length, 2);
  opened[0].onError(new Error("stale old-session callback"));
  const secondFinal = nextSocketMessage(socket, "transcript.final");
  opened[1].onFinal("second request");
  assert.equal((await secondFinal).text, "second request");
  assert.equal(cancellations, 2);

  socket.close();
  await new Promise<void>((resolve) => socket.once("close", () => resolve()));
  await app.close();
});

test("the first completed model sentence reaches TTS before the model finishes", async () => {
  const credential = "server-only-installation-secret";
  const installation = { installationId: "sample", organizationId: "tenant", productId: "product", environmentId: "test", credentialHash: hashCredential(credential), allowedOrigins: ["https://client.test"], allowedRoles: ["member"], activeCatalogVersionId: "v1" };
  const envelope = { payload: { manifest: { catalogVersionId: "v1" }, journeys: [] } } as unknown as SignedCatalogEnvelope;
  const bundle: RuntimeBundle = { schemaVersion: 1, organizationId: "tenant", productId: "product", environmentId: "test", catalogVersionId: "v1", catalogVersion: 1, generatedAt: new Date().toISOString(), journeys: [], salesPlays: [], screens: [], transitions: [], coverage: { weighted: 1, verified: 0, total: 0, unknown: 0 } };
  const stores = new MemoryStores([installation], [envelope], [bundle], []).asRuntimeStores();
  let finishModel: (() => void) | undefined;
  let modelFinished = false;
  let modelCalls = 0;
  const providers: Providers = {
    model: {
      label: "streaming-test",
      step: async (_system, _messages, tools, options) => {
        if (tools.some((tool) => tool.name === "submit_turn_plan")) {
          return { texts: [], toolCalls: [{ id: "plan", name: "submit_turn_plan", args: {
            intent: "product_question", mode: "answer", needsKnowledge: true,
            journeyId: "", journeyInputs: {}, clarification: "",
          } }], done: false };
        }
        modelCalls += 1;
        if (modelCalls > 1) throw new Error("provider unavailable");
        options?.onSentence?.("The first answer is ready.");
        await new Promise<void>((resolve) => { finishModel = resolve; });
        modelFinished = true;
        return { texts: ["The first answer is ready. The second answer is ready."], toolCalls: [], done: true };
      },
    },
    stt: { open: async () => ({ push() {}, finish() {}, cancel() {} }) },
    tts: { id: "sarvam", defaultSpeaker: "test", maxChars: 450, synthesize: async () => ({ bytes: Buffer.from("audio"), mime: "audio/wav" }) },
  };
  const app = await buildServer(loadConfig({ TOKEN_SIGNING_SECRET: "12345678901234567890123456789012", PUBLIC_API_URL: "http://127.0.0.1" }), stores, providers);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const identity = await app.inject({ method: "POST", url: "/api/v3/sdk/identity-tokens", headers: { authorization: `SableInstallation ${credential}` }, payload: { installationId: "sample", userId: "u1", roleProfileId: "member", origin: "https://client.test" } });
  const bootstrap = await app.inject({ method: "POST", url: "/api/v3/sdk/sessions", headers: { origin: "https://client.test" }, payload: { kind: "sable.sdk.bootstrap.request", schemaVersion: SDK_PROTOCOL_VERSION, requestId: "request-stream", installationId: "sample", identityToken: identity.json().identityToken, sdk: { version: "0.1.0", protocolVersion: SDK_PROTOCOL_VERSION, distribution: "script" }, page: { origin: "https://client.test", url: "https://client.test/app", locale: "en-IN" }, capabilities: { domObservation: true, shadowDom: true, sameOriginFrames: true, frameBridge: false, registeredTools: [], voice: true, screenshots: false } } });
  const value = bootstrap.json();
  const sessionId = value.session.sessionId as string;
  const socketBase = address.replace("http:", "ws:");
  const voice = new WebSocket(new URL("/ws/sdk/voice", socketBase).toString(), [ticketProtocol(value.voiceTransport.oneTimeTicket)]);
  const control = new WebSocket(new URL("/ws/sdk", socketBase).toString(), [ticketProtocol(value.transport.oneTimeTicket)]);
  await Promise.all([
    new Promise<void>((resolve, reject) => { voice.once("open", resolve); voice.once("error", reject); }),
    new Promise<void>((resolve, reject) => { control.once("open", resolve); control.once("error", reject); }),
  ]);

  const voiceReady = nextSocketMessage(voice, "voice.ready");
  voice.send(JSON.stringify({ type: "voice.start" }));
  await voiceReady;
  const firstAudio = nextSocketMessage(voice, "tts.chunk");
  control.send(JSON.stringify({ kind: "sable.sdk.client.user_turn", schemaVersion: SDK_PROTOCOL_VERSION, messageId: "message-stream", sessionId, sentAt: new Date().toISOString(), turnId: "turn-stream", text: "What is the refund policy?", modality: "voice" }));
  const audio = await firstAudio;
  assert.equal(audio.text, "The first answer is ready.");
  assert.equal(modelFinished, false);
  const speechEnd = nextSocketMessage(voice, "tts.end");
  finishModel?.();
  const ended = await speechEnd;
  const listenAgain = nextSocketMessage(voice, "voice.listen");
  control.send(JSON.stringify({
    kind: "sable.sdk.client.audio_playback", schemaVersion: SDK_PROTOCOL_VERSION,
    messageId: "message-played", sessionId, sentAt: new Date().toISOString(),
    utteranceId: ended.utteranceId, turnId: "turn-stream", sequence: ended.lastSequence,
    state: "ended",
  }));
  assert.equal((await listenAgain).turnId, "turn-stream");

  // A provider failure must not strand an otherwise-open continuous voice
  // session. The error is spoken, then listening resumes after its playback.
  const controlError = nextSocketMessage(control, "sable.sdk.server.error");
  const errorSpeechEnd = nextSocketMessage(voice, "tts.end");
  control.send(JSON.stringify({ kind: "sable.sdk.client.user_turn", schemaVersion: SDK_PROTOCOL_VERSION, messageId: "message-error", sessionId, sentAt: new Date().toISOString(), turnId: "turn-error", text: "Try again", modality: "voice" }));
  assert.match(String((await controlError).message), /provider unavailable/);
  const errorEnded = await errorSpeechEnd;
  const listenAfterError = nextSocketMessage(voice, "voice.listen");
  control.send(JSON.stringify({
    kind: "sable.sdk.client.audio_playback", schemaVersion: SDK_PROTOCOL_VERSION,
    messageId: "message-error-played", sessionId, sentAt: new Date().toISOString(),
    utteranceId: errorEnded.utteranceId, turnId: "turn-error", sequence: errorEnded.lastSequence,
    state: "ended",
  }));
  assert.equal((await listenAfterError).turnId, "turn-error");

  voice.close();
  control.close();
  await Promise.all([
    new Promise<void>((resolve) => voice.once("close", () => resolve())),
    new Promise<void>((resolve) => control.once("close", () => resolve())),
  ]);
  await app.close();
});

test("a section explanation runs the approved journey, requests a fresh DOM, then explains", async () => {
  const credential = "server-only-installation-secret";
  const installation = { installationId: "sample", organizationId: "tenant", productId: "product", environmentId: "test", credentialHash: hashCredential(credential), allowedOrigins: ["https://client.test"], allowedRoles: ["member"], activeCatalogVersionId: "v1" };
  const envelope = { payload: { manifest: { catalogVersionId: "v1" }, journeys: [{
    id: "show-reports", name: "Show reports", description: "Show the reports section", state: "approved", risk: "read", roles: ["member"],
    inputSchema: { required: [], properties: {} }, compatibility: [{ classification: "SDK_DIRECT" }], workflow: { steps: [] },
  }, {
    id: "show-settings", name: "Show settings", description: "Show the settings section", state: "approved", risk: "read", roles: ["member"],
    inputSchema: { required: [], properties: {} }, compatibility: [{ classification: "SDK_DIRECT" }], workflow: { steps: [] },
  }] } } as unknown as SignedCatalogEnvelope;
  const bundle: RuntimeBundle = {
    schemaVersion: 1, organizationId: "tenant", productId: "product", environmentId: "test", catalogVersionId: "v1", catalogVersion: 1, generatedAt: new Date().toISOString(), salesPlays: [], screens: [], transitions: [], coverage: { weighted: 1, verified: 1, total: 1, unknown: 0 },
    journeys: [
      { key: "show-reports", name: "Show reports", roleProfileIds: ["member"], intentPhrases: ["what does reports contain"], reliability: 1, workflow: { schemaVersion: 1, id: "show-reports", version: 1, name: "Show reports", risk: "read", preconditions: [], steps: [{ id: "reports", action: "navigate", say: "This is the reports section." }], postconditions: [] } },
      { key: "show-settings", name: "Show settings", roleProfileIds: ["member"], intentPhrases: ["open settings"], reliability: 1, workflow: { schemaVersion: 1, id: "show-settings", version: 1, name: "Show settings", risk: "read", preconditions: [], steps: [{ id: "settings", action: "navigate", say: "This is the settings section." }], postconditions: [] } },
    ],
  };
  const stores = new MemoryStores([installation], [envelope], [bundle], [{
    id: "reports-kb", tenantId: "tenant", productId: "product", catalogVersionId: "v1", title: "Reports", section: "Reports", content: "Reports contains attendance and fee summaries.", source: "docs", trust: "official", score: 1,
  }]).asRuntimeStores();
  let responseCall = 0;
  const providers: Providers = {
    model: {
      label: "presentation-test",
      step: async (_system, messages, tools, options) => {
        const latestText = messages.flatMap((message) => message.blocks).flatMap((block) => block.type === "text" ? [block.text] : []).at(-1) ?? "";
        if (tools.some((tool) => tool.name === "submit_turn_plan")) {
          const args = latestText.includes("What is this product") ? {
            intent: "product_question", mode: "answer", needsKnowledge: true, taskControl: "side_question",
            journeyId: "", journeyInputs: {}, clarification: "",
          } : latestText.includes("Open settings") ? {
            intent: "action", mode: "execute", needsKnowledge: false, taskControl: "replace",
            journeyId: "show-settings", journeyInputs: {}, clarification: "",
          } : latestText.includes("don't want") ? {
            intent: "conversation", mode: "answer", needsKnowledge: false, taskControl: "stop",
            journeyId: "", journeyInputs: {}, clarification: "",
          } : {
            intent: "product_question", mode: "execute_then_observe_and_answer", needsKnowledge: true, taskControl: "none",
            journeyId: "show-reports", journeyInputs: {}, clarification: "",
          };
          return { texts: [], toolCalls: [{ id: "plan", name: "submit_turn_plan", args }], done: false };
        }
        responseCall += 1;
        const text = latestText.includes("Open settings") ? "I’m opening settings." : responseCall === 1 ? "Let’s look at reports." : "Reports contains attendance and fee summaries.";
        options?.onSentence?.(text);
        return { texts: [text], toolCalls: [], done: true };
      },
    },
    stt: { open: async () => ({ push() {}, finish() {}, cancel() {} }) },
    tts: { id: "sarvam", defaultSpeaker: "test", maxChars: 450, synthesize: async () => ({ bytes: Buffer.from("audio"), mime: "audio/wav" }) },
  };
  const app = await buildServer(loadConfig({ TOKEN_SIGNING_SECRET: "12345678901234567890123456789012", PUBLIC_API_URL: "http://127.0.0.1" }), stores, providers);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const identity = await app.inject({ method: "POST", url: "/api/v3/sdk/identity-tokens", headers: { authorization: `SableInstallation ${credential}` }, payload: { installationId: "sample", userId: "u1", roleProfileId: "member", origin: "https://client.test" } });
  const bootstrap = await app.inject({ method: "POST", url: "/api/v3/sdk/sessions", headers: { origin: "https://client.test" }, payload: { kind: "sable.sdk.bootstrap.request", schemaVersion: SDK_PROTOCOL_VERSION, requestId: "request-presentation", installationId: "sample", identityToken: identity.json().identityToken, sdk: { version: "0.1.0", protocolVersion: SDK_PROTOCOL_VERSION, distribution: "script" }, page: { origin: "https://client.test", url: "https://client.test/app", locale: "en-IN" }, capabilities: { domObservation: true, shadowDom: true, sameOriginFrames: true, frameBridge: false, registeredTools: [], voice: false, screenshots: false } } });
  const value = bootstrap.json();
  const sessionId = value.session.sessionId as string;
  const control = new WebSocket(new URL("/ws/sdk", address.replace("http:", "ws:")).toString(), [ticketProtocol(value.transport.oneTimeTicket)]);
  await new Promise<void>((resolve, reject) => { control.once("open", resolve); control.once("error", reject); });

  const transition = nextSocketMessage(control, "sable.sdk.server.assistant_final");
  const journey = nextSocketMessage(control, "sable.sdk.server.run_journey");
  control.send(JSON.stringify({ kind: "sable.sdk.client.user_turn", schemaVersion: SDK_PROTOCOL_VERSION, messageId: "message-presentation", sessionId, sentAt: new Date().toISOString(), turnId: "turn-presentation", text: "Tell me what the reports section has", modality: "text" }));
  assert.equal((await transition).text, "Let’s look at reports.");
  const command = await journey;
  assert.equal(command.journeyId, "show-reports");

  // A newer turn does not overlap the active journey. It is queued until the
  // SDK confirms a safe step-boundary pause, then receives a normal answer.
  const pause = nextSocketMessage(control, "sable.sdk.server.pause_journey");
  control.send(JSON.stringify({ kind: "sable.sdk.client.user_turn", schemaVersion: SDK_PROTOCOL_VERSION, messageId: "message-interrupt", sessionId, sentAt: new Date().toISOString(), turnId: "turn-interrupt", text: "What is this product?", modality: "voice" }));
  assert.equal((await pause).journeyId, "show-reports");
  const interruptedAnswer = nextSocketMessage(control, "sable.sdk.server.assistant_final");
  control.send(JSON.stringify({ kind: "sable.sdk.client.journey_progress", schemaVersion: SDK_PROTOCOL_VERSION, messageId: "message-paused", sessionId, sentAt: new Date().toISOString(), commandId: command.commandId, journeyId: "show-reports", stepId: "reports", phase: "paused" }));
  assert.equal((await interruptedAnswer).turnId, "turn-interrupt");

  const resumedJourney = nextSocketMessage(control, "sable.sdk.server.run_journey");
  control.send(JSON.stringify({ kind: "sable.sdk.client.user_turn", schemaVersion: SDK_PROTOCOL_VERSION, messageId: "message-continue", sessionId, sentAt: new Date().toISOString(), turnId: "turn-continue", text: "continue", modality: "text" }));
  const resumed = await resumedJourney;
  assert.equal(resumed.journeyId, "show-reports");
  assert.equal((resumed.resume as { nextStepId: string }).nextStepId, "reports");

  const observationRequest = nextSocketMessage(control, "sable.sdk.server.request_observation");
  control.send(JSON.stringify({ kind: "sable.sdk.client.journey_result", schemaVersion: SDK_PROTOCOL_VERSION, messageId: "message-result", sessionId, sentAt: new Date().toISOString(), commandId: resumed.commandId, journeyId: "show-reports", ok: true, completedSteps: 1 }));
  const observe = await observationRequest;
  assert.match(String(observe.reason), /after verified SDK navigation/);

  const explanation = nextSocketMessage(control, "sable.sdk.server.assistant_final");
  control.send(JSON.stringify({
    kind: "sable.sdk.client.observation", schemaVersion: SDK_PROTOCOL_VERSION, messageId: "message-observation", sessionId, sentAt: new Date().toISOString(),
    reason: "requested", replyToCommandId: observe.commandId, turnId: "turn-presentation",
    observation: { kind: "sable.screen_observation", schemaVersion: 1, observationId: "obs-reports", version: 2, capturedAt: new Date().toISOString(), url: "https://client.test/app#reports", origin: "https://client.test", title: "Reports", fingerprint: "reports", visibleText: "Attendance Fee summaries", elements: [] },
  }));
  assert.equal((await explanation).text, "Reports contains attendance and fee summaries.");

  // A request for another approved journey replaces the paused journey. The
  // old SDK checkpoint is stopped before the new command is issued.
  const oldTransition = nextSocketMessage(control, "sable.sdk.server.assistant_final");
  const oldJourney = nextSocketMessage(control, "sable.sdk.server.run_journey");
  control.send(JSON.stringify({ kind: "sable.sdk.client.user_turn", schemaVersion: SDK_PROTOCOL_VERSION, messageId: "message-old", sessionId, sentAt: new Date().toISOString(), turnId: "turn-old", text: "Show me reports again", modality: "text" }));
  await oldTransition;
  const oldCommand = await oldJourney;
  const replacementPause = nextSocketMessage(control, "sable.sdk.server.pause_journey");
  control.send(JSON.stringify({ kind: "sable.sdk.client.user_turn", schemaVersion: SDK_PROTOCOL_VERSION, messageId: "message-replace", sessionId, sentAt: new Date().toISOString(), turnId: "turn-replace", text: "Open settings instead", modality: "text" }));
  await replacementPause;
  const replacementStop = nextSocketMessage(control, "sable.sdk.server.stop_journey");
  const replacementTransition = nextSocketMessage(control, "sable.sdk.server.assistant_final");
  const replacementJourney = nextSocketMessage(control, "sable.sdk.server.run_journey");
  control.send(JSON.stringify({ kind: "sable.sdk.client.journey_progress", schemaVersion: SDK_PROTOCOL_VERSION, messageId: "message-replace-paused", sessionId, sentAt: new Date().toISOString(), commandId: oldCommand.commandId, journeyId: "show-reports", stepId: "reports", phase: "paused" }));
  assert.match(String((await replacementStop).reason), /Replaced/);
  assert.equal((await replacementTransition).text, "I’m opening settings.");
  const settingsCommand = await replacementJourney;
  assert.equal(settingsCommand.journeyId, "show-settings");
  const settingsResult = nextSocketMessage(control, "sable.sdk.server.assistant_final");
  control.send(JSON.stringify({ kind: "sable.sdk.client.journey_result", schemaVersion: SDK_PROTOCOL_VERSION, messageId: "message-settings-result", sessionId, sentAt: new Date().toISOString(), commandId: settingsCommand.commandId, journeyId: "show-settings", ok: true, completedSteps: 1 }));
  await settingsResult;

  // Natural language can stop a journey without requiring a fixed command.
  const finalTransition = nextSocketMessage(control, "sable.sdk.server.assistant_final");
  const finalJourney = nextSocketMessage(control, "sable.sdk.server.run_journey");
  control.send(JSON.stringify({ kind: "sable.sdk.client.user_turn", schemaVersion: SDK_PROTOCOL_VERSION, messageId: "message-final", sessionId, sentAt: new Date().toISOString(), turnId: "turn-final", text: "Show reports", modality: "text" }));
  await finalTransition;
  const finalCommand = await finalJourney;
  const stopPause = nextSocketMessage(control, "sable.sdk.server.pause_journey");
  control.send(JSON.stringify({ kind: "sable.sdk.client.user_turn", schemaVersion: SDK_PROTOCOL_VERSION, messageId: "message-natural-stop", sessionId, sentAt: new Date().toISOString(), turnId: "turn-natural-stop", text: "I don't want to do this anymore", modality: "text" }));
  await stopPause;
  const stoppedCommand = nextSocketMessage(control, "sable.sdk.server.stop_journey");
  const stoppedAnswer = nextSocketMessage(control, "sable.sdk.server.assistant_final");
  control.send(JSON.stringify({ kind: "sable.sdk.client.journey_progress", schemaVersion: SDK_PROTOCOL_VERSION, messageId: "message-natural-stop-paused", sessionId, sentAt: new Date().toISOString(), commandId: finalCommand.commandId, journeyId: "show-reports", stepId: "reports", phase: "paused" }));
  assert.match(String((await stoppedCommand).reason), /Stopped by the user/);
  assert.equal((await stoppedAnswer).text, "Stopped the current journey.");

  control.close();
  await new Promise<void>((resolve) => control.once("close", () => resolve()));
  await app.close();
});
