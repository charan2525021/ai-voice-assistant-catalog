import { config } from "../config.js";
import { brain as kb } from "../knowledge/store.js";
import { cosine, embedOne } from "../knowledge/embeddings.js";
import { chunkHash, loadBench } from "./retrieval-bench.js";

/**
 * Parameter sweep for first-stage retrieval.
 *
 * Loads the corpus and the question set ONCE, embeds each question once, then
 * scores every configuration against the same cached vectors. Running the
 * benchmark as separate processes re-loads a 170 MB store and re-embeds every
 * question per configuration, which made sweeping unaffordable and meant the
 * hybrid weight had never actually been tested — 0.7/0.3 was a reasonable guess
 * that no measurement ever challenged.
 */

const K = 4;

async function main() {
  console.log(`(product: ${config.product})`);
  await kb.load();
  const cases = await loadBench();
  if (!cases.length) { console.error("no benchmark — run npm run bench:generate"); process.exit(1); }
  console.log(`corpus ${kb.docs.length} chunks · ${cases.length} questions\n`);

  const docs = kb.docs.filter((d) => d.embedding?.length);
  // Pre-compute per question: its vector, and the lexical scores it produces.
  const prepared = [];
  for (const c of cases) {
    const qv = await embedOne(c.question);
    if (!qv) continue;
    const lexical = kb.searchDocs(c.question, 40);
    const maxLex = Math.max(...lexical.map((l) => l.score), 1);
    const lex = new Map(lexical.map((l) => [l.chunk.id, l.score / maxLex]));
    const sem = new Map(docs.map((d) => [d.id, cosine(qv, d.embedding!)]));
    prepared.push({ c, lex, sem });
  }

  const trust = (t: string) => (t === "official" ? 1.3 : t === "marketing" ? 1.1 : 1.0);

  console.log("  semW  lexW | chunk@1  chunk@4    MRR | article@4");
  console.log("  -----------|--------------------------|----------");
  for (const semW of [1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4]) {
    const lexW = Number((1 - semW).toFixed(2));
    let h1 = 0, hk = 0, rr = 0, src = 0;
    for (const p of prepared) {
      const ranked = docs
        .map((d) => ({ d, s: (semW * (p.sem.get(d.id) ?? 0) + lexW * (p.lex.get(d.id) ?? 0)) * trust(d.trust) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, K);
      const idx = ranked.findIndex((r) => chunkHash(r.d.text) === p.c.goldHash);
      if (idx === 0) h1++;
      if (idx >= 0) { hk++; rr += 1 / (idx + 1); }
      if (p.c.goldSource && ranked.some((r) => r.d.source === p.c.goldSource)) src++;
    }
    const n = prepared.length;
    const pct = (x: number) => `${((x / n) * 100).toFixed(1)}%`.padStart(6);
    console.log(`  ${semW.toFixed(2)}  ${lexW.toFixed(2)} | ${pct(h1)}   ${pct(hk)}  ${(rr / n).toFixed(3)} |  ${pct(src)}`);
  }
  process.exit(0);
}

await main();
