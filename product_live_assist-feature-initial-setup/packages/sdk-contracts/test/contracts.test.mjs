import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeJson,
  validateSdkBootstrapRequest,
  validateSdkCatalog,
  validateSdkClientMessage,
  validateSdkIdentityClaims,
  validateSdkServerCommand,
  validateSdkTelemetryBatch,
  validateSignedCatalogEnvelope,
} from "../dist/index.js";

const compatibility = (stepId) => ({
  kind: "sable.step_compatibility",
  stepId,
  classification: "SDK_DIRECT",
  reason: "Verified by the SDK test gate",
});

function catalog() {
  const stepCompatibility = compatibility("open-projects");
  return {
    kind: "sable.sdk_catalog",
    schemaVersion: 1,
    manifest: {
      kind: "sable.catalog.manifest",
      schemaVersion: 1,
      protocolVersion: 1,
      catalogId: "catalog",
      catalogVersionId: "catalog-v1",
      version: 1,
      organizationId: "org",
      productId: "product",
      environmentId: "staging",
      roleProfileId: "member",
      channel: "staging",
      issuedAt: "2026-08-14T00:00:00.000Z",
      supportedSdk: { minimum: "0.1.0" },
    },
    screens: [{
      kind: "sable.catalog.screen",
      id: "home",
      name: "Home",
      variants: [{ id: "default", minimumConfidence: 0.8, anchors: [{ kind: "route", pattern: "/home", weight: 1 }] }],
    }],
    controls: [{
      kind: "sable.catalog.control",
      id: "projects-link",
      screenId: "home",
      name: "Projects",
      risk: "read",
      locators: [{ kind: "aria_role_name", role: "link", name: "Projects", rank: 1 }],
    }],
    journeys: [{
      kind: "sable.catalog.journey",
      id: "view-projects",
      version: 1,
      name: "View projects",
      intents: ["show my projects"],
      roles: ["member"],
      risk: "read",
      inputSchema: { kind: "sable.journey_input_schema", properties: {}, required: [], additionalProperties: false },
      workflow: {
        kind: "sable.workflow",
        schemaVersion: 1,
        id: "view-projects",
        version: 1,
        name: "View projects",
        risk: "read",
        preconditions: [],
        steps: [{ kind: "action", id: "open-projects", action: "click", target: { controlId: "projects-link" }, compatibility: stepCompatibility }],
        postconditions: [{ kind: "url_matches", pattern: "/projects" }],
      },
      compatibility: [stepCompatibility],
      state: "approved",
      reliability: 0.99,
    }],
    tools: [],
    privacyPolicy: {
      kind: "sable.catalog.privacy_policy",
      schemaVersion: 1,
      defaultTextTreatment: "allow",
      screenshots: "disabled",
      excludedRoutes: ["/billing"],
      rules: [{ kind: "input_type", inputType: "password", action: "exclude" }],
      maximumVisibleTextChars: 20_000,
      allowElementValues: false,
    },
    telemetryPolicy: {
      kind: "sable.catalog.telemetry_policy",
      schemaVersion: 1,
      enabled: true,
      sampleRate: 1,
      allowedEvents: ["journey.completed", "sdk.error"],
      batchMaximumEvents: 100,
      flushIntervalMs: 5_000,
      includeVisibleText: false,
      includeElementValues: false,
    },
  };
}

