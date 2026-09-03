import assert from "node:assert/strict";
import test from "node:test";
import { DefaultWorkflowPolicy, WorkflowExecutor, resolveTemplate, validateJourneyInputs } from "../dist/index.js";

const direct = (stepId, classification = "SDK_DIRECT") => ({
  kind: "sable.step_compatibility",
  stepId,
  classification,
  reason: "test compatibility",
});

const observation = (version = 1) => ({
  kind: "sable.screen_observation",
  schemaVersion: 1,
  observationId: `observation-${version}`,
  version,
  capturedAt: "2026-08-14T00:00:00.000Z",
  url: "https://client.example/home",
  origin: "https://client.example",
  title: "Home",
  fingerprint: `screen-${version}`,
  elements: [],
});

function workflow(steps, extra = {}) {
  return {
    kind: "sable.workflow",
    schemaVersion: 1,
    id: "workflow",
    version: 1,
    name: "Test workflow",
    risk: "read",
    preconditions: [],
    steps,
    postconditions: [],
    ...extra,
  };
}

test("resolves typed inputs and rejects undeclared input", () => {
  const schema = {
    kind: "sable.journey_input_schema",
    properties: { name: { type: "string", minimumLength: 2 } },
    required: ["name"],
    additionalProperties: false,
  };
  const valid = validateJourneyInputs(schema, { name: " Aashi " });
  assert.equal(valid.ok, true);
  assert.equal(resolveTemplate({ kind: "input_ref", name: "name", transforms: ["trim", "uppercase"] }, valid.values), "AASHI");
  assert.equal(validateJourneyInputs(schema, { name: "x", other: true }).ok, false);
});

test("executes materialized actions through only the injected driver", async () => {
  const actions = [];
  const driver = {
    async observe() { return observation(actions.length + 1); },
    async perform(action) { actions.push(action); return { ok: true, detail: "performed" }; },
    async check() { return true; },
  };
  const result = await new WorkflowExecutor(driver).execute(workflow([{
    kind: "action",
    id: "fill-name",
    action: "fill",
    target: { controlId: "name" },
    value: { kind: "input_ref", name: "name", transforms: ["trim"] },
    compatibility: direct("fill-name"),
  }]), {
    inputs: { name: " Project Apollo " },
    policy: new DefaultWorkflowPolicy({ maximumRisk: "read", confirmationAtOrAbove: "destructive" }),
  });
  assert.equal(result.ok, true);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].value, "Project Apollo");
});

