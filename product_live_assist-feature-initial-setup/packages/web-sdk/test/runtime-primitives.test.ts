import assert from "node:assert/strict";
import test from "node:test";
import { PrivacyEngine } from "../src/privacy.js";
import { DeterministicSafetyPolicy } from "../src/safety.js";
import { BrowserActionDriver, classifyBrowserNavigation, targetMatchesRecognizedScreen } from "../src/action-driver.js";
import { ToolRegistry } from "../src/tools.js";
import { compareVersions, parseVersion, versionIsSupported } from "../src/version.js";
import { ScreenRecognizer } from "../src/recognizer.js";

test("SDK compatibility uses numeric semantic versions", () => {
  assert.deepEqual(parseVersion("1.12.3"), { major: 1, minor: 12, patch: 3 });
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(versionIsSupported("1.2.3", "1.2.0", "1.3.0"), true);
  assert.equal(versionIsSupported("2.0.0", "1.2.0", "1.9.9"), false);
});

test("a freshly requested observation retains its deterministic catalog screen identity", () => {
  const recognizer = new ScreenRecognizer({
    screens: [{ id: "home", variants: [{ id: "desktop", minimumConfidence: 0.6, anchors: [{ kind: "route", pattern: "/", weight: 1 }] }] }],
  } as never, {}, undefined);
  const raw = {
    kind: "sable.screen_observation", schemaVersion: 1, observationId: "obs", version: 1,
    capturedAt: new Date().toISOString(), url: "https://app.example/", origin: "https://app.example",
    title: "Home", fingerprint: "home", elements: [],
  } as const;
  const enriched = recognizer.enrich(raw);
  assert.equal(enriched.matchedScreenId, "home");
  assert.equal(enriched.matchConfidence, 1);
});

test("privacy scrubber removes secrets before network boundaries", () => {
  const privacy = new PrivacyEngine(undefined, { maxTextChars: 1_000 });
  const scrubbed = privacy.scrubPayload({
    password: "never-send-this",
    nested: { authorization: "Bearer abcdefghijklmnop", safe: "Visible help text" },
    message: "Use Bearer abcdefghijklmnop for this",
  });
  assert.deepEqual(scrubbed, {
    password: "[redacted]",
    nested: { authorization: "[redacted]", safe: "Visible help text" },
    message: "Use [redacted] for this",
  });
});

test("tool registry accepts only catalog-declared code and validates inputs", async () => {
  const definition = {
    kind: "sable.catalog.tool",
    schemaVersion: 1,
    name: "createProject",
    description: "Creates a project",
    inputSchema: {
      kind: "sable.journey_input_schema",
      properties: { name: { type: "string", minimumLength: 2 } },
      required: ["name"],
      additionalProperties: false,
    },
    risk: "reversible_write",
    confirmation: "policy",
    availability: "required",
    timeoutMs: 1_000,
  } as const;
  const registry = new ToolRegistry([definition]);
  registry.register({ definition, execute: ({ name }) => ({ id: `project-${name}` }) } as never);
  const success = await registry.execute("createProject", { name: "Demo" }, { journeyId: "journey", stepId: "step" });
  assert.equal(success.ok, true);
  await assert.rejects(
    () => registry.execute("createProject", { unexpected: true }, { journeyId: "journey", stepId: "step" }),
    /did not match/,
  );
});

test("local safety fails closed for unverified and over-risk steps", async () => {
  const policy = new DeterministicSafetyPolicy({ maximumRisk: "reversible_write" });
  const workflow = { id: "flow", name: "Flow", risk: "read" } as never;
  const unsupported = {
    id: "one",
    compatibility: { classification: "HUMAN_ONLY", reason: "requires a user" },
  } as never;
  const destructive = {
    id: "two",
    risk: "destructive",
    compatibility: { classification: "SDK_DIRECT", reason: "verified" },
  } as never;
  assert.equal((await policy.authorize(unsupported, workflow)).allowed, false);
  assert.equal((await policy.authorize(destructive, workflow)).allowed, false);
  const reversible = {
    id: "three",
    risk: "reversible_write",
    compatibility: { classification: "SDK_DIRECT", reason: "verified" },
  } as never;
  assert.equal(policy.shouldConfirm(reversible, workflow), true);
  const resumable = {
    id: "navigate", kind: "action", action: "navigate",
    continuity: { kind: "sable.cross_page_continuity", expectedScreenIds: ["reports"], destinationOrigins: ["https://app.example"] },
    compatibility: { classification: "SDK_RESUMABLE_NAVIGATION", reason: "signed checkpoint" },
  } as never;
  assert.equal((await policy.authorize(resumable, workflow)).allowed, true);
  assert.equal((await policy.authorize(resumable, { ...workflow, risk: "reversible_write" } as never)).allowed, false);
});

