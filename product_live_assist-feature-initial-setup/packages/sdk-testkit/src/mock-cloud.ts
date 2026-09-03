import {
  SDK_PROTOCOL_VERSION,
  SDK_TELEMETRY_SCHEMA_VERSION,
  type SdkBootstrapRequest,
  type SdkBootstrapResponse,
  type SdkClientMessage,
  type SdkServerCommand,
  type SdkTelemetryBatch,
  type SignedCatalogEnvelope,
} from "@sable/sdk-contracts";
import {
  createSignedCatalogFixture,
  type SignedCatalogFixture,
  type TestSdkCatalog,
} from "./catalog-fixtures.js";

export interface MockIdentityClaims {
  organizationId: string;
  productId: string;
  environmentId: string;
  roleProfileId: string;
  subject: string;
  origin: string;
}

export interface MockCloudRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface MockCloudFault {
  status: number;
  body: unknown;
}

export interface MockCloudOptions {
  baseUrl?: string;
  signedCatalog?: SignedCatalogFixture;
  identityToken?: string;
  claims?: Partial<MockIdentityClaims>;
  killed?: boolean;
  latencyMs?: number;
  commands?: SdkServerCommand[];
  faults?: Readonly<Record<string, MockCloudFault>>;
}

export type MockWebSocketFactory = (
  url: string | URL,
  protocols?: string | string[],
) => WebSocket;

export interface MockCloud {
  baseUrl: string;
  identityToken: string;
  sessionToken: string;
  requests: MockCloudRequest[];
  telemetry: SdkTelemetryBatch[];
  clientMessages: SdkClientMessage[];
  fetch: typeof fetch;
  webSocketFactory: MockWebSocketFactory;
  getCatalog(): TestSdkCatalog;
  getEnvelope(): SignedCatalogEnvelope;
  getSigningKeys(): SignedCatalogFixture["keys"];
  setCatalog(fixture: SignedCatalogFixture): void;
  setKilled(killed: boolean): void;
  enqueueCommand(command: SdkServerCommand): void;
  reset(): void;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function createMockIdentityToken(
  claims: Partial<MockIdentityClaims> = {},
): string {
  const complete: MockIdentityClaims & { issuedAt: number; expiresAt: number } = {
    organizationId: "org-fixture",
    productId: "product-fixture",
    environmentId: "staging",
    roleProfileId: "member",
    subject: "user-fixture",
    origin: "https://client.fixture.test",
    issuedAt: 1_786_665_600,
    expiresAt: 4_102_444_800,
    ...claims,
  };
  // Deliberately opaque test data, not a production JWT implementation.
  return `mock-identity.${base64UrlJson(complete)}.fixture-signature`;
}

export function createMockBootstrapRequest(
  identityToken: string,
  overrides: Partial<SdkBootstrapRequest> = {},
): SdkBootstrapRequest {
  const base: SdkBootstrapRequest = {
    kind: "sable.sdk.bootstrap.request",
    schemaVersion: SDK_PROTOCOL_VERSION,
    requestId: "bootstrap-request-fixture",
    installationId: "installation-fixture",
    identityToken,
    sdk: {
      version: "0.1.0",
      protocolVersion: SDK_PROTOCOL_VERSION,
      distribution: "npm",
    },
    page: {
      origin: "https://client.fixture.test",
      url: "https://client.fixture.test/semantic",
      locale: "en-US",
      timezone: "UTC",
    },
    capabilities: {
      domObservation: true,
      shadowDom: true,
      sameOriginFrames: true,
      frameBridge: false,
      registeredTools: [],
      voice: false,
      screenshots: false,
    },
  };
  return {
    ...base,
    ...overrides,
    sdk: { ...base.sdk, ...overrides.sdk },
    page: { ...base.page, ...overrides.page },
    capabilities: { ...base.capabilities, ...overrides.capabilities },
  };
}

export function createMockTelemetryBatch(
  events: SdkTelemetryBatch["events"] = [],
): SdkTelemetryBatch {
  return {
    kind: "sable.sdk.telemetry_batch",
    schemaVersion: SDK_TELEMETRY_SCHEMA_VERSION,
    batchId: "telemetry-batch-fixture",
    sessionId: "sdk-session-fixture",
    sentAt: "2026-08-14T00:01:00.000Z",
    events,
  };
}

export function createMockRunJourneyCommand(
  overrides: Partial<Extract<SdkServerCommand, { kind: "sable.sdk.server.run_journey" }>> = {},
): Extract<SdkServerCommand, { kind: "sable.sdk.server.run_journey" }> {
  return {
    kind: "sable.sdk.server.run_journey",
    schemaVersion: SDK_PROTOCOL_VERSION,
    commandId: "command-fixture",
    sessionId: "sdk-session-fixture",
    sentAt: "2026-08-14T00:01:00.000Z",
    turnId: "turn-fixture",
    catalogVersionId: "catalog-fixture-v1",
    journeyId: "create-project",
    inputs: { projectName: "Northstar" },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function safeHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = key.toLowerCase() === "authorization" ? "[redacted]" : value;
  });
  return result;
}

