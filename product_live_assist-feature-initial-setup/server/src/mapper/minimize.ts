import type { Journey } from "./types.js";
import { verifyJourney } from "./verifier.js";
import type { LiveTarget } from "../livebox.js";
import { emit } from "../events.js";

/**
 * Minimal-path synthesis.
 *
 * Verification proves a path WORKS — not that it is the path a human would take.
 * One learned journey reached "Your Cart" by clicking "Add to cart" four times on
 * the way, and that wandering had two costs:
 *   1. the demo shows a nonsense route to the prospect, and
 *   2. the journey's embedding absorbed another flow's vocabulary, which
 *      measurably broke flow routing (three flows collapsed to 0.43/0.42/0.41).
 *
 * So we shrink each journey by delta-debugging: drop a step, re-verify, keep the
 * shorter version only if it still passes. Every candidate is proven — we never
 * shorten on a guess.
 */
export interface MinimizeResult {
  before: number;
  after: number;
  trials: number;
  changed: boolean;
}

const fingerprint = (steps: Journey["steps"]): string =>
  steps.map((s) => `${s.action}|${s.role ?? ""}|${(s.name ?? "").toLowerCase()}`).join(">");

export async function minimizeJourney(
  journey: Journey,
  startUrl: string,
  opts: { maxTrials?: number; log?: (s: string) => void; others?: Journey[]; target?: LiveTarget } = {},
): Promise<MinimizeResult> {
  const maxTrials = opts.maxTrials ?? 10;
  const log = opts.log ?? (() => {});
  const before = journey.steps.length;
  let trials = 0;

  /*
   * Semantic guard. A postcondition proves the END STATE, not the INTENT: the
   * proof for "add to cart FROM THE DETAILS PAGE" is just "Remove", which is
   * equally true if you add from the catalog. Naive minimisation therefore
   * deleted the details-page step and produced an exact duplicate of another
   * journey — still passing, but no longer the thing its name describes.
   * So never shrink a journey into a path another journey already covers.
   */
  const forbidden = new Set((opts.others ?? []).filter((o) => o.id !== journey.id).map((o) => fingerprint(o.steps)));
  const collapses = (candidate: Journey["steps"]) => forbidden.has(fingerprint(candidate));

  if (before <= 1 || journey.status !== "verified") {
    const result = { before, after: before, trials, changed: false };
    emit("map.minimize", { status: "ok", data: {
      goal: journey.goal, stepsBefore: before, stepsAfter: before,
      replayTrials: trials, changed: false,
      skippedReason: before <= 1 ? "journey already has the minimum number of steps" : "journey is not verified",
    } });
    return result;
  }

  let best = [...journey.steps];

  /*
   * Never spend a replay on a shape we have already replayed.
   *
   * On a 2-step journey the two passes below propose the IDENTICAL candidate —
   * pass 1 drops the leading step, pass 2 drops index 0 — so both trials tested
   * the same thing and the budget was gone before the useful candidate was
   * reached. Each replay costs a browser session, so dedup is worth more than
   * the bookkeeping.
   */
  const tried = new Set<string>([fingerprint(best)]);
  const attempt = async (candidate: Journey["steps"]): Promise<boolean> => {
    const key = fingerprint(candidate);
    if (tried.has(key)) return false;
    tried.add(key);
    if (collapses(candidate)) return false; // would duplicate another journey
    trials++;
    const v = await verifyJourney({ ...journey, steps: candidate }, startUrl, opts.target);
    return v.ok;
  };

  // Pass 1 — drop leading steps. Exploration usually wanders at the START
  // (opening things, backtracking) before finding the real path.
  while (best.length > 1 && trials < maxTrials) {
    const candidate = best.slice(1);
    if (collapses(candidate)) { log(`      skipped a trim that would duplicate another journey`); break; }
    if (!(await attempt(candidate))) break;
    log(`      trimmed leading step → ${candidate.length} steps still verify`);
    best = candidate;
  }

  /*
   * Pass 2 — drop individual redundant steps.
   *
   * Starts at the LAST index, not `length - 2`. The old bound made the final
   * step permanently unremovable, so a trailing one-shot control — the
   * "Got it" of a first-run dialog, a stray click after the goal was already
   * reached — stayed in the journey forever and broke every later replay, on
   * which that dialog no longer appears. The last step is no more sacred than
   * any other: if the proof still holds without it, it was never part of the
   * journey.
   */
  for (let i = best.length - 1; i >= 0 && trials < maxTrials; i--) {
    if (best.length <= 1) break;
    const candidate = best.filter((_, idx) => idx !== i);
    if (!(await attempt(candidate))) continue;
    log(`      removed redundant step ${i + 1} → ${candidate.length} steps still verify`);
    best = candidate;
  }

  const changed = best.length < before;
  if (changed) journey.steps = best;
  const result = { before, after: best.length, trials, changed };
  emit("map.minimize", { status: "ok", data: {
    goal: journey.goal, stepsBefore: before, stepsAfter: best.length,
    replayTrials: trials, changed,
  } });
  return result;
}
