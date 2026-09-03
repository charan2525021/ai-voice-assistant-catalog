import { config } from "../config.js";
import { makeBrain, type NMessage } from "../brain.js";
import { brain as kb } from "../knowledge/store.js";
import { cosine, degradedCount, embedOne, resetDegraded, setEmbeddingPatience } from "../knowledge/embeddings.js";
import { DEFAULT_CALIBRATION, loadCalibration, saveCalibration, type Calibration } from "../knowledge/calibration.js";
import { chunkHash, loadBench } from "./retrieval-bench.js";
import { loadGraph } from "../mapper/graph.js";

// Calibration writes numbers that live on disk and shape every later answer, so
// it waits out a rate limit instead of degrading to lexical and being discarded.
setEmbeddingPatience(6, 30000);

/**
 * Measure this product's retrieval parameters and persist them.
 *
 * Two independent calibrations:
 *   semWeight  — swept against the document benchmark (needs `bench:generate`).
 *   flow*      — derived from the separation between a journey's own phrasings
 *                and its nearest competitor, using the product's real graph.
 *
 * Both DEGRADE GRACEFULLY: whatever cannot be measured keeps its previous value
 * (or the default). A product with no benchmark still gets flow thresholds, and
 * a product with no journeys still gets a document weight. Refusing to write
 * anything unless everything is measurable would mean most products never get
 * calibrated at all.
 */

const K = 4;

/**
 * Off-domain probes — unanswerable by ANY product's own documentation.
 *
 * Deliberately not product-specific: they name other vendors' systems, other
 * industries, and compliance artefacts that live outside a product manual. If
 * one of these scores as highly as a real question, the corpus cannot support a
 * refusal guarantee and the floor stays off rather than being faked.
 */
const OFF_DOMAIN = [
  "does this integrate with SAP S/4HANA out of the box?",
  "can I run this on my own Kubernetes cluster on-premise?",
  "what is your uptime SLA for the Australian region?",
  "does it support COBOL mainframe connectors?",
  "can I get FedRAMP High authorization documentation?",
  "what is the price of a Tesla Model 3?",
  "how do I file my income tax return in India?",
  "does it come with a built-in flight booking engine?",
];

/** Where to put the line between "this is grounded" and "refuse". */
async function calibrateGrounding(): Promise<{ floor: number; n: number } | null> {
  const cases = await loadBench();
  if (cases.length < 20 || kb.docs.length < 200) {
    console.log(`  grounding: skipped — needs a real corpus (${kb.docs.length} chunks, ${cases.length} questions)`);
    return null;
  }
  const top = async (q: string) => (await kb.searchDocsSemantic(q, 4))[0]?.score ?? 0;
  /*
   * Pace the probes. This runs straight after the weight sweep's embeddings, and
   * the combined burst reliably tripped HTTP 429 on the gateway — which the
   * degradation guard then (correctly) turned into a refusal to save, so
   * calibration could never complete. A calibration run is offline and
   * infrequent; spending a few extra seconds to stay under the limit is free,
   * whereas a demo turn could not afford this.
   */
  const paced = async (q: string) => { const s = await top(q); await new Promise((r) => setTimeout(r, 400)); return s; };
  const ans: number[] = [];
  for (const c of cases.slice(0, 40)) ans.push(await paced(c.question));
  const off: number[] = [];
  for (const q of OFF_DOMAIN) off.push(await paced(q));

  const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.floor(a.length * p)] ?? 0;
  const ansLow = pct(ans, 0.05);
  const offHigh = Math.max(...off);
  console.log(`  grounding: answerable p05 ${ansLow.toFixed(3)} · off-domain max ${offHigh.toFixed(3)}`);

  if (offHigh >= ansLow) {
    console.warn(
      `  ⚠ off-domain questions score as highly as real ones — NOT enabling a grounding floor.` +
        `\n    Any threshold here would reject real questions to block fake ones. Refusal must stay the model's job until the corpus separates them.`,
    );
    return null;
  }
  // Midway between the two distributions: as far from rejecting a real question
  // as from accepting an off-domain one.
  const floor = Number(((ansLow + offHigh) / 2).toFixed(3));
  console.log(`  grounding: floor ${floor} (blocks off-domain, keeps answerable)`);
  return { floor, n: ans.length + off.length };
}

