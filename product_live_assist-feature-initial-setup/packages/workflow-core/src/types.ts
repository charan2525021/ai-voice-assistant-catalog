import type {
  JsonValue,
  ResolvedAction,
  RiskLevel,
  ScreenObservation,
  WorkflowAssertion,
  WorkflowDefinition,
  WorkflowStep,
} from "@sable/sdk-contracts";

export interface DriverResult {
  ok: boolean;
  detail: string;
  observation?: ScreenObservation;
}

export interface ActionDriver {
  observe(signal?: AbortSignal): Promise<ScreenObservation>;
  perform(action: ResolvedAction, expected: ScreenObservation, signal?: AbortSignal): Promise<DriverResult>;
  check(assertion: WorkflowAssertion, baseline?: ScreenObservation, signal?: AbortSignal): Promise<boolean | DriverResult>;
}

export interface PolicyContext {
  workflow: WorkflowDefinition;
  step: WorkflowStep;
  observation?: ScreenObservation;
  inputs: Readonly<Record<string, JsonValue>>;
  approvalGranted: boolean;
}

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
  requiresApproval?: boolean;
  approvalReason?: string;
}

export interface WorkflowPolicyGate {
  authorize(context: PolicyContext, signal?: AbortSignal): PolicyDecision | Promise<PolicyDecision>;
}

export interface ApprovalContext {
  workflow: WorkflowDefinition;
  step: WorkflowStep;
  reason: string;
  risk: RiskLevel;
  observation: ScreenObservation;
}

export interface ApprovalGate {
  request(context: ApprovalContext, signal?: AbortSignal): Promise<boolean>;
}

export type WorkflowRunEventType =
  | "workflow_started"
  | "workflow_completed"
  | "workflow_failed"
  | "step_started"
  | "step_completed"
  | "step_skipped"
  | "step_failed"
  | "assertion"
  | "approval_requested"
  | "approval_resolved";

export interface WorkflowRunEvent {
  kind: "sable.workflow_run_event";
  type: WorkflowRunEventType;
  at: string;
  workflowId: string;
  stepId?: string;
  sequence: number;
  ok?: boolean;
  detail?: string;
}

export interface WorkflowTelemetry {
  record(event: WorkflowRunEvent): void | Promise<void>;
}

export interface WorkflowRunResult {
  ok: boolean;
  completedSteps: number;
  failedStepId?: string;
  error?: string;
  events: WorkflowRunEvent[];
  finalScreen?: ScreenObservation;
}

export interface ExecuteOptions {
  inputs?: Record<string, JsonValue>;
  signal?: AbortSignal;
  /** Supports voice or host interruption sources that cannot expose an AbortSignal. */
  shouldStop?: () => boolean;
  /** Resume only at a top-level step boundary. */
  startAt?: number;
  /** Stop successfully at this top-level boundary and skip whole-workflow postconditions. */
  endAtExclusive?: number;
  /** Runs before a step. Intended for safe-boundary pause checks, not narration. */
  onStep?: (step: WorkflowStep, topLevelIndex: number) => void | Promise<void>;
  /** Runs only after the step has completed successfully. */
  onStepCompleted?: (step: WorkflowStep, topLevelIndex: number) => void | Promise<void>;
  policy?: WorkflowPolicyGate;
  approvals?: ApprovalGate;
  telemetry?: WorkflowTelemetry;
  maxExecutedSteps?: number;
  maxLoopIterations?: number;
  maxDurationMs?: number;
}
