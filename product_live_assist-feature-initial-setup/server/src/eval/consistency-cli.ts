/**
 * Are this install's VERIFIED journeys still executable?
 *
 * Runs for every product, not just the default one. It used to check whichever
 * product `config.product` happened to name — so a green result meant "saucedemo
 * is fine" while a broken Dolibarr sat unexamined behind the same tick. The
 * graph and the brain are module-level singletons bound to that product, so each
 * product is checked in its own process rather than by unpicking that binding.
 *
 *   npm run eval:consistency                # every product
 *   PRODUCT=dolibarr npm run eval:consistency   # just one
 */
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import path from "node:path";

const only = (process.env.PRODUCT ?? "").trim();

if (!only) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const contentRoot = path.resolve(here, "../../../content");
  const products = readdirSync(contentRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name)
    .sort();

  let failed = 0;
  for (const p of products) {
    try {
      const out = execFileSync("npx", ["tsx", fileURLToPath(import.meta.url)], {
        env: { ...process.env, PRODUCT: p },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      process.stdout.write(out);
    } catch (e: any) {
      failed++;
      process.stdout.write(e.stdout || "");
      process.stdout.write(`${p.padEnd(18)} ERROR — ${String(e.stderr || e.message).split("\n")[0]}\n`);
    }
  }
  console.log(`\n${failed === 0 ? "✅ all products consistent" : `❌ ${failed} product(s) failed`}`);
  process.exit(failed === 0 ? 0 : 1);
}

const { config } = await import("../config.js");
const { brain: kb } = await import("../knowledge/store.js");
const { runConsistencyEvals } = await import("./harness.js");
await kb.load();
const r = await runConsistencyEvals();
console.log(
  `${config.product.padEnd(18)} ${r.failed === 0 ? `OK — ${r.passed} verified journey(s) executable` : `FAIL — ${r.failed} of ${r.passed + r.failed}`}`,
);
for (const x of r.results.filter((y) => !y.ok)) console.log(`   ✗ ${x.name}: ${x.detail}`);
process.exit(r.failed === 0 ? 0 : 1);
