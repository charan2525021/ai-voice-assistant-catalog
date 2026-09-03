import { createHash } from "node:crypto";
import { makeBrain, type NMessage, type ToolDef } from "../brain.js";
import { citationFor, type DocumentCitation, type DocumentSection } from "./document-structure.js";

export interface DocumentProcedure {
  id: string;
  sectionId: string;
  goal: string;
  steps: string[];
  /** Exact source text promised by the manual; never model-invented evidence. */
  successMessage?: string;
  prerequisites: string[];
  citation: DocumentCitation;
  extraction: "llm" | "deterministic";
}

const PROCEDURE_TOOL: ToolDef = {
  name: "record_procedures",
  description: "Record procedures stated in the supplied documentation. Do not infer missing facts.",
  parameters: {
    type: "object",
    properties: {
      procedures: {
        type: "array",
        items: {
          type: "object",
          properties: {
            sectionId: { type: "string" },
            goal: { type: "string" },
            steps: { type: "array", items: { type: "string" } },
            successMessage: { type: "string" },
            prerequisites: { type: "array", items: { type: "string" } },
          },
          required: ["sectionId", "goal", "steps", "prerequisites"],
        },
      },
    },
    required: ["procedures"],
  },
};

function key(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 16);
}

function clean(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/** Return the source's exact spelling for a model-supplied proof, or reject it. */
export function exactSourcePhrase(section: DocumentSection, proposal: unknown): string | undefined {
  const wanted = clean(proposal);
  if (!wanted) return undefined;
  const at = section.text.toLowerCase().indexOf(wanted.toLowerCase());
  return at < 0 ? undefined : section.text.slice(at, at + wanted.length);
}

function likelySuccess(section: DocumentSection, listEnd: number): string | undefined {
  for (const paragraph of section.paragraphs.slice(listEnd)) {
    const match = paragraph.match(/(?:success(?: message)?|confirmation|you (?:will|should) see|appears?|displays?|shown):?\s*["“]?([^"”]{3,160})/i);
    if (match) return exactSourcePhrase(section, match[1].replace(/[.”]$/, ""));
  }
  return undefined;
}

/** Deterministic fallback keeps the pipeline usable when the extraction model is unavailable. */
export function proceduresFromSections(sections: DocumentSection[]): DocumentProcedure[] {
  const out: DocumentProcedure[] = [];
  for (const section of sections) {
    for (const list of section.lists.filter((item) => item.ordered && item.items.length >= 2)) {
      const prerequisites = section.paragraphs
        .slice(0, Math.max(0, list.paragraphStart - 1))
        .filter((paragraph) => /prerequisite|before you begin|you need|requires?/i.test(paragraph));
      const goal = section.heading || list.items[0].replace(/^(?:click|select|open|go to|choose)\s+/i, "");
      const citation = citationFor(section, Math.max(1, list.paragraphStart - 1), Math.min(section.paragraphs.length, list.paragraphEnd + 1));
      out.push({
        id: `procedure-${key(`${section.id}:${list.paragraphStart}:${goal}`)}`,
        sectionId: section.id,
        goal,
        steps: [...list.items],
        successMessage: likelySuccess(section, list.paragraphEnd),
        prerequisites,
        citation,
        extraction: "deterministic",
      });
    }
  }
  return out;
}

/**
 * Use an LLM for semantic fields, but bind every output back to an existing
 * section/list. Invalid steps and invented success strings are discarded.
 */
