/** Product Knowledge Graph — journeys are executable, verified programs. */

import type { DocumentProcedure } from "../knowledge/procedures.js";

export interface JourneyStep {
  action: "click" | "fill" | "select" | "navigate" | "scroll";
  /** Durable selector: ARIA role + accessible name (survives redesigns). */
  role?: string;
  name?: string;
  /**
   * The product's own test hook for this control, when it publishes one.
   *
   * Preferred over `name` at replay. An accessible name is stable for product
   * chrome ("Guardrails") and account-specific for anything rendered from data
   * ("Default Organization", a project or tenant name) — recording only the name
   * therefore produces journeys that work in the demo tenant and match nothing
   * in a customer's. `role`/`name` are still recorded, both as the fallback and
   * because they are what a person reads in a review.
   */
  testId?: string;
  value?: string; // for fill / select option
  submit?: boolean; // press Enter after fill
  url?: string; // for navigate
  direction?: "up" | "down";
  /**
   * This step may legitimately be absent on a later run — skip it instead of
   * failing the journey.
   *
   * Written for one-shot UI: a first-run tour, a "Got it" dialog, a cookie
   * banner, a "what's new" panel. Those are genuinely present when a journey is
   * recorded and genuinely gone afterwards, so recording them as required steps
   * produced journeys that verified once and could never replay — and the
   * minimiser could not remove them either, because the proof did still depend
   * on getting past the dialog THAT time.
   *
   * Only ever set for a step that dismissed something: it must not change the
   * route and must not be the step the proof rests on.
   */
  optional?: boolean;
  note?: string; // what this step accomplishes (talking point)
  /**
   * One short spoken line for THIS step, e.g. "Now I'll open the cart".
   * Written by the Semanticist during onboarding. Replay emits it before the
   * step so a TTS voice can guide the user through the journey step by step,
   * rather than narrating once and then acting silently.
   */
  say?: string;
  /** Observed transition evidence captured during exploration. */
  fromUrl?: string;
  toUrl?: string;
  fromFingerprint?: string;
  toFingerprint?: string;
}

/**
 * Proof is deliberately typed: navigation, list changes and writes do not
 * produce the same kind of evidence. `text` remains for old graphs and for
 * transient confirmations, but it is no longer the universal success test.
 */
export type JourneyProofKind =
  | "text"
  | "url_changed"
  | "screen_reached"
  | "record_created"
  | "field_changed"
  | "result_set_changed"
  | "order_changed";

export interface JourneyEvidenceContract {
  kind: JourneyProofKind;
  /** Exact/digit-tolerant text for text and write proofs. */
  expectedText?: string;
  /** Origin-relative URL template, e.g. `/projects/:id?view=history`. */
  expectedUrl?: string;
  expectedTitle?: string;
  /** Stable controls which identify the destination screen. */
  requiredControls?: string[];
  /** Captured screen identity; supporting evidence, never the only assertion. */
  expectedFingerprint?: string;
  /** Why this contract is capable of proving the goal. */
  rationale?: string;
}

export interface DocumentControlMatch {
  stepIndex: number;
  documentedStep: string;
  status: "matched" | "unmatched";
  score: number;
  screenTitle?: string;
  control?: string;
  executable?: JourneyStep;
  reason?: string;
}

export interface DocumentationJourneyContext {
  procedure: DocumentProcedure;
  matches: DocumentControlMatch[];
  executablePrefix: JourneyStep[];
  matchStatus: "full" | "partial" | "none";
  staleReasons: string[];
}

export interface PlannedJourneyJob {
  goal: string;
  why: string;
  instruction?: string;
  source?: "planner" | "human_rework" | "manual" | "documentation";
  documentation?: DocumentationJourneyContext;
}

export type JourneyFailureStage = "planning" | "exploration" | "verification" | "publication";
export type JourneyFailureCategory =
  | "not_observed"
  | "unsupported_by_plan"
  | "permission_blocked"
  | "unsafe_action"
  | "record_specific"
  | "goal_mismatch"
  | "selector_missing"
  | "proof_inconclusive"
  | "proof_missing"
  | "timeout"
  | "replay_error"
  | "documentation_stale"
  | "unknown";

export interface JourneyFailure {
  stage: JourneyFailureStage;
  category: JourneyFailureCategory;
  reason: string;
  retryable: boolean;
  failedStep?: number;
  beforeUrl?: string;
  afterUrl?: string;
  beforeFingerprint?: string;
  afterFingerprint?: string;
  capturedAt: string;
}

export interface JourneyVerificationRun {
  ok: boolean;
  detail: string;
  attemptedAt: string;
  category?: JourneyFailureCategory;
  retryable?: boolean;
  failedStep?: number;
  beforeUrl?: string;
  afterUrl?: string;
  beforeFingerprint?: string;
  afterFingerprint?: string;
}

export type JourneyApprovalStatus = "pending" | "approved" | "rejected" | "rework_requested";

export interface JourneyApproval {
  status: JourneyApprovalStatus;
  revision: number;
  /** Approval is bound to this exact executable revision. */
  checksum: string;
  reviewedBy?: string;
  reviewedAt?: string;
  comment?: string;
  reworkInstruction?: string;
}

