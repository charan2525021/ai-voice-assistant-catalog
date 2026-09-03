import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { canonicalizeJson } from "@sable/sdk-contracts";
import { SignedCatalogClient } from "../src/catalog.js";

function signedFixture() {
  const catalog = {
    kind: "sable.sdk_catalog",
    schemaVersion: 1,
    manifest: {
      kind: "sable.catalog.manifest",
      schemaVersion: 1,
      protocolVersion: 1,
      catalogId: "catalog-test",
      catalogVersionId: "catalog-test-v1",
      version: 1,
      organizationId: "org-test",
      productId: "product-test",
      environmentId: "staging",
      roleProfileId: "member",
      channel: "staging",
      issuedAt: new Date().toISOString(),
      expiresAt: "2099-01-01T00:00:00.000Z",
      supportedSdk: { minimum: "0.1.0", maximum: "0.1.99" },
    },
    screens: [], controls: [], journeys: [], tools: [],
    privacyPolicy: {
      kind: "sable.catalog.privacy_policy", schemaVersion: 1, defaultTextTreatment: "allow",
      screenshots: "disabled", excludedRoutes: [], rules: [], maximumVisibleTextChars: 20_000,
      allowElementValues: false,
    },
    telemetryPolicy: {
      kind: "sable.catalog.telemetry_policy", schemaVersion: 1, enabled: false, sampleRate: 0,
      allowedEvents: [], batchMaximumEvents: 100, flushIntervalMs: 5_000,
      includeVisibleText: false, includeElementValues: false,
    },
  } as const;
  const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const bytes = Buffer.from(canonicalizeJson(catalog));
  const envelope = {
    kind: "sable.signed_catalog",
    schemaVersion: 1,
    payload: catalog,
    digest: { algorithm: "SHA-256", encoding: "base64url", value: createHash("sha256").update(bytes).digest("base64url") },
    signature: {
      kind: "sable.catalog_signature", algorithm: "ES256", keyId: "test-key", encoding: "base64url",
      value: sign("sha256", bytes, { key: keys.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url"),
      signedAt: new Date().toISOString(),
    },
  } as const;
  return { envelope, publicJwk: keys.publicKey.export({ format: "jwk" }) as JsonWebKey };
}

test("catalog client verifies signature, digest, version, scope, and origin", async () => {
  const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("https://client.example.test/projects") });
  try {
    const fixture = signedFixture();
    const client = new SignedCatalogClient([{ keyId: "test-key", algorithm: "ES256", jwk: fixture.publicJwk }]);
    const loaded = await client.load({
      source: { kind: "inline", envelope: fixture.envelope },
      expectedCatalogVersionId: "catalog-test-v1",
      expectedScope: {
        organizationId: "org-test", productId: "product-test", environmentId: "staging",
        roleProfileId: "member", origin: "https://client.example.test",
      },
    });
    assert.equal(loaded.catalog.manifest.catalogVersionId, "catalog-test-v1");
    assert.equal(loaded.source, "network");

    const tampered = structuredClone(fixture.envelope);
    tampered.payload.manifest.productId = "other-product";
    await assert.rejects(() => new SignedCatalogClient([
      { keyId: "test-key", algorithm: "ES256", jwk: fixture.publicJwk },
    ]).load({
      source: { kind: "inline", envelope: tampered },
      expectedScope: {
        organizationId: "org-test", productId: "other-product", environmentId: "staging",
        roleProfileId: "member", origin: "https://client.example.test",
      },
    }), /digest/);
  } finally {
    if (locationDescriptor) Object.defineProperty(globalThis, "location", locationDescriptor);
    else delete (globalThis as { location?: unknown }).location;
  }
});