test("runs completion narration hooks only after a successful action", async () => {
  const order = [];
  const driver = {
    async observe() { return observation(); },
    async perform() { order.push("action"); return { ok: true, detail: "performed" }; },
    async check() { return true; },
  };
  const result = await new WorkflowExecutor(driver).execute(workflow([{
    kind: "action",
    id: "open-platform",
    action: "click",
    target: { controlId: "platform" },
    narration: "This is the platform section.",
    compatibility: direct("open-platform"),
  }]), {
    onStep: () => { order.push("before"); },
    onStepCompleted: (step) => { order.push(`narration:${step.narration}`); },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(order, ["before", "action", "narration:This is the platform section."]);
});

test("does not run completion narration hooks for a failed action", async () => {
  let narrated = false;
  const driver = {
    async observe() { return observation(); },
    async perform() { return { ok: false, detail: "control did not respond" }; },
    async check() { return true; },
  };
  const result = await new WorkflowExecutor(driver).execute(workflow([{
    kind: "action",
    id: "open-platform",
    action: "click",
    target: { controlId: "platform" },
    narration: "This is the platform section.",
    compatibility: direct("open-platform"),
  }]), {
    onStepCompleted: () => { narrated = true; },
  });
  assert.equal(result.ok, false);
  assert.equal(narrated, false);
});

test("requests one approval before state-changing steps and fails closed without it", async () => {
  const step = {
    kind: "action",
    id: "save",
    action: "click",
    target: { controlId: "save" },
    compatibility: direct("save"),
  };
  const driver = {
    async observe() { return observation(); },
    async perform() { return { ok: true, detail: "saved" }; },
    async check() { return true; },
  };
  const definition = workflow([step], { risk: "reversible_write" });
  const deniedByMissingGate = await new WorkflowExecutor(driver).execute(definition, {
    policy: new DefaultWorkflowPolicy({ maximumRisk: "reversible_write" }),
  });
  assert.equal(deniedByMissingGate.ok, false);
  assert.match(deniedByMissingGate.error, /no approval gate/);

  let approvals = 0;
  const approved = await new WorkflowExecutor(driver).execute(definition, {
    policy: new DefaultWorkflowPolicy({ maximumRisk: "reversible_write" }),
    approvals: { async request() { approvals++; return true; } },
  });
  assert.equal(approved.ok, true);
  assert.equal(approvals, 1);
});

test("does not reuse a policy-generated approval for a later consequential action", async () => {
  let approvals = 0;
  const driver = {
    async observe() { return observation(); },
    async perform() { return { ok: true, detail: "done" }; },
    async check() { return true; },
  };
  const action = (id) => ({
    kind: "action",
    id,
    action: "click",
    target: { controlId: id },
    compatibility: direct(id),
  });
  const result = await new WorkflowExecutor(driver).execute(workflow([
    action("first-write"),
    action("second-write"),
  ], { risk: "reversible_write" }), {
    policy: new DefaultWorkflowPolicy({ maximumRisk: "reversible_write" }),
    approvals: { async request() { approvals++; return true; } },
  });
  assert.equal(result.ok, true);
  assert.equal(approvals, 2);
});

test("scopes an explicit approval to only its bounded child block", async () => {
  let approvals = 0;
  const driver = {
    async observe() { return observation(); },
    async perform() { return { ok: true, detail: "done" }; },
    async check() { return true; },
  };
  const child = (id) => ({
    kind: "action",
    id,
    action: "click",
    target: { controlId: id },
    compatibility: direct(id),
  });
  const wrapper = {
    kind: "approval",
    id: "approve-two-writes",
    reason: "Approve these two related changes",
    then: [child("first-child"), child("second-child")],
    compatibility: direct("approve-two-writes"),
  };
  const result = await new WorkflowExecutor(driver).execute(workflow([
    wrapper,
    child("outside-write"),
  ], { risk: "reversible_write" }), {
    policy: new DefaultWorkflowPolicy({ maximumRisk: "reversible_write" }),
    approvals: { async request() { approvals++; return true; } },
  });
  assert.equal(result.ok, true);
  assert.equal(approvals, 2, "one explicit-block approval plus one fresh approval outside the block");
});

test("blocks a step that did not pass SDK compatibility", async () => {
  let performed = false;
  const driver = {
    async observe() { return observation(); },
    async perform() { performed = true; return { ok: true, detail: "unexpected" }; },
    async check() { return true; },
  };
  const result = await new WorkflowExecutor(driver).execute(workflow([{
    kind: "action",
    id: "upload",
    action: "click",
    target: { controlId: "upload" },
    compatibility: direct("upload", "NEEDS_USER_GESTURE"),
  }]));
  assert.equal(result.ok, false);
  assert.equal(performed, false);
  assert.match(result.error, /NEEDS_USER_GESTURE/);
});

test("honors AbortSignal before any action", async () => {
  let performed = false;
  const driver = {
    async observe() { return observation(); },
    async perform() { performed = true; return { ok: true, detail: "unexpected" }; },
    async check() { return true; },
  };
  const controller = new AbortController();
  controller.abort();
  const result = await new WorkflowExecutor(driver).execute(workflow([{
    kind: "action",
    id: "open",
    action: "click",
    target: { controlId: "open" },
    compatibility: direct("open"),
  }]), { signal: controller.signal });
  assert.equal(result.ok, false);
  assert.equal(performed, false);
  assert.match(result.error, /interrupted/);
});

test("enforces the execution budget inside bounded loops", async () => {
  const driver = {
    async observe() { return observation(); },
    async perform() { return { ok: true, detail: "performed" }; },
    async check() { return false; },
  };
  const child = { kind: "action", id: "next", action: "click", target: { controlId: "next" }, compatibility: direct("next") };
  const loop = { kind: "loop", id: "loop", until: { kind: "text_visible", text: "Done" }, steps: [child], maxIterations: 10, compatibility: direct("loop") };
  const result = await new WorkflowExecutor(driver).execute(workflow([loop]), { maxExecutedSteps: 3 });
  assert.equal(result.ok, false);
  assert.match(result.error, /execution budget/);
});

test("enforces a step timeout through the injected AbortSignal", async () => {
  let receivedSignal = false;
  const driver = {
    async observe() { return observation(); },
    async perform(_action, _expected, signal) {
      receivedSignal = Boolean(signal);
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("driver aborted")), { once: true }));
    },
    async check() { return true; },
  };
  const result = await new WorkflowExecutor(driver).execute(workflow([{
    kind: "action",
    id: "slow",
    action: "click",
    target: { controlId: "slow" },
    timeoutMs: 5,
    compatibility: direct("slow"),
  }]));
  assert.equal(receivedSignal, true);
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out after 5ms/);
});

