/**
 * Generates a self-contained runtime database and installation credential for
 * dynamic-mode acceptance testing. The runtime file only contains an
 * installation with `dynamicMode.enabled = true` and a minimal signed catalog
 * so the SDK bootstrap succeeds. Dynamic mode does not rely on catalog controls
 * or journeys; the LLM plans against the SDK's UIMap of the target page.
 *
 * Env (all optional):
 *   DYNAMIC_TEST_ORIGIN            Origin allowed to mount. Default
 *                                  http://localhost:5173.
 *   DYNAMIC_INSTALLATION_ID        Default "dynamic-installation".
 *   DYNAMIC_PRODUCT_ID             Default "dynamic-target".
 *   DYNAMIC_RUNTIME_FILE           Runtime file to write. Default
 *                                  ./data/dynamic-runtime.generated.json
 *   DYNAMIC_SECRETS_FILE           Secrets file for the test host. Default
 *                                  ./data/dynamic-secrets.generated.json
 *
 * Prints the generated broker secret so you can pass it to the host on start.
 */
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertValidSdkCatalog,
  canonicalizeJson,
  SDK_CATALOG_SCHEMA_VERSION,
  SDK_PROTOCOL_VERSION,
  type SdkCatalog,
  type SignedCatalogEnvelope,
} from "@sable/sdk-contracts";
import type { RuntimeBundle } from "@sable/runtime-core";
import { hashCredential } from "../src/security.js";

const origin = process.env.DYNAMIC_TEST_ORIGIN ?? "http://localhost:5173";
const installationId = process.env.DYNAMIC_INSTALLATION_ID ?? "dynamic-installation";
const productId = process.env.DYNAMIC_PRODUCT_ID ?? "dynamic-target";
const organizationId = process.env.DYNAMIC_ORGANIZATION_ID ?? "dynamic-tenant";
const environmentId = process.env.DYNAMIC_ENVIRONMENT_ID ?? "test";
const catalogVersionId = process.env.DYNAMIC_CATALOG_VERSION_ID ?? "dynamic-v1";
const roleProfileId = process.env.DYNAMIC_ROLE ?? "member";
const runtimeFile = resolve(process.env.DYNAMIC_RUNTIME_FILE ?? "./data/dynamic-runtime.generated.json");
const secretsFile = resolve(process.env.DYNAMIC_SECRETS_FILE ?? "./data/dynamic-secrets.generated.json");

const credential = `sable_dynamic_${randomBytes(24).toString("base64url")}`;
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const publicJwk = createPublicKey(privateKey).export({ format: "jwk" });
const keyId = `dynamic-${createHash("sha256").update(JSON.stringify(publicJwk)).digest("hex").slice(0, 12)}`;
const brokerSecret = randomBytes(24).toString("hex");

const catalog: SdkCatalog = {
  kind: "sable.sdk_catalog",
  schemaVersion: SDK_CATALOG_SCHEMA_VERSION,
  manifest: {
    kind: "sable.catalog.manifest",
    schemaVersion: SDK_CATALOG_SCHEMA_VERSION,
    protocolVersion: SDK_PROTOCOL_VERSION,
    catalogId: `${productId}-catalog`,
    catalogVersionId,
    version: 1,
    organizationId,
    productId,
    environmentId,
    roleProfileId,
    channel: "production",
    issuedAt: new Date().toISOString(),
    supportedSdk: { minimum: "0.1.0", maximum: "1.0.0" },
  },
  // Dynamic mode does not require screens, controls, or journeys — the LLM
  // reasons over the SDK's UIMap. The signed envelope still needs to validate,
  // so we emit empty collections.
  screens: [],
  controls: [],
  journeys: [],
  tools: [],
  privacyPolicy: {
    kind: "sable.catalog.privacy_policy",
    schemaVersion: SDK_CATALOG_SCHEMA_VERSION,
    defaultTextTreatment: "allow",
    screenshots: "disabled",
    excludedRoutes: [],
    rules: [
      { kind: "input_type", inputType: "password", action: "exclude" },
      { kind: "attribute", attribute: "data-private", action: "redact", replacement: "[private]" },
    ],
    maximumVisibleTextChars: 25_000,
    allowElementValues: false,
  },
  telemetryPolicy: {
    kind: "sable.catalog.telemetry_policy",
    schemaVersion: SDK_CATALOG_SCHEMA_VERSION,
    enabled: true,
    sampleRate: 1,
    allowedEvents: ["session.started", "session.stopped", "catalog.loaded", "action.completed", "sdk.error", "transport.state"],
    batchMaximumEvents: 50,
    flushIntervalMs: 5_000,
    includeVisibleText: false,
    includeElementValues: false,
  },
};

