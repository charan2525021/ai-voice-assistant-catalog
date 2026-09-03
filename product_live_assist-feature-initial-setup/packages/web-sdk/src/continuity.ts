import type { JsonValue, SessionDescriptor } from "@sable/sdk-contracts";
import { randomId } from "./utils.js";

export const CONTINUITY_SCHEMA_VERSION = 1 as const;
export const DEFAULT_CONTINUITY_IDLE_TTL_MS = 30 * 60 * 1_000;
export const DEFAULT_CONTINUITY_ABSOLUTE_TTL_MS = 8 * 60 * 60 * 1_000;
export const DEFAULT_CONTINUITY_MAX_BYTES = 256 * 1_024;
export const DEFAULT_CONTINUITY_MAX_MESSAGES = 100;
export const DEFAULT_REASONING_MESSAGES = 12;

export interface ContinuityTranscriptMessage {
  key: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

export interface ContinuityJourneyCheckpoint {
  journeyId: string;
  journeyVersion: number;
  turnId: string;
  originalRequest: string;
  inputs: Record<string, JsonValue>;
  completedStepIds: string[];
  nextStepId: string;
  nextStepIndex: number;
  navigationStepId: string;
  destinationUrl: string;
  expectedScreenIds: string[];
  /** Preserves a bounded dynamic action across a document reload. */
  stopAfterStepId?: string;
}

export interface ContinuityCatalogNavigationCheckpoint {
  turnId: string;
  originalRequest: string;
  sourceScreenId: string;
  controlId: string;
  targetScreenId: string;
  destinationUrl: string;
}

export interface ContinuitySnapshot {
  kind: "sable.browser_continuity";
  schemaVersion: typeof CONTINUITY_SCHEMA_VERSION;
  continuityId: string;
  installationId: string;
  organizationId: string;
  productId: string;
  environmentId: string;
  userId: string;
  roleProfileId: string;
  catalogVersionId: string;
  origin: string;
  startedAt: string;
  updatedAt: string;
  /** Last server revision incorporated into this browser cache. */
  serverRevision?: number;
  transcript: ContinuityTranscriptMessage[];
  journey?: ContinuityJourneyCheckpoint;
  catalogNavigation?: ContinuityCatalogNavigationCheckpoint;
}

export interface ContinuityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const memoryFallback = new Map<string, string>();
const fallbackContinuityStorage: ContinuityStorage = {
  getItem: (key) => memoryFallback.get(key) ?? null,
  setItem: (key, value) => { memoryFallback.set(key, value); },
  removeItem: (key) => { memoryFallback.delete(key); },
};

export interface ContinuityOptions {
  storage?: ContinuityStorage;
  idleTtlMs?: number;
  absoluteTtlMs?: number;
  maximumBytes?: number;
  maximumMessages?: number;
}

export type ContinuityClearReason = "logout" | "expired" | "scope_changed" | "catalog_changed" | "invalid" | "user" | "storage_failed";

export interface ContinuityScope {
  installationId: string;
  organizationId: string;
  productId: string;
  environmentId: string;
  userId: string;
  roleProfileId: string;
  catalogVersionId: string;
  origin: string;
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value ?? fallback, maximum));
}

function validDate(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isTranscriptMessage(value: unknown): value is ContinuityTranscriptMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.key === "string" && item.key.length <= 256
    && (item.role === "user" || item.role === "assistant")
    && typeof item.text === "string" && item.text.length > 0 && item.text.length <= 10_000
    && typeof item.createdAt === "string" && validDate(item.createdAt) !== undefined;
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 10) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 100 && value.every((item) => isJsonValue(item, depth + 1));
  return !!value && typeof value === "object" && Object.keys(value).length <= 100
    && Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

