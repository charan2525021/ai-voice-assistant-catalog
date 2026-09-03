export const WORKFLOW_SCHEMA_VERSION = 1 as const;

export type WorkflowRisk = "read" | "reversible_write" | "external_side_effect" | "destructive";

export interface WorkflowTarget {
  role?: string;
  accessibleName?: string;
  label?: string;
  text?: string;
  testId?: string;
  /** Last resort for client UIs that expose no semantic locator. */
  cssFallback?: string;
}

export type WorkflowAssertion =
  | { kind: "text_visible"; text: string }
  | { kind: "text_absent"; text: string }
  | { kind: "url_matches"; pattern: string }
  | { kind: "element_visible"; target: WorkflowTarget }
  | { kind: "screen_changed"; fromFingerprint?: string }
  | { kind: "list_changed"; fromSignature?: string }
  | { kind: "adapter"; adapter: string; operation: string; input?: Record<string, unknown> };

interface StepBase {
  id: string;
  say?: string;
  timeoutMs?: number;
  risk?: WorkflowRisk;
  optional?: boolean;
}

export type PrimitiveWorkflowStep =
  | (StepBase & { action: "navigate"; url: string })
  | (StepBase & { action: "click"; target: WorkflowTarget })
  | (StepBase & { action: "fill"; target: WorkflowTarget; value: string; submit?: boolean })
  | (StepBase & { action: "select"; target: WorkflowTarget; value: string })
  | (StepBase & { action: "scroll"; direction: "up" | "down" })
  | (StepBase & { action: "keypress"; key: string })
  | (StepBase & { action: "hover"; target: WorkflowTarget })
  | (StepBase & { action: "drag"; source: WorkflowTarget; target: WorkflowTarget })
  | (StepBase & { action: "upload"; target: WorkflowTarget; objectKeys: string[] })
  | (StepBase & { action: "download"; target: WorkflowTarget })
  | (StepBase & { action: "wait"; milliseconds?: number; until?: WorkflowAssertion })
  | (StepBase & { action: "adapter_call"; adapter: string; operation: string; input?: Record<string, unknown> });

export type WorkflowStep =
  | PrimitiveWorkflowStep
  | (StepBase & { action: "assert"; assertion: WorkflowAssertion })
  | (StepBase & { action: "approval"; reason: string; then: WorkflowStep[] })
  | (StepBase & { action: "branch"; condition: WorkflowAssertion; then: WorkflowStep[]; otherwise?: WorkflowStep[] })
  | (StepBase & { action: "loop"; until: WorkflowAssertion; steps: WorkflowStep[]; maxIterations: number });

export interface WorkflowDefinition {
  schemaVersion: typeof WORKFLOW_SCHEMA_VERSION;
  id: string;
  version: number;
  name: string;
  startUrl?: string;
  risk: WorkflowRisk;
  preconditions: WorkflowAssertion[];
  steps: WorkflowStep[];
  postconditions: WorkflowAssertion[];
}

export interface WorkflowValidationResult {
  ok: boolean;
  errors: string[];
}

const TARGET_KEYS: (keyof WorkflowTarget)[] = ["role", "accessibleName", "label", "text", "testId", "cssFallback"];

