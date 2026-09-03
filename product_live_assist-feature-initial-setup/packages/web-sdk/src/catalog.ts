import {
  assertValidSdkCatalog,
  canonicalizeJson,
  validateSignedCatalogEnvelope,
  type CatalogDigest,
  type SdkCatalog,
  type SignedCatalogEnvelope,
} from "@sable/sdk-contracts";
import { SableSdkError } from "./errors.js";
import { base64UrlToBytes, bytesToBase64Url, isRecord } from "./utils.js";
import { SDK_VERSION, versionIsSupported } from "./version.js";

export interface CatalogTrustKey {
  keyId: string;
  algorithm: "ES256" | "Ed25519";
  jwk: JsonWebKey;
}

export interface CatalogScope {
  organizationId: string;
  productId: string;
  environmentId: string;
  roleProfileId: string;
  origin: string;
}

export type CatalogSource =
  | { kind: "inline"; envelope: SignedCatalogEnvelope }
  | { kind: "remote"; url: string; digest: CatalogDigest; keyId: string };

export interface CatalogCacheEntry {
  envelope: SignedCatalogEnvelope;
  verifiedAt: string;
}

export interface CatalogCache {
  get(key: string): Promise<CatalogCacheEntry | undefined> | CatalogCacheEntry | undefined;
  set(key: string, entry: CatalogCacheEntry): Promise<void> | void;
  delete(key: string): Promise<void> | void;
  clear(): Promise<void> | void;
}

export class MemoryCatalogCache implements CatalogCache {
  private entries = new Map<string, CatalogCacheEntry>();
  get(key: string): CatalogCacheEntry | undefined { return this.entries.get(key); }
  set(key: string, entry: CatalogCacheEntry): void { this.entries.set(key, entry); }
  delete(key: string): void { this.entries.delete(key); }
  clear(): void { this.entries.clear(); }
}

export interface CatalogLoadOptions {
  source: CatalogSource;
  sessionToken?: string;
  expectedScope: CatalogScope;
  expectedCatalogVersionId?: string;
  signal?: AbortSignal;
}

export interface LoadedCatalog {
  catalog: SdkCatalog;
  envelope: SignedCatalogEnvelope;
  source: "network" | "cache";
}

function cacheKey(source: CatalogSource): string {
  return source.kind === "inline"
    ? source.envelope.payload.manifest.catalogVersionId
    : `${source.keyId}:${source.digest.value}`;
}

function validationPassed(result: unknown): boolean {
  return isRecord(result) ? result.ok === true : result === true;
}