export interface JourneyRevisionSnapshot {
  revision: number;
  checksum: string;
  goal: string;
  capability: string;
  steps: JourneyStep[];
  postcondition: string;
  proof?: JourneyProofKind;
  evidence?: JourneyEvidenceContract;
  documentation?: DocumentationJourneyContext;
  status: Journey["status"];
  verificationRuns: JourneyVerificationRun[];
  failure?: JourneyFailure;
  approval?: JourneyApproval;
  createdAt: string;
  source: "autonomous" | "documentation" | "human_demonstration" | "human_rework" | "remap";
}

export interface Journey {
  id: string;
  goal: string; // "Create a task"
  capability: string; // "Task capture"
  entities: string[]; // ["Task"]
  preconditions: string[];
  steps: JourneyStep[];
  /**
   * URL the journey was recorded from. Replay must return here first: programs are
   * learned from a clean start screen, so running one from an arbitrary mid-demo
   * screen is not valid. Without this the agent (correctly) refuses to replay.
   */
  startUrl?: string;
  postcondition: string; // text expected on screen after success
  /**
   * How success is proven. Text presence cannot verify ORDERING (sorting changes
   * order, not content), so sorting/filtering journeys need a different assertion.
   */
  proof?: JourneyProofKind;
  /** Structured, deterministic contract used by the verifier. */
  evidence?: JourneyEvidenceContract;
  /** Source claim beside observed execution; never verification evidence itself. */
  documentation?: DocumentationJourneyContext & {
    prefilledSteps?: number;
    executionMismatch?: string;
  };
  /** Verification state — nothing is trusted until replayed from a clean state. */
  status: "unverified" | "verified" | "broken";
  reliability: number; // rolling replay success rate 0..1
  attempts: number;
  /** Individual replay evidence used to calculate reliability. */
  verificationRuns?: JourneyVerificationRun[];
  /** Last failure, retained across restarts and visible in the admin console. */
  failure?: JourneyFailure;
  verifiedAt?: string;
  /** Immutable-revision identity and human review state. */
  revision?: number;
  revisionChecksum?: string;
  approval?: JourneyApproval;
  revisionHistory?: JourneyRevisionSnapshot[];
  meaning?: string; // what it MEANS (Semanticist)
  requiresJourney?: string[]; // journey ids this depends on — enables composition
  /** Evidence for non-happy-path coverage gathered during the same mapping run. */
  coverage?: Partial<Record<"validation" | "permission" | "empty_state" | "error", {
    status: "unknown" | "discovered" | "verified" | "broken" | "blocked";
    depth: 0 | 1 | 2 | 3 | 4 | 5;
    detail: string;
    checkedAt?: string;
  }>>;
}

export interface ScreenNode {
  id: string;
  url: string;
  title: string;
  purpose: string;
  controls: string[]; // "button 'Save'"
  /**
   * Dedup key for the survey. Normalises digits away so a changing count does
   * not look like a new screen — good for crawling, useless for recognising a
   * live page, because nothing at runtime computes it.
   */
  fingerprint?: string;
  /**
   * The RUNTIME fingerprint (runtime/screen-state.ts), which is what the live
   * browser produces and the evidence router compares against. Recorded
   * separately because the two hashes are computed from different inputs and
   * can never be equal: storing only the survey's meant a mapped screen could
   * never be matched to the page actually on screen, and transitions derived
   * from journey steps found no endpoints at all.
   */
  runtimeFingerprint?: string;
  /** Semantic click path from the authenticated start state. */
  reachedBy?: { role: string; name: string }[];
  /** Bounded visible evidence used to classify empty/error states. */
  visibleText?: string;
  /** Generic page class used to keep legal/account/tenant data out of planning. */
  kind?: "product" | "tenant_content" | "legal" | "account" | "billing" | "external";
}

export interface CapabilityNode {
  id: string;
  name: string;
  description: string;
  journeys: string[];
  entities: string[];
}

export interface TrainingRunMetric {
  id: string;
  startedAt: string;
  finishedAt?: string;
  mode: "exploration_only" | "documents_plus_ui";
  documentCandidates: number;
  safeDocumentCandidates: number;
  plannedFromDocuments: number;
  plannedFromUi: number;
  staleOrUngrounded: number;
  prefilledSteps: number;
  explored: number;
  machineVerified: number;
  proofFailures: number;
  documentationStaleFailures: number;
  durationMs?: number;
}

export interface ProductGraph {
  product: string;
  startUrl: string;
  builtAt: string;
  screens: ScreenNode[];
  journeys: Journey[];
  capabilities: CapabilityNode[];
  /** Jobs proposed by the planner that have not been learned yet. */
  backlog: {
    goal: string;
    why: string;
    status: "pending" | "failed" | "done";
    failure?: JourneyFailure;
    instruction?: string;
    source?: "planner" | "human_rework" | "manual" | "documentation";
    documentation?: DocumentationJourneyContext;
  }[];
  /** Why discovery stopped, so incomplete coverage is observable. */
  survey?: { visits: number; maxVisits: number; frontierRemaining: number; stopReason: "frontier_exhausted" | "screen_limit" | "visit_limit" };
  /** Comparable run outcomes for feature-flag before/after measurement. */
  trainingMetrics?: { runs: TrainingRunMetric[] };
}

export const emptyGraph = (product: string, startUrl: string): ProductGraph => ({
  product,
  startUrl,
  builtAt: new Date().toISOString(),
  screens: [],
  journeys: [],
  capabilities: [],
  backlog: [],
});