function isJourney(value: unknown): value is ContinuityJourneyCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return ["journeyId", "turnId", "originalRequest", "nextStepId", "navigationStepId", "destinationUrl"].every((key) => typeof item[key] === "string")
    && (item.stopAfterStepId === undefined || typeof item.stopAfterStepId === "string")
    && typeof item.journeyVersion === "number" && Number.isInteger(item.journeyVersion) && item.journeyVersion > 0
    && typeof item.nextStepIndex === "number" && Number.isInteger(item.nextStepIndex) && item.nextStepIndex >= 0
    && Array.isArray(item.completedStepIds) && item.completedStepIds.length <= 500 && item.completedStepIds.every((id) => typeof id === "string")
    && Array.isArray(item.expectedScreenIds) && item.expectedScreenIds.length > 0 && item.expectedScreenIds.length <= 20 && item.expectedScreenIds.every((id) => typeof id === "string")
    && isJsonValue(item.inputs);
}

function isCatalogNavigation(value: unknown): value is ContinuityCatalogNavigationCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return ["turnId", "originalRequest", "sourceScreenId", "controlId", "targetScreenId", "destinationUrl"]
    .every((key) => typeof item[key] === "string" && (item[key] as string).length > 0);
}

function parseSnapshot(raw: string): ContinuitySnapshot | undefined {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || value.kind !== "sable.browser_continuity" || value.schemaVersion !== CONTINUITY_SCHEMA_VERSION) return undefined;
    const required = ["continuityId", "installationId", "organizationId", "productId", "environmentId", "userId", "roleProfileId", "catalogVersionId", "origin", "startedAt", "updatedAt"];
    if (!required.every((key) => typeof value[key] === "string")) return undefined;
    if (validDate(value.startedAt as string) === undefined || validDate(value.updatedAt as string) === undefined) return undefined;
    if (!Array.isArray(value.transcript) || !value.transcript.every(isTranscriptMessage)) return undefined;
    if (value.serverRevision !== undefined && (typeof value.serverRevision !== "number" || !Number.isInteger(value.serverRevision) || value.serverRevision < 0)) return undefined;
    if (value.journey !== undefined && !isJourney(value.journey)) return undefined;
    if (value.catalogNavigation !== undefined && !isCatalogNavigation(value.catalogNavigation)) return undefined;
    return value as unknown as ContinuitySnapshot;
  } catch { return undefined; }
}

export function scopeFromSession(session: SessionDescriptor): ContinuityScope {
  return {
    installationId: session.installationId,
    organizationId: session.organizationId,
    productId: session.productId,
    environmentId: session.environmentId,
    userId: session.userId,
    roleProfileId: session.roleProfileId,
    catalogVersionId: session.catalogVersionId,
    origin: session.origin,
  };
}

function sameScope(snapshot: ContinuitySnapshot, scope: ContinuityScope): boolean {
  return snapshot.installationId === scope.installationId
    && snapshot.organizationId === scope.organizationId
    && snapshot.productId === scope.productId
    && snapshot.environmentId === scope.environmentId
    && snapshot.userId === scope.userId
    && snapshot.roleProfileId === scope.roleProfileId
    && snapshot.catalogVersionId === scope.catalogVersionId
    && snapshot.origin === scope.origin;
}

/** A bounded, fail-closed continuity store. Storage failure never breaks the host page. */
export class BrowserContinuityStore {
  private readonly key: string;
  private readonly idleTtlMs: number;
  private readonly absoluteTtlMs: number;
  private readonly maximumBytes: number;
  private readonly maximumMessages: number;
  private snapshot?: ContinuitySnapshot;
  private disabled = false;

