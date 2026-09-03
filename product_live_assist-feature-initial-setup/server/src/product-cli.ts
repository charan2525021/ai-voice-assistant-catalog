import { getProduct, listProducts, saveProduct, scaffoldProduct } from "./products.js";
import { onboardProduct, preflight } from "./onboarding.js";
import { loadGraph } from "./mapper/graph.js";
import { flushEvents } from "./events.js";

/**
 * Product onboarding from the command line.
 *
 *   npm run product:add -- --name "Acme CRM" --url https://app.acme.com [--user u --pass p] [--allow checkout]
 *   npm run product:list
 *   npm run product:onboard -- --id acme-crm [--jobs 5] [--screens 6]
 *   npm run product:show -- --id acme-crm
 *
 * Same code path as the HTTP API, so CLI and UI can't drift apart.
 */
function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const cmd = process.argv[2];

if (cmd === "add") {
  const name = arg("name");
  const url = arg("url");
  if (!name || !url) fail('usage: product:add -- --name "My Product" --url https://app.example.com [--user U --pass P] [--allow checkout,buy] [--no-map]');

  const rec = await scaffoldProduct({
    name,
    startUrl: url,
    auth: arg("user") ? { mode: "login", username: arg("user"), password: arg("pass") } : { mode: "none" },
    allowActions: arg("allow") ? arg("allow").split(",").map((s) => s.trim()).filter(Boolean) : [],
    notes: arg("notes") || undefined,
  });
  console.log(`✓ registered "${rec.name}" as id "${rec.id}" → content/${rec.id}/`);

  console.log("\n① Preflight: can we reach it, and are we past any login?");
  const pre = await preflight(rec);
  console.log(`   ${pre.ok ? "✓" : "✗"} ${pre.message}`);
  rec.onboarding = { status: pre.ok ? "preflight_ok" : "preflight_failed", message: pre.message, updatedAt: new Date().toISOString() };
  await saveProduct(rec);

  if (!pre.ok) {
    console.log(`\nFix the above, then run:  npm run product:onboard -- --id ${rec.id}`);
    await flushEvents();
    process.exit(1);
  }
  if (has("no-map")) {
    console.log(`\nSkipping mapping. When ready:  npm run product:onboard -- --id ${rec.id}`);
    await flushEvents();
    process.exit(0);
  }
  console.log("\n② Onboarding: ingest content, then map + verify journeys…\n");
  const out = await onboardProduct(rec, { maxJobs: Number(arg("jobs", "5")), maxScreens: Number(arg("screens", "6")), log: (l) => console.log(`   ${l}`) });
  console.log(`\n✓ ${rec.name} ready — ${out.verified}/${out.journeys} journeys verified, ${out.capabilities} capability area(s)`);
  console.log(`  Demo it: open http://localhost:${process.env.PORT ?? 8787} and pick "${rec.name}"`);
} else if (cmd === "docs") {
  // Attach knowledge to an existing product from local files and/or URLs.
  const rec = await getProduct(arg("id"));
  if (!rec) fail("usage: product:docs -- --id <product-id> [--files a.md,b.md] [--sources https://…,https://…]");
  const { promises: fsp } = await import("node:fs");
  const path = await import("node:path");
  const { CONTENT_ROOT } = await import("./products.js");
  const { ingestContent } = await import("./knowledge/ingest.js");
  const { brainFor } = await import("./knowledge/store.js");
  const dir = path.join(CONTENT_ROOT, rec!.id);
  await fsp.mkdir(path.join(dir, "docs"), { recursive: true });
  let n = 0;
  for (const f of arg("files").split(",").map((x) => x.trim()).filter(Boolean)) {
    const text = await fsp.readFile(f, "utf8");
    await fsp.writeFile(path.join(dir, "docs", path.basename(f).replace(/\.[^.]+$/, "") + ".md"), text);
    n++;
  }
  const sources = arg("sources").split(",").map((x) => x.trim()).filter(Boolean);
  if (sources.length) await fsp.writeFile(path.join(dir, "sources.txt"), sources.join("\n") + "\n");
  const kb = await brainFor(rec!.id);
  await ingestContent(dir, kb);
  console.log(`✓ ${n} file(s) + ${sources.length} source(s) → ${kb.docs.length} doc chunk(s) indexed`);
} else if (cmd === "list") {
  const products = await listProducts();
  if (!products.length) console.log('No products yet. Add one:  npm run product:add -- --name "X" --url https://…');
  for (const p of products) {
    const g = await loadGraph(p.id, p.startUrl).catch(() => null);
    const v = g ? g.journeys.filter((j) => j.status === "verified").length : 0;
    console.log(`  ${p.id.padEnd(20)} ${String(p.onboarding?.status ?? "new").padEnd(16)} ${v} verified journey(s)  ${p.startUrl}`);
  }
} else if (cmd === "onboard") {
  const rec = await getProduct(arg("id"));
  if (!rec) fail("usage: product:onboard -- --id <product-id>   (see product:list)");
  const out = await onboardProduct(rec!, { maxJobs: Number(arg("jobs", "5")), maxScreens: Number(arg("screens", "6")), log: (l) => console.log(`   ${l}`) });
  console.log(`\n✓ ${rec!.name}: ${out.verified}/${out.journeys} verified, ${out.capabilities} capability area(s)`);
} else if (cmd === "show") {
  const rec = await getProduct(arg("id"));
  if (!rec) fail("usage: product:show -- --id <product-id>");
  const g = await loadGraph(rec!.id, rec!.startUrl);
  console.log(`${rec!.name} (${rec!.id}) — ${rec!.startUrl}`);
  console.log(`status: ${rec!.onboarding?.status ?? "new"} — ${rec!.onboarding?.message ?? ""}`);
  console.log(`\nCapabilities:`);
  g.capabilities.forEach((c) => console.log(`  • ${c.name}: ${c.description || "—"} (${c.journeys.length} flow(s))`));
  console.log(`\nJourneys:`);
  g.journeys.forEach((j) => {
    const narrated = j.steps.filter((s) => s.say).length;
    console.log(`  ${j.status === "verified" ? "✓" : "✗"} ${j.goal} — ${j.steps.length} step(s), ${narrated} narrated`);
  });
} else {
  fail("commands: add | docs | list | onboard | show");
}
await flushEvents();
process.exit(0);

async function fail(msg: string): Promise<never> {
  console.error(msg);
  await flushEvents(); // an error is exactly the event worth not losing
  process.exit(1);
}
