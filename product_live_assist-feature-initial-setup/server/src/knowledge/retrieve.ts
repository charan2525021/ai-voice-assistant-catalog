import type { BrainStore, DocChunk, Flow, PlaybookItem, Persona } from "./store.js";
import type { SessionMemory } from "./memory.js";
import { traverse, capabilityOverview, type GraphContext } from "./graphview.js";
import { intentOf, type CompiledLexicon } from "./lexicon.js";
import { emit } from "../events.js";

export type Intent = "show_me" | "question" | "objection" | "buying_signal" | "smalltalk";

export interface ContextPacket {
  intent: Intent;
  persona?: Persona;
  flow?: Flow;
  facts: { chunk: DocChunk; score?: number }[];
  valueProps: PlaybookItem[];
  objection?: PlaybookItem;
  discovery?: PlaybookItem;
  /** Walked from the product graph: prerequisites + sibling capabilities. */
  graph?: GraphContext | null;
  overview?: string;
}

/**
 * Intent patterns live in the product's lexicon rather than here, so a vertical
 * or a non-English deployment can supply its own without a code change. The
 * defaults are the exact English patterns this function used to hold.
 */
function classify(text: string, lex?: CompiledLexicon): Intent {
  return intentOf(text, lex) as Intent;
}

/** The retriever/router: assembles the grounded context packet for one turn. */
export async function retrieveContext(
  text: string,
  memory: SessionMemory,
  store: BrainStore,
): Promise<{ packet: ContextPacket; system: string }> {
  const intent = classify(text, store.lexicon);

  // persona: keep what we know, else infer
  let persona: Persona | undefined = store.personas.find((p) => p.id === memory.persona);
  if (!persona) {
    persona = store.inferPersona([...memory.needs, text].join(" "));
    if (persona) memory.setPersona(persona.id);
  }

  const facts = (await store.searchDocsSemantic(text, 4)).map((r) => ({ chunk: r.chunk, score: r.score }));

  // Always attempt a flow match — an actionable request is often phrased as a
  // question ("can you chuck something in my basket?" classifies as `question`),
  // and gating on intent hid verified flows from the agent entirely. The
  // semantic threshold is what guards against a wrong match, not the intent.
  let flow: Flow | undefined;
  if (intent !== "objection") {
    flow = await store.matchFlowSemantic(text);
    if (flow) { memory.addFlow(flow.id); memory.addShown(flow.feature); }
  }

  const valueProps = store.playbookFor("value_prop", persona?.id, text, 2);
  const objection = intent === "objection" ? store.playbookFor("objection", persona?.id, text, 1)[0] : undefined;
  const discovery =
    Object.keys(memory.qualification).length < 2 && memory.turns <= 4
      ? store.playbookFor("discovery", persona?.id, text, 1)[0]
      : undefined;

  // Walk the graph outward from the matched flow (prerequisites, siblings).
  const graph = flow ? await traverse(flow.name, store.product) : null;
  // A capability overview answers "what can this product do?" from real structure.
  const overview = intent === "question" || intent === "smalltalk" ? await capabilityOverview(store.product) : "";

  const packet: ContextPacket = { intent, persona, flow, facts, valueProps, objection, discovery, graph, overview };
  emit("retrieve.context", { status: "ok", data: {
    query: text,
    intent,
    matchedChunks: facts.map(({ chunk, score }) => ({
      chunkId: chunk.id,
      title: chunk.title,
      section: chunk.section,
      source: chunk.source,
      trust: chunk.trust,
      score,
      chunkText: chunk.text,
    })),
    matchedFlow: flow ? { id: flow.id, name: flow.name, feature: flow.feature } : undefined,
    persona: persona ? { id: persona.id, name: persona.name, role: persona.role } : undefined,
  } });
  return { packet, system: packetToSystem(packet, memory) };
}

/** Turn the retrieved packet into the system prompt for this turn (grounding + guidance). */
function packetToSystem(p: ContextPacket, memory: SessionMemory): string {
  const lines: string[] = [];

  if (p.facts.length) {
    lines.push(
      "GROUNDED KNOWLEDGE — you may ONLY state product facts supported below, and cite the source in brackets like [Docs: Title]:",
      ...p.facts.map((f) => `- ${f.chunk.text}  [${f.chunk.trust === "official" ? "Docs" : "Info"}: ${f.chunk.title}]`),
      "If the prospect asks something NOT covered above, say you're not certain and offer to follow up — do NOT invent features. Call note_unanswered with their question.",
    );
  } else {
    lines.push(
      "No knowledge-base match for this. Do not invent product facts. If it's a product question, say you're not certain and call note_unanswered.",
    );
  }

  if (p.flow) {
    const verified = (p.flow as any).program?.length > 0;
    lines.push(
      "",
      verified
        ? `VERIFIED FLOW for "${p.flow.feature}" — this exact sequence has been tested and proven to work:`
        : `GOLDEN-PATH FLOW to demonstrate "${p.flow.feature}" — follow these steps, verifying each against the live screen (adapt if the UI differs):`,
      ...p.flow.steps.map((s, i) => `  ${i + 1}. ${s}`),
      verified
        ? `ALWAYS call run_verified_flow for this — it repositions to the correct starting screen by itself and narrates each step, so you do NOT need to navigate there first and must NOT click through it manually. Expected result: "${(p.flow as any).postcondition ?? ""}".`
        : "",
      p.flow.talkingPoints.length ? `Talking points: ${p.flow.talkingPoints.join(" ")}` : "",
    );
  }

  const selling: string[] = [];
  if (p.persona) selling.push(`Prospect looks like: ${p.persona.name} (${p.persona.role}); pains: ${p.persona.pains.join(", ")}.`);
  if (p.valueProps.length) selling.push(`Value props to weave in when relevant: ${p.valueProps.map((v) => v.content).join(" | ")}`);
  if (p.objection) selling.push(`They raised an objection — respond with: ${p.objection.content}`);
  if (p.discovery) selling.push(`Ask this discovery question when natural: "${p.discovery.content}"  (then call record_qualification when they answer).`);
  if (selling.length) lines.push("", "SELLING GUIDANCE:", ...selling);

  if (p.graph?.prerequisites.length) {
    lines.push(
      "",
      "PREREQUISITES (from the product graph) — these must happen first, and there are verified flows for them:",
      ...p.graph.prerequisites.map((q, i) => `  ${i + 1}. ${q.goal}${q.meaning ? ` — ${q.meaning}` : ""}`),
    );
  }
  if (p.graph?.siblings.length) {
    lines.push(
      "",
      `RELATED IN "${p.graph.capability?.name ?? "this area"}" — natural things to offer next:`,
      ...p.graph.siblings.map((s) => `  - ${s.goal}`),
    );
  }
  if (p.overview) lines.push("", "WHAT THIS PRODUCT DOES (capability map):", p.overview);

  lines.push("", "PROSPECT CONTEXT SO FAR:", memory.summary());
  return lines.filter(Boolean).join("\n");
}
