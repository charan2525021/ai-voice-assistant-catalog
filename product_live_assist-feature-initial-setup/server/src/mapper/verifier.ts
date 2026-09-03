import { LiveBox, type LiveTarget, type PageSnapshot } from "../livebox.js";
import { emit } from "../events.js";
import type { Journey, JourneyEvidenceContract, JourneyFailure, JourneyFailureCategory } from "./types.js";
import { EMPTY_STATE } from "./proof.js";
import { expand, expandProgram, newRunTag } from "./unique.js";
import { buildEvidenceContract, failureCategory, matchesUrlTemplate, validateGoalAlignment, urlTemplate } from "./journey-evidence.js";
import { fingerprintSnapshot } from "../runtime/screen-state.js";
import { approvalIsCurrent } from "./journey-review.js";
import { assessProductAccess } from "../access.js";

/**
 * Replay verifier. The explorer proposes a path; this module independently
 * proves both that the path ran and that its observable effect matches the goal.
 */
export interface VerifyResult {
  ok: boolean;
  detail: string;
  failedStep?: number;
  inconclusive?: boolean;
  category?: JourneyFailureCategory;
  retryable?: boolean;
  beforeUrl?: string;
  afterUrl?: string;
  beforeFingerprint?: string;
  afterFingerprint?: string;
}

export function requiredVerificationRuns(journey: Journey): number {
  const mutation = ["record_created", "field_changed"].includes(journey.evidence?.kind ?? journey.proof ?? "text");
  return Math.max(1, Number(mutation
    ? process.env.VERIFY_MUTATION_RUNS ?? 3
    : process.env.VERIFY_REQUIRED_RUNS ?? 2));
}

/** Fail closed: legacy/singly-replayed journeys are drafts until reverified. */
export function isJourneyMachineVerified(journey: Journey): boolean {
  if (journey.status !== "verified") return false;
  const needed = requiredVerificationRuns(journey);
  const runs = journey.verificationRuns ?? [];
  return runs.length >= needed && runs.slice(-needed).every((run) => run.ok);
}

export function isJourneyPublishable(journey: Journey): boolean {
  return isJourneyMachineVerified(journey) && approvalIsCurrent(journey);
}

function verificationFailure(result: VerifyResult): JourneyFailure {
  return {
    stage: "verification",
    category: result.category ?? "unknown",
    reason: result.detail,
    retryable: result.retryable ?? true,
    failedStep: result.failedStep,
    beforeUrl: result.beforeUrl,
    afterUrl: result.afterUrl,
    beforeFingerprint: result.beforeFingerprint,
    afterFingerprint: result.afterFingerprint,
    capturedAt: new Date().toISOString(),
  };
}

/** Run and record the full publication gate; callers cannot accidentally trust one lucky replay. */
export async function verifyJourneyRepeatedly(
  journey: Journey,
  startUrl: string,
  target?: LiveTarget,
  sharedBox?: LiveBox,
): Promise<{ ok: boolean; detail: string; last: VerifyResult; needed: number }> {
  const needed = requiredVerificationRuns(journey);
  let last: VerifyResult = { ok: false, detail: "verification did not run", category: "unknown" };
  const batch = [] as NonNullable<Journey["verificationRuns"]>;
  for (let run = 0; run < needed; run++) {
    last = await verifyJourney(journey, startUrl, target, sharedBox);
    batch.push({
      ok: last.ok, detail: last.detail, attemptedAt: new Date().toISOString(),
      category: last.category, retryable: last.retryable, failedStep: last.failedStep,
      beforeUrl: last.beforeUrl, afterUrl: last.afterUrl,
      beforeFingerprint: last.beforeFingerprint, afterFingerprint: last.afterFingerprint,
    });
    if (!last.ok) break;
  }
  journey.verificationRuns = [...(journey.verificationRuns ?? []), ...batch].slice(-50);
  journey.attempts = (journey.attempts ?? 0) + batch.length;
  const successes = journey.verificationRuns.filter((item) => item.ok).length;
  journey.reliability = journey.verificationRuns.length ? successes / journey.verificationRuns.length : 0;
  const ok = batch.length === needed && batch.every((item) => item.ok);
  journey.status = ok ? "verified" : "broken";
  journey.verifiedAt = ok ? new Date().toISOString() : undefined;
  journey.failure = ok ? undefined : verificationFailure(last);
  return { ok, detail: ok ? `${needed}/${needed} independent replays passed` : last.detail, last, needed };
}

