import type { Journey, ProductGraph } from "./types.js";

/**
 * Derive journey composition and prune dead weight.
 *
 * Composition: journeys frequently re-learn a prerequisite inline — "mark a task
 * complete" starts by creating a task. If another verified journey already
 * achieves that prefix, link to it (`requiresJourney`) and record the
 * precondition, so the graph can plan multi-journey goals instead of treating
 * every journey as isolated.
 */

function stepKey(s: Journey["steps"][number]): string {
  return `${s.action}|${s.role ?? ""}|${(s.name ?? "").toLowerCase()}|${s.action === "fill" || s.action === "select" ? "*" : ""}`;
}

/** Is `maybePrefix` an ordered prefix of `steps`? */
function isPrefix(maybePrefix: Journey["steps"], steps: Journey["steps"]): boolean {
  if (!maybePrefix.length || maybePrefix.length >= steps.length) return false;
  return maybePrefix.every((s, i) => stepKey(s) === stepKey(steps[i]));
}

export function deriveComposition(graph: ProductGraph): { linked: number } {
  const verified = graph.journeys.filter((j) => j.status === "verified");
  let linked = 0;

  for (const j of verified) {
    const deps = verified
      .filter((other) => other.id !== j.id && isPrefix(other.steps, j.steps))
      // prefer the longest prefix — the most complete prerequisite
      .sort((a, b) => b.steps.length - a.steps.length);

    if (!deps.length) continue;
    const dep = deps[0];
    j.requiresJourney = [dep.id];
    const note = `requires "${dep.goal}" first`;
    if (!j.preconditions.includes(note)) j.preconditions.push(note);
    linked++;
  }
  return { linked };
}

/**
 * Drop journeys that are dead weight: broken ones that a verified journey
 * already supersedes (same capability), and stale duplicates of the same goal.
 * Broken journeys with no replacement are KEPT — they are the repair backlog.
 */
export function pruneJourneys(graph: ProductGraph): { removed: number; keptBroken: number } {
  const before = graph.journeys.length;
  const verifiedCaps = new Set(graph.journeys.filter((j) => j.status === "verified").map((j) => j.capability.toLowerCase()));

  const byGoal = new Map<string, Journey>();
  for (const j of graph.journeys) {
    const key = j.goal.toLowerCase();
    const existing = byGoal.get(key);
    // keep the better of any duplicates: verified beats broken, then more reliable
    if (!existing) byGoal.set(key, j);
    else {
      const better =
        (j.status === "verified" ? 2 : 0) + j.reliability > (existing.status === "verified" ? 2 : 0) + existing.reliability
          ? j
          : existing;
      byGoal.set(key, better);
    }
  }

  const kept = [...byGoal.values()].filter(
    (j) => j.status === "verified" || !verifiedCaps.has(j.capability.toLowerCase()),
  );
  graph.journeys = kept;
  return { removed: before - kept.length, keptBroken: kept.filter((j) => j.status !== "verified").length };
}
