import type { RiskLevel, StepCompatibility, ToolDefinition, WorkflowDefinition, WorkflowStep } from "@sable/sdk-contracts";
import { SableSdkError } from "./errors.js";

const RISK_ORDER: RiskLevel[] = ["read", "reversible_write", "external_side_effect", "destructive"];

export interface ApprovalRequest {
  requestId: string;
  reason: string;
  journeyId: string;
  journeyName: string;
  stepId: string;
  risk: RiskLevel;
  expiresAt: string;
}

export type ApprovalHandler = (request: ApprovalRequest, signal?: AbortSignal) => Promise<boolean>;

export interface SafetyOptions {
  maximumRisk?: RiskLevel;
  confirmReversibleWrites?: boolean;
  approvalTimeoutMs?: number;
}

function workflowStepCompatibility(step: WorkflowStep): StepCompatibility {
  return (step as unknown as { compatibility: StepCompatibility }).compatibility;
}

function strongerRisk(left: RiskLevel, right: RiskLevel): RiskLevel {
  return RISK_ORDER.indexOf(left) >= RISK_ORDER.indexOf(right) ? left : right;
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const timer = globalThis.setTimeout(() => finish(() => reject(new SableSdkError("POLICY_BLOCKED", "User confirmation timed out"))), milliseconds);
    const onAbort = () => finish(() => reject(new SableSdkError("ABORTED", "User stopped the action")));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

/** Fixed local policy. Neither the model nor a catalog can weaken these checks. */
export class DeterministicSafetyPolicy {
  private approvalHandler?: ApprovalHandler;
  private readonly maximumRisk: RiskLevel;
  private readonly confirmReversibleWrites: boolean;
  private readonly approvalTimeoutMs: number;

  constructor(options: SafetyOptions = {}, approvalHandler?: ApprovalHandler) {
    this.maximumRisk = options.maximumRisk ?? "reversible_write";
    this.confirmReversibleWrites = options.confirmReversibleWrites ?? true;
    this.approvalTimeoutMs = Math.max(5_000, Math.min(options.approvalTimeoutMs ?? 60_000, 300_000));
    this.approvalHandler = approvalHandler;
  }

  setApprovalHandler(handler: ApprovalHandler | undefined): void {
    this.approvalHandler = handler;
  }

  riskFor(step: WorkflowStep, workflow: WorkflowDefinition): RiskLevel {
    return strongerRisk(workflow.risk, step.risk ?? "read");
  }

  async authorize(step: WorkflowStep, workflow: WorkflowDefinition): Promise<{ allowed: boolean; reason?: string }> {
    const compatibility = workflowStepCompatibility(step);
    if (!compatibility || !["SDK_DIRECT", "SDK_RESUMABLE_NAVIGATION", "NEEDS_REGISTERED_TOOL"].includes(compatibility.classification)) {
      return { allowed: false, reason: compatibility?.reason ?? "Step has no verified Web SDK compatibility result" };
    }
    if (compatibility.classification === "SDK_RESUMABLE_NAVIGATION"
      && !(workflow.risk === "read" && step.kind === "action" && step.action === "navigate" && !!step.continuity)) {
      return { allowed: false, reason: "Resumable navigation is allowed only for signed read-only navigate steps" };
    }
    if (RISK_ORDER.indexOf(this.riskFor(step, workflow)) > RISK_ORDER.indexOf(this.maximumRisk)) {
      return { allowed: false, reason: `${this.riskFor(step, workflow)} exceeds the local maximum risk ${this.maximumRisk}` };
    }
    return { allowed: true };
  }

  shouldConfirm(step: WorkflowStep, workflow: WorkflowDefinition, tool?: ToolDefinition): boolean {
    const toolConfirmation = tool && (tool as unknown as Record<string, unknown>).confirmation;
    if (toolConfirmation === "always") return true;
    if (toolConfirmation === "never" && this.riskFor(step, workflow) === "read") return false;
    const risk = this.riskFor(step, workflow);
    return risk === "external_side_effect" || risk === "destructive" || (risk === "reversible_write" && this.confirmReversibleWrites);
  }

  async confirm(step: WorkflowStep, workflow: WorkflowDefinition, reason: string, signal?: AbortSignal): Promise<boolean> {
    if (!this.approvalHandler) return false;
    const risk = this.riskFor(step, workflow);
    const request: ApprovalRequest = {
      requestId: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
      reason,
      journeyId: workflow.id,
      journeyName: workflow.name,
      stepId: step.id,
      risk,
      expiresAt: new Date(Date.now() + this.approvalTimeoutMs).toISOString(),
    };
    return withTimeout(this.approvalHandler(request, signal), this.approvalTimeoutMs, signal);
  }
}