const PROOF_WAIT_MS = Number(process.env.PROOF_WAIT_MS ?? 10_000);

async function waitForText(box: LiveBox, text: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await box.hasText(text)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

const meta = (snapshot: PageSnapshot) => ({
  beforeUrl: snapshot.url,
  beforeFingerprint: fingerprintSnapshot(snapshot),
});

const afterMeta = (snapshot: PageSnapshot) => ({
  afterUrl: snapshot.url,
  afterFingerprint: fingerprintSnapshot(snapshot),
});

function failed(detail: string, extra: Partial<VerifyResult> = {}): VerifyResult {
  return {
    ok: false,
    detail,
    category: extra.category ?? failureCategory(detail),
    retryable: extra.retryable ?? true,
    ...extra,
  };
}

function contractFor(journey: Journey): JourneyEvidenceContract {
  return journey.evidence ?? buildEvidenceContract({
    goal: journey.goal,
    steps: journey.steps,
    requestedProof: journey.proof ?? "text",
    postcondition: journey.postcondition,
  });
}

function controlsOn(snapshot: PageSnapshot): Set<string> {
  return new Set(snapshot.elements
    .filter((item) => item.name)
    .map((item) => `${item.role || item.tag} "${item.name}"`.toLowerCase()));
}

const MUTATING_CONTROL = /\b(new|create|add|save|submit|upload|import|generate|update|edit|change|set|enable|disable|apply|confirm)\b/i;
const RESULT_CONTROL = /\b(search|find|filter|sort|order|apply)\b/i;

/** Steps before the asserted action establish context and must run before "before" evidence is captured. */
function assertedActionIndex(journey: Journey, contract: JourneyEvidenceContract): number {
  if (contract.kind === "result_set_changed" || contract.kind === "order_changed") {
    const index = journey.steps.findIndex((step) =>
      step.action === "fill" || step.action === "select" ||
      (step.action === "click" && RESULT_CONTROL.test(step.name ?? "")));
    return index < 0 ? 0 : index;
  }
  const index = journey.steps.findIndex((step) =>
    step.action === "fill" || step.action === "select" ||
    (step.action === "click" && MUTATING_CONTROL.test(step.name ?? "")) ||
    (step.action === "click" && (!step.fromUrl || !step.toUrl || urlTemplate(step.fromUrl) === urlTemplate(step.toUrl))));
  return index < 0 ? journey.steps.findIndex((step) => step.action !== "navigate") : index;
}

export async function verifyJourney(
  journey: Journey,
  startUrl: string,
  target?: LiveTarget,
  sharedBox?: LiveBox,
): Promise<VerifyResult> {
  const started = Date.now();
  const result = await verifyJourneyInner(journey, startUrl, target, sharedBox);
  emit("map.verify", {
    status: result.ok ? "ok" : "error",
    ms: Date.now() - started,
    error: result.ok ? undefined : result.detail,
    data: {
      goal: journey.goal,
      capability: journey.capability,
      proof: contractFor(journey).kind,
      steps: journey.steps.length,
      failedStep: result.failedStep,
      category: result.category,
      retryable: result.retryable,
      inconclusive: !!result.inconclusive,
      beforeUrl: result.beforeUrl,
      afterUrl: result.afterUrl,
      beforeFingerprint: result.beforeFingerprint,
      afterFingerprint: result.afterFingerprint,
      detail: result.detail,
    },
  });
  return result;
}

async function verifyJourneyInner(
  journey: Journey,
  startUrl: string,
  target?: LiveTarget,
  sharedBox?: LiveBox,
): Promise<VerifyResult> {
  const alignment = validateGoalAlignment(journey);
  if (!alignment.ok) {
    return failed(alignment.reason ?? "goal and evidence are not aligned", {
      category: alignment.category ?? "goal_mismatch", retryable: false, inconclusive: true,
    });
  }

  const contract = contractFor(journey);
  const documentedProof = journey.documentation?.procedure.successMessage?.trim();
  /*
   * Blame the document only when the DOCUMENT'S OWN WORDING is what failed.
   *
   * This used to relabel every verification failure on a documented journey as
   * "Documentation is stale", purely because the source happened to quote a
   * success message. A control that moved, a slow render, a lost session — all
   * were reported as a stale manual, which sends whoever reads the log to
   * re-check the docs for a problem that is not there.
   *
   * Since the explorer now prefers observed proof over the documented phrase,
   * a journey only carries the document's wording when nothing better was seen.
   * That is the one case where the document is genuinely the suspect.
   */
  const restsOnDocumentWording =
    !!documentedProof && (contract.expectedText ?? journey.postcondition ?? "").trim() === documentedProof;
  const documentationFailure = (detail: string, extra: Parameters<typeof failed>[1] = {}) =>
    failed(restsOnDocumentWording ? `The documented success text was not observed: ${detail}` : detail, {
      ...extra,
      ...(restsOnDocumentWording ? { category: "documentation_stale" as const, retryable: true } : {}),
    });
  if (["text", "record_created", "field_changed"].includes(contract.kind) && EMPTY_STATE.test((contract.expectedText ?? journey.postcondition ?? "").trim())) {
    return failed(`postcondition "${contract.expectedText ?? journey.postcondition}" is an empty-state message`, {
      category: "proof_inconclusive", retryable: false, inconclusive: true,
    });
  }

  const box = sharedBox ?? new LiveBox(target ?? { startUrl });
  try {
    if (!sharedBox) await box.start();
    await box.resetState();
    const accessSnapshot = await box.snapshot(false);
    const access = assessProductAccess(startUrl, accessSnapshot);
    if (!access.ok) {
      return failed(`Product access was lost before replay: ${access.message}`, {
        ...meta(accessSnapshot), category: "permission_blocked", retryable: false,
      });
    }

    // Navigation and destination-screen journeys are valid without a mutation.
    if (contract.kind === "url_changed" || contract.kind === "screen_reached") {
      const before = await box.snapshot(false);
      const replay = await box.runProgram(journey.steps as any);
      if (!replay.ok) return failed(replay.error ?? "replay failed", { failedStep: replay.ran, ...meta(before) });
      const after = await box.snapshot(false);
      const common = { ...meta(before), ...afterMeta(after) };
      const routeChanged = urlTemplate(before.url) !== urlTemplate(after.url);
      const stateChanged = fingerprintSnapshot(before) !== fingerprintSnapshot(after);
      if (contract.kind === "url_changed" && !routeChanged) {
        return failed("destination route did not change", { ...common, category: "proof_missing" });
      }
      /*
       * A changed FINGERPRINT is not a reached SCREEN.
       *
       * The old test passed on `routeChanged || stateChanged`, and the
       * fingerprint moves for anything at all — a dropdown opening, a tooltip,
       * a toast, a lazily-loaded row. That is how "Open the default
       * organization settings" certified: one click that opened a menu, same
       * URL before and after, recorded as "reached verified screen /dashboard".
       *
       * So a same-route claim now needs independent evidence that this is a
       * different screen rather than the same one with something expanded. The
       * document title is that evidence: a menu does not change it, an SPA view
       * switch does. Everything else belongs to `text` or `field_changed`.
       */
      const titleChanged = before.title !== after.title;
      if (contract.kind === "screen_reached" && !routeChanged) {
        if (!stateChanged) {
          return failed("destination screen did not change", { ...common, category: "proof_missing" });
        }
        if (!titleChanged) {
          return failed(
            `the route and title are unchanged (${urlTemplate(after.url)}), so this revealed UI on the same screen rather than reaching a new one`,
            { ...common, category: "proof_inconclusive", retryable: false, inconclusive: true },
          );
        }
      }
      if (contract.expectedUrl && !matchesUrlTemplate(after.url, contract.expectedUrl)) {
        return failed(`reached ${urlTemplate(after.url)}, expected ${contract.expectedUrl}`, { ...common, category: "proof_missing" });
      }
      if (contract.expectedTitle && after.title !== contract.expectedTitle) {
        return failed(`destination title was "${after.title}", expected "${contract.expectedTitle}"`, { ...common, category: "proof_missing" });
      }
      const actualControls = controlsOn(after);
      const missing = (contract.requiredControls ?? []).filter((control) => !actualControls.has(control.toLowerCase()));
      if (missing.length) {
        return failed(`destination screen is missing required controls: ${missing.join(", ")}`, { ...common, category: "proof_missing" });
      }
      return { ok: true, detail: `reached verified screen ${contract.expectedUrl ?? urlTemplate(after.url)}`, ...common };
    }

    // Searches, filters and sorting are proved by a structural list delta.
    if (contract.kind === "order_changed" || contract.kind === "result_set_changed") {
      const firstAction = assertedActionIndex(journey, contract);
      const leadIn = firstAction > 0 ? journey.steps.slice(0, firstAction) : [];
      const actionSteps = firstAction > 0 ? journey.steps.slice(firstAction) : journey.steps;
      if (leadIn.length) {
        const navigation = await box.runProgram(leadIn as any);
        if (!navigation.ok) return failed(navigation.error ?? "could not reach the result list", { failedStep: navigation.ran });
      }
      const beforeSnap = await box.snapshot(false);
      const before = await box.listSignature();
      const replay = await box.runProgram(actionSteps as any);
      if (!replay.ok) return failed(replay.error ?? "replay failed", { failedStep: replay.ran + leadIn.length, ...meta(beforeSnap) });
      const after = await box.listSignature();
      const afterSnap = await box.snapshot(false);
      const common = { ...meta(beforeSnap), ...afterMeta(afterSnap) };
      if (!before || !after) return failed("could not read a result list before and after the journey", { ...common, category: "proof_inconclusive" });
      return before !== after
        ? { ok: true, detail: `${contract.kind === "order_changed" ? "list order" : "result set"} changed as expected`, ...common }
        : failed(`${contract.kind === "order_changed" ? "list order" : "result set"} did not change`, { ...common, category: "proof_missing" });
    }

    /*
     * For writes/text confirmations, leading navigation is setup. Measure the
     * differential immediately before the first real action, then replay only
     * those acting steps using one fresh unique tag.
     */
    const firstAction = assertedActionIndex(journey, contract);
    const leadIn = firstAction <= 0 ? [] : journey.steps.slice(0, firstAction);
    const actionSteps = firstAction < 0 ? [] : journey.steps.slice(Math.max(firstAction, 0));
    if (!actionSteps.length) {
      return failed("text/write proof has no acting step; use a screen or URL proof", {
        category: "proof_inconclusive", retryable: false, inconclusive: true,
      });
    }
    if (leadIn.length) {
      const navigation = await box.runProgram(leadIn as any);
      if (!navigation.ok) return documentationFailure(navigation.error ?? "could not reach the action screen", { failedStep: navigation.ran });
    }

    const before = await box.snapshot(false);
    const runTag = newRunTag();
    const expected = expand(contract.expectedText ?? journey.postcondition, runTag);
    if (!expected) return failed("proof contract has no expected text", { ...meta(before), category: "proof_inconclusive", retryable: false });
    if (await box.hasText(expected)) {
      return documentationFailure(`postcondition "${expected}" was already visible before the acting step`, {
        ...meta(before), category: "proof_inconclusive", retryable: false, inconclusive: true,
      });
    }

    const replay = await box.runProgram(expandProgram(actionSteps as any[], runTag) as any);
    if (!replay.ok) return documentationFailure(replay.error ?? "replay failed", { failedStep: replay.ran + leadIn.length, ...meta(before) });
    const appeared = await waitForText(box, expected, PROOF_WAIT_MS);
    const after = await box.snapshot(false);
    const common = { ...meta(before), ...afterMeta(after) };
    return appeared
      ? { ok: true, detail: `proof appeared only after the journey ran: "${expected}"`, ...common }
      : documentationFailure(`postcondition NOT met: expected "${expected}" after the journey`, { ...common, category: "proof_missing" });
  } catch (error) {
    return failed(`replay error: ${(error as Error).message}`, { category: "replay_error" });
  } finally {
    if (!sharedBox) await box.stop().catch(() => {});
  }
}
