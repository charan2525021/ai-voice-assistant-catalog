import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { brain, type BrainStore, type DocChunk, type Flow, type MapEdge, type MapNode, type Persona, type PlaybookItem } from "./store.js";
import { chunkText, runCrawl, type CrawlSpec } from "./crawl.js";
import {
  chunkStructuredSections,
  documentJourneyPlanningEnabled,
  parseDocumentSections,
  type DocumentSection,
} from "./document-structure.js";
import { extractDocumentProcedures } from "./procedures.js";
import { emit } from "../events.js";

// ============================ Content ingestion (per product) ============================

/** Reject scaffolding shipped with a product folder before it becomes "knowledge". */
export function isPlaceholderContent(raw: string): boolean {
  const normalized = raw.toLowerCase().replace(/\s+/g, " ");
  return [
    "replace this with real product documentation",
    "replace with real product documentation",
    "tia may only state facts that appear here",
    "add your product documentation here",
    "todo: add product documentation",
  ].some((marker) => normalized.includes(marker));
}

/** Local files use the SAME overlap-aware chunker as the crawler, so a fact that
 *  spans a boundary is retrievable regardless of where the text came from. */
async function readTextFiles(dir: string, trust: DocChunk["trust"]): Promise<{ docs: DocChunk[]; sections: DocumentSection[] }> {
  if (!existsSync(dir)) return { docs: [], sections: [] };
  const out: DocChunk[] = [];
  const sections: DocumentSection[] = [];
  for (const name of await fs.readdir(dir)) {
    if (!/\.(md|markdown|txt)$/i.test(name)) continue;
    const raw = await fs.readFile(path.join(dir, name), "utf8");
    if (isPlaceholderContent(raw)) {
      console.warn(`  ! skipped placeholder document ${name}`);
      continue;
    }
    const title = (raw.match(/^#\s+(.+)$/m)?.[1] || name.replace(/\.(md|markdown|txt)$/i, "")).trim();
    const freshness = new Date().toISOString();
    if (documentJourneyPlanningEnabled()) {
      const parsed = parseDocumentSections(raw, { source: name, title, trust, freshness });
      sections.push(...parsed);
      out.push(...chunkStructuredSections(parsed).map((chunk, i) => ({ id: `${name}-${i}`, ...chunk })));
    } else {
      const text = raw.replace(/^#\s+.+$/m, "").replace(/[#*`>]/g, "").trim();
      out.push(...chunkText(text).map((t, i) => ({ id: `${name}-${i}`, text: t, source: name, title, section: title, trust, freshness })));
    }
  }
  return { docs: out, sections };
}

/**
 * Web sources, from either config file.
 *
 * `sources.txt` — one URL per line, optional leading trust word. Unchanged
 *   syntax, but it now goes through the real fetcher: status-checked,
 *   main-content extracted, overlap-chunked. The old path stored 404 error
 *   pages as official documentation.
 * `sources.json` — `{ "crawls": [CrawlSpec, …] }` for sitemap-scale ingestion
 *   with include/exclude filters, a page limit and concurrency.
 *
 * Both may be present; results are concatenated.
 */
async function crawlSources(txtFile: string, jsonFile: string): Promise<{ docs: DocChunk[]; sections: DocumentSection[] }> {
  const specs: CrawlSpec[] = [];

  if (existsSync(txtFile)) {
    const byTrust = new Map<DocChunk["trust"], string[]>();
    const lines = (await fs.readFile(txtFile, "utf8")).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    for (const line of lines) {
      const [maybeTrust, ...rest] = line.split(/\s+/);
      const known = ["official", "marketing", "community"].includes(maybeTrust);
      const trust = (known ? maybeTrust : "official") as DocChunk["trust"];
      const url = rest.length ? rest.join(" ") : maybeTrust;
      if (!/^https?:\/\//i.test(url)) continue;
      if (!byTrust.has(trust)) byTrust.set(trust, []);
      byTrust.get(trust)!.push(url);
    }
    for (const [trust, urls] of byTrust) specs.push({ urls, trust });
  }

  if (existsSync(jsonFile)) {
    try {
      const cfg = JSON.parse(await fs.readFile(jsonFile, "utf8")) as { crawls?: CrawlSpec[] };
      specs.push(...(cfg.crawls ?? []));
    } catch (e) {
      console.warn(`  ! bad JSON in ${jsonFile}: ${(e as Error).message}`);
    }
  }

  const out: DocChunk[] = [];
  const sections: DocumentSection[] = [];
  for (const spec of specs) {
    const res = await runCrawl(spec);
    out.push(...res.chunks.map((c, i) => ({ ...c, id: `crawl-${out.length + i}` })));
    sections.push(...res.sections);
  }
  return { docs: out, sections };
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (e) {
    console.warn(`  ! bad JSON in ${file}: ${(e as Error).message}`);
    return fallback;
  }
}

/** Load a product's content folder into the Brain. All parts are optional. */
export async function ingestContent(dir: string, store: BrainStore = brain): Promise<void> {
  const brain = store; // shadow the default singleton so this is product-scoped
  await brain.load();
  const started = Date.now();
  emit("ingest.run", { status: "start", data: { directory: path.basename(dir) } });
  try {

  const localDocs = await readTextFiles(path.join(dir, "docs"), "official");
  const marketingDocs = await readTextFiles(path.join(dir, "marketing"), "marketing");
  const crawledDocs = await crawlSources(path.join(dir, "sources.txt"), path.join(dir, "sources.json"));
  const docs: DocChunk[] = [
    ...localDocs.docs,
    ...marketingDocs.docs,
    ...crawledDocs.docs,
  ];
  // give ids uniqueness across sources
  docs.forEach((d, i) => (d.id = `doc-${i}`));
  for (const chunk of docs) {
    emit("ingest.chunk", { status: "ok", data: {
      chunkId: chunk.id, title: chunk.title, source: chunk.source, trust: chunk.trust,
      charCount: chunk.text.length, chunkText: chunk.text,
    } });
  }

  const flows = (await readJson<Flow[]>(path.join(dir, "flows.json"), [])).map((f, i) => ({
    ...f,
    id: f.id || `flow-${i}`,
    intents: f.intents ?? [],
    steps: f.steps ?? [],
    talkingPoints: f.talkingPoints ?? [],
    prerequisites: f.prerequisites ?? "none",
    resetSteps: f.resetSteps ?? "",
  }));
  const playbook = (await readJson<PlaybookItem[]>(path.join(dir, "playbook.json"), [])).map((p, i) => ({
    ...p,
    id: p.id || `pb-${i}`,
    personas: p.personas ?? ["*"],
    keywords: p.keywords ?? [],
  }));
  const personas = (await readJson<Persona[]>(path.join(dir, "personas.json"), [])).map((p, i) => ({
    ...p,
    id: p.id || `persona-${i}`,
    pains: p.pains ?? [],
    keywords: p.keywords ?? [],
  }));

  brain.setDocs(docs);
  const sections = [...localDocs.sections, ...marketingDocs.sections, ...crawledDocs.sections];
  const procedures = documentJourneyPlanningEnabled() ? await extractDocumentProcedures(sections) : [];
  if (documentJourneyPlanningEnabled()) brain.setDocumentPlanningData(sections, procedures);
  brain.setAuthoredFlows(flows);
  brain.setPlaybook(playbook);
  brain.setPersonas(personas);

  // Semantic index — this is what lets real user phrasing find the right content.
  process.stdout.write("  building semantic index… ");
  const emb = await brain.buildEmbeddings();

  await brain.save("docs", "flows", "playbook", "personas", ...(documentJourneyPlanningEnabled() ? ["sections", "procedures"] as const : []));
  emit("ingest.run", { status: "ok", ms: Date.now() - started, data: {
    sources: [...new Map(docs.map((doc) => [`${doc.source}\u0000${doc.trust}`, {
      source: doc.source, title: doc.title, trust: doc.trust,
    }])).values()],
    chunkCount: docs.length,
    embeddedCount: emb.docs,
    procedureCount: procedures.length,
    flowCount: flows.length,
  } });
  } catch (error) {
    emit("ingest.run", { status: "error", ms: Date.now() - started,
      error: (error as Error).message, data: { directory: path.basename(dir) } });
    throw error;
  }
}

// ============================ Product-map crawl (B2, optional) ============================

const SNAP = `(() => {
  const sel = 'a[href], button, input, textarea, select, [role="button"], [role="tab"]';
  const els = [...document.querySelectorAll(sel)].map(e => (e.innerText || e.getAttribute('aria-label') || e.getAttribute('placeholder') || '').trim()).filter(Boolean).slice(0, 40);
  return { title: document.title, elements: [...new Set(els)] };
})()`;

/** Lightly crawl the product from its start URL to record screens (context for flows). */
export async function crawlMap(startUrl: string, maxPages = 8): Promise<void> {
  await brain.load();
  console.log(`Crawling product map from ${startUrl} (max ${maxPages} pages)`);
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];
  const seen = new Set<string>();
  const queue = [startUrl];
  const origin = new URL(startUrl).origin;

  while (queue.length && nodes.length < maxPages) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      const snap = (await page.evaluate(SNAP)) as { title: string; elements: string[] };
      const id = `node-${nodes.length}`;
      nodes.push({ id, url, label: snap.title || url, summary: snap.elements.slice(0, 8).join(", "), elements: snap.elements });
      const links = (await page.evaluate(`[...document.querySelectorAll('a[href]')].map(a => a.href)`)) as string[];
      for (const l of links) {
        if (l.startsWith(origin) && !seen.has(l) && queue.length + nodes.length < maxPages) {
          queue.push(l);
          edges.push({ from: id, to: l, action: "navigate" });
        }
      }
      console.log(`  mapped ${url} → ${snap.elements.length} elements`);
    } catch (e) {
      console.warn(`  ! ${url}: ${(e as Error).message}`);
    }
  }
  await browser.close();
  brain.setMap(nodes, edges);
  await brain.save("mapNodes", "mapEdges");
  console.log(`Product map: ${nodes.length} screens recorded.`);
}