async function calibrateDocs(): Promise<{ semWeight: number; n: number } | null> {
  const cases = await loadBench();
  if (cases.length < 20) {
    console.log(`  docs: skipped — need >=20 benchmark questions, have ${cases.length} (run npm run bench:generate)`);
    return null;
  }
  const docs = kb.docs.filter((d) => d.embedding?.length);
  if (!docs.length) { console.log("  docs: skipped — no embeddings"); return null; }

  const prepared = [];
  for (const c of cases) {
    const qv = await embedOne(c.question);
    if (!qv) continue;
    // Same candidate pool as searchDocsSemantic uses in production. A different
    // pool size changes the lexical normalisation denominator, so sweeping with
    // one and serving with another optimises a function we never run.
    const lexical = kb.searchDocs(c.question, Math.max(K * 3, 12));
    const maxLex = Math.max(...lexical.map((l) => l.score), 1);
    prepared.push({
      c,
      lex: new Map(lexical.map((l) => [l.chunk.id, l.score / maxLex])),
      sem: new Map(docs.map((d) => [d.id, cosine(qv, d.embedding!)])),
    });
  }
  const trust = (t: string) => (t === "official" ? 1.3 : t === "marketing" ? 1.1 : 1.0);

  let best = { w: DEFAULT_CALIBRATION.semWeight, score: -1 };
  for (const semW of [1.0, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.6, 0.5]) {
    const lexW = 1 - semW;
    let rr = 0;
    for (const p of prepared) {
      const ranked = docs
        .map((d) => ({ d, s: (semW * (p.sem.get(d.id) ?? 0) + lexW * (p.lex.get(d.id) ?? 0)) * trust(d.trust) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, K);
      const idx = ranked.findIndex((r) => chunkHash(r.d.text) === p.c.goldHash);
      if (idx >= 0) rr += 1 / (idx + 1);
    }
    // MRR rather than recall@1: it rewards moving the right answer UP even when
    // it was already in the window, so the curve has a real gradient to follow.
    const mrr = rr / prepared.length;
    console.log(`    semW ${semW.toFixed(2)} → MRR ${mrr.toFixed(3)}`);
    if (mrr > best.score) best = { w: semW, score: mrr };
  }
  console.log(`  docs: best semWeight ${best.w} (MRR ${best.score.toFixed(3)}, n=${prepared.length})`);
  return { semWeight: best.w, n: prepared.length };
}

/** Realistic buyer phrasings for a journey goal — deliberately NOT restatements. */
async function paraphrase(model: ReturnType<typeof makeBrain>, goal: string): Promise<string[]> {
  const system = `You write how a real customer would ASK for something during a live product demo.

Given a task the product can do, write 3 different ways a buyer might request it out loud.
Use everyday language and DIFFERENT words from the task name — contractions, idiom, indirect phrasing.
One per line. No numbering, no quotes, nothing else.`;
  const res = await model.step(system, [{ role: "user", blocks: [{ type: "text", text: goal }] }] as NMessage[], []).catch(() => null);
  return (res?.texts.join("\n") ?? "")
    .split("\n")
    .map((l) => l.replace(/^[-*\d.\s"']+|["'\s]+$/g, "").trim())
    .filter((l) => l.length > 8)
    .slice(0, 3);
}

async function calibrateFlows(): Promise<{ floor: number; strong: number; dominance: number; n: number } | null> {
  const graph = await loadGraph();
  const verified = graph.journeys.filter((j) => j.status === "verified");
  const flows = kb.flows.filter((f) => f.embedding?.length);
  if (verified.length < 2 || flows.length < 2) {
    console.log(`  flows: skipped — need >=2 verified journeys with embeddings (have ${verified.length}/${flows.length})`);
    return null;
  }

  /*
   * For each journey, phrase it several ways and record the score of the RIGHT
   * flow and of its best competitor. The floor must sit below the weakest
   * correct match; the dominance ratio only has to break near-ties.
   *
   * CRITICAL: the phrasings must be REALISTIC, not restatements of the goal.
   * Calibrating on "Start checkout" and "show me how to start checkout" measures
   * a distribution centred around 0.69 — but a real buyer says "I need to sort
   * out payment for this lot", which scores 0.36 against the same flow. A floor
   * derived from the easy distribution sits above most real utterances, so the
   * primary matcher rejects correct answers all day and silently falls through
   * to keyword matching. Measured, not theorised: the first version of this
   * function produced floor 0.45 and did exactly that.
   */
  const correct: number[] = [];
  const wrong: number[] = [];
  const model = makeBrain("planner");
  for (const j of verified) {
    const phrasings = [j.goal, ...(await paraphrase(model, j.goal))];
    for (const q of phrasings) {
      const qv = await embedOne(q);
      if (!qv) continue;
      const ranked = flows
        .map((f) => ({ f, s: cosine(qv, f.embedding!) }))
        .sort((a, b) => b.s - a.s);
      const mine = ranked.find((r) => r.f.name === j.goal);
      const other = ranked.find((r) => r.f.name !== j.goal);
      if (mine) correct.push(mine.s);
      if (other) wrong.push(other.s);
    }
  }
  if (correct.length < 4) { console.log("  flows: skipped — too few measurable phrasings"); return null; }

  const sorted = [...correct].sort((a, b) => a - b);
  const p10 = sorted[Math.floor(sorted.length * 0.1)];
  const wrongSorted = [...wrong].sort((a, b) => a - b);
  const wrongP90 = wrongSorted[Math.floor(wrongSorted.length * 0.9)] ?? 0;

  /*
   * The floor is derived from the CORRECT distribution only, never raised to
   * clear the competitor distribution.
   *
   * On realistic phrasing those two distributions OVERLAP — measured on Swag
   * Labs: correct p10 0.363, competitor p90 0.577. There is therefore no floor
   * that separates them, and raising the floor toward the competitors buys a
   * little precision by rejecting a large share of correct matches, which then
   * fall through to keyword matching. The floor's only job is "is this related
   * at all"; discrimination between related flows belongs to the dominance
   * ratio and the verb class, which compare candidates rather than thresholding
   * them independently.
   */
  const floor = Math.max(0.2, Math.min(0.4, p10 - 0.05));
  const strong = Math.max(floor + 0.05, sorted[Math.floor(sorted.length * 0.5)]);
  const overlap = wrongP90 > p10;
  console.log(
    `  flows: correct p10 ${p10.toFixed(3)} · competitor p90 ${wrongP90.toFixed(3)} → floor ${floor.toFixed(3)}, strong ${strong.toFixed(3)} (n=${correct.length})`,
  );
  if (overlap) {
    console.warn(
      `  ⚠ score distributions OVERLAP (a competing flow commonly outscores the right one on real phrasing).\n` +
        `    No threshold can separate them, so routing accuracy here rests on the verb class and dominance ratio.\n` +
        `    The durable fixes are more distinct journey goals, or richer intent phrases per flow — not a different floor.`,
    );
  }
  return { floor, strong, dominance: DEFAULT_CALIBRATION.flowDominance, n: correct.length };
}

console.log(`(product: ${config.product})`);
await kb.load();
console.log(`corpus ${kb.docs.length} chunks · ${kb.flows.length} flows\n`);

const prev = await loadCalibration(config.product);
resetDegraded();
const docs = await calibrateDocs();
const flows = await calibrateFlows();
/*
 * Measured AFTER the doc weight, so the floor reflects the scores the product
 * will actually serve. That ordering costs a cooldown: the weight sweep embeds
 * ~60 questions, and going straight into the grounding probes put the combined
 * burst over the gateway's rate limit every single run — each probe succeeds on
 * its own, so this is throughput, not a bad query. Without the pause the
 * degradation guard fires and calibration can never complete.
 */
if (docs) {
  console.log("\n  (cooling down before grounding probes so the burst stays under the rate limit…)");
  await new Promise((r) => setTimeout(r, 20000));
}
const grounding = await calibrateGrounding();

if (!docs && !flows && !grounding) {
  console.log("\nNothing measurable — calibration unchanged.");
  process.exit(0);
}

/*
 * Refuse to persist a measurement taken through a degraded run.
 *
 * This is not hypothetical: the first saucedemo calibration hit an HTTP 429
 * partway through, fell back to lexical for some queries, and derived a flow
 * floor of 0.45 from the resulting mush — which would have rejected genuine
 * matches on every future demo. A transient rate limit must not become a
 * permanent mis-tuning, so a degraded run exits non-zero and writes nothing.
 */
if (degradedCount() > 0) {
  console.error(
    `\n❌ Embeddings degraded ${degradedCount()} time(s) during measurement — REFUSING to save.` +
      `\n   Thresholds derived from partially-lexical scores would be wrong and permanent. Re-run when the endpoint is healthy.`,
  );
  process.exit(1);
}

const next: Calibration = {
  semWeight: docs?.semWeight ?? prev?.semWeight ?? DEFAULT_CALIBRATION.semWeight,
  groundingFloor: grounding?.floor ?? prev?.groundingFloor ?? DEFAULT_CALIBRATION.groundingFloor,
  flowFloor: flows?.floor ?? prev?.flowFloor ?? DEFAULT_CALIBRATION.flowFloor,
  flowStrong: flows?.strong ?? prev?.flowStrong ?? DEFAULT_CALIBRATION.flowStrong,
  flowDominance: flows?.dominance ?? prev?.flowDominance ?? DEFAULT_CALIBRATION.flowDominance,
  calibratedAt: new Date().toISOString(),
  sampleSize: (docs?.n ?? 0) + (flows?.n ?? 0) + (grounding?.n ?? 0),
  notes: `docs ${docs ? `n=${docs.n}` : "skipped"}; flows ${flows ? `n=${flows.n}` : "skipped"}; grounding ${grounding ? `n=${grounding.n}` : "skipped"}`,
};

await saveCalibration(config.product, next);
console.log(`\nSaved calibration for ${config.product}:`);
console.log(`  semWeight ${next.semWeight}  flowFloor ${next.flowFloor.toFixed(3)}  flowStrong ${next.flowStrong.toFixed(3)}  flowDominance ${next.flowDominance}`);
process.exit(0);