  constructor(
    private readonly scope: ContinuityScope,
    private readonly storage: ContinuityStorage,
    options: ContinuityOptions = {},
    private readonly preferredContinuityId?: string,
  ) {
    this.key = `sable:continuity:${scope.installationId}:v${CONTINUITY_SCHEMA_VERSION}`;
    this.idleTtlMs = bounded(options.idleTtlMs, DEFAULT_CONTINUITY_IDLE_TTL_MS, 60_000, 24 * 60 * 60 * 1_000);
    this.absoluteTtlMs = bounded(options.absoluteTtlMs, DEFAULT_CONTINUITY_ABSOLUTE_TTL_MS, this.idleTtlMs, 24 * 60 * 60 * 1_000);
    this.maximumBytes = bounded(options.maximumBytes, DEFAULT_CONTINUITY_MAX_BYTES, 16 * 1_024, 1_024 * 1_024);
    this.maximumMessages = bounded(options.maximumMessages, DEFAULT_CONTINUITY_MAX_MESSAGES, 1, 500);
  }

  load(now = Date.now()): { snapshot?: ContinuitySnapshot; cleared?: ContinuityClearReason } {
    let raw: string | null;
    try { raw = this.storage.getItem(this.key); }
    catch { this.disabled = true; return { cleared: "storage_failed" }; }
    if (!raw) return {};
    const snapshot = parseSnapshot(raw);
    if (!snapshot) { this.clear("invalid"); return { cleared: "invalid" }; }
    if (!sameScope(snapshot, this.scope)) {
      const reason: ContinuityClearReason = snapshot.catalogVersionId !== this.scope.catalogVersionId ? "catalog_changed" : "scope_changed";
      this.clear(reason);
      return { cleared: reason };
    }
    if (this.preferredContinuityId && snapshot.continuityId !== this.preferredContinuityId) {
      this.clear("scope_changed");
      return { cleared: "scope_changed" };
    }
    const started = Date.parse(snapshot.startedAt);
    const updated = Date.parse(snapshot.updatedAt);
    if (now - updated > this.idleTtlMs || now - started > this.absoluteTtlMs || updated > now + 60_000) {
      this.clear("expired");
      return { cleared: "expired" };
    }
    this.snapshot = structuredClone(snapshot);
    return { snapshot: structuredClone(snapshot) };
  }

  replace(snapshot: ContinuitySnapshot, now = Date.now()): boolean {
    if (!sameScope(snapshot, this.scope)) return false;
    this.snapshot = { ...structuredClone(snapshot), updatedAt: new Date(now).toISOString() };
    return this.persist();
  }

  ensure(now = Date.now()): ContinuitySnapshot {
    this.snapshot ??= {
      kind: "sable.browser_continuity",
      schemaVersion: CONTINUITY_SCHEMA_VERSION,
      continuityId: this.preferredContinuityId ?? randomId("continuity"),
      ...this.scope,
      startedAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      transcript: [],
    };
    return this.snapshot;
  }

  messages(): ContinuityTranscriptMessage[] {
    return structuredClone(this.snapshot?.transcript ?? []);
  }

  /** Replaces the browser cache with the server-authoritative transcript. */
  replaceTranscript(transcript: ContinuityTranscriptMessage[], serverRevision: number, now = Date.now()): void {
    const snapshot = this.ensure(now);
    snapshot.transcript = structuredClone(transcript).slice(-this.maximumMessages);
    snapshot.serverRevision = serverRevision;
    snapshot.updatedAt = new Date(now).toISOString();
    this.persist();
  }

  appendMessage(message: Omit<ContinuityTranscriptMessage, "createdAt"> & { createdAt?: string }, now = Date.now()): void {
    const text = message.text.trim().slice(0, 10_000);
    if (!text) return;
    const snapshot = this.ensure(now);
    const item: ContinuityTranscriptMessage = { ...message, text, createdAt: message.createdAt ?? new Date(now).toISOString() };
    const existing = snapshot.transcript.findIndex((candidate) => candidate.key === item.key);
    if (existing >= 0) snapshot.transcript[existing] = item;
    else snapshot.transcript.push(item);
    snapshot.transcript = snapshot.transcript.slice(-this.maximumMessages);
    snapshot.updatedAt = new Date(now).toISOString();
    this.persist();
  }

