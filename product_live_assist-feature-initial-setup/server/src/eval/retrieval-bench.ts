import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { makeBrain, type NMessage } from "../brain.js";
import { brain as kb, type BrainStore } from "../knowledge/store.js";

/**
 * Retrieval benchmark.
 *
 * The existing eval suite tests FLOW ROUTING (does phrasing reach the right
 * journey) and refusal. It says nothing about whether the right *document* is
 * retrieved, because until there was a real corpus there was nothing to measure:
 * every product had one or two chunks, so top-4 retrieval returned the entire
 * knowledge base and scored a perfect result while proving nothing.
 *
 * With a real corpus, retrieval quality becomes a number. The method is the
 * standard synthetic-IR one: take a known chunk, have a model write a question
 * that chunk answers, then check whether retrieval finds that chunk again.
 *
 * Honest limitation: questions generated FROM a chunk share its vocabulary, so
 * absolute scores here flatter the system relative to a real prospect who uses
 * their own words. It is a reliable instrument for measuring CHANGE — the same
 * questions before and after a change — not for quoting an absolute accuracy.
 */

export interface BenchCase {
  question: string;
  /** Stable identity of the gold chunk — ids are reassigned on every ingest. */
  goldHash: string;
  goldTitle: string;
  /** Source article the gold chunk came from (document-level scoring). */
  goldSource?: string;
}

/** Content-addressed id, stable across re-ingest as long as chunking is stable. */
export function chunkHash(text: string): string {
  return createHash("sha1").update(text.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16);
}

const benchFile = () => path.join(config.contentDir || "", "retrieval-bench.json");

// ============================ Generation ============================

export async function generateBench(store: BrainStore, count = 60): Promise<BenchCase[]> {
  const docs = store.docs.filter((d) => d.text.length > 300);
  if (docs.length < count) throw new Error(`corpus too small to benchmark: ${docs.length} usable chunks`);

  // Spread the sample across the corpus rather than taking a contiguous block,
  // so one documentation section cannot dominate the score.
  const stride = Math.floor(docs.length / count);
  const sample = Array.from({ length: count }, (_, i) => docs[i * stride]);

  const model = makeBrain("planner");
  const out: BenchCase[] = [];
  for (const [i, d] of sample.entries()) {
    const system = `You write ONE realistic question a prospective customer would ask a salesperson about this product.

Rules:
- The question must be answerable from the passage below.
- Ask the way a BUYER talks, not the way documentation is written. Do not copy phrases from the passage.
- One sentence. No preamble, no quotes. Output only the question.`;
    const res = await model
      .step(system, [{ role: "user", blocks: [{ type: "text", text: d.text.slice(0, 1200) }] }] as NMessage[], [])
      .catch(() => null);
    const q = res?.texts.join(" ").trim().split("\n")[0]?.replace(/^["'\s]+|["'\s]+$/g, "");
    if (!q || q.length < 12) continue;
    out.push({ question: q, goldHash: chunkHash(d.text), goldTitle: d.title, goldSource: d.source });
    if ((i + 1) % 10 === 0) console.log(`  generated ${out.length}/${count}…`);
  }
  await fs.writeFile(benchFile(), JSON.stringify(out, null, 2));
  console.log(`Wrote ${out.length} case(s) to ${benchFile()}`);
  return out;
}

export async function loadBench(): Promise<BenchCase[]> {
  const f = benchFile();
  if (!existsSync(f)) return [];
  return JSON.parse(await fs.readFile(f, "utf8")) as BenchCase[];
}

// ============================ Scoring ============================

export interface BenchResult {
  n: number;
  recallAt1: number;
  recallAt4: number;
  mrr: number;
  /**
   * Did the right ARTICLE appear at all? This, not exact-chunk recall, is what
   * determines whether the agent can answer: adjacent chunks of one article
   * usually carry the same fact, and chunks now overlap on purpose. Exact-chunk
   * recall also penalises diversity by construction, so optimising for it alone
   * would push the system toward returning four windows onto one paragraph.
   */
  sourceRecall: number;
  /** Distinct articles per result set — the diversity MMR is meant to buy. */
  distinctSources: number;
  misses: { question: string; goldTitle: string; got: string }[];
}

export async function runBench(store: BrainStore, cases: BenchCase[], k = 4): Promise<BenchResult> {
  let hit1 = 0;
  let hitK = 0;
  let rrSum = 0;
  let srcHit = 0;
  let srcSpread = 0;
  const misses: BenchResult["misses"] = [];

  for (const c of cases) {
    const hits = await store.searchDocsSemantic(c.question, k);
    const ranks = hits.map((h) => chunkHash(h.chunk.text));
    const idx = ranks.indexOf(c.goldHash);
    if (idx === 0) hit1++;
    if (idx >= 0) {
      hitK++;
      rrSum += 1 / (idx + 1);
    } else {
      misses.push({ question: c.question, goldTitle: c.goldTitle, got: hits[0]?.chunk.title ?? "(nothing)" });
    }
    if (c.goldSource && hits.some((h) => h.chunk.source === c.goldSource)) srcHit++;
    srcSpread += new Set(hits.map((h) => h.chunk.source)).size;
  }

  const n = cases.length || 1;
  return {
    n: cases.length,
    recallAt1: hit1 / n,
    recallAt4: hitK / n,
    mrr: rrSum / n,
    sourceRecall: srcHit / n,
    distinctSources: srcSpread / n,
    misses,
  };
}

export function printBench(label: string, r: BenchResult): void {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  console.log(`\n=== ${label} (n=${r.n}) ===`);
  console.log(`  chunk:  recall@1 ${pct(r.recallAt1)}   recall@4 ${pct(r.recallAt4)}   MRR ${r.mrr.toFixed(3)}`);
  console.log(`  article: recall@4 ${pct(r.sourceRecall)}   distinct sources/query ${r.distinctSources.toFixed(2)}`);
  if (r.misses.length) {
    console.log(`  ${r.misses.length} chunk miss(es); first few:`);
    for (const m of r.misses.slice(0, 5)) console.log(`    · "${m.question.slice(0, 70)}" → wanted "${m.goldTitle.slice(0, 40)}", got "${m.got.slice(0, 40)}"`);
  }
}

// ============================ CLI ============================

/*
 * Entry-point check via resolved PATHS, not string-concatenated URLs. The
 * obvious `import.meta.url === \`file://${process.argv[1]}\`` silently never
 * matches here: this repo lives under "…/Sable Product /…", and import.meta.url
 * percent-encodes the spaces while process.argv[1] does not. The module then
 * loads, runs nothing, and exits 0 — looking exactly like a successful run.
 */
if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? "")) {
  const cmd = process.argv[2];
  console.log(`(product: ${config.product})`);
  await kb.load();
  console.log(`corpus: ${kb.docs.length} chunks`);

  if (cmd === "generate") {
    await generateBench(kb, Number(process.argv[3] ?? 60));
  } else {
    const cases = await loadBench();
    if (!cases.length) {
      console.error(`No benchmark for ${config.product}. Run: npm run bench:generate`);
      process.exit(1);
    }
    printBench("Document retrieval", await runBench(kb, cases));
  }
  process.exit(0);
}
