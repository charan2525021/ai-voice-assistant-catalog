import type { ScreenState } from "../runtime/screen-state.js";
import { assertValidWorkflow, type PrimitiveWorkflowStep, type WorkflowAssertion, type WorkflowDefinition, type WorkflowRisk, type WorkflowStep } from "./schema.js";
import { emit } from "../events.js";

export interface DriverResult {
  ok: boolean;
  detail: string;
}

export interface ActionDriver {
  observe(): Promise<ScreenState>;
  perform(step: PrimitiveWorkflowStep, expected: ScreenState, signal?: AbortSignal): Promise<DriverResult>;
  check(assertion: WorkflowAssertion, baseline?: ScreenState): Promise<boolean>;
}

export interface WorkflowPolicyGate {
  authorize(step: WorkflowStep, workflow: WorkflowDefinition): Promise<{ allowed: boolean; reason?: string }>;
}

export interface ApprovalGate {
  request(reason: string, workflow: WorkflowDefinition, signal?: AbortSignal): Promise<boolean>;
}

export interface WorkflowRunEvent {
  type: "step_started" | "step_completed" | "step_failed" | "assertion" | "approval";
  stepId?: string;
  detail?: string;
  at: string;
}

export interface WorkflowRunResult {
  ok: boolean;
  completedSteps: number;
  failedStepId?: string;
  error?: string;
  events: WorkflowRunEvent[];
  finalScreen?: ScreenState;
}

export interface ExecuteOptions {
  signal?: AbortSignal;
  /** Useful when interruption comes from a voice subsystem rather than AbortSignal. */
  shouldStop?: () => boolean;
  /** Resume a flat, previously verified workflow at this top-level step. */
  startAt?: number;
  onStep?: (step: WorkflowStep, index: number) => void | Promise<void>;
  policy?: WorkflowPolicyGate;
  approvals?: ApprovalGate;
  maxExecutedSteps?: number;
}

const RISK_ORDER: WorkflowRisk[] = ["read", "reversible_write", "external_side_effect", "destructive"];

export class DefaultWorkflowPolicy implements WorkflowPolicyGate {
  constructor(private readonly maximumRisk: WorkflowRisk = "reversible_write") {}
  async authorize(step: WorkflowStep, workflow: WorkflowDefinition): Promise<{ allowed: boolean; reason?: string }> {
    // A workflow's declared risk is the floor for every contained step. This
    // prevents a destructive workflow from bypassing policy by omitting risk on
    // individual actions.
    const workflowRisk = workflow.risk ?? "read";
    const stepRisk = step.risk ?? "read";
    const risk = RISK_ORDER.indexOf(stepRisk) > RISK_ORDER.indexOf(workflowRisk) ? stepRisk : workflowRisk;
    const allowed = RISK_ORDER.indexOf(risk) <= RISK_ORDER.indexOf(this.maximumRisk);
    return allowed ? { allowed: true } : { allowed: false, reason: `${risk} actions require a stricter approval policy` };
  }
}

function abortError(): Error {
  const error = new Error("workflow interrupted");
  error.name = "AbortError";
  return error;
}

/**
 * Product-neutral deterministic executor.  All client specificity is in the
 * WorkflowDefinition and ActionDriver adapter; this file contains no SaaS,
 * selector, URL, or product-name conditions.
 */
export class WorkflowExecutor {
  constructor(private readonly driver: ActionDriver) {}

