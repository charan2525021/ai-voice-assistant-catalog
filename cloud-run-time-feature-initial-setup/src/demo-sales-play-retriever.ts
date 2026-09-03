import type { CatalogSalesPlay, SalesPlayKind, SignedCatalogEnvelope } from "@sable/sdk-contracts";
import type { GuidedDemoSessionState } from "./demo-director.js";
import type { DemoInterruptionPlan } from "./demo-interruption-planner.js";

export const DEMO_SALES_PLAY_LIMIT = 3;

export interface DemoSalesPlayGrounding {
  /** Policy result, not a field chosen by the planner model. */
  playMode: "none" | "retrieve";
  allowedPlayKinds: SalesPlayKind[];
  maximumChunks: number;
  /** IDs only: content remains in the session's pinned signed catalog. */
  selectedPlayIds: string[];
}

export interface DemoSalesPlayRetrievalContext {
  catalog: SignedCatalogEnvelope;
  demo: GuidedDemoSessionState;
  requestText: string;
}

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "can", "do", "does", "for", "from", "how", "i", "in", "is",
  "it", "me", "of", "on", "or", "our", "that", "the", "this", "to", "we", "what", "when", "where", "which",
  "why", "with", "you", "your",
]);

function normalize(value: string): string {
  return value.toLocaleLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function tokens(value: string): Set<string> {
  return new Set(normalize(value).split(/\s+/).filter((token) => token.length > 1 && !STOP_WORDS.has(token)));
}

function overlap(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const token of left) if (right.has(token)) count += 1;
  return count;
}

/**
 * Intent gating is deliberately deterministic. The planner states meaning and
 * whether facts may be needed; this function owns which sales-play categories
 * are permitted to enter the answer context.
 */
export function allowedDemoSalesPlayKinds(plan: DemoInterruptionPlan): SalesPlayKind[] {
  if (plan.responseMode === "clarify" || plan.playbackDirective === "resume_now" || plan.playbackDirective === "stop") return [];

  switch (plan.intent) {
    case "product_question":
      return ["product_answer", "value_proposition", "proof", "positioning"];
    case "objection":
      return ["objection_response", "proof", "positioning", "value_proposition"];
    case "how_to":
      return ["product_answer"];
    case "screen_question":
      return plan.needsKnowledge ? ["product_answer", "proof"] : [];
    case "action":
      // A valid replacement/continue/stop is handled by deterministic playback.
      // Knowledge is useful only when the requested action cannot be fulfilled
      // or the model explicitly found an informational component.
      return plan.unavailableReason || plan.needsKnowledge ? ["product_answer", "next_best_action"] : [];
    case "conversation":
      return [];
  }
}

function scorePlay(plan: DemoInterruptionPlan, play: CatalogSalesPlay, context: DemoSalesPlayRetrievalContext): number | undefined {
  const personaId = context.demo.personaId;
  if (play.personaIds.length && (!personaId || !play.personaIds.includes(personaId))) return undefined;

  const profile = context.catalog.payload.demoProfile;
  const answerModule = profile?.modules.find((module) => module.id === (plan.answerSubjectModuleId ?? context.demo.activeModuleId));
  const activeJourneyId = answerModule?.journeyId ?? plan.subjectJourneyId;
  const query = normalize(context.requestText);
  const queryTokens = tokens(query);
  const titleTokens = tokens(play.title);
  const contentTokens = tokens(play.content);
  const journeyMatch = !!activeJourneyId && play.journeyIds.includes(activeJourneyId);

  let signalScore = 0;
  for (const rawPhrase of play.signalPhrases) {
    const phrase = normalize(rawPhrase);
    if (!phrase) continue;
    if (query.includes(phrase)) {
      signalScore = Math.max(signalScore, 12);
      continue;
    }
    const phraseTokens = tokens(phrase);
    if (!phraseTokens.size) continue;
    const coverage = overlap(queryTokens, phraseTokens) / phraseTokens.size;
    if (coverage >= 0.6) signalScore = Math.max(signalScore, 4 + (coverage * 4));
  }

  const titleOverlap = overlap(queryTokens, titleTokens);
  const contentOverlap = overlap(queryTokens, contentTokens);
  // A journey-scoped chunk can answer a vague question such as "why does this
  // matter?" while unrelated chunks still require a textual match.
  if (!journeyMatch && signalScore === 0 && titleOverlap === 0 && contentOverlap === 0) return undefined;

  return signalScore
    + (titleOverlap * 2.5)
    + Math.min(3, contentOverlap * 0.5)
    + (journeyMatch ? 4 : play.journeyIds.length === 0 ? 1 : 0)
    + (play.personaIds.length ? 2 : 1);
}

/** Retrieve bounded, approved knowledge chunks from the pinned signed catalog. */
export function retrieveDemoSalesPlays(
  plan: DemoInterruptionPlan,
  context: DemoSalesPlayRetrievalContext,
): DemoSalesPlayGrounding {
  const allowedPlayKinds = allowedDemoSalesPlayKinds(plan);
  if (!allowedPlayKinds.length) {
    return { playMode: "none", allowedPlayKinds: [], maximumChunks: DEMO_SALES_PLAY_LIMIT, selectedPlayIds: [] };
  }

  const allowed = new Set<SalesPlayKind>(allowedPlayKinds);
  const selectedPlayIds = (context.catalog.payload.salesPlays ?? [])
    .map((play, index) => ({ play, index, score: allowed.has(play.kind) ? scorePlay(plan, play, context) : undefined }))
    .filter((candidate): candidate is typeof candidate & { score: number } => candidate.score !== undefined)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, DEMO_SALES_PLAY_LIMIT)
    .map(({ play }) => play.id);

  return {
    playMode: "retrieve",
    allowedPlayKinds,
    maximumChunks: DEMO_SALES_PLAY_LIMIT,
    selectedPlayIds,
  };
}

/** Resolve persisted IDs without trusting continuity to carry mutable content. */
export function resolveDemoSalesPlays(catalog: SignedCatalogEnvelope, grounding: DemoSalesPlayGrounding): CatalogSalesPlay[] {
  const byId = new Map((catalog.payload.salesPlays ?? []).map((play) => [play.id, play]));
  return grounding.selectedPlayIds.flatMap((id) => {
    const play = byId.get(id);
    return play ? [play] : [];
  });
}
