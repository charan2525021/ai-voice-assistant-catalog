import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { brain as kb } from "../knowledge/store.js";
import { retrieveContext } from "../knowledge/retrieve.js";
import { SessionMemory } from "../knowledge/memory.js";
import { loadGraph } from "../mapper/graph.js";
import { verifyJourney } from "../mapper/verifier.js";

/**
 * Regression harness.
 *
 * Every defect found so far was found by hand — which is why the same bug class
 * (blanked screenshot base64) shipped twice, and why a publishing bug looked
 * like a retrieval failure. This turns those one-off manual probes into a suite
 * that runs on every change.
 *
 * Three layers, cheapest first:
 *   routing     — does real user phrasing reach the right flow?  (embeddings only)
 *   grounding   — are unknown questions refused instead of invented?
 *   journeys    — do the stored programs still replay?  (browser, slowest)
 */

export interface EvalCase {
  /** What a prospect might say. */
  query: string;
  /** Flow name expected to match, or null to assert NO flow should match. */
  expectFlow?: string | null;
  /**
   * Any ONE of these is acceptable. As coverage grows, several flows can be
   * legitimately correct for the same phrasing ("finish the order" reasonably
   * matches both "start checkout" and "review the order total"), so pinning a
   * single answer makes the suite brittle rather than accurate.
   */
  expectFlowOneOf?: string[];
  /** Substring expected in the retrieved grounding (case-insensitive). */
  expectFact?: string;
  /** True if the Brain should have NO supporting facts (so Aidan must refuse). */
  expectNoFacts?: boolean;
}

export interface EvalReport {
  passed: number;
  failed: number;
  results: { name: string; ok: boolean; detail: string }[];
}

const casesFile = () => path.join(config.contentDir || "", "evals.json");

/**
 * Baseline cases are DERIVED from the graph so every product gets coverage for
 * free: each verified journey must be reachable from its own goal phrasing.
 * Hand-written cases in evals.json are added on top.
 */
export async function loadCases(): Promise<EvalCase[]> {
  const cases: EvalCase[] = [];
  const graph = await loadGraph();
  const verified = graph.journeys.filter((j) => j.status === "verified");
  for (const j of verified) {
    // Journeys that end in the same proven state are interchangeable answers.
    const equivalent = verified.filter((o) => o.postcondition === j.postcondition).map((o) => o.goal);
    const expect = equivalent.length > 1 ? { expectFlowOneOf: equivalent } : { expectFlow: j.goal };
    cases.push({ query: j.goal, ...expect });
    cases.push({ query: `show me how to ${j.goal.toLowerCase()}`, ...expect });
  }
  // A question no product can answer — the Brain must not fabricate support.
  cases.push({ query: "does this integrate with SAP and Workday out of the box?", expectNoFacts: true, expectFlow: null });

  const f = casesFile();
  if (existsSync(f)) {
    try {
      cases.push(...(JSON.parse(await fs.readFile(f, "utf8")) as EvalCase[]));
    } catch (e) {
      console.warn(`  ! could not read ${f}: ${(e as Error).message}`);
    }
  }
  return cases;
}

