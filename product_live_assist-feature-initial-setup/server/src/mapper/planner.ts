import { makeBrain, type NMessage } from "../brain.js";
import { brain as defaultKb, type BrainStore } from "../knowledge/store.js";
import type { ScreenNode } from "./types.js";
import type { PlannedJourneyJob, JourneyFailureCategory } from "./types.js";
import { goalGroundedInScreens, plannerEligibleScreen } from "./journey-evidence.js";
import { documentJourneyPlanningEnabled } from "../knowledge/document-structure.js";
import { matchDocumentProcedure, safetyForDocumentProcedure } from "./document-path.js";
import { emit } from "../events.js";

export interface PlanningResult {
  jobs: PlannedJourneyJob[];
  rejected: { goal: string; why: string; category: JourneyFailureCategory }[];
  metrics: {
    mode: "exploration_only" | "documents_plus_ui";
    documentCandidates: number;
    safeDocumentCandidates: number;
    plannedFromDocuments: number;
    plannedFromUi: number;
    staleOrUngrounded: number;
  };
}

/**
 * Curriculum Planner — turns the surface map + ingested docs into a RANKED list
 * of jobs to learn. This is what makes exploration goal-directed instead of a
 * combinatorial crawl: the agent tries to accomplish things, not click things.
 */
async function proposeUiJobs(
  productName: string,
  screens: ScreenNode[],
  maxJobs: number,
  /** Coverage inputs: what demos actually asked for, and what we already know. */
  opts: { demand?: string[]; alreadyLearned?: string[]; retry?: string[]; kb?: BrainStore; hasCredentials?: boolean; allowActions?: string[] } = {},
): Promise<{ jobs: { goal: string; why: string }[]; docChunks: {
  id: string; title: string; source: string; trust: string;
  chunkText: string; textFedToPlanner: string;
}[] }> {
  const model = makeBrain("planner");
  const creationAllowed = (opts.allowActions ?? []).some((item) => /(^|\b)(create|write|mutate)(\b|$)/i.test(item));
  const controlsPerScreen = Math.max(1, Number(process.env.PLANNER_CONTROLS_PER_SCREEN ?? 40));

  const eligibleScreens = screens.filter(plannerEligibleScreen);
  const surface = eligibleScreens
    .map((s) => `- ${s.title} (${s.url}) [${s.kind ?? "product"}]\n    controls: ${s.controls.slice(0, controlsPerScreen).join(", ")}`)
    .join("\n");

  /*
   * Docs are the product's own account of what matters — free signal, no clicking.
   *
   * This used to be `kb.docs.slice(0, 6)`, which is fine for a hand-written
   * overview file and useless the moment a real manual is indexed: draw.io's
   * 855 chunks meant the planner saw 0.7% of the corpus, all of it from
   * whichever document happened to sort first, so it planned from the UI alone
   * and proposed goals the product cannot prove. Sample one chunk per DOCUMENT,
   * spread evenly across the corpus, so the hints describe the product's breadth
   * rather than its first page.
   */
  const kb = opts.kb ?? defaultKb;
  const byDocument = new Map<string, (typeof kb.docs)[number]>();
  for (const chunk of kb.docs) if (!byDocument.has(chunk.title)) byDocument.set(chunk.title, chunk);
  const distinct = [...byDocument.values()];
  const wanted = Number(process.env.PLANNER_DOC_HINTS ?? 14);
  const stride = Math.max(1, Math.floor(distinct.length / wanted));
  const sampled = distinct.filter((_, i) => i % stride === 0).slice(0, wanted);
  const docHints = sampled.map((d) => `- ${d.title}: ${d.text.slice(0, 180)}`).join("\n");

  const system = `You are planning how an assistant should learn to use a software product called "${productName}".

Given the screens and controls below, list the concrete JOBS a real user comes to this product to do.
A job is a goal with an observable result, e.g. "Create a task", "Mark a task complete", "Filter to active items".
Not a job: "Click the menu", "Look at the page", "Explore settings".

WHAT YOU MAY NOT DO (the execution layer BLOCKS these, so proposing them wastes the whole budget):
- Anything requiring a password: signing up, registering, logging in, changing credentials.
- Anything destructive or irreversible: deleting, removing, cancelling, sending, inviting, publishing, archiving.
- Billing, payment, subscription or account-settings pages.${
  opts.allowActions?.length ? `\nEXCEPTION — this product explicitly permits: ${opts.allowActions.join(", ")}.` : ""
}${
  opts.hasCredentials
    ? "\nYou ARE already signed in, so authenticated screens are fair game."
    : "\nYou are NOT signed in and cannot sign in. Propose only jobs a VISITOR can complete — browsing, opening items, filtering, searching, sorting, navigating."
}

${creationAllowed
  ? `CREATING RECORDS IS EXPLICITLY ALLOWED IN THIS ENVIRONMENT. Prefer replayable, uniquely named test records and observable proof.`
  : `THIS ENVIRONMENT IS READ-ONLY. Do not propose creating, adding, saving, generating, importing, uploading, running, or otherwise changing records. Prefer opening, searching, filtering, comparing, inspecting, and explaining existing data.`}

Rules:
- Only propose jobs that are clearly achievable with the controls listed AND allowed above.
- A documentation claim is not enough: at least one visible control, title or route must support the job.
- Do not turn legal/privacy pages, billing/account settings, banners or customer-created record names into product capabilities.
- When a screen shows tenant records, propose a generic job such as "Open a project", never a named record such as "Open Acme Dashboard".
- Each job must have a deterministic completion signal: a destination route/screen, a changed result set, or a new/updated record.
- Prefer jobs whose target is stable, not tied to one row's text (e.g. "open an article", not "follow Artem Bondar").
- ${creationAllowed ? "Order creation jobs before jobs that depend on the created record." : "Keep every job read-only; do not rely on a submit/save action."}
- Skip anything destructive, billing-related, or account/settings related.
- Prefer jobs that span MULTIPLE screens end to end (they make the best demos) over single clicks.
- Return at most ${maxJobs}.
${opts.alreadyLearned?.length ? `\nALREADY LEARNED — do not repeat these:\n${opts.alreadyLearned.map((g) => `- ${g}`).join("\n")}` : ""}
${opts.demand?.length ? `\nREAL PROSPECT DEMAND — questions asked in live demos that we could not answer. Prioritise jobs that would let us demonstrate these:\n${opts.demand.map((d) => `- ${d}`).join("\n")}` : ""}
${opts.retry?.length ? `\nPREVIOUSLY FAILED — retry these ONLY if the controls above make them clearly achievable, rephrased more concretely:\n${opts.retry.map((d) => `- ${d}`).join("\n")}` : ""}

Reply as a numbered list, one per line, in exactly this format:
1. <job goal> | <why a user wants this>`;

  const user = `Screens and controls:\n${surface}\n\n${docHints ? `From the product documentation:\n${docHints}` : ""}`;

  const res = await model.step(system, [{ role: "user", blocks: [{ type: "text", text: user }] }] as NMessage[], []);
  const text = res.texts.join("\n");

  const jobs: { goal: string; why: string }[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*\d+[.)]\s*(.+)$/);
    if (!m) continue;
    const [goal, why] = m[1].split("|").map((s) => s.trim());
    if (!goal) continue;
    const clean = goal.replace(/\*\*/g, "");
    const key = clean.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (seen.has(key) || !goalGroundedInScreens(clean, eligibleScreens)) continue;
    seen.add(key);
    jobs.push({ goal: clean, why: why || "" });
  }
  return {
    jobs: jobs.slice(0, maxJobs),
    docChunks: sampled.map((chunk) => ({
      id: chunk.id, title: chunk.title, source: chunk.source, trust: chunk.trust,
      chunkText: chunk.text,
      textFedToPlanner: `- ${chunk.title}: ${chunk.text.slice(0, 180)}`,
    })),
  };
}

