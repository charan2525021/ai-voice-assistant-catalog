import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DocumentSection } from "./document-structure.js";
import type { DocumentProcedure } from "./procedures.js";

// ============================ Types (the Brain's stores) ============================

/** B1 — Knowledge Base chunk (docs/help center/marketing), with citation + trust. */
export interface DocChunk {
  id: string;
  text: string;
  source: string; // URL or "seed"
  title: string;
  section: string;
  trust: "official" | "marketing" | "community"; // rank by trust
  freshness: string; // ISO date ingested
  embedding?: number[]; // semantic vector (see embeddings.ts)
  /** Optional source coordinates; retrieval behavior does not depend on them. */
  structure?: {
    sectionId: string;
    paragraphStart: number;
    paragraphEnd: number;
    containsOrderedProcedure: boolean;
  };
}

/** B2 — a golden-path flow (named demo sequence over the product map). */
export interface Flow {
  id: string;
  name: string;
  feature: string;
  intents: string[]; // trigger phrases
  steps: string[]; // ordered, human-readable, executed guided-by-vision
  talkingPoints: string[];
  prerequisites: string;
  resetSteps: string;
  embedding?: number[]; // semantic vector over goal + intents + feature
  /** Executable steps from the mapper (durable role/name selectors), if learned. */
  program?: { action: string; role?: string; name?: string; testId?: string; value?: string; submit?: boolean; url?: string; say?: string }[];
  postcondition?: string;
  /** Mapper publication proof. Missing metadata means a legacy mapped flow is draft-only. */
  verification?: { passedRuns: number; requiredRuns: number };
  /** Human release decision bound to the exact executable revision. */
  approval?: { status: "approved"; revision: number; checksum: string; approvedChecksum: string };
  /** Screen the program was recorded from; replay returns here first. */
  startUrl?: string;
  /**
   * Who owns this record.
   *
   * `flows.json` has TWO writers — content ingestion (hand-authored
   * `content/<product>/flows.json`) and the mapper's publish step (verified
   * journeys). Both used to call `setFlows()`, which replaces the whole array,
   * so whichever ran last silently deleted the other's work. Running
   * `brain:ingest` after `map:learn` therefore destroyed every executable
   * program, downgrading the live agent from deterministic replay to
   * improvisation with no error and no log line. Provenance lets each writer
   * replace only its own rows.
   */
  origin?: "authored" | "mapped";
}

/** B2 — product map (screens + transitions), from the crawler. */
export interface MapNode {
  id: string;
  url: string;
  label: string;
  summary: string;
  elements: string[];
}
export interface MapEdge {
  from: string;
  to: string;
  action: string;
}

/** B3 — persona/use-case taxonomy. */
export interface Persona {
  id: string;
  name: string;
  role: string;
  pains: string[];
  keywords: string[];
}

/** B3 — sales playbook items. */
export interface PlaybookItem {
  id: string;
  kind: "discovery" | "value_prop" | "objection" | "positioning";
  personas: string[]; // persona ids, or ["*"]
  keywords: string[]; // trigger words (objections/value)
  prompt?: string; // for discovery questions
  content: string;
}

/** B4 — logged session (for the learning loop). */
export interface SessionRecord {
  id: string;
  startedAt: string;
  endedAt?: string;
  persona?: string;
  needs: string[];
  qualification: Record<string, string>;
  flowsSuggested: string[];
  objections: string[];
  kbGaps: string[]; // questions the KB couldn't answer
  frictionPoints?: string[]; // V1 Intent Rescue: where the prospect struggled
  turns: number;
  actionFailures: number;
  outcome?: "engaged" | "qualified" | "dropped" | "unknown";
  transcript: { role: string; text: string }[];
}

interface BrainData {
  docs: DocChunk[];
  /** Structure/procedures are planner inputs; `docs` remains the live retrieval index. */
  sections: DocumentSection[];
  procedures: DocumentProcedure[];
  flows: Flow[];
  mapNodes: MapNode[];
  mapEdges: MapEdge[];
  personas: Persona[];
  playbook: PlaybookItem[];
  sessions: SessionRecord[];
}