export function validateWorkflow(workflow: WorkflowDefinition): WorkflowValidationResult {
  const errors: string[] = [];
  if (workflow.schemaVersion !== WORKFLOW_SCHEMA_VERSION) errors.push(`unsupported schemaVersion ${workflow.schemaVersion}`);
  if (!workflow.id.trim()) errors.push("workflow.id is required");
  if (!workflow.name.trim()) errors.push("workflow.name is required");
  if (!Number.isInteger(workflow.version) || workflow.version < 1) errors.push("workflow.version must be a positive integer");
  if (!workflow.steps.length) errors.push("workflow.steps must not be empty");

  const ids = new Set<string>();
  let visited = 0;
  const checkTarget = (target: WorkflowTarget | undefined, path: string) => {
    if (!target || !TARGET_KEYS.some((key) => typeof target[key] === "string" && String(target[key]).trim())) {
      errors.push(`${path} needs at least one locator`);
    }
  };
  const walk = (steps: WorkflowStep[], path: string) => {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const at = `${path}[${i}]`;
      visited++;
      if (visited > 500) {
        errors.push("workflow exceeds the 500-step structural limit");
        return;
      }
      if (!step.id?.trim()) errors.push(`${at}.id is required`);
      else if (ids.has(step.id)) errors.push(`${at}.id duplicates ${step.id}`);
      else ids.add(step.id);
      if (step.timeoutMs !== undefined && (step.timeoutMs < 1 || step.timeoutMs > 120_000)) {
        errors.push(`${at}.timeoutMs must be between 1 and 120000`);
      }
      if (["click", "fill", "select", "hover", "upload", "download"].includes(step.action)) {
        checkTarget((step as Extract<WorkflowStep, { target: WorkflowTarget }>).target, `${at}.target`);
      }
      if (step.action === "drag") {
        checkTarget(step.source, `${at}.source`);
        checkTarget(step.target, `${at}.target`);
      }
      if (step.action === "navigate" && !/^https?:\/\//i.test(step.url)) errors.push(`${at}.url must be http(s)`);
      if (step.action === "wait" && step.milliseconds === undefined && !step.until) errors.push(`${at} needs milliseconds or until`);
      if (step.action === "loop") {
        if (!Number.isInteger(step.maxIterations) || step.maxIterations < 1 || step.maxIterations > 20) {
          errors.push(`${at}.maxIterations must be between 1 and 20`);
        }
        walk(step.steps, `${at}.steps`);
      }
      if (step.action === "branch") {
        walk(step.then, `${at}.then`);
        if (step.otherwise) walk(step.otherwise, `${at}.otherwise`);
      }
      if (step.action === "approval") walk(step.then, `${at}.then`);
    }
  };
  walk(workflow.steps, "steps");
  return { ok: errors.length === 0, errors };
}

export function assertValidWorkflow(workflow: WorkflowDefinition): void {
  const result = validateWorkflow(workflow);
  if (!result.ok) throw new Error(`invalid workflow: ${result.errors.join("; ")}`);
}

/** Compatibility adapter for journeys learned by the current mapper. */
export function legacyProgramToWorkflow(input: {
  id: string;
  name: string;
  version?: number;
  startUrl?: string;
  postcondition?: string;
  program: { action: string; role?: string; name?: string; testId?: string; value?: string; submit?: boolean; url?: string; direction?: string; say?: string }[];
}): WorkflowDefinition {
  const labels = input.program.map((step) => `${step.action} ${step.name ?? ""}`).join(" ").toLowerCase();
  const risk: WorkflowRisk = /\b(delete|remove|destroy|erase|deactivate|close account)\b/.test(labels)
    ? "destructive"
    : /\b(send|publish|pay|purchase|checkout|buy|invite|share externally|transfer|archive|revoke)\b/.test(labels)
      ? "external_side_effect"
      : input.program.some((step) => ["fill", "select"].includes(step.action) || /\b(create|add|save|update|change|submit)\b/i.test(step.name ?? ""))
        ? "reversible_write"
        : "read";
  const steps: WorkflowStep[] = input.program.map((step, index) => {
    const base = { id: `step-${index + 1}`, say: step.say };
    // Carry the product's test hook through: it is what replay prefers when the
    // accessible name turns out to be account data rather than product chrome.
    const target: WorkflowTarget = { role: step.role, accessibleName: step.name, testId: step.testId };
    if (step.action === "navigate") return { ...base, action: "navigate", url: step.url ?? input.startUrl ?? "" };
    if (step.action === "fill") return { ...base, action: "fill", target, value: step.value ?? "", submit: step.submit };
    if (step.action === "select") return { ...base, action: "select", target, value: step.value ?? "" };
    if (step.action === "scroll") return { ...base, action: "scroll", direction: step.direction === "up" ? "up" : "down" };
    return { ...base, action: "click", target };
  });
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: input.id,
    version: input.version ?? 1,
    name: input.name,
    startUrl: input.startUrl,
    risk,
    preconditions: [],
    steps,
    postconditions: input.postcondition ? [{ kind: "text_visible", text: input.postcondition }] : [],
  };
}
