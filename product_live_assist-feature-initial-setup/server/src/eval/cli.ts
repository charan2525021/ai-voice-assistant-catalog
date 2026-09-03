import { config } from "../config.js";
import { brain as kb } from "../knowledge/store.js";
import { loadCases, runConsistencyEvals, runJourneyEvals, runRetrievalEvals, type EvalReport } from "./harness.js";
import { flushEvents } from "../events.js";

/**
 * `npm run eval`            → routing + grounding (fast, no browser)
 * `npm run eval -- --full`  → also replays every verified journey
 *
 * Exits non-zero on any failure so it can gate a commit or CI run.
 */
function print(title: string, r: EvalReport) {
  console.log(`\n=== ${title} ===`);
  for (const res of r.results) {
    console.log(`  ${res.ok ? "✓" : "✗"} ${res.name}${res.ok && res.detail === "ok" ? "" : ` — ${res.detail}`}`);
  }
  console.log(`  ${r.passed} passed, ${r.failed} failed`);
}

const full = process.argv.includes("--full");
console.log(`(product: ${config.product})`);
await kb.load();

// Free and fastest: does the published flow set match what the graph certifies?
const consistency = await runConsistencyEvals();
if (consistency.results.length) print("Graph ↔ published flows", consistency);

const cases = await loadCases();
console.log(`Loaded ${cases.length} retrieval case(s)${full ? " + journey replays" : ""}`);

const retrieval = await runRetrievalEvals(cases);
print("Routing & grounding", retrieval);

let journeys: EvalReport | null = null;
if (full) {
  journeys = await runJourneyEvals();
  print("Journey replay", journeys);
}

const failed = consistency.failed + retrieval.failed + (journeys?.failed ?? 0);
console.log(`\n${failed === 0 ? "✅ ALL PASS" : `❌ ${failed} FAILURE(S)`}`);
await flushEvents();
process.exit(failed === 0 ? 0 : 1);