function guidedDemoCatalog() {
  const value = catalog();
  value.journeys[0].demoSafe = true;
  value.journeys[0].workflow.steps[0].narration = "I am opening the projects screen now.";
  value.journeys[0].workflow.steps[0].narrationAudioAssetId = "demo-voice";
  value.demoAudioAssets = [{
    id: "demo-voice",
    mime: "audio/mpeg",
    sha256: "a".repeat(64),
    durationMs: 1_800,
  }];
  value.demoProfile = {
    id: "niroggyan-guided-demo",
    version: 1,
    greeting: { text: "Welcome to the Niroggyan demo.", audioAssetId: "demo-voice" },
    questions: [
      { id: "visitor-role", captureKey: "lead.role", prompt: { text: "What kind of organisation are you from?", audioAssetId: "demo-voice" } },
      { id: "visitor-goal", captureKey: "lead.goal", prompt: { text: "What would you most like to see today?", audioAssetId: "demo-voice" } },
      { id: "lab-volume", captureKey: "lead.labVolume", prompt: { text: "Roughly how many reports do you handle?" } },
    ],
    intake: {
      genericQuestionIds: ["visitor-role", "visitor-goal"],
      personaQuestionByPersonaId: { "lab-owner": "lab-volume" },
    },
    personas: [{
      id: "lab-owner",
      name: "Lab owner",
      description: "Owns or operates a diagnostic laboratory.",
      classifierSignals: ["laboratory", "diagnostic centre"],
    }],
    modules: [{
      id: "projects-overview",
      name: "Projects overview",
      journeyId: "view-projects",
      introduction: { text: "Let me show you the projects area.", audioAssetId: "demo-voice" },
      completion: { text: "That completes the projects overview.", audioAssetId: "demo-voice" },
      failureMessage: { text: "I could not complete that module safely." },
    }],
    defaultPlaylistModuleIds: ["projects-overview"],
    playlistModuleIdsByPersonaId: { "lab-owner": ["projects-overview"] },
    closing: { text: "Thank you for exploring Niroggyan.", audioAssetId: "demo-voice" },
  };
  value.salesPlays = [
    {
      id: "answer-projects",
      kind: "product_answer",
      title: "What projects contain",
      content: "Projects organise the work and reports that belong to a customer engagement.",
      personaIds: [],
      capabilityIds: ["projects"],
      journeyIds: ["view-projects"],
      signalPhrases: ["what is a project"],
    },
    {
      id: "discover-report-volume",
      kind: "discovery_question",
      title: "Understand reporting volume",
      content: "Ask about monthly report volume only when it helps answer the visitor's question.",
      personaIds: ["lab-owner"],
      capabilityIds: ["reports"],
      journeyIds: [],
      signalPhrases: ["report volume"],
      captureKey: "lead.monthlyReportVolume",
    },
    {
      id: "suggest-projects-overview",
      kind: "next_best_action",
      title: "Offer the projects overview",
      content: "Offer to show the projects overview; do not start it without confirmation.",
      personaIds: ["lab-owner"],
      capabilityIds: ["projects"],
      journeyIds: ["view-projects"],
      signalPhrases: ["show me an example"],
      suggestedJourneyId: "view-projects",
      requiresConfirmation: true,
    },
  ];
  return value;
}

test("validates a role-scoped SDK catalog and referential integrity", () => {
  const value = catalog();
  assert.equal(validateSdkCatalog(value).ok, true);
  value.journeys[0].workflow.steps[0].target.controlId = "missing-control";
  const invalid = validateSdkCatalog(value);
  assert.equal(invalid.ok, false);
  assert.match(invalid.issues.map((issue) => issue.message).join(" "), /missing control/);
});

test("validates guided-demo recordings, demo-safe modules, and sales knowledge references", () => {
  assert.equal(validateSdkCatalog(guidedDemoCatalog()).ok, true);

  const missingJourney = guidedDemoCatalog();
  missingJourney.demoProfile.modules[0].journeyId = "missing-journey";
  const missingJourneyResult = validateSdkCatalog(missingJourney);
  assert.equal(missingJourneyResult.ok, false);
  assert.match(missingJourneyResult.issues.map((issue) => issue.message).join(" "), /missing journey/);

  const missingAudio = guidedDemoCatalog();
  missingAudio.demoAudioAssets = [];
  const missingAudioResult = validateSdkCatalog(missingAudio);
  assert.equal(missingAudioResult.ok, false);
  assert.match(missingAudioResult.issues.map((issue) => issue.message).join(" "), /missing.*audio asset/);

  const unsafeJourney = guidedDemoCatalog();
  unsafeJourney.journeys[0].demoSafe = false;
  const unsafeJourneyResult = validateSdkCatalog(unsafeJourney);
  assert.equal(unsafeJourneyResult.ok, false);
  assert.match(unsafeJourneyResult.issues.map((issue) => issue.message).join(" "), /demoSafe true/);
});