// ============================ Store (JSON-backed, in-memory) ============================

import { config } from "../config.js";
import { cosine, embed, embedOne } from "./embeddings.js";
import { loadCalibration, resolveParam, type Calibration } from "./calibration.js";
import { defaultLexicon, loadLexicon, verbClassOf, type CompiledLexicon } from "./lexicon.js";
import { capabilityCandidates } from "./graphview.js";

const BRAIN_ROOT = fileURLToPath(new URL("../../data/brain", import.meta.url));
/** Where a given product's store lives on disk. */
export const productDataDir = (product: string) => path.join(BRAIN_ROOT, product);

const STOPWORDS = new Set(
  "the a an and or of to in for is are do does can how what with your you i we it this that on at as be by from will would our my me they them their can't dont don't have has".split(
    /\s+/,
  ),
);

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/**
 * Coarse action class of a phrase. Embeddings encode topic, not verb — "put
 * something in my basket" and "view my basket" are near-identical vectors — so
 * flow routing needs an explicit signal for what the user wants to DO.
 *
 * The patterns themselves now live in `lexicon.ts` so a product, a vertical or
 * a language can supply its own without editing this module. The defaults there
 * are these exact patterns, so existing products are unaffected.
 */


/** Delegates to the product's lexicon (English defaults when none is supplied). */
function verbClass(text: string, lex?: CompiledLexicon): string | null {
  return verbClassOf(text, lex);
}

export class BrainStore {
  private data: BrainData = { docs: [], sections: [], procedures: [], flows: [], mapNodes: [], mapEdges: [], personas: [], playbook: [], sessions: [] };
  private idf = new Map<string, number>();
  /**
   * One store per product. The server holds several at once (a session binds to
   * whichever product it is demoing), so nothing here may reach for a global
   * "current product" — that was the single-product blocker.
   */
  readonly product: string;
  private readonly dir: string;
  /** Measured retrieval parameters for THIS product (null = never calibrated). */
  private calibration: Calibration | null = null;
  /** Verb/intent patterns for THIS product; English defaults until overridden. */
  lexicon: CompiledLexicon = defaultLexicon;
  constructor(product: string = config.product) {
    this.product = product;
    this.dir = productDataDir(product);
  }

  /** Is a measured grounding floor in force for this product? */
  groundingFloorActive(): boolean {
    return this.param("GROUNDING_FLOOR", "groundingFloor") > 0;
  }

  /** Env override > this product's measurement > built-in default. */
  private param(envName: string, key: "semWeight" | "groundingFloor" | "flowFloor" | "flowStrong" | "flowDominance"): number {
    return resolveParam(envName, key, this.calibration);
  }

  get docs() { return this.data.docs; }
  get sections() { return this.data.sections; }
  get procedures() { return this.data.procedures; }
  /** Authored flows stay available; mapped flows require replay plus exact human approval. */
  get flows() {
    return this.data.flows.filter((flow) => {
      const origin = flow.origin ?? (flow.program?.length ? "mapped" : "authored");
      return origin === "authored" || !!flow.verification && flow.verification.passedRuns >= flow.verification.requiredRuns &&
        flow.approval?.status === "approved" && flow.approval.checksum === flow.approval.approvedChecksum;
    });
  }
  get personas() { return this.data.personas; }
  get playbook() { return this.data.playbook; }
  get mapNodes() { return this.data.mapNodes; }
  get sessions() { return this.data.sessions; }

  /** Newest mtime across the store's files — used for hot reload. */
  private async storeStamp(): Promise<number> {
    let newest = 0;
    for (const key of Object.keys(this.data)) {
      const f = path.join(this.dir, `${key}.json`);
      if (!existsSync(f)) continue;
      const st = await fs.stat(f).catch(() => null);
      if (st) newest = Math.max(newest, st.mtimeMs);
    }
    return newest;
  }
  private loadedStamp = 0;

