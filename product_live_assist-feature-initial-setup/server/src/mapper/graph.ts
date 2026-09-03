import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { atomicWrite } from "../atomic-write.js";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { emptyGraph, type ProductGraph, type Journey } from "./types.js";
import { isJourneyPublishable, requiredVerificationRuns } from "./verifier.js";

const BRAIN_ROOT = fileURLToPath(new URL("../../data/brain", import.meta.url));
/** Graphs are per product — the server holds several at once. */
const graphFile = (product: string) => path.join(BRAIN_ROOT, product, "product-graph.json");

export async function loadGraph(product: string = config.product, startUrl = config.demo.startUrl): Promise<ProductGraph> {
  const file = graphFile(product);
  if (!existsSync(file)) return emptyGraph(product, startUrl);
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as ProductGraph;
  } catch {
    return emptyGraph(product, startUrl);
  }
}

/** Kept versions of a product's graph, newest first. */
const versionsDir = (product: string) => path.join(BRAIN_ROOT, product, "graph-versions");
const KEEP_VERSIONS = Number(process.env.GRAPH_VERSIONS_KEPT ?? 10);

export async function saveGraph(g: ProductGraph): Promise<void> {
  const product = g.product || config.product;
  const file = graphFile(product);
  await fs.mkdir(path.dirname(file), { recursive: true });

  /*
   * Keep the version we are about to replace.
   *
   * Re-mapping overwrote in place, so a bad run — a product that was mid-deploy,
   * a session that expired halfway, a network blip — destroyed a good graph with
   * no way back, and the only recovery was to re-map and hope. Journeys are
   * expensive to earn (explore, verify, narrate), so they are worth versioning.
   */
  if (existsSync(file)) {
    try {
      const prev = await fs.readFile(file, "utf8");
      const dir = versionsDir(product);
      await fs.mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await fs.writeFile(path.join(dir, `${stamp}.json`), prev);
      const kept = (await fs.readdir(dir)).filter((f) => f.endsWith(".json")).sort();
      for (const old of kept.slice(0, Math.max(0, kept.length - KEEP_VERSIONS))) {
        await fs.rm(path.join(dir, old), { force: true }).catch(() => {});
      }
    } catch (e) {
      // Never let archiving stop a save — losing history is bad, losing the new
      // graph is worse.
      console.warn(`[graph] could not archive the previous version: ${(e as Error).message}`);
    }
  }

  // atomic — a half-written graph is worse than none
  await atomicWrite(file, JSON.stringify(g, null, 2));
}

export interface GraphVersion {
  id: string;
  savedAt: string;
  journeys: number;
  verified: number;
  screens: number;
}

/** Previous graphs, newest first, with enough detail to choose one. */
export async function listGraphVersions(product: string): Promise<GraphVersion[]> {
  const dir = versionsDir(product);
  if (!existsSync(dir)) return [];
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json")).sort().reverse();
  const out: GraphVersion[] = [];
  for (const f of files) {
    try {
      const g = JSON.parse(await fs.readFile(path.join(dir, f), "utf8")) as ProductGraph;
      out.push({
        id: f.replace(/\.json$/, ""),
        savedAt: f.replace(/\.json$/, "").replace(/-(\d{2})-(\d{2})-(\d{3})Z$/, ":$1:$2.$3Z"),
        journeys: g.journeys?.length ?? 0,
        verified: g.journeys?.filter(isJourneyPublishable).length ?? 0,
        screens: g.screens?.length ?? 0,
      });
    } catch {
      /* a corrupt archive should not hide the rest */
    }
  }
  return out;
}

/** Restore a previous graph. The current one is archived first, so this is undoable. */
export async function restoreGraphVersion(product: string, id: string): Promise<ProductGraph | null> {
  const src = path.join(versionsDir(product), `${id}.json`);
  if (!existsSync(src)) return null;
  const g = JSON.parse(await fs.readFile(src, "utf8")) as ProductGraph;
  await saveGraph({ ...g, product });
  return g;
}

/**
 * Export verified journeys into the Brain's `flows` format, so the live agent
 * (flow-first execution) and Intent Rescue immediately benefit from what the
 * mapper learned. Only VERIFIED journeys are exported — unproven paths never
 * reach a customer demo.
 */
export function journeysToFlows(g: ProductGraph) {
  return g.journeys
    .filter(isJourneyPublishable)
    .map((j, i) => ({
      id: j.id || `flow-${i}`,
      name: j.goal,
      feature: j.capability,
      intents: intentsFor(j.goal),
      steps: j.steps.map(describeStep),
      talkingPoints: j.meaning ? [j.meaning] : [],
      prerequisites: j.preconditions.join("; ") || "none",
      resetSteps: "",
      // Carry the VERIFIED executable program through, so the live agent can
      // replay it deterministically instead of re-deriving the path each time.
      program: j.steps.map((s) => ({ action: s.action, role: s.role, name: s.name, testId: s.testId, value: s.value, submit: s.submit, url: s.url, say: s.say })),
      postcondition: j.postcondition,
      proof: j.proof ?? "text",
      verification: {
        passedRuns: j.verificationRuns?.slice(-requiredVerificationRuns(j)).filter((run) => run.ok).length ?? 0,
        requiredRuns: requiredVerificationRuns(j),
      },
      approval: {
        status: "approved" as const,
        revision: j.revision ?? 1,
        checksum: j.revisionChecksum!,
        approvedChecksum: j.approval!.checksum,
      },
      /*
       * Fall back to the product's entry point. `Journey.startUrl` was added
       * later and backfilled only on Swag Labs, so journeys learned before it
       * published a program with no start screen — and replay refuses to run a
       * program from wherever the prospect happens to be, so the agent silently
       * improvised instead of replaying a verified path. The graph's startUrl is
       * where a clean run begins, which is exactly what replay needs.
       */
      startUrl: j.startUrl ?? g.startUrl,
    }));
}

function describeStep(s: Journey["steps"][number]): string {
  if (s.action === "click") return `Click the ${s.role} "${s.name}"`;
  if (s.action === "fill") return `Type "${s.value}" into the ${s.role} "${s.name}"${s.submit ? " and press Enter" : ""}`;
  if (s.action === "select") return `Choose "${s.value}" in the ${s.role} "${s.name}"`;
  if (s.action === "navigate") return `Open ${s.url}`;
  return `Scroll ${s.direction ?? "down"}`;
}

/** Cheap intent phrases so the existing matcher can route "show me X" to this journey. */
function intentsFor(goal: string): string[] {
  const g = goal.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  const out = new Set<string>([g]);
  out.add(g.replace(/^(create|add) /, "add "));
  out.add(`show me how to ${g}`);
  out.add(`how do i ${g}`);
  return [...out].filter(Boolean);
}
