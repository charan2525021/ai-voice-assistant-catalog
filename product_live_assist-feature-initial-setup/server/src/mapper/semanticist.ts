import { makeBrain, type NMessage } from "../brain.js";
import { brain as defaultKb, type BrainStore } from "../knowledge/store.js";
import type { Journey } from "./types.js";

/**
 * Semanticist — turns a verified click-path into MEANING: what the capability is
 * for and why a user cares. Topology alone can't guide a buyer; this is the
 * layer that lets Aidan say "this is how your team keeps work visible" instead
 * of "this button goes to that screen".
 *
 * Grounded in the ingested docs where possible, so it doesn't invent value claims.
 */
export async function describeMeaning(productName: string, journey: Journey, kb: BrainStore = defaultKb): Promise<string> {
  const model = makeBrain("semanticist");
  const facts = kb
    .searchDocs(`${journey.goal} ${journey.capability}`, 2)
    .map((r) => `- ${r.chunk.text.slice(0, 220)}`)
    .join("\n");

  const path = journey.steps
    .map((s) => (s.action === "fill" ? `type into ${s.role} "${s.name}"` : `${s.action} ${s.role} "${s.name}"`))
    .join(" → ");

  const system = `You describe what a product capability means for the person using it.
Write ONE sentence (max 28 words) explaining what this accomplishes and why a user would care.
Be concrete and grounded. Do not invent features, integrations, or metrics. No marketing fluff.`;

  const user = `Product: ${productName}
Task learned: ${journey.goal}
Steps: ${path}
Proof it worked: "${journey.postcondition}"
${facts ? `\nRelevant documentation:\n${facts}` : ""}`;

  const res = await model.step(system, [{ role: "user", blocks: [{ type: "text", text: user }] }] as NMessage[], []);
  return res.texts.join(" ").trim().slice(0, 240);
}

/**
 * Write ONE short spoken line per step ("Now I'll open the cart…").
 *
 * Stored on the journey during onboarding so replay can narrate step by step.
 * Without this a verified flow runs as a silent block — fine for a script,
 * wrong for something meant to sound like a person guiding you through a product.
 */
/**
 * Write the SPOKEN narration for a journey.
 *
 * This is dialogue, not documentation. Two rules learned from hearing it aloud:
 *
 *  1. GROUP the mechanical steps. Narrating every field ("I enter the first name…",
 *     "I enter the last name…", "I enter the postal code…") sounds like a robot
 *     reading a form. A person says "let me pop in your shipping details" once.
 *     So we return one line per PHASE and leave the other steps silent.
 *  2. SPOKEN register. Contractions, short, no markdown, no bracketed citations,
 *     no raw UI identifiers — nobody says "product-sort-container" out loud.
 */
/**
 * Write the SPOKEN narration for a journey.
 *
 * Dialogue, not documentation. Two rules learned from hearing it aloud:
 *  1. GROUP mechanical steps. Narrating every field ("I enter the first name…",
 *     "I enter the last name…") sounds like a robot reading a form; a person says
 *     "let me pop in your shipping details" once.
 *  2. SPOKEN register — contractions, short, no markdown/ids/citations.
 *
 * Output format is "<step number>: <line>" rather than one line per step. Asking
 * for N lines with "-" placeholders failed on every multi-step journey (the model
 * returns only the grouped lines), which silently left long walkthroughs unnarrated.
 */
export async function describeSteps(productName: string, journey: Journey): Promise<string[]> {
  const model = makeBrain("semanticist");
  const steps = journey.steps
    .map((s, i) => {
      const what =
        s.action === "fill" ? `type "${s.value}" into ${s.role} "${s.name}"`
        : s.action === "select" ? `choose "${s.value}" in ${s.role} "${s.name}"`
        : s.action === "navigate" ? `open ${s.url}`
        : `${s.action} ${s.role ?? ""} "${s.name ?? ""}"`;
      return `${i + 1}. ${what}`;
    })
    .join("\n");

  const system = `You guide someone through ${productName} out loud, on a call. Write what you SAY.

You will perform the numbered UI steps below. Group them the way a person speaks:
- consecutive form fields = ONE line ("Let me pop in your shipping details")
- a click that changes screen usually deserves its own short line
- ${Math.min(4, Math.max(1, Math.ceil(journey.steps.length / 2)))} spoken lines is plenty for ${journey.steps.length} steps — fewer is better

How to speak: contractions, warm, max 12 words. Say what it means for them, not what you click.
Never read out field names, ids, markdown, quotes or brackets.

Output ONLY lines of the form:
<step number>: <what you say as you begin that step>

Start with step 1. Only include a step number where you START speaking a new line.`;

  const user = `Goal: ${journey.goal}\nUI steps:\n${steps}`;
  const res = await model.step(system, [{ role: "user", blocks: [{ type: "text", text: user }] }] as NMessage[], []);

  // Map "<n>: line" onto step indexes; steps without a line stay silent (covered
  // by the previous line's speech).
  const out: string[] = new Array(journey.steps.length).fill("");
  let matched = 0;
  for (const raw of res.texts.join("\n").split("\n")) {
    const m = raw.trim().match(/^(?:step\s*)?(\d+)\s*[:).-]\s*(.+)$/i);
    if (!m) continue;
    const idx = parseInt(m[1], 10) - 1;
    const line = m[2].replace(/^["'*\s-]+|["'*\s]+$/g, "").trim();
    if (idx < 0 || idx >= out.length || !line) continue;
    out[idx] = line;
    matched++;
  }
  if (!matched) return [];
  if (!out[0]) out[0] = out.find(Boolean) ?? ""; // always speak at the start
  return out;
}
