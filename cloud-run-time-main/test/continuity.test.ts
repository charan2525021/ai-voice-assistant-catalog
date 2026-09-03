import assert from "node:assert/strict";
import test from "node:test";
import { SDK_PROTOCOL_VERSION, type SignedCatalogEnvelope } from "@sable/sdk-contracts";
import WebSocket from "ws";
import { loadConfig } from "../src/config.js";
import type { Providers } from "../src/providers/index.js";
import { buildServer } from "../src/server.js";
import { hashCredential, TokenSigner } from "../src/security.js";
import { MemoryStores } from "../src/stores/memory.js";

const ticketProtocol = (ticket: string) => `sable.ticket.${Buffer.from(ticket).toString("base64url")}`;
const nextSocketMessage = (socket: WebSocket, kind: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${kind}`)), 2_000);
  socket.on("message", function listener(raw) {
    const value = JSON.parse(raw.toString()) as Record<string, unknown>;
    if (value.kind !== kind) return;
    clearTimeout(timer); socket.off("message", listener); resolve(value);
  });
});

const credential = "server-only-installation-secret";
const signingSecret = "12345678901234567890123456789012";
const installation = {
  installationId: "sample", organizationId: "tenant", productId: "product", environmentId: "test",
  credentialHash: hashCredential(credential), allowedOrigins: ["https://source.test", "https://destination.test"],
  allowedRoles: ["member"], activeCatalogVersionId: "v2",
};
const continuityId = new TokenSigner(signingSecret).opaqueId("continuity", "sample", "tenant", "product", "test", "u1", "member", "v2");
const journey = {
  id: "open-reports", version: 2, name: "Open reports", state: "approved", risk: "read", roles: ["member"],
  inputSchema: { properties: { destination: { type: "enum", enum: ["https://destination.test/reports"] } }, required: ["destination"] },
  workflow: { steps: [
    { id: "navigate", kind: "action", action: "navigate", url: { kind: "input_ref", name: "destination" }, compatibility: { classification: "SDK_RESUMABLE_NAVIGATION" }, continuity: { expectedScreenIds: ["reports"], destinationOrigins: ["https://destination.test"] } },
    { id: "verify", kind: "assert", compatibility: { classification: "SDK_DIRECT" } },
  ] },
};
const envelope = { payload: { manifest: { catalogVersionId: "v2" }, journeys: [journey] } } as unknown as SignedCatalogEnvelope;
const providers: Providers = {
  model: { label: "test", step: async () => ({ texts: ["ok"], toolCalls: [], done: true }) },
  stt: { open: async () => ({ push() {}, finish() {}, cancel() {} }) },
  tts: { id: "sarvam", defaultSpeaker: "test", maxChars: 450, synthesize: async () => ({ bytes: Buffer.alloc(8), mime: "audio/wav" }) },
};

async function bootstrap(app: Awaited<ReturnType<typeof buildServer>>, origin: string, requestId: string, path?: string) {
  const identity = await app.inject({ method: "POST", url: "/api/v3/sdk/identity-tokens", headers: { authorization: `SableInstallation ${credential}` }, payload: { installationId: "sample", userId: "u1", roleProfileId: "member", origin } });
  const response = await app.inject({ method: "POST", url: "/api/v3/sdk/sessions", headers: { origin }, payload: {
    kind: "sable.sdk.bootstrap.request", schemaVersion: SDK_PROTOCOL_VERSION, requestId, installationId: "sample", identityToken: identity.json().identityToken,
    sdk: { version: "0.1.0", protocolVersion: SDK_PROTOCOL_VERSION, distribution: "script" },
    page: { origin, url: `${origin}${path ?? (origin.includes("destination") ? "/reports" : "/home")}`, locale: "en-IN" },
    capabilities: { domObservation: true, shadowDom: true, sameOriginFrames: true, frameBridge: false, registeredTools: [], voice: false, screenshots: false },
  } });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

function snapshot() {
  return {
    kind: "sable.browser_continuity", schemaVersion: 1, continuityId,
    installationId: "sample", organizationId: "tenant", productId: "product", environmentId: "test",
    userId: "u1", roleProfileId: "member", catalogVersionId: "v2", origin: "https://source.test",
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    transcript: [{ key: "user:turn-1", role: "user", text: "Open reports and explain", createdAt: new Date().toISOString() }],
    journey: {
      journeyId: "open-reports", journeyVersion: 2, turnId: "turn-1", originalRequest: "Open reports and explain",
      inputs: { destination: "https://destination.test/reports" }, completedStepIds: ["navigate"],
      nextStepId: "verify", nextStepIndex: 1, navigationStepId: "navigate",
      destinationUrl: "https://destination.test/reports", expectedScreenIds: ["reports"],
    },
  };
}

async function seedAuthoritativeContinuity(stores: ReturnType<MemoryStores["asRuntimeStores"]>, presentationRequested = true) {
  const now = new Date().toISOString();
  await stores.continuities.put({
    continuityId, organizationId: "tenant", installationId: "sample", userId: "u1", role: "member", catalogVersionId: "v2",
    messages: [{ role: "user", blocks: [{ type: "text", text: "Open reports and explain" }] }],
    transcript: [{ key: "user:turn-1", role: "user", text: "Open reports and explain", createdAt: now }],
    pendingJourney: { turnId: "turn-1", originalRequest: "Open reports and explain", journeyId: "open-reports", inputs: { destination: "https://destination.test/reports" }, presentationRequested, completedStepIds: [] },
    startedAt: now, updatedAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString(), revision: 1,
  });
}

test("cross-origin handoff is scope-bound and can be consumed only once", async () => {
  const stores = new MemoryStores([installation], [envelope], [], []).asRuntimeStores();
  await seedAuthoritativeContinuity(stores);
  const app = await buildServer(loadConfig({ TOKEN_SIGNING_SECRET: signingSecret, PUBLIC_API_URL: "https://runtime.test" }), stores, providers);
  const source = await bootstrap(app, "https://source.test", "source-bootstrap");
  const created = await app.inject({ method: "POST", url: "/api/v3/sdk/handoffs", headers: { origin: "https://source.test", authorization: `Bearer ${source.session.sessionToken}` }, payload: { snapshot: snapshot(), destinationUrl: "https://destination.test/reports" } });
  assert.equal(created.statusCode, 201, created.body);
  const destination = await bootstrap(app, "https://destination.test", "destination-bootstrap");
  assert.equal(source.session.continuityId, destination.session.continuityId);
  const consume = () => app.inject({ method: "POST", url: "/api/v3/sdk/handoffs/consume", headers: { origin: "https://destination.test", authorization: `Bearer ${destination.session.sessionToken}` }, payload: { token: created.json().token, destinationUrl: "https://destination.test/reports" } });
  const first = await consume();
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().snapshot.origin, "https://destination.test");
  assert.equal((await consume()).statusCode, 400);
  await app.close();
});

test("a restored journey resumes only after the trained destination screen matches", async () => {
  const stores = new MemoryStores([installation], [envelope], [], []).asRuntimeStores();
  // A plain execute plan is resumable too. Presentation mode affects only the
  // final explanation; it is not an authorization requirement for continuity.
  await seedAuthoritativeContinuity(stores, false);
  const app = await buildServer(loadConfig({ TOKEN_SIGNING_SECRET: signingSecret, PUBLIC_API_URL: "http://127.0.0.1" }), stores, providers);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const destination = await bootstrap(app, "https://destination.test", "resume-bootstrap");
  const socket = new WebSocket(new URL("/ws/sdk", address.replace("http:", "ws:")).toString(), [ticketProtocol(destination.transport.oneTimeTicket)]);
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  const base = { schemaVersion: SDK_PROTOCOL_VERSION, sessionId: destination.session.sessionId, sentAt: new Date().toISOString() };
  socket.send(JSON.stringify({ ...base, kind: "sable.sdk.client.ready", messageId: "ready-1", catalogVersionId: "v2", currentUrl: "https://destination.test/reports" }));
  const value = snapshot(); value.origin = "https://destination.test";
  const { nextStepIndex: _notOnWire, ...wireJourney } = value.journey;
  const restoredState = nextSocketMessage(socket, "sable.sdk.server.restore_state");
  socket.send(JSON.stringify({ ...base, kind: "sable.sdk.client.restore_context", messageId: "restore-1", continuityId: value.continuityId, transcript: value.transcript, journey: wireJourney }));
  const restored = await restoredState;
  assert.equal(restored.continuityId, continuityId);
  assert.equal((restored.transcript as unknown[]).length, 1);
  const resumed = nextSocketMessage(socket, "sable.sdk.server.run_journey");
  socket.send(JSON.stringify({ ...base, kind: "sable.sdk.client.observation", messageId: "observation-1", reason: "initial", observation: {
    kind: "sable.screen_observation", schemaVersion: 1, observationId: "obs-1", version: 1, capturedAt: new Date().toISOString(),
    url: "https://destination.test/reports", origin: "https://destination.test", title: "Reports", fingerprint: "reports-v1", elements: [], matchedScreenId: "reports", matchConfidence: 1,
  } }));
  const command = await resumed;
  assert.equal(command.journeyId, "open-reports");
  assert.deepEqual(command.resume, { completedStepIds: ["navigate"], nextStepId: "verify" });
  socket.close();
  await new Promise<void>((resolve) => socket.once("close", () => resolve()));
  await app.close();
});

test("a newer browser tab takes over the same server continuity without stale writes", async () => {
  const stores = new MemoryStores([installation], [envelope], [], []).asRuntimeStores();
  const app = await buildServer(loadConfig({ TOKEN_SIGNING_SECRET: signingSecret, PUBLIC_API_URL: "http://127.0.0.1" }), stores, providers);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const firstSession = await bootstrap(app, "https://source.test", "tab-one", "/home");
  const secondSession = await bootstrap(app, "https://source.test", "tab-two", "/home");
  assert.equal(firstSession.session.continuityId, secondSession.session.continuityId);

  const connect = async (sessionValue: Record<string, any>) => {
    const socket = new WebSocket(new URL("/ws/sdk", address.replace("http:", "ws:")).toString(), [ticketProtocol(sessionValue.transport.oneTimeTicket)]);
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    const base = { schemaVersion: SDK_PROTOCOL_VERSION, sessionId: sessionValue.session.sessionId, sentAt: new Date().toISOString() };
    socket.send(JSON.stringify({ ...base, kind: "sable.sdk.client.ready", messageId: `ready-${sessionValue.session.sessionId}`, catalogVersionId: "v2", currentUrl: "https://source.test/home" }));
    const restored = nextSocketMessage(socket, "sable.sdk.server.restore_state");
    socket.send(JSON.stringify({ ...base, kind: "sable.sdk.client.restore_context", messageId: `restore-${sessionValue.session.sessionId}`, continuityId, transcript: [] }));
    await restored;
    return socket;
  };

  const first = await connect(firstSession);
  const firstClosed = new Promise<number>((resolve) => first.once("close", (code) => resolve(code)));
  const second = await connect(secondSession);
  assert.equal(await firstClosed, 4001);
  const stored = await stores.continuities.get(continuityId);
  assert.ok((stored?.revision ?? 0) >= 2);
  second.close();
  await new Promise<void>((resolve) => second.once("close", resolve));
  await app.close();
});

test("a journey-independent catalog navigation completes only on its trained destination", async () => {
  const navigationEnvelope = { payload: {
    manifest: { catalogVersionId: "v2" }, journeys: [],
    screens: [{ id: "home", name: "Home", roles: ["member"] }, { id: "mystery", name: "Mystery", roles: ["member"] }],
    controls: [{ id: "mystery-link", screenId: "home", name: "Mystery", risk: "read", locators: [] }],
  } } as unknown as SignedCatalogEnvelope;
  const navigationBundle = {
    schemaVersion: 1, organizationId: "tenant", productId: "product", environmentId: "test", catalogVersionId: "v2", catalogVersion: 2,
    generatedAt: new Date().toISOString(), journeys: [], salesPlays: [], coverage: { weighted: 1, verified: 1, total: 1, unknown: 0 },
    screens: [
      { key: "home", name: "Home", url: "https://source.test/home", fingerprint: "home", roleProfileId: "member", controls: [{ key: "mystery-link", role: "link", accessibleName: "Mystery", risk: "read" }] },
      { key: "mystery", name: "Mystery", url: "https://source.test/mystery", fingerprint: "mystery", roleProfileId: "member", controls: [] },
    ],
    transitions: [{ fromScreenKey: "home", fromFingerprint: "home", toScreenKey: "mystery", toFingerprint: "mystery", roleProfileId: "member", controlKey: "mystery-link", action: { kind: "navigate" }, reliability: 0.98 }],
  } as never;
  const stores = new MemoryStores([installation], [navigationEnvelope], [navigationBundle], []).asRuntimeStores();
  const now = new Date().toISOString();
  await stores.continuities.put({
    continuityId, organizationId: "tenant", installationId: "sample", userId: "u1", role: "member", catalogVersionId: "v2",
    messages: [], transcript: [], pendingCatalogNavigation: { turnId: "turn-nav", originalRequest: "Open Mystery", sourceScreenId: "home", controlId: "mystery-link", targetScreenId: "mystery", destinationUrl: "" },
    startedAt: now, updatedAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString(), revision: 1,
  });
  const app = await buildServer(loadConfig({ TOKEN_SIGNING_SECRET: signingSecret, PUBLIC_API_URL: "http://127.0.0.1" }), stores, providers);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const session = await bootstrap(app, "https://source.test", "catalog-nav-bootstrap", "/mystery");
  const socket = new WebSocket(new URL("/ws/sdk", address.replace("http:", "ws:")).toString(), [ticketProtocol(session.transport.oneTimeTicket)]);
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  const base = { schemaVersion: SDK_PROTOCOL_VERSION, sessionId: session.session.sessionId, sentAt: new Date().toISOString() };
  socket.send(JSON.stringify({ ...base, kind: "sable.sdk.client.ready", messageId: "ready-nav", catalogVersionId: "v2", currentUrl: "https://source.test/mystery" }));
  socket.send(JSON.stringify({ ...base, kind: "sable.sdk.client.restore_context", messageId: "restore-nav", continuityId, transcript: [], catalogNavigation: {
    turnId: "turn-nav", originalRequest: "Open Mystery", sourceScreenId: "home", controlId: "mystery-link", targetScreenId: "mystery", destinationUrl: "https://source.test/mystery",
  } }));
  const completed = nextSocketMessage(socket, "sable.sdk.server.assistant_final");
  const cleared = nextSocketMessage(socket, "sable.sdk.server.clear_catalog_navigation");
  socket.send(JSON.stringify({ ...base, kind: "sable.sdk.client.observation", messageId: "obs-nav", reason: "initial", observation: {
    kind: "sable.screen_observation", schemaVersion: 1, observationId: "obs-nav", version: 1, capturedAt: now,
    url: "https://source.test/mystery", origin: "https://source.test", title: "Mystery", fingerprint: "mystery", elements: [], matchedScreenId: "mystery", matchConfidence: 1,
  } }));
  assert.match(String((await completed).text), /opened Mystery/);
  await cleared;
  socket.close();
  await new Promise<void>((resolve) => socket.once("close", resolve));
  await app.close();
});

test("a dynamic catalog route pauses after a verified step and continues with only the next signed edge", async () => {
  const navigationEnvelope = { payload: {
    manifest: { catalogVersionId: "v2" }, journeys: [],
    screens: [
      { id: "home", name: "Home", roles: ["member"] },
      { id: "mystery", name: "Mystery", roles: ["member"] },
      { id: "sharp", name: "Sharp Objects", roles: ["member"] },
    ],
    controls: [
      { id: "mystery-link", screenId: "home", name: "Mystery", risk: "read", locators: [] },
      { id: "sharp-link", screenId: "mystery", name: "Sharp Objects", risk: "read", locators: [] },
    ],
  } } as unknown as SignedCatalogEnvelope;
  const navigationBundle = {
    schemaVersion: 1, organizationId: "tenant", productId: "product", environmentId: "test", catalogVersionId: "v2", catalogVersion: 2,
    generatedAt: new Date().toISOString(), journeys: [], salesPlays: [], coverage: { weighted: 1, verified: 1, total: 1, unknown: 0 },
    screens: [
      { key: "home", name: "Home", url: "https://source.test/home", fingerprint: "home", roleProfileId: "member", controls: [{ key: "mystery-link", role: "link", accessibleName: "Mystery", risk: "read" }] },
      { key: "mystery", name: "Mystery", url: "https://source.test/mystery", fingerprint: "mystery", roleProfileId: "member", controls: [{ key: "sharp-link", role: "link", accessibleName: "Sharp Objects", risk: "read" }] },
      { key: "sharp", name: "Sharp Objects", url: "https://source.test/sharp", fingerprint: "sharp", roleProfileId: "member", controls: [] },
    ],
    transitions: [
      { fromScreenKey: "home", fromFingerprint: "home", toScreenKey: "mystery", toFingerprint: "mystery", roleProfileId: "member", controlKey: "mystery-link", action: { kind: "navigate", classification: "SDK_RESUMABLE_NAVIGATION" }, reliability: 0.98 },
      { fromScreenKey: "mystery", fromFingerprint: "mystery", toScreenKey: "sharp", toFingerprint: "sharp", roleProfileId: "member", controlKey: "sharp-link", action: { kind: "navigate", classification: "SDK_RESUMABLE_NAVIGATION" }, reliability: 0.98 },
    ],
  } as never;
  const stores = new MemoryStores([installation], [navigationEnvelope], [navigationBundle], []).asRuntimeStores();
  const now = new Date().toISOString();
  await stores.continuities.put({
    continuityId, organizationId: "tenant", installationId: "sample", userId: "u1", role: "member", catalogVersionId: "v2",
    messages: [], transcript: [], pendingCatalogNavigation: {
      turnId: "turn-plan", originalRequest: "Open Sharp Objects", sourceScreenId: "home", controlId: "mystery-link", targetScreenId: "mystery", destinationUrl: "",
      modality: "text", finalTargetScreenId: "sharp", remainingSteps: [{ sourceScreenId: "mystery", controlId: "sharp-link", targetScreenId: "sharp" }],
    },
    startedAt: now, updatedAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString(), revision: 1,
  });
  const app = await buildServer(loadConfig({ TOKEN_SIGNING_SECRET: signingSecret, PUBLIC_API_URL: "http://127.0.0.1" }), stores, providers);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const session = await bootstrap(app, "https://source.test", "catalog-plan-bootstrap", "/mystery");
  const socket = new WebSocket(new URL("/ws/sdk", address.replace("http:", "ws:")).toString(), [ticketProtocol(session.transport.oneTimeTicket)]);
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  const base = { schemaVersion: SDK_PROTOCOL_VERSION, sessionId: session.session.sessionId, sentAt: now };
  socket.send(JSON.stringify({ ...base, kind: "sable.sdk.client.ready", messageId: "ready-plan", catalogVersionId: "v2", currentUrl: "https://source.test/mystery" }));
  socket.send(JSON.stringify({ ...base, kind: "sable.sdk.client.restore_context", messageId: "restore-plan", continuityId, transcript: [], catalogNavigation: {
    turnId: "turn-plan", originalRequest: "Open Sharp Objects", sourceScreenId: "home", controlId: "mystery-link", targetScreenId: "mystery", destinationUrl: "https://source.test/mystery",
  } }));
  const paused = nextSocketMessage(socket, "sable.sdk.server.assistant_final");
  socket.send(JSON.stringify({ ...base, kind: "sable.sdk.client.observation", messageId: "obs-plan", reason: "initial", observation: {
    kind: "sable.screen_observation", schemaVersion: 1, observationId: "obs-plan", version: 1, capturedAt: now,
    url: "https://source.test/mystery", origin: "https://source.test", title: "Mystery", fingerprint: "mystery", elements: [{ id: "sharp", role: "link", name: "Sharp Objects", visible: true, enabled: true, controlId: "sharp-link" }], matchedScreenId: "mystery", matchConfidence: 1,
  } }));
  assert.match(String((await paused).text), /Say continue/);
  const nextCommand = nextSocketMessage(socket, "sable.sdk.server.run_catalog_navigation");
  socket.send(JSON.stringify({ ...base, kind: "sable.sdk.client.user_turn", messageId: "continue-plan", turnId: "continue-plan", text: "continue", modality: "text" }));
  assert.deepEqual(
    (({ sourceScreenId, controlId, targetScreenId }) => ({ sourceScreenId, controlId, targetScreenId }))(await nextCommand),
    { sourceScreenId: "mystery", controlId: "sharp-link", targetScreenId: "sharp" },
  );
  socket.close();
  await new Promise<void>((resolve) => socket.once("close", resolve));
  await app.close();
});
