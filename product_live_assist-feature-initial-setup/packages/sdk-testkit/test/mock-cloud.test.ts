import assert from "node:assert/strict";
import test from "node:test";
import {
  validateSdkBootstrapRequest,
  validateSdkBootstrapResponse,
  validateSignedCatalogEnvelope,
} from "@sable/sdk-contracts";
import {
  createMockBootstrapRequest,
  createMockCloud,
  createMockRunJourneyCommand,
  createMockTelemetryBatch,
} from "../src/mock-cloud.js";

test("bootstraps a session and serves its pinned signed catalog", async () => {
  const cloud = createMockCloud();
  const request = createMockBootstrapRequest(cloud.identityToken);
  assert.equal(validateSdkBootstrapRequest(request).ok, true);
  const sessionResponse = await cloud.fetch("/api/v3/sdk/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  assert.equal(sessionResponse.status, 200);
  const session = (await sessionResponse.json()) as {
    kind: string;
    session: { sessionToken: string };
    catalog: { url: string };
  };
  assert.equal(validateSdkBootstrapResponse(session).ok, true);
  assert.equal(session.kind, "sable.sdk.bootstrap.response");
  assert.equal(session.session.sessionToken, cloud.sessionToken);

  const catalogResponse = await cloud.fetch(session.catalog.url, {
    headers: { authorization: `Bearer ${session.session.sessionToken}` },
  });
  assert.equal(catalogResponse.status, 200);
  const envelope = (await catalogResponse.json()) as {
    kind: string;
    payload: { manifest: { catalogId: string } };
  };
  assert.equal(validateSignedCatalogEnvelope(envelope).ok, true);
  assert.equal(envelope.kind, "sable.signed_catalog");
  assert.equal(envelope.payload.manifest.catalogId, cloud.getCatalog().manifest.catalogId);
  assert.equal(cloud.requests[1]!.headers.authorization, "[redacted]");
});

test("rejects bad identity and session credentials", async () => {
  const cloud = createMockCloud();
  const badIdentity = await cloud.fetch("/api/v3/sdk/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(createMockBootstrapRequest("wrong")),
  });
  assert.equal(badIdentity.status, 401);

  const badSession = await cloud.fetch(
    "/api/v3/sdk/catalog",
    { headers: { authorization: "Bearer wrong" } },
  );
  assert.equal(badSession.status, 401);
});

test("captures an exact telemetry batch", async () => {
  const cloud = createMockCloud();
  const authorization = { authorization: `Bearer ${cloud.sessionToken}` };
  const batch = createMockTelemetryBatch();
  const telemetryResponse = await cloud.fetch("/api/v3/sdk/events", {
    method: "POST",
    headers: { ...authorization, "content-type": "application/json" },
    body: JSON.stringify(batch),
  });
  assert.equal(telemetryResponse.status, 202);
  assert.deepEqual(cloud.telemetry, [batch]);
});

test("uses the exact WebSocket URL, subprotocols, and command shape", async () => {
  const command = createMockRunJourneyCommand();
  const cloud = createMockCloud({ commands: [command] });
  const bootstrapResponse = await cloud.fetch("/api/v3/sdk/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(createMockBootstrapRequest(cloud.identityToken)),
  });
  const bootstrap = (await bootstrapResponse.json()) as {
    transport: { websocketUrl: string; oneTimeTicket: string };
  };
  const encodedTicket = Buffer.from(bootstrap.transport.oneTimeTicket, "utf8").toString("base64url");
  const socket = cloud.webSocketFactory(bootstrap.transport.websocketUrl, [
    `sable.ticket.${encodedTicket}`,
  ]);
  const received = await new Promise<unknown>((resolve) => {
    socket.addEventListener("message", (event) => {
      resolve(JSON.parse((event as MessageEvent).data as string));
    });
  });
  assert.deepEqual(received, command);
});