test("navigation distinguishes same-document routes from SDK-destroying page loads", () => {
  assert.equal(classifyBrowserNavigation("https://app.example/settings?tab=team", "#members"), "same_document");
  assert.equal(classifyBrowserNavigation("https://app.example/settings", "/billing"), "full_page");
  assert.equal(classifyBrowserNavigation("https://app.example/settings", "https://other.example/"), "cross_origin");
  assert.equal(classifyBrowserNavigation("not a URL", "/billing"), "invalid");
});

test("a full-page navigation runs only after the continuity callback prepares it", async () => {
  const observation = {
    kind: "sable.screen_observation", schemaVersion: 1, observationId: "obs-1", version: 1,
    capturedAt: new Date().toISOString(), url: "https://app.example/home", origin: "https://app.example",
    title: "Home", fingerprint: "home-v1", elements: [],
  } as const;
  let assigned = "";
  const root = { location: { href: observation.url, assign: (value: string) => { assigned = value; } } } as unknown as Document;
  const observer = { observe: async () => observation };
  const action = { kind: "sable.resolved_action", stepId: "navigate", action: "navigate", url: "https://app.example/reports" } as const;
  const blocked = new BrowserActionDriver(observer as never, {} as never, {} as never, {} as never, {} as never, { root });
  assert.equal((await blocked.perform(action, observation as never)).ok, false);
  const prepared = new BrowserActionDriver(observer as never, {} as never, {} as never, {} as never, {} as never, {
    root,
    onBeforeDocumentNavigation: async (request) => `${request.destinationUrl}?prepared=1`,
  });
  assert.equal((await prepared.perform(action, observation as never)).ok, true);
  assert.equal(assigned, "https://app.example/reports?prepared=1");
});

test("read-only waits tolerate the DOM transition they are intended to observe", async () => {
  const expected = {
    kind: "sable.screen_observation", schemaVersion: 1, observationId: "before", version: 1,
    capturedAt: new Date().toISOString(), url: "https://app.example/loading", origin: "https://app.example",
    title: "Loading", fingerprint: "before", visibleText: "Loading", elements: [],
  } as const;
  const rendered = { ...expected, observationId: "after", version: 2, fingerprint: "after", visibleText: "Ready" } as const;
  const observer = { observe: async () => rendered };
  const root = {} as Document;
  const driver = new BrowserActionDriver(observer as never, {} as never, {} as never, {} as never, {} as never, { root, maximumWaitMs: 100 });
  const wait = await driver.perform({
    kind: "sable.resolved_action", stepId: "ready", action: "wait", milliseconds: 100,
    until: { kind: "text_visible", text: "Ready" },
  } as never, expected as never);
  assert.equal(wait.ok, true);

  const write = await driver.perform({
    kind: "sable.resolved_action", stepId: "change", action: "click", target: { controlId: "save" },
  } as never, expected as never);
  assert.equal(write.ok, false);
  assert.match(write.detail ?? "", /page changed before the action/);
});

test("a signed control target cannot be used on another or unrecognized screen", () => {
  const target = { controlId: "billing:save", screenId: "billing" };
  assert.equal(targetMatchesRecognizedScreen(target, "billing"), true);
  assert.equal(targetMatchesRecognizedScreen(target, "settings"), false);
  assert.equal(targetMatchesRecognizedScreen(target, undefined), false);
  assert.equal(targetMatchesRecognizedScreen({ controlId: "global-help" }, undefined), true);
});
