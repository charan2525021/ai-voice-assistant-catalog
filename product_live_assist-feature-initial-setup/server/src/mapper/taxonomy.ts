import { makeBrain, type NMessage } from "../brain.js";
import type { ProductGraph, CapabilityNode } from "./types.js";

/**
 * Build a real capability taxonomy.
 *
 * Previously each journey produced its own "capability", so the graph had a 1:1
 * mapping and the word carried no information ("Continue shopping from the cart"
 * is a journey, not a capability). Grouping journeys into genuine capability
 * areas is what lets the graph answer "what can this product do?" and what gives
 * traversal something meaningful to walk between.
 */
export async function buildTaxonomy(graph: ProductGraph): Promise<CapabilityNode[]> {
  const verified = graph.journeys.filter((j) => j.status === "verified");
  if (!verified.length) return [];

  const model = makeBrain("planner");
  const list = verified.map((j, i) => `${i + 1}. ${j.goal}${j.meaning ? ` — ${j.meaning}` : ""}`).join("\n");

  const system = `You organise a product's capabilities.

Given the tasks a product supports, group them into a small number of CAPABILITY AREAS — the
coarse things the product does, as a buyer would describe them (e.g. "Cart & checkout",
"Catalog browsing", "Reporting"). Aim for 2–6 areas; several tasks per area.

For each area output exactly one line:
AREA: <name> | <one-sentence description> | <task numbers, comma separated>

Use only the task numbers given. Every task must appear in exactly one area. No other output.`;

  const res = await model.step(system, [{ role: "user", blocks: [{ type: "text", text: list }] }] as NMessage[], []);
  const text = res.texts.join("\n");

  const caps: CapabilityNode[] = [];
  const assigned = new Set<number>();
  for (const raw of text.split("\n")) {
    /*
     * Parse tolerantly. The model reliably produces the GROUPING but not the
     * exact punctuation — it drops the "AREA:" prefix and separates name from
     * description with ":" rather than "|". The dependable anchor is the trailing
     * list of task numbers, so key off that and treat the rest as name/description.
     */
    const line = raw.replace(/^\s*(?:AREA\s*:)?\s*/i, "").replace(/^[-*\d.\s]+/, "").trim();
    const cut = line.lastIndexOf("|");
    if (cut < 0) continue;
    const nums = line.slice(cut + 1).trim();
    if (!/^[\d,\s]+$/.test(nums) || !nums) continue;
    const head = line.slice(0, cut).trim();
    const sep = head.search(/\s*[|:]\s*/);
    const name = (sep > 0 ? head.slice(0, sep) : head).trim();
    const description = (sep > 0 ? head.slice(sep).replace(/^\s*[|:]\s*/, "") : "").trim();
    if (!name) continue;
    const idxs = nums
      .split(",")
      .map((n) => parseInt(n.trim(), 10) - 1)
      .filter((n) => n >= 0 && n < verified.length && !assigned.has(n));
    if (!idxs.length) continue;
    idxs.forEach((n) => assigned.add(n));
    const journeys = idxs.map((n) => verified[n]);
    caps.push({
      id: `cap-${caps.length}`,
      name: name.trim(),
      description: description.trim(),
      journeys: journeys.map((j) => j.id),
      entities: [...new Set(journeys.flatMap((j) => j.entities))],
    });
    journeys.forEach((j) => (j.capability = name.trim()));
  }

  // Anything the model missed keeps its own area, so nothing is silently dropped.
  verified.forEach((j, i) => {
    if (assigned.has(i)) return;
    caps.push({ id: `cap-${caps.length}`, name: j.capability, description: "", journeys: [j.id], entities: j.entities });
  });
  return caps;
}