export async function extractDocumentProcedures(sections: DocumentSection[]): Promise<DocumentProcedure[]> {
  const candidates = sections.filter((section) => section.lists.some((list) => list.ordered && list.items.length >= 2));
  const fallback = proceduresFromSections(candidates);
  if (!candidates.length) return [];

  const limit = Math.max(1, Number(process.env.DOC_PROCEDURE_MAX_SECTIONS ?? 80));
  const maxChars = Math.max(2000, Number(process.env.DOC_PROCEDURE_BATCH_CHARS ?? 24000));
  const selected = candidates.slice(0, limit);
  const groups: DocumentSection[][] = [];
  let group: DocumentSection[] = [];
  let chars = 0;
  for (const section of selected) {
    if (group.length && chars + section.text.length > maxChars) { groups.push(group); group = []; chars = 0; }
    group.push(section); chars += section.text.length;
  }
  if (group.length) groups.push(group);

  const extracted: DocumentProcedure[] = [];
  const coveredLists = new Set<string>();
  const model = makeBrain("planner");
  for (const batch of groups) {
    const source = batch.map((section) => `[${section.id}] ${section.title} > ${section.heading}\n${section.text}`).join("\n\n---\n\n");
    const system = `Extract only user procedures explicitly stated in product documentation.
For each procedure, preserve the documented step wording. Capture prerequisites and a promised on-screen success message only when the source says it verbatim.
Never invent a success message. Use the exact sectionId. Call record_procedures once.`;
    try {
      const response = await model.step(system, [{ role: "user", blocks: [{ type: "text", text: source }] }] as NMessage[], [PROCEDURE_TOOL]);
      const call = response.toolCalls.find((item) => item.name === "record_procedures");
      const rows = Array.isArray(call?.args?.procedures) ? call!.args.procedures as Record<string, unknown>[] : [];
      const byId = new Map(batch.map((section) => [section.id, section]));
      for (const row of rows) {
        const section = byId.get(clean(row.sectionId));
        if (!section) continue;
        const proposedSteps = Array.isArray(row.steps) ? row.steps.map(clean).filter(Boolean) : [];
        const documentedLists = section.lists.filter((list) => list.ordered && list.items.length >= 2);
        const documented = documentedLists
          .map((list) => ({ list, score: proposedSteps.filter((step) => list.items.some((item) => item.toLowerCase().includes(step.toLowerCase()) || step.toLowerCase().includes(item.toLowerCase()))).length }))
          .sort((a, b) => b.score - a.score)[0]?.list;
        if (!documented) continue;
        // The source list is authoritative. The model may re-associate a goal,
        // but it may not silently rewrite or add operational instructions.
        const steps = proposedSteps.length === documented.items.length && proposedSteps.every((step) => section.text.toLowerCase().includes(step.toLowerCase()))
          ? proposedSteps : documented.items;
        const goal = clean(row.goal) || section.heading;
        const successMessage = exactSourcePhrase(section, row.successMessage) ?? likelySuccess(section, documented.paragraphEnd);
        const prerequisites = (Array.isArray(row.prerequisites) ? row.prerequisites : [])
          .map((item) => exactSourcePhrase(section, item)).filter((item): item is string => !!item);
        extracted.push({
          id: `procedure-${key(`${section.id}:${documented.paragraphStart}:${goal}`)}`,
          sectionId: section.id,
          goal,
          steps,
          successMessage,
          prerequisites,
          citation: citationFor(section, Math.max(1, documented.paragraphStart - 1), Math.min(section.paragraphs.length, documented.paragraphEnd + 1)),
          extraction: "llm",
        });
        coveredLists.add(`${section.id}:${documented.paragraphStart}`);
      }
    } catch (error) {
      console.warn(`  ! procedure extraction fell back to deterministic parsing: ${(error as Error).message}`);
    }
  }

  const combined = [...extracted];
  for (const procedure of fallback) {
    const section = candidates.find((item) => item.id === procedure.sectionId);
    const list = section?.lists.find((item) => procedure.citation.paragraphStart <= item.paragraphStart && procedure.citation.paragraphEnd >= item.paragraphEnd);
    if (!list || !coveredLists.has(`${procedure.sectionId}:${list.paragraphStart}`)) combined.push(procedure);
  }
  const unique = new Map<string, DocumentProcedure>();
  for (const procedure of combined) unique.set(`${procedure.sectionId}:${procedure.steps.join("\u0000").toLowerCase()}`, procedure);
  return [...unique.values()];
}
