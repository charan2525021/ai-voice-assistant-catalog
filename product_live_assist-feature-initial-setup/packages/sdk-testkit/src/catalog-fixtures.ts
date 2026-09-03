import {
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import {
  SDK_CATALOG_SCHEMA_VERSION,
  SDK_PROTOCOL_VERSION,
  SDK_WORKFLOW_SCHEMA_VERSION,
  canonicalizeJson,
  type CatalogControl,
  type CatalogManifest,
  type CatalogScreen,
  type JourneyDefinition,
  type PrivacyPolicy,
  type SdkCatalog,
  type SignedCatalogEnvelope,
  type StepCompatibility,
  type StepCompatibilityClass,
  type TelemetryPolicy,
  type ToolDefinition,
} from "@sable/sdk-contracts";

export type TestSdkCatalog = SdkCatalog;
export type TestCatalogManifest = CatalogManifest;
export type TestCatalogScreen = CatalogScreen;
export type TestCatalogControl = CatalogControl;
export type TestCatalogJourney = JourneyDefinition;
export type TestToolContract = ToolDefinition;

export interface CatalogOverrides {
  manifest?: Partial<CatalogManifest>;
  screens?: CatalogScreen[];
  controls?: CatalogControl[];
  journeys?: JourneyDefinition[];
  tools?: ToolDefinition[];
  privacyPolicy?: Partial<PrivacyPolicy>;
  telemetryPolicy?: Partial<TelemetryPolicy>;
}

export interface FixtureSigningKeys {
  keyId: string;
  privateKeyPem: string;
  publicKeyPem: string;
  publicJwk: JsonWebKey;
}

export interface SignedCatalogFixture {
  /** Convenience alias for `envelope.payload`. */
  catalog: SdkCatalog;
  envelope: SignedCatalogEnvelope;
  keys: FixtureSigningKeys;
  canonicalSignedPayload: string;
}

export type InvalidCatalogKind =
  | "tampered-signature"
  | "wrong-origin"
  | "wrong-role"
  | "unsupported-sdk"
  | "missing-control"
  | "duplicate-control-id"
  | "unsafe-script";

export interface InvalidCatalogFixture extends SignedCatalogFixture {
  kind: InvalidCatalogKind;
  expectedFailure: string;
  /** Scope/version inputs that make an otherwise signed catalog invalid for a session. */
  expectedContext?: {
    origin?: string;
    roleProfileId?: string;
    sdkVersion?: string;
  };
}

function compatibility(
  stepId: string,
  classification: StepCompatibilityClass = "SDK_DIRECT",
): StepCompatibility {
  return {
    kind: "sable.step_compatibility",
    stepId,
    classification,
    reason:
      classification === "SDK_DIRECT"
        ? "Verified for direct DOM execution by the fixture SDK"
        : `Fixture step classified as ${classification}`,
    verifiedAt: "2026-08-14T00:00:00.000Z",
    verifiedSdkVersion: "0.1.0",
    verifiedApplicationBuild: "fixture-2026.08",
  };
}

function defaultInputSchema(): JourneyDefinition["inputSchema"] {
  return {
    kind: "sable.journey_input_schema",
    properties: {
      projectName: {
        type: "string",
        description: "The project name to create",
        minimumLength: 1,
        maximumLength: 120,
      },
    },
    required: ["projectName"],
    additionalProperties: false,
  };
}

export function buildCatalog(overrides: CatalogOverrides = {}): SdkCatalog {
  const createStep = compatibility("open-create-project");
  const nameStep = compatibility("enter-project-name");
  const saveStep = compatibility("save-project");
  const base: SdkCatalog = {
    kind: "sable.sdk_catalog",
    schemaVersion: SDK_CATALOG_SCHEMA_VERSION,
    manifest: {
      kind: "sable.catalog.manifest",
      schemaVersion: SDK_CATALOG_SCHEMA_VERSION,
      protocolVersion: SDK_PROTOCOL_VERSION,
      catalogId: "catalog-fixture",
      catalogVersionId: "catalog-fixture-v1",
      version: 1,
      organizationId: "org-fixture",
      productId: "product-fixture",
      environmentId: "staging",
      roleProfileId: "member",
      channel: "staging",
      issuedAt: "2026-08-14T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      supportedSdk: { minimum: "0.1.0", maximum: "0.1.99" },
      applicationBuildHints: ["fixture-2026.08"],
      publishedBy: "sdk-testkit",
    },
    screens: [
      {
        kind: "sable.catalog.screen",
        id: "projects-list",
        name: "Projects",
        roles: ["member"],
        variants: [
          {
            id: "projects-list-en",
            locale: "en",
            minimumConfidence: 0.78,
            anchors: [
              { kind: "route", pattern: "/semantic", weight: 0.25 },
              { kind: "title", text: "Projects", weight: 0.35 },
              {
                kind: "control",
                controlId: "create-project-button",
                weight: 0.4,
              },
            ],
          },
        ],
      },
      {
        kind: "sable.catalog.screen",
        id: "project-create",
        name: "Create project",
        roles: ["member"],
        variants: [
          {
            id: "project-create-en",
            locale: "en",
            minimumConfidence: 0.75,
            anchors: [
              { kind: "title", text: "Projects", weight: 0.25 },
              {
                kind: "control",
                controlId: "project-name-input",
                weight: 0.4,
              },
              {
                kind: "control",
                controlId: "save-project-button",
                weight: 0.35,
              },
            ],
          },
        ],
      },
    ],
    controls: [
      {
        kind: "sable.catalog.control",
        id: "create-project-button",
        screenId: "projects-list",
        name: "Create project",
        locators: [
          { kind: "agent_id", value: "create-project", rank: 1 },
          {
            kind: "aria_role_name",
            role: "button",
            name: "Create project",
            rank: 2,
            exact: true,
          },
        ],
        risk: "reversible_write",
      },
      {
        kind: "sable.catalog.control",
        id: "project-name-input",
        screenId: "project-create",
        name: "Project name",
        locators: [
          { kind: "label", text: "Project name", rank: 1, exact: true },
          { kind: "test_id", value: "project-name", rank: 2 },
        ],
        risk: "reversible_write",
      },
      {
        kind: "sable.catalog.control",
        id: "save-project-button",
        screenId: "project-create",
        name: "Save project",
        locators: [
          {
            kind: "aria_role_name",
            role: "button",
            name: "Save project",
            rank: 1,
            exact: true,
          },
        ],
        risk: "reversible_write",
      },
    ],
    journeys: [
      {
        kind: "sable.catalog.journey",
        id: "create-project",
        version: 1,
        name: "Create a project",
        description: "Create a project from the semantic fixture page.",
        intents: ["create a project", "add a new project"],
        roles: ["member"],
        risk: "reversible_write",
        inputSchema: defaultInputSchema(),
        workflow: {
          kind: "sable.workflow",
          schemaVersion: SDK_WORKFLOW_SCHEMA_VERSION,
          id: "create-project",
          version: 1,
          name: "Create a project",
          risk: "reversible_write",
          preconditions: [
            {
              kind: "screen_matches",
              screenId: "projects-list",
              minimumConfidence: 0.75,
            },
          ],
          steps: [
            {
              kind: "action",
              id: "open-create-project",
              action: "click",
              target: {
                controlId: "create-project-button",
                screenId: "projects-list",
              },
              compatibility: createStep,
            },
            {
              kind: "action",
              id: "enter-project-name",
              action: "fill",
              target: {
                controlId: "project-name-input",
                screenId: "project-create",
              },
              value: { kind: "input_ref", name: "projectName", transforms: ["trim"] },
              compatibility: nameStep,
            },
            {
              kind: "action",
              id: "save-project",
              action: "click",
              target: {
                controlId: "save-project-button",
                screenId: "project-create",
              },
              compatibility: saveStep,
            },
          ],
          postconditions: [
            { kind: "text_visible", text: "Project created successfully" },
          ],
        },
        compatibility: [createStep, nameStep, saveStep],
        state: "approved",
        reliability: 0.98,
        sourceCitations: [
          { kind: "human", sourceId: "sdk-testkit", title: "Semantic fixture" },
        ],
      },
    ],
    tools: [],
    privacyPolicy: {
      kind: "sable.catalog.privacy_policy",
      schemaVersion: SDK_CATALOG_SCHEMA_VERSION,
      defaultTextTreatment: "allow",
      screenshots: "disabled",
      excludedRoutes: [],
      rules: [
        { kind: "selector", selector: "[data-sable-private]", action: "exclude" },
        {
          kind: "selector",
          selector: "[data-sable-observe='off']",
          action: "exclude",
        },
        { kind: "input_type", inputType: "password", action: "redact" },
        {
          kind: "text_pattern",
          pattern: "sk-[A-Za-z0-9_-]+",
          action: "redact",
          replacement: "[redacted]",
        },
      ],
      maximumVisibleTextChars: 20_000,
      allowElementValues: false,
    },
    telemetryPolicy: {
      kind: "sable.catalog.telemetry_policy",
      schemaVersion: SDK_CATALOG_SCHEMA_VERSION,
      enabled: true,
      sampleRate: 1,
      allowedEvents: [
        "session.started",
        "session.stopped",
        "catalog.loaded",
        "screen.matched",
        "element.resolved",
        "action.completed",
        "journey.started",
        "journey.completed",
        "journey.failed",
        "approval.requested",
        "approval.resolved",
        "privacy.redacted",
        "transport.state",
        "sdk.error",
      ],
      batchMaximumEvents: 100,
      flushIntervalMs: 5_000,
      includeVisibleText: false,
      includeElementValues: false,
    },
  };

  return {
    ...base,
    ...overrides,
    manifest: { ...base.manifest, ...overrides.manifest },
    privacyPolicy: { ...base.privacyPolicy, ...overrides.privacyPolicy },
    telemetryPolicy: { ...base.telemetryPolicy, ...overrides.telemetryPolicy },
  };
}

/** Public alias kept for fixture callers; implementation comes from sdk-contracts. */
export const canonicalJson = canonicalizeJson;

export function generateFixtureSigningKeys(
  keyId = "fixture-key-1",
): FixtureSigningKeys {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  return {
    keyId,
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    publicJwk: publicKey.export({ format: "jwk" }) as JsonWebKey,
  };
}

export function sealCatalog(
  unsealedCatalog: SdkCatalog,
  keys = generateFixtureSigningKeys(),
): SignedCatalogFixture {
  const catalog = structuredClone(unsealedCatalog);
  const canonicalSignedPayload = canonicalJson(catalog);
  const payloadBytes = Buffer.from(canonicalSignedPayload);
  const envelope: SignedCatalogEnvelope = {
    kind: "sable.signed_catalog",
    schemaVersion: SDK_CATALOG_SCHEMA_VERSION,
    payload: catalog,
    digest: {
      algorithm: "SHA-256",
      encoding: "base64url",
      value: createHash("sha256").update(payloadBytes).digest("base64url"),
    },
    signature: {
      kind: "sable.catalog_signature",
      algorithm: "ES256",
      keyId: keys.keyId,
      encoding: "base64url",
      value: cryptoSign("sha256", payloadBytes, {
        key: keys.privateKeyPem,
        dsaEncoding: "ieee-p1363",
      }).toString("base64url"),
      signedAt: "2026-08-14T00:00:00.000Z",
    },
  };
  return { catalog, envelope, keys, canonicalSignedPayload };
}

export function createSignedCatalogFixture(
  overrides: CatalogOverrides = {},
  keys?: FixtureSigningKeys,
): SignedCatalogFixture {
  return sealCatalog(buildCatalog(overrides), keys);
}

export function verifySignedCatalogFixture(fixture: SignedCatalogFixture): boolean {
  const payload = canonicalJson(fixture.envelope.payload);
  const expectedDigest = createHash("sha256").update(payload).digest("base64url");
  if (expectedDigest !== fixture.envelope.digest.value) return false;
  return cryptoVerify(
    "sha256",
    Buffer.from(payload),
    { key: fixture.keys.publicKeyPem, dsaEncoding: "ieee-p1363" },
    Buffer.from(fixture.envelope.signature.value, "base64url"),
  );
}

export function createIncompatibleCatalogFixture(
  keys?: FixtureSigningKeys,
): SignedCatalogFixture {
  const classes: StepCompatibilityClass[] = [
    "SDK_DIRECT",
    "NEEDS_STABLE_MARKER",
    "NEEDS_REGISTERED_TOOL",
    "NEEDS_USER_GESTURE",
    "NEEDS_FRAME_BRIDGE",
    "EXTENSION_ONLY",
    "HUMAN_ONLY",
    "UNSUPPORTED",
  ];
  const baseJourney = buildCatalog().journeys[0]!;
  const compatibilityEntries = classes.map((classification, index) =>
    compatibility(`compatibility-${index + 1}`, classification),
  );
  const steps = compatibilityEntries.map((entry) => ({
    kind: "action" as const,
    id: entry.stepId,
    action: "wait" as const,
    milliseconds: 1,
    compatibility: entry,
  }));
  return createSignedCatalogFixture(
    {
      journeys: [
        {
          ...baseJourney,
          id: "compatibility-matrix",
          name: "Compatibility classification matrix",
          workflow: {
            ...baseJourney.workflow,
            id: "compatibility-matrix",
            name: "Compatibility classification matrix",
            preconditions: [],
            steps,
            postconditions: [],
          },
          compatibility: compatibilityEntries,
        },
      ],
      tools: [
        {
          kind: "sable.catalog.tool",
          schemaVersion: SDK_CATALOG_SCHEMA_VERSION,
          name: "fixtureTool",
          description: "A client-reviewed test tool",
          inputSchema: {
            kind: "sable.journey_input_schema",
            properties: {},
            required: [],
            additionalProperties: false,
          },
          risk: "reversible_write",
          confirmation: "always",
          availability: "required",
          timeoutMs: 5_000,
        },
      ],
    },
    keys,
  );
}

export function createInvalidCatalogFixture(
  kind: InvalidCatalogKind,
  keys = generateFixtureSigningKeys(),
): InvalidCatalogFixture {
  const catalog = buildCatalog();
  let expectedFailure = "Catalog is invalid";
  let expectedContext: InvalidCatalogFixture["expectedContext"];

  switch (kind) {
    case "tampered-signature": {
      const fixture = sealCatalog(catalog, keys);
      fixture.catalog.journeys[0]!.name = "Tampered after signing";
      return {
        ...fixture,
        kind,
        expectedFailure: "Catalog digest or signature does not match its payload",
      };
    }
    case "wrong-origin":
      expectedContext = { origin: "https://another-tenant.fixture.test" };
      expectedFailure = "SDK session origin does not match the current page";
      break;
    case "wrong-role":
      expectedContext = { roleProfileId: "administrator" };
      expectedFailure = "Catalog role does not match the SDK session role";
      break;
    case "unsupported-sdk":
      catalog.manifest.supportedSdk = { minimum: "99.0.0", maximum: "99.0.0" };
      expectedContext = { sdkVersion: "0.1.0" };
      expectedFailure = "SDK version is outside the catalog compatibility range";
      break;
    case "missing-control": {
      const step = catalog.journeys[0]!.workflow.steps[0];
      if (step?.kind === "action" && step.action === "click") {
        step.target.controlId = "control-that-does-not-exist";
      }
      expectedFailure = "Journey references a control that is not in the catalog";
      break;
    }
    case "duplicate-control-id":
      catalog.controls.push(structuredClone(catalog.controls[0]!));
      expectedFailure = "Catalog control IDs must be unique";
      break;
    case "unsafe-script": {
      const unsafe = catalog.journeys[0]!.workflow.steps[0] as unknown as Record<
        string,
        unknown
      >;
      unsafe.script = "document.body.innerHTML = ''";
      expectedFailure = "Executable code is not allowed in a catalog";
      break;
    }
  }

  return {
    ...sealCatalog(catalog, keys),
    kind,
    expectedFailure,
    ...(expectedContext ? { expectedContext } : {}),
  };
}