test("allows an explicit manual handoff but never an unresolved SDK_DIRECT control", () => {
  const value = catalog();
  value.controls[0].locators = [];
  const unsafe = validateSdkCatalog(value);
  assert.equal(unsafe.ok, false);
  assert.match(unsafe.issues.map((issue) => issue.message).join(" "), /SDK_DIRECT.*unresolved control/);

  value.manifest.channel = "production";
  value.journeys[0].state = "verified";
  value.journeys[0].manualHandoff = { reason: "Needs a stable marker", instructions: ["Add data-sable-id"] };
  value.journeys[0].workflow.steps[0].compatibility.classification = "NEEDS_STABLE_MARKER";
  value.journeys[0].compatibility[0].classification = "NEEDS_STABLE_MARKER";
  assert.equal(validateSdkCatalog(value).ok, true);
});

test("validates signed envelope structure without claiming cryptographic verification", () => {
  const envelope = {
    kind: "sable.signed_catalog",
    schemaVersion: 1,
    payload: catalog(),
    digest: { algorithm: "SHA-256", encoding: "base64url", value: "A".repeat(43) },
    signature: {
      kind: "sable.catalog_signature",
      algorithm: "ES256",
      keyId: "key-1",
      encoding: "base64url",
      value: "A".repeat(86),
      signedAt: "2026-08-14T00:00:00.000Z",
    },
  };
  assert.equal(validateSignedCatalogEnvelope(envelope).ok, true);
  envelope.digest.value = "not-base64url-sha256";
  assert.equal(validateSignedCatalogEnvelope(envelope).ok, false);
});

test("canonical JSON is stable and rejects non-JSON values", () => {
  assert.equal(canonicalizeJson({ z: 1, a: [true, "x"] }), '{"a":[true,"x"],"z":1}');
  assert.throws(() => canonicalizeJson({ value: Number.NaN }), /non-finite/);
  assert.throws(() => canonicalizeJson({ value: undefined }), /not valid JSON/);
  assert.throws(() => canonicalizeJson({ value: "\ud800" }), /unpaired Unicode/);
});

test("token claim validation enforces version, type, origin, and lifetime", () => {
  const claims = {
    v: 1,
    typ: "sdk_identity",
    jti: "token-1",
    installationId: "install",
    organizationId: "org",
    productId: "product",
    environmentId: "staging",
    roleProfileId: "member",
    userId: "user",
    origin: "https://client.example",
    iat: 100,
    exp: 200,
  };
  assert.equal(validateSdkIdentityClaims(claims).ok, true);
  claims.exp = 401;
  assert.equal(validateSdkIdentityClaims(claims).ok, false);
  claims.exp = 50;
  assert.equal(validateSdkIdentityClaims(claims).ok, false);
});

test("bootstrap accepts a normal-page capability declaration", () => {
  assert.equal(validateSdkBootstrapRequest({
    kind: "sable.sdk.bootstrap.request",
    schemaVersion: 1,
    requestId: "request",
    installationId: "install",
    identityToken: "header.payload.signature",
    sdk: { version: "0.1.0", protocolVersion: 1, distribution: "script" },
    page: { origin: "https://client.example", url: "https://client.example/home", locale: "en-IN" },
    capabilities: {
      domObservation: true,
      shadowDom: true,
      sameOriginFrames: true,
      frameBridge: false,
      registeredTools: [],
      voice: true,
      screenshots: false,
    },
  }).ok, true);
});

