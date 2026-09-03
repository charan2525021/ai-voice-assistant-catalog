import {
  SDK_PROTOCOL_VERSION,
  validateSdkBootstrapResponse,
  type SdkBootstrapRequest,
  type SdkBootstrapResponse,
} from "@sable/sdk-contracts";
import { SableSdkError } from "./errors.js";
import { isRecord, randomId } from "./utils.js";
import { SDK_VERSION } from "./version.js";

export type TokenProvider = (signal?: AbortSignal) => Promise<string> | string;

export interface BootstrapOptions {
  apiBaseUrl: string;
  installationId: string;
  tokenProvider: TokenProvider;
  distribution: "script" | "npm";
  registeredTools: string[];
  voice: boolean;
  frameBridge: boolean;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}

function valid(result: unknown): boolean {
  return isRecord(result) && result.ok === true;
}

function safeApiBase(value: string): URL {
  const parsed = new URL(value, globalThis.location?.href);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("apiBaseUrl must not contain credentials, query, or fragment");
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))) {
    throw new Error("apiBaseUrl must use HTTPS except on localhost");
  }
  return parsed;
}

function redactedPageUrl(value: string): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, "[redacted]");
  if (/(?:access_token|id_token|code|secret|password|session|auth)=/i.test(url.hash)) url.hash = "#[redacted]";
  return url.toString();
}

export class SessionBootstrapClient {
  private readonly fetcher: typeof fetch;
  private readonly apiBase: URL;

  constructor(private readonly options: BootstrapOptions) {
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.apiBase = safeApiBase(options.apiBaseUrl);
  }

  async create(): Promise<SdkBootstrapResponse> {
    const requestId = randomId("bootstrap");
    const identityToken = await this.options.tokenProvider(this.options.signal);
    if (!identityToken || identityToken.length > 16_384) throw new SableSdkError("AUTHENTICATION_FAILED", "Token provider did not return a valid short-lived identity token");
    const locale = globalThis.navigator?.language || "en";
    const request: SdkBootstrapRequest = {
      kind: "sable.sdk.bootstrap.request",
      schemaVersion: SDK_PROTOCOL_VERSION,
      requestId,
      installationId: this.options.installationId,
      identityToken,
      sdk: { version: SDK_VERSION, protocolVersion: SDK_PROTOCOL_VERSION, distribution: this.options.distribution },
      page: {
        origin: globalThis.location.origin,
        url: redactedPageUrl(globalThis.location.href),
        locale,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        referrerOrigin: (() => {
          try { return document.referrer ? new URL(document.referrer).origin : undefined; } catch { return undefined; }
        })(),
      },
      capabilities: {
        domObservation: true,
        shadowDom: true,
        sameOriginFrames: true,
        frameBridge: this.options.frameBridge,
        registeredTools: [...new Set(this.options.registeredTools)].sort(),
        voice: this.options.voice,
        screenshots: false,
      },
    };
    const response = await this.fetcher(new URL("api/v3/sdk/sessions", this.apiBase).toString(), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      body: JSON.stringify(request),
      signal: this.options.signal,
    });
    if (!response.ok) throw new SableSdkError("AUTHENTICATION_FAILED", `SDK session bootstrap failed with ${response.status}`);
    const value: unknown = await response.json();
    if (!valid(validateSdkBootstrapResponse(value))) throw new SableSdkError("AUTHENTICATION_FAILED", "SDK session bootstrap returned an invalid response");
    const bootstrap = value as SdkBootstrapResponse;
    if (bootstrap.requestId !== requestId || bootstrap.session.installationId !== this.options.installationId) {
      throw new SableSdkError("AUTHENTICATION_FAILED", "SDK session bootstrap response did not match this request");
    }
    if (bootstrap.session.origin !== globalThis.location.origin) {
      throw new SableSdkError("AUTHENTICATION_FAILED", "SDK session was issued for a different browser origin");
    }
    if (Date.parse(bootstrap.session.expiresAt) <= Date.now()) throw new SableSdkError("AUTHENTICATION_FAILED", "SDK session was already expired");
    if (bootstrap.killSwitch.disabled) throw new SableSdkError("POLICY_BLOCKED", bootstrap.killSwitch.reason || "SDK is disabled for this installation");
    return bootstrap;
  }

  async close(sessionToken: string): Promise<void> {
    await this.fetcher(new URL("api/v3/sdk/session", this.apiBase).toString(), {
      method: "DELETE",
      headers: { authorization: `Bearer ${sessionToken}` },
      credentials: "omit",
      cache: "no-store",
      keepalive: true,
    }).catch(() => undefined);
  }
}