async function readBody(request: Request): Promise<unknown> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const text = await request.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  return authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
}

type WebSocketListener = (event: Event) => void;

class FixtureWebSocket {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readonly binaryType = "blob";
  readonly bufferedAmount = 0;
  readonly extensions = "";
  readonly protocol: string;
  readyState = this.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  private listeners = new Map<string, Set<WebSocketListener>>();

  constructor(
    readonly url: string,
    protocol: string,
    private readonly clientMessages: SdkClientMessage[],
    private readonly pendingCommands: SdkServerCommand[],
  ) {
    this.protocol = protocol;
    queueMicrotask(() => {
      this.readyState = this.OPEN;
      this.dispatch("open", new Event("open"));
      this.flushCommands();
    });
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== this.OPEN) throw new Error("Mock WebSocket is not open");
    const text = typeof data === "string" ? data : String(data);
    this.clientMessages.push(JSON.parse(text) as SdkClientMessage);
  }

  close(code = 1000, reason = "fixture closed"): void {
    if (this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSED;
    const event = new Event("close") as CloseEvent;
    Object.defineProperties(event, {
      code: { value: code },
      reason: { value: reason },
      wasClean: { value: code === 1000 },
    });
    this.dispatch("close", event);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const callback: WebSocketListener =
      typeof listener === "function" ? listener : (event) => listener.handleEvent(event);
    const listeners = this.listeners.get(type) ?? new Set<WebSocketListener>();
    listeners.add(callback);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (typeof listener === "function") this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: Event): boolean {
    this.dispatch(event.type, event);
    return !event.defaultPrevented;
  }

  push(command: SdkServerCommand): void {
    this.pendingCommands.push(command);
    this.flushCommands();
  }

  private flushCommands(): void {
    if (this.readyState !== this.OPEN) return;
    while (this.pendingCommands.length) {
      const command = this.pendingCommands.shift()!;
      this.dispatch(
        "message",
        new MessageEvent("message", { data: JSON.stringify(command) }),
      );
    }
  }

  private dispatch(type: string, event: Event): void {
    const property = this[`on${type}` as "onopen"] as ((event: Event) => void) | null;
    property?.(event);
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

export function createMockCloud(options: MockCloudOptions = {}): MockCloud {
  const baseUrl = (options.baseUrl ?? "https://sdk-api.fixture.test").replace(/\/$/, "");
  const websocketBaseUrl = baseUrl.replace(/^http/, "ws");
  const claims: MockIdentityClaims = {
    organizationId: "org-fixture",
    productId: "product-fixture",
    environmentId: "staging",
    roleProfileId: "member",
    subject: "user-fixture",
    origin: "https://client.fixture.test",
    ...options.claims,
  };
  const identityToken = options.identityToken ?? createMockIdentityToken(claims);
  const sessionToken = "mock-sdk-session-token";
  const socketTicket = "one-time-socket-ticket";
  const requests: MockCloudRequest[] = [];
  const telemetry: SdkTelemetryBatch[] = [];
  const clientMessages: SdkClientMessage[] = [];
  const commands = [...(options.commands ?? [])];
  const sockets = new Set<FixtureWebSocket>();
  let socketTicketConsumed = false;
  let signedCatalog =
    options.signedCatalog ??
    createSignedCatalogFixture({
      manifest: {
        organizationId: claims.organizationId,
        productId: claims.productId,
        environmentId: claims.environmentId,
        roleProfileId: claims.roleProfileId,
      },
    });
  let killed = options.killed ?? false;

  const mockFetch: typeof fetch = async (input, init) => {
    const inputUrl =
      typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const absoluteUrl = new URL(inputUrl, `${baseUrl}/`).toString();
    const request =
      input instanceof Request ? new Request(input, init) : new Request(absoluteUrl, init);
    const url = new URL(request.url);
    const body = await readBody(request.clone());
    requests.push({
      method: request.method,
      path: `${url.pathname}${url.search}`,
      headers: safeHeaders(request.headers),
      body,
    });

    if (options.latencyMs && options.latencyMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, options.latencyMs));
    }

    const fault = options.faults?.[`${request.method} ${url.pathname}`];
    if (fault) return jsonResponse(fault.body, fault.status);

    if (request.method === "POST" && url.pathname === "/api/v3/sdk/sessions") {
      const posted = body as Partial<SdkBootstrapRequest> | undefined;
      if (posted?.identityToken !== identityToken) {
        return jsonResponse(
          { error: { code: "INVALID_IDENTITY", message: "Identity token is invalid" } },
          401,
        );
      }
      if (
        posted.kind !== "sable.sdk.bootstrap.request" ||
        posted.schemaVersion !== SDK_PROTOCOL_VERSION ||
        typeof posted.requestId !== "string" ||
        !posted.requestId ||
        typeof posted.installationId !== "string" ||
        !posted.installationId
      ) {
        return jsonResponse(
          { error: { code: "INVALID_REQUEST", message: "Bootstrap contract is invalid" } },
          400,
        );
      }
      if (posted.page?.origin !== claims.origin) {
        return jsonResponse(
          { error: { code: "ORIGIN_MISMATCH", message: "Page origin is not authorized" } },
          403,
        );
      }
      const response: SdkBootstrapResponse = {
        kind: "sable.sdk.bootstrap.response",
        schemaVersion: SDK_PROTOCOL_VERSION,
        requestId: posted.requestId,
        serverTime: "2026-08-14T00:00:00.000Z",
        session: {
          kind: "sable.sdk.session",
          schemaVersion: SDK_PROTOCOL_VERSION,
          sessionId: "sdk-session-fixture",
          continuityId: "continuity-fixture",
          installationId: posted.installationId,
          organizationId: claims.organizationId,
          productId: claims.productId,
          environmentId: claims.environmentId,
          roleProfileId: claims.roleProfileId,
          userId: claims.subject,
          origin: claims.origin,
          catalogVersionId: signedCatalog.catalog.manifest.catalogVersionId,
          sessionToken,
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        catalog: {
          kind: "remote",
          url: `${baseUrl}/api/v3/sdk/catalog`,
          digest: signedCatalog.envelope.digest,
          keyId: signedCatalog.envelope.signature.keyId,
        },
        transport: {
          websocketUrl: `${websocketBaseUrl}/ws/sdk`,
          oneTimeTicket: socketTicket,
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        killSwitch: {
          disabled: killed,
          ...(killed ? { reason: "Disabled by the fixture control plane" } : {}),
        },
      };
      socketTicketConsumed = false;
      return jsonResponse(response);
    }

    if (
      request.method === "GET" &&
      url.pathname === "/api/v3/sdk/catalog"
    ) {
      if (bearerToken(request) !== sessionToken) {
        return jsonResponse(
          { error: { code: "INVALID_SESSION", message: "Session token is invalid" } },
          401,
        );
      }
      return jsonResponse(signedCatalog.envelope);
    }

    if (request.method === "POST" && url.pathname === "/api/v3/sdk/events") {
      if (bearerToken(request) !== sessionToken) {
        return jsonResponse({ error: { code: "INVALID_SESSION" } }, 401);
      }
      const batch = body as SdkTelemetryBatch;
      if (
        batch.kind !== "sable.sdk.telemetry_batch" ||
        batch.schemaVersion !== SDK_TELEMETRY_SCHEMA_VERSION
      ) {
        return jsonResponse({ error: { code: "INVALID_TELEMETRY" } }, 400);
      }
      telemetry.push(batch);
      return new Response(null, { status: 202 });
    }

    if (
      request.method === "DELETE" &&
      url.pathname === "/api/v3/sdk/session"
    ) {
      if (bearerToken(request) !== sessionToken) {
        return jsonResponse({ error: { code: "INVALID_SESSION" } }, 401);
      }
      return new Response(null, { status: 204 });
    }

    return jsonResponse(
      { error: { code: "NOT_FOUND", message: `${request.method} ${url.pathname}` } },
      404,
    );
  };

  const webSocketFactory: MockWebSocketFactory = (url, protocols) => {
    const protocolList = typeof protocols === "string" ? [protocols] : (protocols ?? []);
    const encodedTicket = Buffer.from(socketTicket, "utf8").toString("base64url");
    const expectedProtocol = `sable.ticket.${encodedTicket}`;
    if (protocolList.length !== 1 || protocolList[0] !== expectedProtocol) {
      throw new Error("Mock WebSocket requires exactly one encoded one-time-ticket protocol");
    }
    const expected = `${websocketBaseUrl}/ws/sdk`;
    if (String(url) !== expected) throw new Error(`Unexpected Mock WebSocket URL: ${String(url)}`);
    if (socketTicketConsumed) throw new Error("Mock WebSocket one-time ticket was already consumed");
    socketTicketConsumed = true;
    const socket = new FixtureWebSocket(expected, expectedProtocol, clientMessages, commands);
    sockets.add(socket);
    return socket as unknown as WebSocket;
  };

  return {
    baseUrl,
    identityToken,
    sessionToken,
    requests,
    telemetry,
    clientMessages,
    fetch: mockFetch,
    webSocketFactory,
    getCatalog: () => signedCatalog.catalog,
    getEnvelope: () => signedCatalog.envelope,
    getSigningKeys: () => signedCatalog.keys,
    setCatalog: (fixture) => {
      signedCatalog = fixture;
    },
    setKilled: (value) => {
      killed = value;
    },
    enqueueCommand: (command) => {
      if (sockets.size === 0) commands.push(command);
      else for (const socket of sockets) socket.push(command);
    },
    reset: () => {
      requests.length = 0;
      telemetry.length = 0;
      clientMessages.length = 0;
      commands.length = 0;
      for (const socket of sockets) socket.close();
      sockets.clear();
    },
  };
}
