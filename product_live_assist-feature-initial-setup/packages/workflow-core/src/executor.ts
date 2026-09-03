import type {
  ActionWorkflowStep,
  JsonValue,
  ResolvedAction,
  RiskLevel,
  ScreenObservation,
  TemplateValue,
  WorkflowAssertion,
  WorkflowDefinition,
  WorkflowStep,
} from "@sable/sdk-contracts";
import { DefaultWorkflowPolicy, greaterRisk } from "./policy.js";
import { resolveTemplate } from "./templates.js";
import type {
  ActionDriver,
  ApprovalContext,
  ExecuteOptions,
  PolicyDecision,
  WorkflowRunEvent,
  WorkflowRunResult,
} from "./types.js";

const HARD_MAX_EXECUTED_STEPS = 2_000;
const HARD_MAX_LOOP_ITERATIONS = 20;
const HARD_MAX_NESTING_DEPTH = 20;
const HARD_MAX_DURATION_MS = 600_000;
const RISK_ORDER: RiskLevel[] = ["read", "reversible_write", "external_side_effect", "destructive"];

function abortError(message = "workflow interrupted"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function runWithTimeout<T>(
  operation: (signal?: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
  stepId: string,
): Promise<T> {
  if (parentSignal?.aborted) throw abortError();
  if (timeoutMs === undefined) return raceAbort(operation(parentSignal), parentSignal);
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = () => controller.abort();
  if (parentSignal?.aborted) controller.abort();
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await raceAbort(operation(controller.signal), controller.signal);
  } catch (error) {
    if (timedOut) throw new Error(`step ${stepId} timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

function materializeAssertion(assertion: WorkflowAssertion, inputs: Readonly<Record<string, JsonValue>>): WorkflowAssertion {
  if (assertion.kind !== "tool_check" || assertion.input === undefined) return assertion;
  return { ...assertion, input: { kind: "literal", value: resolveTemplate(assertion.input, inputs) } };
}

function asString(value: JsonValue, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must resolve to a string`);
  return value;
}

function safeDetail(value: string, inputs: Readonly<Record<string, JsonValue>>): string {
  let detail = value.slice(0, 2_000)
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]");
  const inputStrings = new Set<string>();
  const collectStrings = (input: JsonValue, depth = 0): void => {
    if (depth > 20) return;
    if (typeof input === "string") {
      if (input.length >= 3) inputStrings.add(input);
      return;
    }
    if (Array.isArray(input)) {
      input.forEach((item) => collectStrings(item, depth + 1));
      return;
    }
    if (input && typeof input === "object") {
      Object.values(input).forEach((item) => collectStrings(item, depth + 1));
    }
  };
  Object.values(inputs).forEach((input) => collectStrings(input));
  for (const input of [...inputStrings].sort((left, right) => right.length - left.length)) {
    detail = detail.split(input).join("[redacted input]");
  }
  return detail;
}

function validatedNavigation(url: string, observation: ScreenObservation, step: ActionWorkflowStep): string {
  let destination: URL;
  try {
    destination = new URL(url, observation.url);
  } catch {
    throw new Error(`step ${step.id} resolved to an invalid navigation URL`);
  }
  if (destination.origin !== observation.origin) {
    const allowed = step.action === "navigate"
      && step.compatibility.classification === "SDK_RESUMABLE_NAVIGATION"
      && step.continuity?.destinationOrigins.includes(destination.origin);
    if (!allowed) throw new Error(`step ${step.id} cannot navigate outside the current application origin`);
  }
  return destination.toString();
}

function sameOriginStartNavigation(url: string, observation: ScreenObservation): string {
  let destination: URL;
  try { destination = new URL(url, observation.url); }
  catch { throw new Error("workflow startUrl resolved to an invalid navigation URL"); }
  if (destination.origin !== observation.origin) throw new Error("workflow startUrl cannot navigate outside the current application origin");
  return destination.toString();
}

function materializeAction(step: ActionWorkflowStep, inputs: Readonly<Record<string, JsonValue>>): ResolvedAction {
  const base = { kind: "sable.resolved_action" as const, stepId: step.id, action: step.action };
  if (step.action === "navigate") return { ...base, url: asString(resolveTemplate(step.url, inputs), `step ${step.id} url`) };
  if (step.action === "click" || step.action === "hover") return { ...base, target: step.target };
  if (step.action === "fill") return { ...base, target: step.target, value: resolveTemplate(step.value, inputs), ...(step.submit === undefined ? {} : { submit: step.submit }) };
  if (step.action === "select") return { ...base, target: step.target, value: resolveTemplate(step.value, inputs) };
  if (step.action === "scroll") return {
    ...base,
    direction: step.direction,
    ...(step.amount === undefined ? {} : { amount: step.amount }),
    ...(step.target === undefined ? {} : { target: step.target }),
  };
  if (step.action === "keypress") return { ...base, key: step.key, ...(step.target === undefined ? {} : { target: step.target }) };
  if (step.action === "drag") return { ...base, source: step.source, target: step.target };
  if (step.action === "wait") return {
    ...base,
    ...(step.milliseconds === undefined ? {} : { milliseconds: step.milliseconds }),
    ...(step.until === undefined ? {} : { until: materializeAssertion(step.until, inputs) }),
  };
  return { ...base, toolName: step.toolName, input: resolveTemplate(step.input, inputs) };
}

function checkWorkflowStructure(workflow: WorkflowDefinition, maximumLoopIterations: number): void {
  if (workflow.kind !== "sable.workflow" || workflow.schemaVersion !== 1) throw new Error("unsupported workflow contract");
  if (!workflow.steps.length) throw new Error("workflow has no steps");
  const ids = new Set<string>();
  let structuralSteps = 0;
  const walk = (steps: WorkflowStep[], depth: number): void => {
    if (depth > HARD_MAX_NESTING_DEPTH) throw new Error(`workflow exceeds the ${HARD_MAX_NESTING_DEPTH}-level nesting limit`);
    for (const step of steps) {
      structuralSteps++;
      if (structuralSteps > 500) throw new Error("workflow exceeds the 500-step structural limit");
      if (!step.id?.trim()) throw new Error("workflow step id is required");
      if (ids.has(step.id)) throw new Error(`workflow step id ${step.id} is duplicated`);
      ids.add(step.id);
      if (!step.compatibility || step.compatibility.stepId !== step.id) throw new Error(`workflow step ${step.id} has invalid compatibility metadata`);
      if (step.kind === "loop") {
        if (!Number.isInteger(step.maxIterations) || step.maxIterations < 1 || step.maxIterations > maximumLoopIterations) {
          throw new Error(`workflow step ${step.id} exceeds the ${maximumLoopIterations}-iteration limit`);
        }
        walk(step.steps, depth + 1);
      } else if (step.kind === "branch") {
        walk(step.then, depth + 1);
        walk(step.otherwise ?? [], depth + 1);
      } else if (step.kind === "approval") walk(step.then, depth + 1);
    }
  };
  walk(workflow.steps, 0);
}

function riskIndex(risk: RiskLevel): number {
  return RISK_ORDER.indexOf(risk);
}

/**
 * Browser-neutral deterministic executor. Client specificity belongs entirely
 * in the signed workflow data and injected driver/tool implementation.
 */
export class WorkflowExecutor {
  constructor(private readonly driver: ActionDriver) {}

  async execute(workflow: WorkflowDefinition, options: ExecuteOptions = {}): Promise<WorkflowRunResult> {
    const maximumSteps = Math.max(1, Math.min(options.maxExecutedSteps ?? 200, HARD_MAX_EXECUTED_STEPS));
    const maximumLoopIterations = Math.max(1, Math.min(options.maxLoopIterations ?? HARD_MAX_LOOP_ITERATIONS, HARD_MAX_LOOP_ITERATIONS));
    const maximumDurationMs = Math.max(1, Math.min(options.maxDurationMs ?? 300_000, HARD_MAX_DURATION_MS));
    checkWorkflowStructure(workflow, maximumLoopIterations);

    // This deadline actively aborts every awaited driver/policy/approval call.
    // Checking elapsed time only between steps would not bound a hung adapter.
    const executionController = new AbortController();
    let deadlineExceeded = false;
    const onExternalAbort = () => executionController.abort();
    if (options.signal?.aborted) executionController.abort();
    else options.signal?.addEventListener("abort", onExternalAbort, { once: true });
    const deadlineTimer = setTimeout(() => {
      deadlineExceeded = true;
      executionController.abort();
    }, maximumDurationMs);
    const executionSignal = executionController.signal;

    const inputs: Readonly<Record<string, JsonValue>> = Object.freeze({ ...(options.inputs ?? {}) });
    const policy = options.policy ?? new DefaultWorkflowPolicy();
    const events: WorkflowRunEvent[] = [];
    const startedAt = Date.now();
    let sequence = 0;
    let executedSteps = 0;
    let completedSteps = 0;
    let currentStepId: string | undefined;
    let baseline: ScreenObservation | undefined;

    const emit = async (type: WorkflowRunEvent["type"], fields: Omit<WorkflowRunEvent, "kind" | "type" | "at" | "workflowId" | "sequence"> = {}) => {
      const event: WorkflowRunEvent = {
        kind: "sable.workflow_run_event",
        type,
        at: new Date().toISOString(),
        workflowId: workflow.id,
        sequence: ++sequence,
        ...fields,
      };
      events.push(event);
      if (options.telemetry) {
        try {
          const pending = options.telemetry.record(event);
          if (pending && typeof (pending as Promise<void>).catch === "function") {
            void (pending as Promise<void>).catch(() => undefined);
          }
        } catch {
          // Execution and safety must not depend on an observability backend.
        }
      }
    };

    const ensureActive = (): void => {
      if (deadlineExceeded || Date.now() - startedAt >= maximumDurationMs) throw new Error(`workflow exceeded its ${maximumDurationMs}ms duration budget`);
      if (executionSignal.aborted || options.shouldStop?.()) throw abortError();
      if (executedSteps > maximumSteps) throw new Error(`workflow exceeded its ${maximumSteps}-step execution budget`);
    };

    const observe = (signal: AbortSignal | undefined = executionSignal): Promise<ScreenObservation> => {
      ensureActive();
      return raceAbort(this.driver.observe(signal), signal);
    };

    const assert = async (rawAssertion: WorkflowAssertion, base?: ScreenObservation, signal: AbortSignal | undefined = executionSignal): Promise<boolean> => {
      ensureActive();
      const assertion = materializeAssertion(rawAssertion, inputs);
      const checked = await raceAbort(this.driver.check(assertion, base, signal), signal);
      const ok = typeof checked === "boolean" ? checked : checked.ok;
      const detail = typeof checked === "boolean" ? `${assertion.kind}: ${ok ? "passed" : "failed"}` : safeDetail(checked.detail, inputs);
      await emit("assertion", { ok, detail });
      return ok;
    };

    const requestApproval = async (step: WorkflowStep, reason: string, observation: ScreenObservation, signal: AbortSignal | undefined = executionSignal): Promise<number> => {
      const risk = greaterRisk(workflow.risk, step.risk ?? "read");
      if (!options.approvals) throw new Error(`approval required at ${step.id}, but no approval gate is configured`);
      const context: ApprovalContext = { workflow, step, reason, risk, observation };
      await emit("approval_requested", { stepId: step.id, detail: reason });
      const approved = await raceAbort(options.approvals.request(context, signal), signal);
      await emit("approval_resolved", { stepId: step.id, ok: approved, detail: approved ? "approved" : "denied" });
      if (!approved) throw new Error(`approval denied at ${step.id}`);
      return riskIndex(risk);
    };

    const authorize = async (
      step: WorkflowStep,
      observation: ScreenObservation,
      approvalScope: number | undefined,
      signal: AbortSignal | undefined = executionSignal,
    ): Promise<PolicyDecision> => {
      const risk = greaterRisk(workflow.risk, step.risk ?? "read");
      const approvalGranted = approvalScope !== undefined && approvalScope >= riskIndex(risk);
      const decision = await raceAbort(Promise.resolve(policy.authorize({
        workflow,
        step,
        observation,
        inputs,
        approvalGranted,
      }, signal)), signal);
      if (!decision.allowed) throw new Error(decision.reason || `step ${step.id} was blocked by policy`);
      if (decision.requiresApproval && !approvalGranted) {
        await requestApproval(step, decision.approvalReason ?? decision.reason ?? `Approve ${workflow.name}`, observation, signal);
      }
      return decision;
    };

    try {
      await emit("workflow_started");
      baseline = await observe();
      const startAt = Math.max(0, Math.min(options.startAt ?? 0, workflow.steps.length));
      const endAtExclusive = Math.max(startAt, Math.min(options.endAtExclusive ?? workflow.steps.length, workflow.steps.length));
      // A signed checkpoint proves the source-page portion already ran. Rechecking
      // source preconditions or startUrl on the destination would navigate back.
      if (startAt === 0) {
        for (const precondition of workflow.preconditions) {
          if (!(await assert(precondition, baseline))) throw new Error(`precondition failed: ${precondition.kind}`);
        }

        if (workflow.startUrl) {
          const current = await observe();
          const url = sameOriginStartNavigation(asString(resolveTemplate(workflow.startUrl, inputs), "workflow startUrl"), current);
          if (current.url !== url && !current.url.startsWith(`${url}#`)) {
            const result = await raceAbort(this.driver.perform({ kind: "sable.resolved_action", stepId: "__start", action: "navigate", url }, current, executionSignal), executionSignal);
            if (!result.ok) throw new Error(safeDetail(result.detail, inputs));
          }
        }
      }

      const runSteps = async (
        steps: WorkflowStep[],
        topLevelOffset: number,
        inheritedTopLevelIndex?: number,
        parentSignal: AbortSignal | undefined = executionSignal,
        approvalScope?: number,
      ): Promise<void> => {
        for (let index = 0; index < steps.length; index++) {
          ensureActive();
          const step = steps[index];
          if (!step) continue;
          const topLevelIndex = inheritedTopLevelIndex ?? index + topLevelOffset;
          executedSteps++;
          currentStepId = step.id;
          if (options.onStep) await raceAbort(Promise.resolve(options.onStep(step, topLevelIndex)), parentSignal);
          ensureActive();
          await emit("step_started", { stepId: step.id });

          try {
            await runWithTimeout(async (stepSignal) => {
              const observation = await observe(stepSignal);
              await authorize(step, observation, approvalScope, stepSignal);
              if (step.kind === "action") {
                let action = materializeAction(step, inputs);
                if (action.action === "navigate" && action.url) action = { ...action, url: validatedNavigation(action.url, observation, step) };
                const result = await raceAbort(this.driver.perform(action, observation, stepSignal), stepSignal);
                if (!result.ok) throw new Error(safeDetail(result.detail, inputs));
              } else if (step.kind === "assert") {
                if (!(await assert(step.assertion, baseline, stepSignal))) throw new Error(`assertion failed at ${step.id}`);
              } else if (step.kind === "approval") {
                // An explicit approval node intentionally scopes one decision to
                // its bounded child block. Policy-generated approvals for normal
                // steps are never retained and must be fresh for the next step.
                const approvedRisk = await requestApproval(step, step.reason, observation, stepSignal);
                await runSteps(step.then, 0, topLevelIndex, stepSignal, Math.max(approvalScope ?? -1, approvedRisk));
              } else if (step.kind === "branch") {
                const matched = await assert(step.condition, baseline, stepSignal);
                await runSteps(matched ? step.then : step.otherwise ?? [], 0, topLevelIndex, stepSignal, approvalScope);
              } else {
                let satisfied = await assert(step.until, baseline, stepSignal);
                let iterations = 0;
                while (!satisfied && iterations < Math.min(step.maxIterations, maximumLoopIterations)) {
                  iterations++;
                  await runSteps(step.steps, 0, topLevelIndex, stepSignal, approvalScope);
                  satisfied = await assert(step.until, baseline, stepSignal);
                }
                if (!satisfied) throw new Error(`loop condition not satisfied at ${step.id}`);
              }
            }, parentSignal, step.timeoutMs, step.id);
            completedSteps++;
            await emit("step_completed", { stepId: step.id, ok: true });
          } catch (error) {
            const original = error as Error;
            const detail = safeDetail(original.message, inputs);
            if (step.optional && original.name !== "AbortError") {
              await emit("step_skipped", { stepId: step.id, ok: false, detail });
              continue;
            }
            await emit("step_failed", { stepId: step.id, ok: false, detail });
            const safeError = new Error(detail);
            safeError.name = original.name;
            throw safeError;
          }
          if (options.onStepCompleted) {
            await raceAbort(Promise.resolve(options.onStepCompleted(step, topLevelIndex)), parentSignal);
          }
        }
      };

      await runSteps(workflow.steps.slice(startAt, endAtExclusive), startAt);
      const finalScreen = await observe();
      if (endAtExclusive === workflow.steps.length) {
        for (const postcondition of workflow.postconditions) {
          if (!(await assert(postcondition, baseline))) throw new Error(`postcondition failed: ${postcondition.kind}`);
        }
      }
      await emit("workflow_completed", { ok: true });
      return { ok: true, completedSteps, events, finalScreen };
    } catch (error) {
      const failure = error as Error;
      const failureMessage = deadlineExceeded
        ? `workflow exceeded its ${maximumDurationMs}ms duration budget`
        : safeDetail(failure.message, inputs);
      await emit("workflow_failed", { ...(currentStepId === undefined ? {} : { stepId: currentStepId }), ok: false, detail: failureMessage });
      let finalScreen: ScreenObservation | undefined;
      if (failure.name !== "AbortError" && !executionSignal.aborted && !options.shouldStop?.()) {
        try {
          finalScreen = await raceAbort(this.driver.observe(executionSignal), executionSignal);
        } catch {
          // Preserve the original execution failure.
        }
      }
      return {
        ok: false,
        completedSteps,
        ...(currentStepId === undefined ? {} : { failedStepId: currentStepId }),
        error: failureMessage,
        events,
        ...(finalScreen === undefined ? {} : { finalScreen }),
      };
    } finally {
      clearTimeout(deadlineTimer);
      options.signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}