/** Layer 1+2: routing and grounding. No browser, so this is fast and cheap. */
export async function runRetrievalEvals(cases: EvalCase[]): Promise<EvalReport> {
  const results: EvalReport["results"] = [];
  for (const c of cases) {
    const { packet } = await retrieveContext(c.query, new SessionMemory(), kb);
    const flowName = packet.flow?.name ?? null;
    const facts = packet.facts.map((f) => f.chunk.text.toLowerCase()).join(" ");
    const checks: string[] = [];
    let ok = true;

    if (c.expectFlowOneOf?.length) {
      if (!flowName || !c.expectFlowOneOf.includes(flowName)) {
        ok = false;
        checks.push(`flow: expected one of [${c.expectFlowOneOf.join(" | ")}], got ${flowName ? `"${flowName}"` : "NONE"}`);
      }
    } else if (c.expectFlow !== undefined) {
      const want = c.expectFlow;
      const hit = want === null ? flowName === null : flowName === want;
      if (!hit) {
        ok = false;
        checks.push(`flow: expected ${want === null ? "NONE" : `"${want}"`}, got ${flowName ? `"${flowName}"` : "NONE"}`);
      }
    }
    if (c.expectFact && !facts.includes(c.expectFact.toLowerCase())) {
      ok = false;
      checks.push(`fact: "${c.expectFact}" not in retrieved grounding`);
    }
    if (c.expectNoFacts && packet.facts.length > 0) {
      /*
       * A soft note while this was unenforceable — on a 2-chunk corpus the
       * retrieval either found the one relevant chunk or nothing, so there was
       * no honest line to draw. With a measured grounding floor there is, and a
       * product that has one must actually refuse: returning plausible-looking
       * chunks for a question the docs cannot answer is precisely how a demo
       * agent invents a feature. Still a note for uncalibrated products, so a
       * small corpus does not fail a test it cannot pass.
       */
      if (kb.groundingFloorActive()) {
        ok = false;
        checks.push(`refusal: ${packet.facts.length} fact(s) retrieved for an unanswerable question despite an active grounding floor`);
      } else {
        checks.push(`note: ${packet.facts.length} weak fact(s) retrieved (no grounding floor calibrated for this product)`);
      }
    }
    results.push({ name: c.query, ok, detail: checks.join("; ") || "ok" });
  }
  return {
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}

/**
 * Layer 0: is what the graph CERTIFIES the same as what the agent can RUN?
 *
 * The graph is the source of truth for verification; `flows.json` is what the
 * live agent actually reads. Nothing connected the two, so a journey could be
 * `status: "verified"` while its published flow carried no executable program —
 * and `retrieve.ts` silently falls back to the "adapt if the UI differs" prompt
 * in that case, i.e. the agent improvises clicks on a journey we told the
 * customer was proven. `sample-tasks-app` shipped in exactly that state.
 *
 * Free (no model, no browser), so it runs first on every eval.
 */
export async function runConsistencyEvals(): Promise<EvalReport> {
  const graph = await loadGraph();
  const verified = graph.journeys.filter((j) => j.status === "verified");
  const byName = new Map(kb.flows.map((f) => [f.name, f]));
  const results: EvalReport["results"] = [];

  for (const j of verified) {
    const flow = byName.get(j.goal);
    if (!flow) {
      results.push({ name: `published: ${j.goal}`, ok: false, detail: "verified in the graph but MISSING from flows.json — the agent cannot offer it" });
    } else if (!flow.program?.length) {
      results.push({ name: `published: ${j.goal}`, ok: false, detail: "verified in the graph but its flow has NO executable program — the agent would improvise instead of replaying" });
    } else if (flow.program.length !== j.steps.length) {
      results.push({ name: `published: ${j.goal}`, ok: false, detail: `program drift: graph has ${j.steps.length} steps, published flow has ${flow.program.length}` });
    } else {
      results.push({ name: `published: ${j.goal}`, ok: true, detail: `${flow.program.length} steps executable` });
    }
  }

  // A flow claiming to be executable must also know where to start, or replay
  // runs the program from wherever the prospect happens to be.
  for (const f of kb.flows) {
    if (f.program?.length && !f.startUrl) {
      results.push({ name: `published: ${f.name}`, ok: false, detail: "executable program with no startUrl — replay cannot reposition itself" });
    }
  }

  return { passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
}

/** Layer 3: do the stored programs still replay? (slow — spins a browser each) */
export async function runJourneyEvals(): Promise<EvalReport> {
  const graph = await loadGraph();
  const verified = graph.journeys.filter((j) => j.status === "verified");
  const results: EvalReport["results"] = [];
  for (const j of verified) {
    const v = await verifyJourney(j, graph.startUrl);
    results.push({ name: j.goal, ok: v.ok, detail: v.detail });
  }
  return {
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}