async function importTrustKey(key: CatalogTrustKey): Promise<CryptoKey> {
  if (!globalThis.crypto?.subtle) throw new SableSdkError("CATALOG_UNTRUSTED", "This browser cannot verify signed catalogs");
  try {
    return key.algorithm === "ES256"
      ? await globalThis.crypto.subtle.importKey("jwk", key.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"])
      : await globalThis.crypto.subtle.importKey("jwk", key.jwk, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    throw new SableSdkError("CATALOG_UNTRUSTED", `Catalog trust key ${key.keyId} is invalid`);
  }
}

/** Downloads only data, validates its scope/version, then verifies its digest and trusted signature. */
export class SignedCatalogClient {
  private readonly keys = new Map<string, CatalogTrustKey>();

  constructor(
    trustKeys: readonly CatalogTrustKey[],
    private readonly cache: CatalogCache = new MemoryCatalogCache(),
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    for (const key of trustKeys) this.keys.set(key.keyId, key);
  }

  async load(options: CatalogLoadOptions): Promise<LoadedCatalog> {
    const key = cacheKey(options.source);
    const cached = await this.cache.get(key);
    if (cached) {
      try {
        await this.verify(cached.envelope, options);
        return { catalog: cached.envelope.payload, envelope: cached.envelope, source: "cache" };
      } catch {
        await this.cache.delete(key);
      }
    }

    const envelope = options.source.kind === "inline"
      ? options.source.envelope
      : await this.download(options.source.url, options.sessionToken, options.signal);
    if (options.source.kind === "remote") {
      if (envelope.digest.value !== options.source.digest.value || envelope.signature.keyId !== options.source.keyId) {
        throw new SableSdkError("CATALOG_UNTRUSTED", "Downloaded catalog does not match the bootstrap descriptor");
      }
    }
    await this.verify(envelope, options);
    await this.cache.set(key, { envelope, verifiedAt: new Date().toISOString() });
    return { catalog: envelope.payload, envelope, source: "network" };
  }

  private async download(url: string, token: string | undefined, signal?: AbortSignal): Promise<SignedCatalogEnvelope> {
    const parsed = new URL(url, globalThis.location?.href);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))) {
      throw new SableSdkError("CATALOG_UNTRUSTED", "Catalog URLs must use HTTPS except on localhost");
    }
    const response = await this.fetcher(parsed.toString(), {
      method: "GET",
      headers: token ? { authorization: `Bearer ${token}`, accept: "application/json" } : { accept: "application/json" },
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal,
    });
    if (!response.ok) throw new SableSdkError("CATALOG_INVALID", `Catalog request failed with ${response.status}`);
    const value: unknown = await response.json();
    const validated = validateSignedCatalogEnvelope(value);
    if (!validationPassed(validated)) throw new SableSdkError("CATALOG_INVALID", "Catalog envelope failed structural validation");
    return value as SignedCatalogEnvelope;
  }

  private async verify(envelope: SignedCatalogEnvelope, options: CatalogLoadOptions): Promise<void> {
    const validation = validateSignedCatalogEnvelope(envelope);
    if (!validationPassed(validation)) throw new SableSdkError("CATALOG_INVALID", "Catalog envelope failed structural validation");
    assertValidSdkCatalog(envelope.payload);
    const bytes = new TextEncoder().encode(canonicalizeJson(envelope.payload));
    const digest = bytesToBase64Url(await globalThis.crypto.subtle.digest("SHA-256", bytes));
    if (digest !== envelope.digest.value) throw new SableSdkError("CATALOG_UNTRUSTED", "Catalog digest did not match its payload");

    const trust = this.keys.get(envelope.signature.keyId);
    if (!trust || trust.algorithm !== envelope.signature.algorithm) {
      throw new SableSdkError("CATALOG_UNTRUSTED", `Catalog signing key ${envelope.signature.keyId} is not trusted by this installation`);
    }
    const cryptoKey = await importTrustKey(trust);
    const algorithm: AlgorithmIdentifier | EcdsaParams = trust.algorithm === "ES256"
      ? { name: "ECDSA", hash: "SHA-256" }
      : { name: "Ed25519" };
    const rawSignature = base64UrlToBytes(envelope.signature.value);
    const signatureBytes = Uint8Array.from(rawSignature).buffer;
    const verified = await globalThis.crypto.subtle.verify(algorithm, cryptoKey, signatureBytes, bytes);
    if (!verified) throw new SableSdkError("CATALOG_UNTRUSTED", "Catalog signature verification failed");

    const manifest = envelope.payload.manifest;
    if (!versionIsSupported(SDK_VERSION, manifest.supportedSdk.minimum, manifest.supportedSdk.maximum)) {
      throw new SableSdkError("CATALOG_INCOMPATIBLE", `Catalog supports SDK ${manifest.supportedSdk.minimum}–${manifest.supportedSdk.maximum ?? "latest"}; running ${SDK_VERSION}`);
    }
    if (manifest.expiresAt && Date.parse(manifest.expiresAt) <= Date.now()) {
      throw new SableSdkError("CATALOG_INCOMPATIBLE", "Catalog has expired");
    }
    if (options.expectedCatalogVersionId && manifest.catalogVersionId !== options.expectedCatalogVersionId) {
      throw new SableSdkError("CATALOG_UNTRUSTED", "Catalog version does not match the pinned SDK session");
    }
    const expected = options.expectedScope;
    const mismatches = [
      ["organization", manifest.organizationId, expected.organizationId],
      ["product", manifest.productId, expected.productId],
      ["environment", manifest.environmentId, expected.environmentId],
      ["role", manifest.roleProfileId, expected.roleProfileId],
    ].filter(([, actual, wanted]) => actual !== wanted);
    if (mismatches.length) throw new SableSdkError("CATALOG_UNTRUSTED", `Catalog scope mismatch: ${mismatches.map(([name]) => name).join(", ")}`);
    if (new URL(expected.origin).origin !== globalThis.location.origin) {
      throw new SableSdkError("CATALOG_UNTRUSTED", "SDK session origin does not match the current page");
    }
  }
}