  async load(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    for (const key of Object.keys(this.data) as (keyof BrainData)[]) {
      const file = path.join(this.dir, `${key}.json`);
      if (existsSync(file)) {
        try {
          this.data[key] = JSON.parse(await fs.readFile(file, "utf8"));
        } catch {
          /* keep default */
        }
      }
    }
    this.calibration = await loadCalibration(this.product);
    this.lexicon = await loadLexicon(this.product);
    this.buildIndex();
    this.loadedStamp = await this.storeStamp();
    await this.selfHeal();
  }

  /**
   * Re-load if the store changed on disk (e.g. after `brain:ingest` or
   * `map:learn`), so knowledge updates don't require a server restart.
   */
  async reloadIfChanged(): Promise<boolean> {
    const stamp = await this.storeStamp();
    if (stamp <= this.loadedStamp) return false;
    await this.load();
    return true;
  }

  /**
   * Migrate stores written by an older pipeline. A store with docs but no
   * embeddings silently degrades to lexical-only retrieval — which measurably
   * misses most real phrasings — so build the missing index instead of failing quiet.
   */
  private async selfHeal(): Promise<void> {
    const docsMissing = this.data.docs.length > 0 && !this.data.docs.some((d) => d.embedding?.length);
    const flowsMissing = this.flows.length > 0 && !this.flows.some((f) => f.embedding?.length);
    if (!docsMissing && !flowsMissing) return;
    console.log(`[brain] store "${this.product}" has no semantic index — building it now (one-time upgrade)…`);
    const built = await this.buildEmbeddings();
    if (built.docs || built.flows) {
      await this.save("docs", "flows");
      console.log(`[brain] upgraded: embedded ${built.docs} docs, ${built.flows} flows`);
    } else {
      console.warn(`[brain] could not build embeddings — retrieval stays lexical-only for "${this.product}"`);
    }
  }

  /**
   * Atomic, serialised writes. Concurrent demo sessions finalising at once were
   * read-modify-writing the same file and losing records.
   */
  private writeChain: Promise<void> = Promise.resolve();