test("enforces the total duration budget even when a driver never settles", async () => {
  const driver = {
    observe: async () => new Promise(() => undefined),
    perform: async () => ({ ok: true, detail: "ok" }),
    check: async () => ({ ok: true, detail: "ok" }),
  };
  const startedAt = Date.now();
  const result = await new WorkflowExecutor(driver).execute(workflow([{
    kind: "action",
    id: "hung",
    action: "click",
    target: { controlId: "hung" },
    compatibility: direct("hung"),
  }]), {
    maxDurationMs: 10,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /duration budget/);
  assert.ok(Date.now() - startedAt < 1_000);
});

test("telemetry promises cannot delay workflow actions", async () => {
  const driver = {
    async observe() { return observation(); },
    async perform() { return { ok: true, detail: "done" }; },
    async check() { return true; },
  };
  const result = await new WorkflowExecutor(driver).execute(workflow([{
    kind: "action",
    id: "fast",
    action: "click",
    target: { controlId: "fast" },
    compatibility: direct("fast"),
  }]), { telemetry: { record() { return new Promise(() => undefined); } } });
  assert.equal(result.ok, true);
});

test("blocks cross-origin navigation before the driver can perform it", async () => {
  let performed = false;
  const driver = {
    async observe() { return observation(); },
    async perform() { performed = true; return { ok: true, detail: "unexpected" }; },
    async check() { return true; },
  };
  const result = await new WorkflowExecutor(driver).execute(workflow([{
    kind: "action",
    id: "leave-app",
    action: "navigate",
    url: { kind: "literal", value: "https://attacker.example" },
    compatibility: direct("leave-app"),
  }]));
  assert.equal(result.ok, false);
  assert.equal(performed, false);
  assert.match(result.error, /outside the current application origin/);
});

test("allows only a signed resumable navigation to an exact catalog origin", async () => {
  let performed;
  const driver = {
    observe: async () => observation(),
    perform: async (action) => { performed = action; return { ok: true }; },
    check: async () => true,
  };
  const executor = new WorkflowExecutor(driver);
  const step = {
    id: "cross-page", kind: "action", action: "navigate", url: { kind: "literal", value: "https://approved.example/reports" },
    continuity: { kind: "sable.cross_page_continuity", expectedScreenIds: ["reports"], destinationOrigins: ["https://approved.example"] },
    compatibility: direct("cross-page", "SDK_RESUMABLE_NAVIGATION"),
  };
  const result = await executor.execute(workflow([step]), { policy: { authorize: () => ({ allowed: true }) } });
  assert.equal(result.ok, true);
  assert.equal(performed.url, "https://approved.example/reports");
  step.url.value = "https://unapproved.example/reports";
  const rejected = await executor.execute(workflow([step]), { policy: { authorize: () => ({ allowed: true }) } });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /outside the current application origin/);
});

test("a resumed workflow does not repeat source-page preconditions or startUrl", async () => {
  const actions = [];
  const destination = { ...observation(), url: "https://client.example/reports", fingerprint: "reports" };
  const driver = {
    observe: async () => destination,
    perform: async (action) => { actions.push(action); return { ok: true }; },
    check: async () => { throw new Error("source precondition must not run"); },
  };
  const steps = [
    { id: "navigate", kind: "action", action: "navigate", url: { kind: "literal", value: "https://client.example/reports" }, compatibility: direct("navigate") },
    { id: "verify", kind: "action", action: "wait", milliseconds: 1, compatibility: direct("verify") },
  ];
  const result = await new WorkflowExecutor(driver).execute(workflow(steps, {
    startUrl: { kind: "literal", value: "https://client.example/home" },
    preconditions: [{ kind: "text_visible", text: "source only" }],
  }), { startAt: 1 });
  assert.equal(result.ok, true);
  assert.deepEqual(actions.map((action) => action.stepId), ["verify"]);
});

test("a bounded step window succeeds without running later steps or whole-workflow postconditions", async () => {
  const actions = [];
  const driver = {
    observe: async () => observation(),
    perform: async (action) => { actions.push(action.stepId); return { ok: true, detail: "performed" }; },
    check: async () => { throw new Error("whole-workflow postcondition must not run"); },
  };
  const steps = [
    { id: "open", kind: "action", action: "click", target: { controlId: "open" }, compatibility: direct("open") },
    { id: "later", kind: "action", action: "click", target: { controlId: "later" }, compatibility: direct("later") },
  ];
  const result = await new WorkflowExecutor(driver).execute(workflow(steps, {
    postconditions: [{ kind: "text_visible", text: "whole journey complete" }],
  }), { endAtExclusive: 1 });
  assert.equal(result.ok, true);
  assert.deepEqual(actions, ["open"]);
});

test("redacts input values from driver failures and workflow telemetry", async () => {
  const events = [];
  const driver = {
    async observe() { return observation(); },
    async perform() { return { ok: false, detail: "Could not fill super-secret-value" }; },
    async check() { return true; },
  };
  const result = await new WorkflowExecutor(driver).execute(workflow([{
    kind: "action",
    id: "fill-secret",
    action: "fill",
    target: { controlId: "secret" },
    value: { kind: "input_ref", name: "secret" },
    compatibility: direct("fill-secret"),
  }]), {
    inputs: { secret: "super-secret-value" },
    telemetry: { record(event) { events.push(event); } },
  });
  assert.equal(result.ok, false);
  assert.doesNotMatch(JSON.stringify({ result, events }), /super-secret-value/);
  assert.match(result.error, /redacted input/);
});
