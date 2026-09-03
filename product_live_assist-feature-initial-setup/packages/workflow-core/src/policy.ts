import type { RiskLevel, StepCompatibilityClass } from "@sable/sdk-contracts";
import type { PolicyContext, PolicyDecision, WorkflowPolicyGate } from "./types.js";

const RISK_ORDER: RiskLevel[] = ["read", "reversible_write", "external_side_effect", "destructive"];

export interface DefaultWorkflowPolicyOptions {
  maximumRisk?: RiskLevel;
  confirmationAtOrAbove?: RiskLevel;
  allowedCompatibility?: readonly StepCompatibilityClass[];
}

export function greaterRisk(first: RiskLevel, second: RiskLevel): RiskLevel {
  return RISK_ORDER.indexOf(first) >= RISK_ORDER.indexOf(second) ? first : second;
}

export class DefaultWorkflowPolicy implements WorkflowPolicyGate {
  private readonly maximumRisk: RiskLevel;
  private readonly confirmationAtOrAbove: RiskLevel;
  private readonly allowedCompatibility: Set<StepCompatibilityClass>;

  constructor(options: DefaultWorkflowPolicyOptions = {}) {
    this.maximumRisk = options.maximumRisk ?? "reversible_write";
    this.confirmationAtOrAbove = options.confirmationAtOrAbove ?? "reversible_write";
    this.allowedCompatibility = new Set(options.allowedCompatibility ?? ["SDK_DIRECT", "SDK_RESUMABLE_NAVIGATION", "NEEDS_REGISTERED_TOOL"]);
  }

  authorize(context: PolicyContext): PolicyDecision {
    const compatibility = context.step.compatibility.classification;
    if (!this.allowedCompatibility.has(compatibility)) {
      return { allowed: false, reason: `step ${context.step.id} is classified ${compatibility}` };
    }
    if (compatibility === "NEEDS_REGISTERED_TOOL" && !(context.step.kind === "action" && context.step.action === "tool_call")) {
      return { allowed: false, reason: `step ${context.step.id} requires a registered tool action` };
    }
    if (compatibility === "SDK_RESUMABLE_NAVIGATION" && !(context.workflow.risk === "read" && context.step.kind === "action" && context.step.action === "navigate" && !!context.step.continuity)) {
      return { allowed: false, reason: `step ${context.step.id} is not a read-only resumable navigation` };
    }
    const risk = greaterRisk(context.workflow.risk, context.step.risk ?? "read");
    if (RISK_ORDER.indexOf(risk) > RISK_ORDER.indexOf(this.maximumRisk)) {
      return { allowed: false, reason: `${risk} exceeds the configured maximum risk ${this.maximumRisk}` };
    }
    // Explicit approval steps ask once and then authorize their contained
    // steps. Requiring another policy-generated approval at the wrapper would
    // create duplicate prompts.
    const requiresApproval = context.step.kind !== "approval" && !context.approvalGranted && RISK_ORDER.indexOf(risk) >= RISK_ORDER.indexOf(this.confirmationAtOrAbove);
    return {
      allowed: true,
      ...(requiresApproval ? { requiresApproval: true, approvalReason: `Approve ${context.workflow.name} (${risk})` } : {}),
    };
  }
}