  async save(...keys: (keyof BrainData)[]): Promise<void> {
    const toSave = keys.length ? keys : (Object.keys(this.data) as (keyof BrainData)[]);
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(this.dir, { recursive: true });
      for (const key of toSave) {
        const file = path.join(this.dir, `${key}.json`);
        const tmp = `${file}.${process.pid}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(this.data[key], null, 2));
        await fs.rename(tmp, file); // atomic swap — never a half-written file
      }
      this.buildIndex();
      this.loadedStamp = await this.storeStamp();
    });
    return this.writeChain;
  }

  setDocs(d: DocChunk[]) { this.data.docs = d; }
  setDocumentPlanningData(sections: DocumentSection[], procedures: DocumentProcedure[]) {
    this.data.sections = sections;
    this.data.procedures = procedures;
  }

  /**
   * Replace ONLY the flows owned by `origin`, keeping the other writer's rows.
   *
   * A row with no `origin` predates this field; it is treated as `mapped` when
   * it carries an executable program and `authored` otherwise, which is what
   * those rows actually were.
   */
  private replaceFlowsFrom(origin: NonNullable<Flow["origin"]>, incoming: Flow[]): void {
    const ownerOf = (f: Flow): Flow["origin"] => f.origin ?? (f.program?.length ? "mapped" : "authored");
    const kept = this.data.flows.filter((f) => ownerOf(f) !== origin);
    const tagged = incoming.map((f) => ({ ...f, origin }));
    // A verified, executable flow always wins a name collision with an
    // authored placeholder for the same thing.
    const byName = new Map<string, Flow>();
    for (const f of [...kept, ...tagged]) {
      const key = (f.name || f.id).toLowerCase();
      const prev = byName.get(key);
      if (!prev || (f.program?.length ?? 0) > (prev.program?.length ?? 0)) byName.set(key, f);
    }
    this.data.flows = [...byName.values()];
  }

  /** Hand-authored flows from `content/<product>/flows.json`. */
  setAuthoredFlows(f: Flow[]) { this.replaceFlowsFrom("authored", f); }
  /** Verified journeys published by the mapper. */
  setMappedFlows(f: Flow[]) { this.replaceFlowsFrom("mapped", f); }

  /** Compute embeddings for docs + flows (called once at ingest, cached in the store). */
  async buildEmbeddings(): Promise<{ docs: number; flows: number }> {
    let docs = 0;
    let flows = 0;
    const docTexts = this.data.docs.map((d) => `${d.title}. ${d.section}. ${d.text}`);
    const docVecs = await embed(docTexts);
    if (docVecs.length === this.data.docs.length) {
      this.data.docs.forEach((d, i) => (d.embedding = docVecs[i]));
      docs = docVecs.length;
    }
    /*
     * WEIGHTED flow text. Embedding every step equally lets a long, wandering
     * journey absorb another flow's vocabulary — a 7-step "continue shopping"
     * journey that clicks "Add to cart" four times scored as high as the real
     * add-to-cart flow, collapsing the separation between them.
     * The goal is what users express, so repeat it; include only a thin slice of
     * the mechanics (first + last step) for action vocabulary.
     */
    const activeFlows = this.flows;
    const flowTexts = activeFlows.map((f) => {
      const steps = f.steps || [];
      const mechanics = steps.length ? [steps[0], steps[steps.length - 1]].filter(Boolean).join(". ") : "";
      return [f.name, f.name, f.name, f.feature, (f.intents || []).join(". "), (f.talkingPoints || []).join(" "), mechanics]
        .filter(Boolean)
        .join(". ")
        .slice(0, 2000);
    });
    const flowVecs = await embed(flowTexts);
    if (flowVecs.length === activeFlows.length) {
      activeFlows.forEach((f, i) => (f.embedding = flowVecs[i]));
      flows = flowVecs.length;
    }
    return { docs, flows };
  }
  setMap(nodes: MapNode[], edges: MapEdge[]) { this.data.mapNodes = nodes; this.data.mapEdges = edges; }
  setPersonas(p: Persona[]) { this.data.personas = p; }
  setPlaybook(p: PlaybookItem[]) { this.data.playbook = p; }

  private buildIndex(): void {
    this.idf.clear();
    const N = this.data.docs.length || 1;
    const df = new Map<string, number>();
    for (const d of this.data.docs) {
      for (const t of new Set(tokenize(`${d.title} ${d.section} ${d.text}`))) df.set(t, (df.get(t) || 0) + 1);
    }
    for (const [t, c] of df) this.idf.set(t, Math.log(1 + N / c));
  }

  private trustBoost(t: DocChunk["trust"]): number {
    return t === "official" ? 1.3 : t === "marketing" ? 1.1 : 1.0;
  }

  /**
   * B1 — HYBRID retrieval: semantic (embeddings) + lexical (TF-IDF), trust-boosted.
   * Semantic handles vocabulary mismatch ("tick off" vs "mark complete"); lexical
   * keeps exact terms (product nouns, feature names) sharp. Falls back to pure
   * lexical when embeddings are unavailable.
   */
  async searchDocsSemantic(query: string, k = 4): Promise<{ chunk: DocChunk; score: number }[]> {
    const lexical = this.searchDocs(query, Math.max(k * 3, 12));
    const haveVectors = this.data.docs.some((d) => d.embedding?.length);
    if (!haveVectors) return lexical.slice(0, k);

    const qv = await embedOne(query);
    if (!qv) return lexical.slice(0, k);

    const maxLex = Math.max(...lexical.map((l) => l.score), 1);
    const lexScore = new Map(lexical.map((l) => [l.chunk.id, l.score / maxLex]));

    /*
     * The semantic/lexical split is MEASURED per product, not assumed. Sweeping
     * it on a real 4,378-chunk corpus put the optimum at 0.90/0.10 — the 0.70/0.30
     * that shipped was costing ~7 points of recall@1 and 0.03 MRR. It had never
     * been challenged because until there was a corpus, top-4 returned the entire
     * knowledge base and every setting scored identically.
     */
    const semW = this.param("RETRIEVAL_SEM_WEIGHT", "semWeight");
    const lexW = 1 - semW;

    const scored = this.data.docs
      .filter((d) => d.embedding?.length)
      .map((chunk) => {
        const sem = cosine(qv, chunk.embedding!);
        const lex = lexScore.get(chunk.id) ?? 0;
        return { chunk, score: (semW * sem + lexW * lex) * this.trustBoost(chunk.trust) };
      })
      .sort((a, b) => b.score - a.score);

    /*
     * Grounding floor: if the best match is only weakly related, return NOTHING
     * so the agent is forced down its refusal path. An absolute `> 0.25` filter
     * stopped meaning anything once the corpus was real — at 4,378 chunks every
     * question retrieves something, including questions the product cannot
     * answer. Off by default (0) so small, unmeasured products are unaffected.
     */
    const groundFloor = this.param("GROUNDING_FLOOR", "groundingFloor");
    if (groundFloor > 0 && (scored[0]?.score ?? 0) < groundFloor) return [];

    /*
     * First-stage ranking IS the ranking.
     *
     * A model-free reranker (title match, document evidence, MMR diversity) was
     * built and measured here on a real 4,378-chunk corpus: first-stage alone
     * gave article-recall@4 of 93.3%, the corroborating boosts DROPPED it to
     * 90.0%, and boost+MMR only returned it to 93.3% while costing chunk recall.
     * It earned its deletion. `npm run bench` is the experiment to repeat before
     * anyone adds one back.
     */
    return scored.filter((s) => s.score > 0.25).slice(0, k);
  }



  /** Top-k flows by semantic relevance — so prompts retrieve instead of enumerate. */
  async searchFlowsSemantic(query: string, k = 4): Promise<Flow[]> {
    const withVectors = this.flows.filter((f) => f.embedding?.length);
    if (!withVectors.length) return this.flows.slice(0, k);
    const qv = await embedOne(query);
    if (!qv) return this.flows.slice(0, k);
    return withVectors
      .map((f) => ({ f, s: cosine(qv, f.embedding!) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, k)
      .map((x) => x.f);
  }

  /** B2 — semantic flow matching. Keyword matching missed 5/6 real phrasings. */
  async matchFlowSemantic(text: string): Promise<Flow | undefined> {
    const lexHit = this.matchFlow(text);
    const withVectors = this.flows.filter((f) => f.embedding?.length);
    if (!withVectors.length) return lexHit;

    const qv = await embedOne(text);
    if (!qv) return lexHit;

    /*
     * Embeddings capture TOPIC, not ACTION. "chuck something in my basket" and
     * "view the items in my basket" share almost all vocabulary, and scored
     * within 0.004 of each other — a coin flip that routed to the wrong flow.
     * Nudge by the action the user is expressing versus the action the flow performs.
     */
    const qVerb = verbClass(text, this.lexicon);
    const ranked = withVectors
      .map((f) => {
        const base = cosine(qv, f.embedding!);
        const fVerb = verbClass(`${f.name} ${f.feature}`, this.lexicon);
        const agree = qVerb && fVerb && qVerb === fVerb;
        const clash = qVerb && fVerb && qVerb !== fVerb;
        return { f, s: base * (agree ? 1.12 : clash ? 0.92 : 1) };
      })
      .sort((a, b) => b.s - a.s);
    const top = ranked[0];
    const runnerUp = ranked[1]?.s ?? 0;
    if (!top) return lexHit;
    if (lexHit && lexHit.id === top.f.id) return lexHit; // both agree

    /*
     * Calibrated against measured scores rather than guessed. With
     * text-embedding-3-small, genuine matches land ~0.40–0.62 and dominate the
     * runner-up by ~1.9x; an unrelated query tops out ~0.18. A flat 0.42 cutoff
     * wrongly rejected a valid 0.398 match, so accept on EITHER a strong absolute
     * score or clear dominance over the alternatives, above a hard floor.
     */
    /*
     * Recalibrated on measured data. Within ONE product every flow shares a
     * domain vocabulary, so scores legitimately cluster (0.43 / 0.42 / 0.41 for
     * three shopping flows). A 1.4x dominance requirement rejected correct
     * top-1 matches. The FLOOR is the real discriminator — an unrelated query
     * ("refund policy") tops out at 0.18, far below it — so the margin only
     * needs to break near-exact ties.
     */
    /*
     * Per product, not global. These were calibrated once on a 9-flow product;
     * score separation is a function of how many flows share a vocabulary, so a
     * catalogue that grows to 50 flows needs a different floor than one with 9.
     * `npm run calibrate` re-measures them from that product's own journeys.
     */
    const FLOOR = this.param("FLOW_MATCH_FLOOR", "flowFloor");
    const STRONG = this.param("FLOW_MATCH_STRONG", "flowStrong");
    const DOMINANCE = this.param("FLOW_MATCH_DOMINANCE", "flowDominance");
    const accept = top.s >= FLOOR && (top.s >= STRONG || top.s >= runnerUp * DOMINANCE);
    if (accept) return top.f;
    if (lexHit) return lexHit;

    /*
     * Second retrieval route: ask the GRAPH.
     *
     * Per-journey matching just failed, but a capability area is a much wider
     * target than any single journey goal — "I want to pay for these" matches
     * "Cart & checkout" comfortably while matching no individual journey above
     * the floor. If the capability is a confident hit, its member journeys
     * become candidates and we re-score only those, at a relaxed floor: the
     * capability match is independent corroborating evidence, so the same
     * absolute score means more here than it does across the whole catalogue.
     */
    const cap = await capabilityCandidates(text, this.product, embedOne, cosine).catch(() => null);
    if (!cap || cap.score < FLOOR) return undefined;

    const inCap = ranked.filter((r) => cap.goals.includes(r.f.name));
    const bestInCap = inCap[0];
    if (!bestInCap) return undefined;
    const RELAXED = FLOOR * 0.8;
    if (bestInCap.s < RELAXED) return undefined;
    console.log(`[brain] graph-assisted match: capability "${cap.capability}" (${cap.score.toFixed(3)}) → flow "${bestInCap.f.name}" (${bestInCap.s.toFixed(3)})`);
    return bestInCap.f;
  }

  /** B1 — lexical retrieval (TF-IDF-ish + trust boost). Used alone as fallback. */
  searchDocs(query: string, k = 4): { chunk: DocChunk; score: number }[] {
    const qTerms = tokenize(query);
    if (!qTerms.length) return [];
    const scored = this.data.docs.map((chunk) => {
      const hay = tokenize(`${chunk.title} ${chunk.title} ${chunk.section} ${chunk.text}`);
      const tf = new Map<string, number>();
      for (const t of hay) tf.set(t, (tf.get(t) || 0) + 1);
      let score = 0;
      for (const qt of qTerms) {
        const f = tf.get(qt);
        if (f) score += (this.idf.get(qt) || 1) * (1 + Math.log(f));
      }
      return { chunk, score: score * this.trustBoost(chunk.trust) };
    });
    return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
  }

  /** B2 — best-matching flow for a "show me X" intent. */
  matchFlow(text: string): Flow | undefined {
    const q = new Set(tokenize(text));
    const qVerb = verbClass(text, this.lexicon);
    let best: Flow | undefined;
    let bestScore = 0;
    for (const flow of this.flows) {
      /*
       * Never let a keyword collision override the action the user expressed.
       * "I need to sort out payment" is a PURCHASE, but it shares the token
       * "sort" with the catalog-sorting flow, and pure token overlap happily
       * returned the sorting flow — undoing the verb-class work the semantic
       * path does. The lexical path is a fallback, so it must be at least as
       * careful about action as the primary one.
       */
      const fVerb = verbClass(`${flow.name} ${flow.feature}`, this.lexicon);
      if (qVerb && fVerb && qVerb !== fVerb) continue;
      const terms = tokenize(`${flow.name} ${flow.feature} ${flow.intents.join(" ")}`);
      let s = 0;
      for (const t of terms) if (q.has(t)) s += 1;
      // exact intent phrase match is a strong signal
      for (const intent of flow.intents) if (text.toLowerCase().includes(intent.toLowerCase())) s += 3;
      if (s > bestScore) { bestScore = s; best = flow; }
    }
    return bestScore >= 2 ? best : undefined;
  }

  /** B3 — infer the most likely persona from what the prospect has said. */
  inferPersona(text: string): Persona | undefined {
    const q = new Set(tokenize(text));
    let best: Persona | undefined;
    let bestScore = 0;
    for (const p of this.data.personas) {
      let s = 0;
      for (const kw of p.keywords) if (q.has(kw.toLowerCase()) || text.toLowerCase().includes(kw.toLowerCase())) s += 1;
      if (s > bestScore) { bestScore = s; best = p; }
    }
    return bestScore >= 1 ? best : undefined;
  }

  /** B3 — playbook items of a kind relevant to a persona + query keywords. */
  playbookFor(kind: PlaybookItem["kind"], personaId: string | undefined, text: string, k = 2): PlaybookItem[] {
    const q = new Set(tokenize(text));
    return this.data.playbook
      .filter((i) => i.kind === kind && (i.personas.includes("*") || (personaId && i.personas.includes(personaId))))
      .map((i) => {
        let s = i.personas.includes(personaId ?? "") ? 1 : 0;
        for (const kw of i.keywords) if (q.has(kw.toLowerCase()) || text.toLowerCase().includes(kw.toLowerCase())) s += 2;
        return { i, s };
      })
      .sort((a, b) => b.s - a.s)
      .slice(0, k)
      .map((x) => x.i);
  }

  // B4 — learning loop. Re-read from disk first so a concurrent process's
  // sessions aren't clobbered by our in-memory copy.
  async logSession(rec: SessionRecord): Promise<void> {
    const file = path.join(this.dir, "sessions.json");
    if (existsSync(file)) {
      try {
        const onDisk = JSON.parse(await fs.readFile(file, "utf8")) as SessionRecord[];
        const known = new Set(this.data.sessions.map((s) => s.id));
        for (const s of onDisk) if (!known.has(s.id)) this.data.sessions.push(s);
      } catch {
        /* keep in-memory */
      }
    }
    this.data.sessions.push(rec);
    await this.save("sessions");
  }

  signals() {
    const flowCount = new Map<string, number>();
    const objections = new Map<string, number>();
    const gaps: string[] = [];
    let engaged = 0;
    for (const s of this.data.sessions) {
      for (const f of s.flowsSuggested) flowCount.set(f, (flowCount.get(f) || 0) + 1);
      for (const o of s.objections) objections.set(o, (objections.get(o) || 0) + 1);
      gaps.push(...s.kbGaps);
      if (s.outcome === "engaged" || s.outcome === "qualified") engaged++;
    }
    return {
      totalSessions: this.data.sessions.length,
      engaged,
      topFlows: [...flowCount.entries()].sort((a, b) => b[1] - a[1]),
      topObjections: [...objections.entries()].sort((a, b) => b[1] - a[1]),
      kbGaps: gaps,
    };
  }
}

/**
 * Registry of loaded product brains. The server serves many products from one
 * process; each is loaded once and reused across sessions.
 */
const registry = new Map<string, BrainStore>();

export async function brainFor(product: string): Promise<BrainStore> {
  let b = registry.get(product);
  if (!b) {
    b = new BrainStore(product);
    await b.load();
    registry.set(product, b);
  } else {
    await b.reloadIfChanged();
  }
  return b;
}

export function loadedProducts(): string[] {
  return [...registry.keys()];
}

/** Default store for the configured PRODUCT — used by the CLIs, which are single-product per process. */
export const brain = new BrainStore();
