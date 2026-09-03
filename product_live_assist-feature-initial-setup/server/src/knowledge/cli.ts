import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brain } from "./store.js";
import { crawlMap, ingestContent } from "./ingest.js";
import { makeBrain, type NMessage } from "../brain.js";
import { config } from "../config.js";
import { flushEvents } from "../events.js";

const DATA_DIR = path.join(fileURLToPath(new URL("../../data/brain", import.meta.url)), config.product);

async function main() {
  const [cmd, arg, arg2] = process.argv.slice(2);
  console.log(`(product: ${config.product})`);

  if (cmd === "content") {
    // Defaults to the configured product's folder; pass a path to override.
    const dir = arg || config.contentDir;
    if (!dir) return fail("No product configured. Set PRODUCT=<name> in aidan/.env (folder in aidan/content/), or: cli.ts content <dir>");
    await ingestContent(dir);
  } else if (cmd === "map") {
    const url = arg || config.demo.startUrl;
    if (!url) return fail("usage: cli.ts map <start-url> [maxPages]");
    await crawlMap(url, arg2 ? Number(arg2) : 8);
  } else if (cmd === "signals") {
    await brain.load();
    const s = brain.signals();
    console.log("=== Brain learning signals ===");
    console.log(`Sessions: ${s.totalSessions} | engaged/qualified: ${s.engaged}`);
    console.log("Flows demonstrated:", s.topFlows.length ? s.topFlows.map(([f, n]) => `${f}×${n}`).join(", ") : "none");
    console.log("Objections heard:", s.topObjections.length ? s.topObjections.map(([o, n]) => `"${o}"×${n}`).join(", ") : "none");
    console.log(`KB gaps (unanswered questions): ${s.kbGaps.length}`);
    s.kbGaps.slice(0, 20).forEach((g) => console.log(`  - ${g}`));
  } else if (cmd === "improve") {
    await improve();
  } else {
    fail("commands: content <dir> | map <url> [maxPages] | signals | improve");
  }
}

/** B4 — cluster unanswered questions and draft FAQ entries for human review. */
async function improve() {
  await brain.load();
  const gaps = brain.signals().kbGaps;
  if (!gaps.length) return console.log("No KB gaps logged yet — nothing to improve.");

  // dedupe by frequency
  const counts = new Map<string, number>();
  for (const g of gaps) counts.set(g.trim(), (counts.get(g.trim()) || 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([q]) => q);

  const model = makeBrain();
  const system =
    "You help maintain a product knowledge base. For each unanswered prospect question, draft a SHORT candidate FAQ answer. " +
    "You do NOT know this product's specifics, so write the answer as a template a human must verify/fill, and note what to confirm. Output as a numbered list.";
  const messages: NMessage[] = [
    { role: "user", blocks: [{ type: "text", text: `Unanswered questions:\n${top.map((q, i) => `${i + 1}. ${q}`).join("\n")}` }] },
  ];
  const res = await model.step(system, messages, []);
  const drafts = res.texts.join("\n");
  const outFile = path.join(DATA_DIR, "improvements.json");
  const payload = { generatedAt: new Date().toISOString(), topGaps: top, draftFaqs: drafts, status: "needs_review" };
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(outFile, JSON.stringify(payload, null, 2));
  console.log(`Drafted FAQ candidates for ${top.length} gaps → ${outFile} (review, verify, then add to your product's docs/).`);
  console.log("\n" + drafts);
}

async function fail(msg: string): Promise<never> {
  console.error(msg);
  await flushEvents(); // an error is exactly the event worth not losing
  process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await flushEvents();
  process.exit(1);
});
