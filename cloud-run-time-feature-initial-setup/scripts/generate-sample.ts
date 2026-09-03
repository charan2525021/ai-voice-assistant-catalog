import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { assertValidSdkCatalog, canonicalizeJson, SDK_CATALOG_SCHEMA_VERSION, SDK_PROTOCOL_VERSION, SDK_WORKFLOW_SCHEMA_VERSION, type SdkCatalog, type SignedCatalogEnvelope } from "@sable/sdk-contracts";
import type { RuntimeBundle } from "@sable/runtime-core";
import { hashCredential } from "../src/security.js";

const origin = process.env.SAMPLE_APP_ORIGIN ?? "http://localhost:4173";
const credential = `sable_demo_${randomBytes(24).toString("base64url")}`;
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const publicJwk = createPublicKey(privateKey).export({ format: "jwk" });
const keyId = `sample-${createHash("sha256").update(JSON.stringify(publicJwk)).digest("hex").slice(0, 12)}`;
const compatibility = (stepId: string) => ({ kind: "sable.step_compatibility" as const, stepId, classification: "SDK_DIRECT" as const, reason: "Verified semantic test ID in the controlled sample" });

const catalog: SdkCatalog = {
  kind: "sable.sdk_catalog", schemaVersion: SDK_CATALOG_SCHEMA_VERSION,
  manifest: { kind: "sable.catalog.manifest", schemaVersion: SDK_CATALOG_SCHEMA_VERSION, protocolVersion: SDK_PROTOCOL_VERSION, catalogId: "sample-product", catalogVersionId: "sample-v1", version: 1, organizationId: "sample-tenant", productId: "sample-product", environmentId: "sample", roleProfileId: "member", channel: "production", issuedAt: new Date().toISOString(), supportedSdk: { minimum: "0.1.0", maximum: "1.0.0" } },
  screens: [
    { kind: "sable.catalog.screen", id: "dashboard", name: "Dashboard", roles: ["member"], variants: [{ id: "dashboard-default", anchors: [{ kind: "route", pattern: "/", weight: 1 }, { kind: "text", text: "Workspace health", weight: 1 }], minimumConfidence: 0.5 }] },
    { kind: "sable.catalog.screen", id: "settings", name: "Settings", roles: ["member"], variants: [{ id: "settings-default", anchors: [{ kind: "route", pattern: "/#settings", weight: 1 }, { kind: "text", text: "Profile settings", weight: 1 }], minimumConfidence: 0.5 }] },
  ],
  controls: [
    { kind: "sable.catalog.control", id: "settings-link", screenId: "dashboard", name: "Open settings", risk: "read", locators: [{ kind: "test_id", value: "open-settings", rank: 1, exact: true }] },
    { kind: "sable.catalog.control", id: "display-name", screenId: "settings", name: "Display name", risk: "reversible_write", locators: [{ kind: "test_id", value: "display-name", rank: 1, exact: true }] },
    { kind: "sable.catalog.control", id: "save-profile", screenId: "settings", name: "Save profile", risk: "reversible_write", locators: [{ kind: "test_id", value: "save-profile", rank: 1, exact: true }] },
    { kind: "sable.catalog.control", id: "archive-project", screenId: "settings", name: "Archive project", risk: "destructive", locators: [{ kind: "test_id", value: "archive-project", rank: 1, exact: true }] },
  ],
  journeys: [
    { kind: "sable.catalog.journey", id: "open-settings", version: 1, name: "Open settings", description: "Open the settings screen", intents: ["open settings", "show settings", "go to settings"], roles: ["member"], risk: "read", inputSchema: { kind: "sable.journey_input_schema", properties: {}, required: [], additionalProperties: false }, state: "approved", reliability: 1, compatibility: [compatibility("open-settings-step")], workflow: { kind: "sable.workflow", schemaVersion: SDK_WORKFLOW_SCHEMA_VERSION, id: "open-settings", version: 1, name: "Open settings", risk: "read", preconditions: [], steps: [{ id: "open-settings-step", kind: "action", action: "click", target: { controlId: "settings-link" }, narration: "Opening settings.", compatibility: compatibility("open-settings-step") }], postconditions: [{ kind: "text_visible", text: "Profile settings" }] } },
    { kind: "sable.catalog.journey", id: "update-display-name", version: 1, name: "Update display name", description: "Change and save the profile display name", intents: ["update display name", "change my name", "set display name"], roles: ["member"], risk: "reversible_write", inputSchema: { kind: "sable.journey_input_schema", properties: { displayName: { type: "string", description: "New display name", minimumLength: 1, maximumLength: 80 } }, required: ["displayName"], additionalProperties: false }, state: "approved", reliability: 1, compatibility: [compatibility("fill-name"), compatibility("save-name")], workflow: { kind: "sable.workflow", schemaVersion: SDK_WORKFLOW_SCHEMA_VERSION, id: "update-display-name", version: 1, name: "Update display name", risk: "reversible_write", preconditions: [{ kind: "text_visible", text: "Profile settings" }], steps: [{ id: "fill-name", kind: "action", action: "fill", target: { controlId: "display-name" }, value: { kind: "input_ref", name: "displayName", transforms: ["trim"] }, narration: "Entering the new display name.", compatibility: compatibility("fill-name") }, { id: "save-name", kind: "action", action: "click", target: { controlId: "save-profile" }, narration: "Saving the profile.", compatibility: compatibility("save-name") }], postconditions: [{ kind: "text_visible", text: "Profile saved" }] } },
    { kind: "sable.catalog.journey", id: "archive-project", version: 1, name: "Archive project", description: "Archive the sample project after explicit approval", intents: ["archive project"], roles: ["member"], risk: "destructive", inputSchema: { kind: "sable.journey_input_schema", properties: {}, required: [], additionalProperties: false }, state: "approved", reliability: 1, compatibility: [compatibility("approve-archive"), compatibility("archive")], workflow: { kind: "sable.workflow", schemaVersion: SDK_WORKFLOW_SCHEMA_VERSION, id: "archive-project", version: 1, name: "Archive project", risk: "destructive", preconditions: [{ kind: "text_visible", text: "Profile settings" }], steps: [{ id: "approve-archive", kind: "approval", reason: "Archiving changes project availability.", narration: "I need your approval before archiving.", compatibility: compatibility("approve-archive"), then: [{ id: "archive", kind: "action", action: "click", target: { controlId: "archive-project" }, compatibility: compatibility("archive") }] }], postconditions: [{ kind: "text_visible", text: "Project archived" }] } },
  ],
  tools: [],
  privacyPolicy: { kind: "sable.catalog.privacy_policy", schemaVersion: SDK_CATALOG_SCHEMA_VERSION, defaultTextTreatment: "allow", screenshots: "disabled", excludedRoutes: [], rules: [{ kind: "input_type", inputType: "password", action: "exclude" }, { kind: "attribute", attribute: "data-private", action: "redact", replacement: "[private]" }], maximumVisibleTextChars: 25_000, allowElementValues: false },
  telemetryPolicy: { kind: "sable.catalog.telemetry_policy", schemaVersion: SDK_CATALOG_SCHEMA_VERSION, enabled: true, sampleRate: 1, allowedEvents: ["session.started", "session.stopped", "catalog.loaded", "screen.matched", "element.resolved", "action.completed", "journey.started", "journey.completed", "journey.failed", "approval.requested", "approval.resolved", "privacy.redacted", "transport.state", "sdk.error"], batchMaximumEvents: 50, flushIntervalMs: 5_000, includeVisibleText: false, includeElementValues: false },
};

