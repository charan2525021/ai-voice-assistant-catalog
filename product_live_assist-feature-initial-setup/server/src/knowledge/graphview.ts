import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

/**
 * Graph TRAVERSAL for retrieval.
 *
 * Until now the graph was storage only: retrieval embedded the query and ranked
 * a flat list, so the edges (prerequisites, capability membership) were never
 * used at query time. This walks them, so a matched flow arrives with its
 * prerequisite chain and its sibling capabilities attached — which is what lets
 * Aidan say "first we'd create X, then…" and "this sits alongside Y and Z".
 */

interface GJourney {
  id: string;
  goal: string;
  capability: string;
  status: string;
  requiresJourney?: string[];
  meaning?: string;
  entities: string[];
}
interface GCap {
  name: string;
  description: string;
  journeys: string[];
}
interface G {
  journeys: GJourney[];
  capabilities: GCap[];
  screens: { title: string }[];
}

/** Cached per product, so several products can be traversed concurrently. */
const caches = new Map<string, { at: number; g: G | null }>();

async function graph(product: string = config.product): Promise<G | null> {
  const cache = caches.get(product) ?? { at: 0, g: null };
  const file = path.join(fileURLToPath(new URL("../../data/brain", import.meta.url)), product, "product-graph.json");
  if (!existsSync(file)) return null;
  const st = await fs.stat(file).catch(() => null);
  if (cache.g && st && st.mtimeMs <= cache.at) return cache.g;
  try {
    const g = JSON.parse(await fs.readFile(file, "utf8")) as G;
    caches.set(product, { at: st?.mtimeMs ?? Date.now(), g });
    return g;
  } catch {
    return null;
  }
}

export interface GraphContext {
  /** Ordered prerequisite chain that must happen before this journey. */
  prerequisites: { goal: string; meaning?: string }[];
  /** Other journeys in the same capability area — natural "what else" answers. */
  siblings: { goal: string; meaning?: string }[];
  capability?: { name: string; description: string };
}

/** Walk the graph outward from the journey matching this flow name. */
export async function traverse(flowName: string, product?: string): Promise<GraphContext | null> {
  const g = await graph(product);
  if (!g) return null;
  const byId = new Map(g.journeys.map((j) => [j.id, j]));
  const start = g.journeys.find((j) => j.goal === flowName && j.status === "verified");
  if (!start) return null;

  // Follow requiresJourney edges (guarding against cycles).
  const prerequisites: { goal: string; meaning?: string }[] = [];
  const seen = new Set<string>([start.id]);
  let frontier = start.requiresJourney ?? [];
  while (frontier.length && prerequisites.length < 4) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      const j = byId.get(id);
      if (!j) continue;
      prerequisites.unshift({ goal: j.goal, meaning: j.meaning }); // deepest first
      next.push(...(j.requiresJourney ?? []));
    }
    frontier = next;
  }

  const cap = g.capabilities.find((c) => c.journeys.includes(start.id));
  const siblings = (cap?.journeys ?? [])
    .filter((id) => id !== start.id)
    .map((id) => byId.get(id))
    .filter((j): j is GJourney => !!j)
    .slice(0, 4)
    .map((j) => ({ goal: j.goal, meaning: j.meaning }));

  return { prerequisites, siblings, capability: cap ? { name: cap.name, description: cap.description } : undefined };
}

/**
 * Graph-ASSISTED recall — the graph finding a flow that flat search missed.
 *
 * Until now the graph only decorated a result: flat vector search picked a
 * flow, and traversal then attached its prerequisites and siblings. If flat
 * search returned nothing, the structure contributed nothing, so calling it a
 * knowledge graph oversold what happened at query time.
 *
 * A capability is a much broader target than a journey — "Cart & checkout"
 * matches "I want to pay" far more readily than any single journey goal does.
 * So when per-journey matching fails, match the CAPABILITY first and let its
 * membership propose the journeys. This is a genuine second retrieval route,
 * not a re-ranking of the first one.
 *
 * Returns candidate journey goals, best capability first, for the caller to
 * score against its own threshold — this function deliberately does not decide
 * acceptance, because the acceptance rule lives with the calibrated thresholds.
 */
export async function capabilityCandidates(
  query: string,
  product: string | undefined,
  embedQuery: (t: string) => Promise<number[] | null>,
  similarity: (a: number[], b: number[]) => number,
): Promise<{ capability: string; goals: string[]; score: number } | null> {
  const g = await graph(product);
  if (!g?.capabilities?.length) return null;

  const qv = await embedQuery(query);
  if (!qv) return null;

  const byId = new Map(g.journeys.map((j) => [j.id, j]));
  let best: { capability: string; goals: string[]; score: number } | null = null;

  for (const c of g.capabilities) {
    // Embed the capability the way a buyer would describe the area: its name,
    // its description, and the goals it contains.
    const goals = c.journeys.map((id) => byId.get(id)).filter((j): j is GJourney => !!j && j.status === "verified");
    if (!goals.length) continue;
    const text = [c.name, c.description, ...goals.map((j) => j.goal)].filter(Boolean).join(". ");
    const cv = await embedQuery(text);
    if (!cv) continue;
    const score = similarity(qv, cv);
    if (!best || score > best.score) best = { capability: c.name, goals: goals.map((j) => j.goal), score };
  }
  return best;
}

/** A short "what this product does" summary, straight from the capability graph. */
export async function capabilityOverview(product?: string): Promise<string> {
  const g = await graph(product);
  if (!g?.capabilities?.length) return "";
  return g.capabilities
    .map((c) => `- ${c.name}${c.description ? `: ${c.description}` : ""} (${c.journeys.length} demoable flow(s))`)
    .join("\n");
}