  async execute(workflow: WorkflowDefinition, options: ExecuteOptions = {}): Promise<WorkflowRunResult> {
    assertValidWorkflow(workflow);
    const events: WorkflowRunEvent[] = [];
    const policy = options.policy ?? new DefaultWorkflowPolicy();
    const maximum = options.maxExecutedSteps ?? 200;
    let completedSteps = 0;
    let replayIndex = 0;
    let baseline: ScreenState | undefined;

    const ensureActive = () => {
      if (options.signal?.aborted || options.shouldStop?.()) throw abortError();
      if (completedSteps >= maximum) throw new Error(`workflow exceeded its ${maximum}-step execution budget`);
    };
    const assertion = async (value: WorkflowAssertion, base?: ScreenState) => {
      ensureActive();
      const ok = await this.driver.check(value, base);
      events.push({ type: "assertion", detail: `${value.kind}: ${ok ? "passed" : "failed"}`, at: new Date().toISOString() });
      return ok;
    };

    try {
      baseline = await this.driver.observe();
      for (const precondition of workflow.preconditions) {
        if (!(await assertion(precondition, baseline))) throw new Error(`precondition failed: ${precondition.kind}`);
      }

      const runSteps = async (steps: WorkflowStep[], offset = 0): Promise<void> => {
        for (let index = 0; index < steps.length; index++) {
          ensureActive();
          const step = steps[index];
          const tracedIndex = ++replayIndex;
          const authorized = await policy.authorize(step, workflow);
          if (!authorized.allowed) {
            const detail = authorized.reason || `step ${step.id} was blocked by policy`;
            emit("journey.replay.step", { status: "error", error: detail, data: {
              index: tracedIndex, programIndex: index + offset, stepId: step.id,
              action: step.action, ok: false, detail,
            } });
            throw new Error(detail);
          }
          await options.onStep?.(step, index + offset);
          ensureActive();
          events.push({ type: "step_started", stepId: step.id, at: new Date().toISOString() });

          if (step.action === "assert") {
            const ok = await assertion(step.assertion, baseline);
            const detail = `${step.assertion.kind}: ${ok ? "passed" : "failed"}`;
            emit("journey.replay.step", { status: ok ? "ok" : "error", error: ok ? undefined : detail, data: {
              index: tracedIndex, programIndex: index + offset, stepId: step.id,
              action: step.action, ok, detail,
            } });
            if (!ok && !step.optional) throw new Error(`assertion failed at ${step.id}`);
          } else if (step.action === "approval") {
            const approved = await options.approvals?.request(step.reason, workflow, options.signal);
            events.push({ type: "approval", stepId: step.id, detail: approved ? "approved" : "denied", at: new Date().toISOString() });
            emit("journey.replay.step", { status: approved ? "ok" : "error", error: approved ? undefined : "approval denied", data: {
              index: tracedIndex, programIndex: index + offset, stepId: step.id,
              action: step.action, ok: !!approved, detail: approved ? "approved" : "denied",
            } });
            if (!approved) throw new Error(`approval denied at ${step.id}`);
            await runSteps(step.then);
          } else if (step.action === "branch") {
            const matched = await assertion(step.condition, baseline);
            emit("journey.replay.step", { status: "ok", data: {
              index: tracedIndex, programIndex: index + offset, stepId: step.id,
              action: step.action, ok: true, detail: matched ? "then branch selected" : "otherwise branch selected",
            } });
            await runSteps(matched ? step.then : step.otherwise ?? []);
          } else if (step.action === "loop") {
            let satisfied = await assertion(step.until, baseline);
            let iterations = 0;
            for (let iteration = 0; !satisfied && iteration < step.maxIterations; iteration++) {
              iterations++;
              await runSteps(step.steps);
              satisfied = await assertion(step.until, baseline);
            }
            emit("journey.replay.step", { status: satisfied || step.optional ? "ok" : "error", error: satisfied || step.optional ? undefined : "loop condition not satisfied", data: {
              index: tracedIndex, programIndex: index + offset, stepId: step.id,
              action: step.action, ok: satisfied || !!step.optional,
              detail: `loop ran ${iterations} time(s); condition ${satisfied ? "passed" : "failed"}`,
            } });
            if (!satisfied && !step.optional) throw new Error(`loop condition not satisfied at ${step.id}`);
          } else {
            // Observe immediately before acting.  The driver receives that exact
            // observation and can reject the action if the screen changed between
            // resolution and execution.
            const expected = await this.driver.observe();
            const result = await this.driver.perform(step, expected, options.signal);
            const target = "target" in step && step.action !== "drag" ? step.target : undefined;
            const targetName = target?.accessibleName ?? target?.label ?? target?.text;
            const tracedValue = /password|secret|api\s*key|token|authorization|cookie/i.test(targetName ?? "")
              ? "[redacted]"
              : step.action === "fill" || step.action === "select" ? step.value : undefined;
            emit("journey.replay.step", { status: result.ok ? "ok" : "error", error: result.ok ? undefined : result.detail, data: {
              index: tracedIndex, programIndex: index + offset, stepId: step.id,
              action: step.action, role: target?.role,
              name: targetName,
              value: tracedValue,
              ok: result.ok, detail: result.detail,
            } });
            if (!result.ok && !step.optional) throw new Error(result.detail);
            events.push({ type: result.ok ? "step_completed" : "step_failed", stepId: step.id, detail: result.detail, at: new Date().toISOString() });
          }
          completedSteps++;
        }
      };

      if (workflow.startUrl) {
        const current = await this.driver.observe();
        if (!current.url.startsWith(workflow.startUrl)) {
          const result = await this.driver.perform({ id: "__start", action: "navigate", url: workflow.startUrl }, current, options.signal);
          emit("journey.replay.step", { status: result.ok ? "ok" : "error", error: result.ok ? undefined : result.detail, data: {
            index: 0, programIndex: -1, stepId: "__start", action: "navigate",
            value: workflow.startUrl, ok: result.ok, detail: result.detail,
          } });
          if (!result.ok) throw new Error(result.detail);
        }
      }
      const startAt = Math.max(0, Math.min(options.startAt ?? 0, workflow.steps.length));
      await runSteps(workflow.steps.slice(startAt), startAt);
      const finalScreen = await this.driver.observe();
      for (const postcondition of workflow.postconditions) {
        if (!(await assertion(postcondition, baseline))) throw new Error(`postcondition failed: ${postcondition.kind}`);
      }
      return { ok: true, completedSteps, events, finalScreen };
    } catch (error) {
      const e = error as Error;
      const last = [...events].reverse().find((event) => event.stepId);
      events.push({ type: "step_failed", stepId: last?.stepId, detail: e.message, at: new Date().toISOString() });
      return {
        ok: false,
        completedSteps,
        failedStepId: last?.stepId,
        error: e.message,
        events,
        finalScreen: await this.driver.observe().catch(() => undefined),
      };
    }
  }
}
