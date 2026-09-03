import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  SDK_PROTOCOL_VERSION,
  assertValidSdkBootstrapResponse,
  assertValidSignedCatalogEnvelope,
} from "@sable/sdk-contracts";

const publicUrl = String(process.env.BROCHURE_TEST_PUBLIC_URL ?? "").replace(/\/$/, "");
const brokerSecret = String(process.env.BROCHURE_TEST_BROKER_SECRET ?? "");
const origin = "https://www.brochure.niroggyan.com";
if (!publicUrl.startsWith("https://") || brokerSecret.length < 24) {
  throw new Error("Live-gateway verification requires the public HTTPS URL and ephemeral broker secret");
}

const request = async (path, init = {}) => {
  const response = await fetch(`${publicUrl}${path}`, { ...init, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response;
};

const health = await (await request("/healthz")).json();
if (health?.ok !== true) throw new Error("Public gateway health check did not return ok");

const runtimeConfig = await (await request("/runtime-config.generated.json", { headers: { origin } })).json();
if (runtimeConfig.apiBaseUrl !== publicUrl || runtimeConfig.origin !== origin) {
  throw new Error("Public runtime configuration does not match the temporary gateway and brochure origin");
}

const identity = await (await request("/api/sable-token", {
  headers: { origin, "x-sable-test-key": brokerSecret },
})).json();
if (typeof identity.identityToken !== "string") throw new Error("Token broker did not return a short-lived identity token");

const requestId = `live-check-${randomUUID()}`;
const bootstrapResponse = await request("/api/v3/sdk/sessions", {
  method: "POST",
  headers: { origin, "content-type": "application/json" },
  body: JSON.stringify({
    kind: "sable.sdk.bootstrap.request",
    schemaVersion: SDK_PROTOCOL_VERSION,
    requestId,
    installationId: runtimeConfig.installationId,
    identityToken: identity.identityToken,
    sdk: { version: "0.1.0", protocolVersion: SDK_PROTOCOL_VERSION, distribution: "script" },
    page: { origin, url: `${origin}/`, locale: "en-IN", timezone: "Asia/Kolkata" },
    capabilities: {
      domObservation: true,
      shadowDom: true,
      sameOriginFrames: true,
      frameBridge: false,
      registeredTools: ["client_router.navigate"],
      voice: false,
      screenshots: false,
    },
  }),
});
const bootstrap = await bootstrapResponse.json();
assertValidSdkBootstrapResponse(bootstrap, requestId);
if (bootstrap.catalog.kind !== "inline") throw new Error("Live brochure check requires the pinned catalog inline");
assertValidSignedCatalogEnvelope(bootstrap.catalog.envelope);
const catalog = bootstrap.catalog.envelope.payload;
if (catalog.manifest.catalogVersionId !== "niroggyan-brochure-v2-test" || !catalog.demoProfile) {
  throw new Error("Bootstrap did not deliver the signed NirogGyan guided-demo catalog");
}

const ticketProtocol = `sable.ticket.${Buffer.from(bootstrap.transport.oneTimeTicket).toString("base64url")}`;
const demoState = await new Promise((resolve, reject) => {
  const socket = new WebSocket(bootstrap.transport.websocketUrl, [ticketProtocol], { origin });
  const timer = setTimeout(() => { socket.terminate(); reject(new Error("Timed out waiting for the idle guided-demo state")); }, 20_000);
  socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  socket.once("open", () => socket.send(JSON.stringify({
    kind: "sable.sdk.client.ready",
    schemaVersion: SDK_PROTOCOL_VERSION,
    messageId: `live-check-${randomUUID()}`,
    sessionId: bootstrap.session.sessionId,
    sentAt: new Date().toISOString(),
    catalogVersionId: catalog.manifest.catalogVersionId,
    currentUrl: `${origin}/`,
  })));
  socket.on("message", (data) => {
    let message;
    try { message = JSON.parse(String(data)); } catch { return; }
    if (message.kind !== "sable.sdk.server.demo_state") return;
    clearTimeout(timer);
    socket.close(1000, "live gateway verified");
    resolve(message);
  });
});
if (demoState.phase !== "idle" || demoState.canStart !== true) {
  throw new Error("Control socket did not expose an idle, startable guided demo");
}

console.log(JSON.stringify({
  ok: true,
  publicGateway: publicUrl,
  catalogVersionId: catalog.manifest.catalogVersionId,
  modules: catalog.demoProfile.modules.length,
  demoPhase: demoState.phase,
  canStart: demoState.canStart,
}));