function goalKey(goal: string): string {
  return goal.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Interrogative and reference openers — the register of an FAQ, not a task. */
const REFERENCE_GOAL = /^\s*(what|why|when|where|which|who|how(?!\s+to\b)|is|are|does|do|can|should)\b/i;
/** Section headings that name a topic rather than an action. */
const REFERENCE_HEADING = /^\s*(overview|introduction|requirements?|prerequisites?|limitations?|glossary|terminology|concepts?|faq|troubleshooting|best practices?|about|examples?|reference|notes?|changelog|pricing|permissions?|supported\b)/i;

/**
 * Does this documented goal describe something a user DOES?
 *
 * "How to create a board" is a task; "What is a board?" is not, and neither is
 * "Requirements". The distinction is grammatical rather than semantic on
 * purpose — it needs no model call, cannot drift, and the register of reference
 * writing is consistent enough across product manuals to be worth trusting.
 * `how to` is deliberately exempted from the interrogative list: it is the most
 * common way a manual titles an actual procedure.
 */
export function actionableGoal(goal: string): boolean {
  const text = (goal ?? "").trim();
  if (text.length < 3) return false;
  if (text.endsWith("?")) return false;
  if (REFERENCE_GOAL.test(text)) return false;
  if (REFERENCE_HEADING.test(text)) return false;
  return true;
}

/** Detailed planner output is used by onboarding for auditability and metrics. */
export async function proposeJobsDetailed(
  productName: string,
  screens: ScreenNode[],
  maxJobs: number,
  opts: { demand?: string[]; alreadyLearned?: string[]; retry?: string[]; kb?: BrainStore; hasCredentials?: boolean; allowActions?: string[] } = {},
): Promise<PlanningResult> {
  if (!documentJourneyPlanningEnabled()) {
    const ui = await proposeUiJobs(productName, screens, maxJobs, opts);
    const result: PlanningResult = {
      jobs: ui.jobs,
      rejected: [],
      metrics: { mode: "exploration_only", documentCandidates: 0, safeDocumentCandidates: 0, plannedFromDocuments: 0, plannedFromUi: ui.jobs.length, staleOrUngrounded: 0 },
    };
    emit("map.plan", { status: "ok", data: {
      jobs: result.jobs.map((job) => ({ goal: job.goal, why: job.why, source: job.source ?? "planner" })),
      rejected: [], demandSignals: opts.demand ?? [], docChunksFedToPlanner: ui.docChunks,
      screensFedToPlanner: screens.filter(plannerEligibleScreen).map((screen) => ({ title: screen.title, url: screen.url, controls: screen.controls })),
    } });
    return result;
  }

  const kb = opts.kb ?? defaultKb;
  const learned = new Set((opts.alreadyLearned ?? []).map(goalKey));
  const rejected: PlanningResult["rejected"] = [];
  const documentJobs: PlannedJourneyJob[] = [];
  const eligibleScreens = screens.filter(plannerEligibleScreen);
  for (const procedure of kb.procedures) {
    if (learned.has(goalKey(procedure.goal))) continue;
    const safe = safetyForDocumentProcedure(procedure, screens[0]?.url ?? "http://localhost", opts.allowActions);
    if (!safe.allowed) {
      rejected.push({ goal: procedure.goal, why: `Documentation candidate blocked before exploration: ${safe.reason}`, category: "unsafe_action" });
      continue;
    }
    /*
     * A documented goal must name something the product actually shows.
     *
     * Every UI-proposed job passes goalGroundedInScreens; document procedures
     * skipped it entirely, and so the planner turned documentation HEADINGS
     * into jobs — "Citations", "Requirements", "How It Works",
     * "Model-Specific Behavior". Those are section titles, not things a user
     * can do, and the explorer cannot fail them in any informative way: it
     * clicks something, the judge finds no shared concept, and the job dies as
     * goal_mismatch after burning a browser session. A whole documented batch
     * went 0-for-7 that way.
     *
     * Prose describing a SERVER-side pipeline is the common case here, and the
     * tell is always the same — no control, title or route in the product
     * mentions any of it.
     */
    if (!goalGroundedInScreens(procedure.goal, eligibleScreens)) {
      rejected.push({
        goal: procedure.goal,
        why: "Documented goal names nothing observable in the product — likely a section heading or server-side behaviour, not a user journey",
        category: "goal_mismatch",
      });
      continue;
    }
    const documentation = matchDocumentProcedure(procedure, eligibleScreens);
    if (documentation.matchStatus === "none") {
      rejected.push({ goal: procedure.goal, why: `Documentation may be stale: ${documentation.staleReasons.join("; ")}`, category: "documentation_stale" });
      continue;
    }
    /*
     * A documented entry earns a job slot only if it describes a TASK.
     *
     * The filter here is deliberately about the goal's grammar, not about how
     * well its steps match the current UI. Requiring every step to match would
     * be treating the manual as a script — the exact thing the explorer no
     * longer does — and would throw away the accurate-intent-but-stale-wording
     * case that documentation is most useful for.
     *
     * What documentation genuinely cannot supply is a journey where none
     * exists. Reference material is written in a register that gives itself
     * away: "What is Jira work item hierarchy?", "What is a workflow scheme?",
     * "Overview", "Requirements". Those describe concepts, and an explorer sent
     * after one navigates to whatever screen shares a word with it and then
     * fails verification, which is precisely what happened.
     */
    if (!actionableGoal(procedure.goal)) {
      rejected.push({
        goal: procedure.goal,
        why: "Reads as reference or FAQ material rather than a task a user performs — documentation like this is kept for answering questions, not for learning a journey",
        category: "goal_mismatch",
      });
      continue;
    }
    documentJobs.push({
      goal: procedure.goal,
      why: `Documented procedure in ${procedure.citation.title} > ${procedure.citation.section}`,
      source: "documentation",
      documentation,
    });
  }
  documentJobs.sort((a, b) => {
    const rank = (job: PlannedJourneyJob) => job.documentation?.matchStatus === "full" ? 2 : 1;
    return rank(b) - rank(a) || (b.documentation?.executablePrefix.length ?? 0) - (a.documentation?.executablePrefix.length ?? 0);
  });

  /*
   * Clicking is the primary discovery method; documentation is a shortcut.
   *
   * The split used to be `maxJobs - 1`, so documentation could claim 24 of 25
   * slots — and on the two products measured it converted almost none of them,
   * because a documented procedure only pays off when the product still matches
   * what the manual says. Capping its share keeps that upside while guaranteeing
   * the majority of every run goes to what the UI actually offers.
   */
  const documentShare = Math.min(1, Math.max(0, Number(process.env.PLANNER_DOCUMENT_SHARE ?? 0.25)));
  const documentLimit = Math.max(0, Math.min(documentJobs.length, Math.floor(maxJobs * documentShare)));
  const selectedDocuments = documentJobs.slice(0, documentLimit);
  const ui = await proposeUiJobs(productName, screens, maxJobs, {
    ...opts,
    alreadyLearned: [...(opts.alreadyLearned ?? []), ...selectedDocuments.map((job) => job.goal)],
  });
  const seen = new Set(selectedDocuments.map((job) => goalKey(job.goal)));
  const uiJobs: PlannedJourneyJob[] = [];
  for (const job of ui.jobs) {
    if (seen.has(goalKey(job.goal))) continue;
    seen.add(goalKey(job.goal));
    uiJobs.push({ ...job, source: "planner" });
  }
  const jobs = [...selectedDocuments, ...uiJobs].slice(0, maxJobs);
  const result: PlanningResult = {
    jobs,
    rejected,
    metrics: {
      mode: "documents_plus_ui",
      documentCandidates: kb.procedures.length,
      safeDocumentCandidates: documentJobs.length,
      plannedFromDocuments: jobs.filter((job) => job.source === "documentation").length,
      plannedFromUi: jobs.filter((job) => job.source !== "documentation").length,
      staleOrUngrounded: rejected.filter((item) =>
        item.category === "documentation_stale" || item.category === "goal_mismatch").length,
    },
  };
  emit("map.plan", { status: "ok", data: {
    jobs: result.jobs.map((job) => ({
      goal: job.goal, why: job.why, source: job.source ?? "planner",
      documentedSteps: job.documentation?.procedure.steps,
      expectedProof: job.documentation?.procedure.successMessage,
      prerequisites: job.documentation?.procedure.prerequisites,
      citation: job.documentation?.procedure.citation,
      wordingMatch: job.documentation?.matchStatus,
      preMatchedPath: job.documentation?.executablePrefix,
    })),
    rejected: result.rejected,
    demandSignals: opts.demand ?? [],
    docChunksFedToPlanner: ui.docChunks,
    documentedProceduresConsidered: kb.procedures.map((procedure) => ({
      id: procedure.id, goal: procedure.goal, steps: procedure.steps,
      successMessage: procedure.successMessage, prerequisites: procedure.prerequisites,
      citation: procedure.citation,
    })),
    screensFedToPlanner: screens.filter(plannerEligibleScreen).map((screen) => ({ title: screen.title, url: screen.url, controls: screen.controls })),
  } });
  return result;
}

/** Compatibility API: flag-off behavior is the original UI planner. */
export async function proposeJobs(
  productName: string,
  screens: ScreenNode[],
  maxJobs: number,
  opts: { demand?: string[]; alreadyLearned?: string[]; retry?: string[]; kb?: BrainStore; hasCredentials?: boolean; allowActions?: string[] } = {},
): Promise<{ goal: string; why: string }[]> {
  return (await proposeJobsDetailed(productName, screens, maxJobs, opts)).jobs;
}