assertValidSdkCatalog(catalog);
const canonical = canonicalizeJson(catalog);
const digest = createHash("sha256").update(canonical).digest("base64url");
const signature = sign("sha256", Buffer.from(canonical), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
const envelope: SignedCatalogEnvelope = { kind: "sable.signed_catalog", schemaVersion: SDK_CATALOG_SCHEMA_VERSION, payload: catalog, digest: { algorithm: "SHA-256", encoding: "base64url", value: digest }, signature: { kind: "sable.catalog_signature", algorithm: "ES256", keyId, encoding: "base64url", value: signature, signedAt: new Date().toISOString() } };
const runtimeBundle: RuntimeBundle = {
  schemaVersion: 1,
  organizationId: catalog.manifest.organizationId,
  productId: catalog.manifest.productId,
  environmentId: catalog.manifest.environmentId,
  catalogVersionId: catalog.manifest.catalogVersionId,
  catalogVersion: catalog.manifest.version,
  generatedAt: catalog.manifest.issuedAt,
  journeys: catalog.journeys.map((journey) => ({
    key: journey.id,
    name: journey.name,
    roleProfileIds: journey.roles,
    intentPhrases: journey.intents,
    reliability: journey.reliability ?? 1,
    screenKeys: [],
    screenFingerprints: [],
    workflow: {
      schemaVersion: 1,
      id: journey.id,
      version: journey.version,
      name: journey.name,
      risk: journey.risk,
      preconditions: [],
      steps: journey.workflow.steps.map((step) => ({ id: step.id, action: step.kind === "action" ? step.action : step.kind, say: step.narration })),
      postconditions: [],
    },
  })),
  salesPlays: [],
  screens: catalog.screens.map((screen) => ({
    key: screen.id,
    name: screen.name,
    fingerprint: `sdk-screen:${screen.id}`,
    roleProfileId: catalog.manifest.roleProfileId,
    controls: catalog.controls.filter((control) => control.screenId === screen.id).map((control) => ({ key: control.id, accessibleName: control.name, risk: control.risk })),
  })),
  transitions: [],
  coverage: { weighted: 1, verified: catalog.journeys.length, total: catalog.journeys.length, unknown: 0 },
};
const database = {
  installations: [{ installationId: "sample-installation", organizationId: "sample-tenant", productId: "sample-product", environmentId: "sample", credentialHash: hashCredential(credential), allowedOrigins: [origin], allowedRoles: ["member"], activeCatalogVersionId: "sample-v1", voice: { languageCode: "en-IN", speaker: "shubh" } }],
  catalogs: [envelope],
  runtimeBundles: [runtimeBundle],
  knowledge: [
    { id: "docs-1", tenantId: "sample-tenant", productId: "sample-product", catalogVersionId: "sample-v1", title: "Workspace health", section: "Dashboard", content: "Workspace health combines synchronization freshness, connector status, and unresolved setup warnings. Green means all checks are healthy.", source: "sample-product-guide", trust: "official", score: 0 },
    { id: "docs-2", tenantId: "sample-tenant", productId: "sample-product", catalogVersionId: "sample-v1", title: "Profile names", section: "Profile settings", content: "A display name is visible to workspace members and can be changed from Profile settings. It can contain up to 80 characters.", source: "sample-product-guide", trust: "official", score: 0 },
  ],
};
await mkdir("data", { recursive: true }); await mkdir("sample-app/public", { recursive: true });
await writeFile("data/sample-runtime.generated.json", JSON.stringify(database, null, 2), { mode: 0o600 });
await writeFile("data/sample-secrets.generated.json", JSON.stringify({ installationId: "sample-installation", installationCredential: credential }, null, 2), { mode: 0o600 });
await writeFile("sample-app/public/runtime-config.generated.json", JSON.stringify({ apiBaseUrl: process.env.PUBLIC_API_URL ?? "http://localhost:8787", installationId: "sample-installation", catalogTrustKeys: [{ keyId, algorithm: "ES256", jwk: publicJwk }] }, null, 2));
console.log("Generated sample catalog, trust key, and a new installation credential. The credential is stored only in ignored data/sample-secrets.generated.json.");
