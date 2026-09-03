import assert from "node:assert/strict";
import test from "node:test";
import {
  validateSdkCatalog,
  validateSignedCatalogEnvelope,
} from "@sable/sdk-contracts";
import {
  createIncompatibleCatalogFixture,
  createInvalidCatalogFixture,
  createSignedCatalogFixture,
  verifySignedCatalogFixture,
  type InvalidCatalogKind,
} from "../src/catalog-fixtures.js";

test("creates a deterministic-shape ES256 signed catalog fixture", () => {
  const fixture = createSignedCatalogFixture();
  assert.equal(fixture.envelope.kind, "sable.signed_catalog");
  assert.equal(fixture.envelope.signature.algorithm, "ES256");
  assert.ok(fixture.envelope.digest.value.length > 20);
  assert.ok(fixture.envelope.signature.value.length > 20);
  assert.equal(validateSdkCatalog(fixture.catalog).ok, true);
  assert.equal(validateSignedCatalogEnvelope(fixture.envelope).ok, true);
  assert.equal(verifySignedCatalogFixture(fixture), true);
});

test("detects catalog content changed after signing", () => {
  const fixture = createSignedCatalogFixture();
  fixture.catalog.journeys[0]!.workflow.postconditions[0] = {
    kind: "text_visible",
    text: "A fabricated success message",
  };
  assert.equal(verifySignedCatalogFixture(fixture), false);
});

test("provides invalid fixtures for integrity and semantic validation", () => {
  const kinds: InvalidCatalogKind[] = [
    "tampered-signature",
    "wrong-origin",
    "wrong-role",
    "unsupported-sdk",
    "missing-control",
    "duplicate-control-id",
    "unsafe-script",
  ];
  for (const kind of kinds) {
    const fixture = createInvalidCatalogFixture(kind);
    assert.equal(fixture.kind, kind);
    assert.ok(fixture.expectedFailure.length > 10);
    assert.equal(
      verifySignedCatalogFixture(fixture),
      kind !== "tampered-signature",
      `${kind} should ${kind === "tampered-signature" ? "not " : ""}be cryptographically valid`,
    );
  }
});

test("incompatible catalog enumerates all compiler classifications", () => {
  const fixture = createIncompatibleCatalogFixture();
  assert.equal(validateSignedCatalogEnvelope(fixture.envelope).ok, true);
  const compatibility = new Set(
    fixture.catalog.journeys.flatMap((journey) =>
      journey.compatibility.map((entry) => entry.classification),
    ),
  );
  assert.deepEqual(
    [...compatibility].sort(),
    [
      "SDK_DIRECT",
      "NEEDS_STABLE_MARKER",
      "NEEDS_REGISTERED_TOOL",
      "NEEDS_USER_GESTURE",
      "NEEDS_FRAME_BRIDGE",
      "EXTENSION_ONLY",
      "HUMAN_ONLY",
      "UNSUPPORTED",
    ].sort(),
  );
});