assertValidSdkCatalog(catalog);
const canonical = canonicalizeJson(catalog);
const digest = createHash("sha256").update(canonical).digest("base64url");
const signature = sign("sha256", Buffer.from(canonical), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
const envelope: SignedCatalogEnvelope = {
  kind: "sable.signed_catalog",
  schemaVersion: SDK_CATALOG_SCHEMA_VERSION,
  payload: catalog,
  digest: { algorithm: "SHA-256", encoding: "base64url", value: digest },
  signature: { kind: "sable.catalog_signature", algorithm: "ES256", keyId, encoding: "base64url", value: signature, signedAt: new Date().toISOString() },
};

const runtimeBundle: RuntimeBundle = {
  schemaVersion: 1,
  organizationId,
  productId,
  environmentId,
  catalogVersionId,
  catalogVersion: 1,
  generatedAt: catalog.manifest.issuedAt,
  journeys: [],
  salesPlays: [],
  screens: [],
  transitions: [],
  coverage: { weighted: 0, verified: 0, total: 0, unknown: 0 },
};

const installation = {
  installationId,
  organizationId,
  productId,
  environmentId,
  credentialHash: hashCredential(credential),
  allowedOrigins: [origin],
  allowedRoles: [roleProfileId],
  activeCatalogVersionId: catalogVersionId,
  dynamicMode: { enabled: true, autoConfirmLowRisk: true, maxIterationsPerTurn: 8 },
};

const database = {
  installations: [installation],
  catalogs: [envelope],
  runtimeBundles: [runtimeBundle],
  knowledge: [],
};

await mkdir("data", { recursive: true });
await writeFile(runtimeFile, JSON.stringify(database, null, 2), { mode: 0o600 });
await writeFile(secretsFile, JSON.stringify({
  installationId,
  installationCredential: credential,
  brokerSecret,
  allowedOrigins: installation.allowedOrigins,
  allowedRoles: installation.allowedRoles,
  organizationId,
  productId,
  environmentId,
  publicKeys: [{ keyId, algorithm: "ES256", jwk: publicJwk }],
}, null, 2), { mode: 0o600 });

console.log("Generated dynamic-mode installation and signed empty catalog.");
console.log(`  runtime db  -> ${runtimeFile}`);
console.log(`  secrets     -> ${secretsFile}`);
console.log(`  origin      -> ${origin}`);
console.log(`  broker key  -> ${brokerSecret}   (also stored in the secrets file)`);
console.log("");
console.log("Start the runtime with:");
console.log(`  RUNTIME_FILE=${runtimeFile.replace(/^.*[\\/]cloud-run-time[\\/]/, './')} npm run dev`);
console.log("");
console.log("Start the dynamic test host with:");
console.log(`  DYNAMIC_TEST_ORIGIN=${origin} \\`);
console.log(`  DYNAMIC_INSTALLATION_SECRETS=${secretsFile.replace(/^.*[\\/]cloud-run-time[\\/]/, './')} \\`);
console.log(`  DYNAMIC_TEST_BROKER_SECRET=${brokerSecret} \\`);
console.log("  npm run dynamic:host");