test("server protocol exposes declarative journeys, not primitive remote actions", () => {
  const base = { schemaVersion: 1, commandId: "command", sessionId: "session", sentAt: "2026-08-14T00:00:00.000Z" };
  assert.equal(validateSdkServerCommand({
    ...base,
    kind: "sable.sdk.server.run_journey",
    turnId: "turn",
    catalogVersionId: "catalog-v1",
    journeyId: "view-projects",
    inputs: {},
    segment: { startStepId: "open-projects", stopAfterStepId: "verify-projects" },
  }).ok, true);
  assert.equal(validateSdkServerCommand({ ...base, kind: "sable.sdk.server.click", selector: "#pay" }).ok, false);
  assert.equal(validateSdkServerCommand({
    ...base, kind: "sable.sdk.server.run_catalog_navigation", turnId: "turn", catalogVersionId: "catalog-v1",
    sourceScreenId: "home", controlId: "mystery-link", targetScreenId: "mystery",
  }).ok, true);
  assert.equal(validateSdkServerCommand({ ...base, kind: "sable.sdk.server.pause_journey", journeyId: "view-projects", reason: "user interruption" }).ok, true);
  assert.equal(validateSdkServerCommand({
    ...base,
    kind: "sable.sdk.server.demo_state",
    phase: "awaiting_resume",
    activeModuleId: "projects-overview",
    canStart: false,
    canContinue: true,
    canRetry: false,
    canSkip: true,
    canStop: true,
  }).ok, true);
});

test("client protocol exposes bounded guided-demo controls", () => {
  const base = { schemaVersion: 1, messageId: "message", sessionId: "session", sentAt: "2026-08-14T00:00:00.000Z" };
  assert.equal(validateSdkClientMessage({ ...base, kind: "sable.sdk.client.demo_control", action: "continue" }).ok, true);
  assert.equal(validateSdkClientMessage({ ...base, kind: "sable.sdk.client.demo_control", action: "invent-a-journey" }).ok, false);
  assert.equal(validateSdkClientMessage({
    ...base,
    kind: "sable.sdk.client.demo_narration",
    cueKind: "question",
    questionId: "visitor-organisation",
    turnId: "demo-question",
    utteranceId: "utterance-question",
  }).ok, true);
  assert.equal(validateSdkClientMessage({
    ...base,
    kind: "sable.sdk.client.demo_narration",
    cueKind: "arbitrary_text",
    turnId: "demo-question",
    utteranceId: "utterance-question",
    text: "Speak untrusted browser text",
  }).ok, false);
});

test("client restoration protocol carries bounded context and a declarative checkpoint", () => {
  const value = {
    kind: "sable.sdk.client.restore_context", schemaVersion: 1, messageId: "message-restore", sessionId: "session", sentAt: "2026-08-14T00:00:00.000Z",
    continuityId: "continuity-1",
    transcript: [{ key: "user:turn-1", role: "user", text: "Open reports", createdAt: "2026-08-14T00:00:00.000Z" }],
    journey: {
      journeyId: "open-reports", journeyVersion: 2, turnId: "turn-1", originalRequest: "Open reports",
      inputs: { destination: "https://client.example/reports" }, completedStepIds: ["navigate"], nextStepId: "verify",
      navigationStepId: "navigate", destinationUrl: "https://client.example/reports", expectedScreenIds: ["reports"], stopAfterStepId: "verify",
    },
    catalogNavigation: {
      turnId: "turn-2", originalRequest: "Open Mystery", sourceScreenId: "home", controlId: "mystery-link",
      targetScreenId: "mystery", destinationUrl: "https://client.example/mystery",
    },
  };
  assert.equal(validateSdkClientMessage(value).ok, true);
  value.transcript = Array.from({ length: 13 }, (_, index) => ({ key: `user:${index}`, role: "user", text: "x", createdAt: "2026-08-14T00:00:00.000Z" }));
  assert.equal(validateSdkClientMessage(value).ok, false);
});

test("telemetry rejects sensitive context keys", () => {
  const batch = {
    kind: "sable.sdk.telemetry_batch",
    schemaVersion: 1,
    batchId: "batch",
    sessionId: "session",
    sentAt: "2026-08-14T00:00:00.000Z",
    events: [{
      kind: "sable.sdk.telemetry_event",
      schemaVersion: 1,
      eventId: "event",
      sequence: 1,
      sessionId: "session",
      installationId: "install",
      catalogVersionId: "catalog-v1",
      occurredAt: "2026-08-14T00:00:00.000Z",
      type: "sdk.error",
      code: "TEST",
      message: "failed",
      context: { password: "should-never-be-here" },
    }],
  };
  assert.equal(validateSdkTelemetryBatch(batch).ok, false);
  delete batch.events[0].context;
  assert.equal(validateSdkTelemetryBatch(batch).ok, true);
});