  setJourney(journey: ContinuityJourneyCheckpoint | undefined, now = Date.now()): void {
    const snapshot = this.ensure(now);
    snapshot.journey = journey ? structuredClone(journey) : undefined;
    snapshot.updatedAt = new Date(now).toISOString();
    this.persist();
  }

  setCatalogNavigation(navigation: ContinuityCatalogNavigationCheckpoint | undefined, now = Date.now()): void {
    const snapshot = this.ensure(now);
    snapshot.catalogNavigation = navigation ? structuredClone(navigation) : undefined;
    snapshot.updatedAt = new Date(now).toISOString();
    this.persist();
  }

  current(): ContinuitySnapshot | undefined {
    return this.snapshot ? structuredClone(this.snapshot) : undefined;
  }

  clear(_reason: ContinuityClearReason = "user"): void {
    this.snapshot = undefined;
    try { this.storage.removeItem(this.key); } catch { this.disabled = true; }
  }

  private persist(): boolean {
    if (this.disabled || !this.snapshot) return false;
    let encoded = JSON.stringify(this.snapshot);
    while (encoded.length > this.maximumBytes && this.snapshot.transcript.length > 1) {
      this.snapshot.transcript.shift();
      encoded = JSON.stringify(this.snapshot);
    }
    if (encoded.length > this.maximumBytes) {
      this.snapshot.journey = undefined;
      encoded = JSON.stringify(this.snapshot);
    }
    if (encoded.length > this.maximumBytes) return false;
    try { this.storage.setItem(this.key, encoded); return true; }
    catch { this.disabled = true; return false; }
  }
}

export function defaultContinuityStorage(): ContinuityStorage {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return fallbackContinuityStorage;
    return storage;
  } catch { return fallbackContinuityStorage; }
}

export function attachHandoffToken(destinationUrl: string, token: string): string {
  const destination = new URL(destinationUrl);
  const originalHash = destination.hash.startsWith("#") ? destination.hash.slice(1) : destination.hash;
  const fragment = new URLSearchParams({ __sable_handoff: token });
  if (originalHash) fragment.set("__sable_hash", originalHash);
  destination.hash = fragment.toString();
  return destination.toString();
}

/** Reads a one-time cross-origin code and removes it before routers or analytics can retain it. */
export function takeHandoffToken(
  location: Pick<Location, "href"> = globalThis.location,
  history: Pick<History, "replaceState"> = globalThis.history,
): string | undefined {
  try {
    const current = new URL(location.href);
    const fragment = new URLSearchParams(current.hash.startsWith("#") ? current.hash.slice(1) : current.hash);
    const token = fragment.get("__sable_handoff") ?? undefined;
    if (!token) return undefined;
    const originalHash = fragment.get("__sable_hash") ?? "";
    current.hash = originalHash;
    history.replaceState(null, "", current.toString());
    return token;
  } catch { return undefined; }
}

async function continuityRequest<T>(fetcher: typeof fetch, url: string, sessionToken: string, body: unknown): Promise<T> {
  const response = await fetcher(url, {
    method: "POST",
    headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "omit",
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Continuity handoff failed (${response.status})`);
  return response.json() as Promise<T>;
}

export async function createContinuityHandoff(
  apiBaseUrl: string,
  sessionToken: string,
  snapshot: ContinuitySnapshot,
  destinationUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const url = new URL("api/v3/sdk/handoffs", apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`).toString();
  const result = await continuityRequest<{ token: string }>(fetcher, url, sessionToken, { snapshot, destinationUrl });
  if (!result.token || result.token.length > 512) throw new Error("Continuity handoff returned an invalid token");
  return result.token;
}

export async function consumeContinuityHandoff(
  apiBaseUrl: string,
  sessionToken: string,
  token: string,
  destinationUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<ContinuitySnapshot> {
  const url = new URL("api/v3/sdk/handoffs/consume", apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`).toString();
  const result = await continuityRequest<{ snapshot: ContinuitySnapshot }>(fetcher, url, sessionToken, { token, destinationUrl });
  return result.snapshot;
}
