import { makeBrain, type NBlock, type NMessage, type ToolDef } from "../brain.js";
import type { LiveBox, PageSnapshot } from "../livebox.js";
import type { DocumentationJourneyContext, Journey, JourneyFailure, JourneyStep } from "./types.js";
import { Budget, checkAction } from "./safety.js";
import { validateProof } from "./proof.js";
import { UNIQUE_TOKEN, collapse, expand, newRunTag } from "./unique.js";
import { config } from "../config.js";
import { fingerprintSnapshot } from "../runtime/screen-state.js";
import { buildEvidenceContract, failureCategory, validateGoalAlignment } from "./journey-evidence.js";
import { assessProductAccess } from "../access.js";
import { emit } from "../events.js";
import type { BrainStore } from "../knowledge/store.js";

/**
 * How much page text to hold for proof reasoning.
 *
 * The old 6,000 was fine for a substring check but far too small to DIFF two
 * screens: on a real app the interesting new line (a toast, a new table row) is
 * routinely past that cut, so the candidate list came back empty and the model
 * had nothing to choose from.
 */
const PROOF_TEXT_LIMIT = 30000;

/**
 * How much product knowledge to put in front of the explorer, and how much of
 * each chunk. Small on purpose: this is orientation, not reading material, and
 * every character competes with the screen listing that the model must actually
 * act on.
 */
const KNOWLEDGE_CHUNKS = Number(process.env.EXPLORER_KNOWLEDGE_CHUNKS ?? 2);
const KNOWLEDGE_CHUNK_CHARS = Number(process.env.EXPLORER_KNOWLEDGE_CHUNK_CHARS ?? 600);

/**
 * What the product's own documentation says about this goal.
 *
 * The explorer used to receive one matched procedure and nothing else, so a
 * model sent after "Manage workflows" was told a sequence of steps but never
 * what a workflow scheme IS, what the product calls things, or which rules
 * constrain it. Everything the knowledge base knew was available to the planner
 * and to answer-time retrieval, and reached the agent doing the actual work not
 * at all.
 *
 * This is deliberately framed as vocabulary and intent rather than as a plan.
 * Documentation is reliable about what a feature is for and what it is named,
 * and unreliable about which button to press today — so it is given as
 * background, and the hard rule that follows it is that nothing here may be
 * acted on unless it is visible on screen.
 */
async function knowledgeBriefing(goal: string, knowledge?: BrainStore): Promise<string> {
  if (!knowledge || KNOWLEDGE_CHUNKS <= 0) return "";
  const hits = await knowledge.searchDocsSemantic(goal, KNOWLEDGE_CHUNKS).catch(() => []);
  if (!hits.length) return "";
  emit("map.explore.knowledge", { status: "ok", data: {
    goal, chunkCount: hits.length,
    chunks: hits.map(({ chunk, score }) => ({
      chunkId: chunk.id, title: chunk.title, section: chunk.section,
      source: chunk.source, trust: chunk.trust, score,
    })),
  } });
  const lines = hits.map(({ chunk }) => {
    const where = [chunk.title, chunk.section].filter(Boolean).join(" > ");
    const text = chunk.text.replace(/\s+/g, " ").trim().slice(0, KNOWLEDGE_CHUNK_CHARS);
    return `- [${where}] ${text}`;
  });
  return `
PRODUCT BACKGROUND — what this product's documentation says around this topic:
${lines.join("\n")}

Use the above for VOCABULARY and INTENT only: what the feature is for, what this product calls
things, what has to be true first, and which area of the app it is likely to live in. It tells you
what to look for. It does not tell you what to click, and it may describe a version of the app that
no longer exists. Never act on a control, label or message because it appears above — act only on
what is listed in Controls on the current screen.`;
}

/**
 * Explorer — attempts ONE job and records a replayable trace.
 *
 * Every successful action is recorded with a DURABLE selector (ARIA role +
 * accessible name), never the per-snapshot element id, so the resulting journey
 * can be replayed in a fresh session by the Verifier.
 */

const TOOLS: ToolDef[] = [
  {
    name: "click",
    description: "Click an element by its id from the current screen list.",
    parameters: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
  },
  {
    name: "fill",
    description: "Type into a text field by id. submit=true presses Enter.",
    parameters: {
      type: "object",
      properties: { id: { type: "integer" }, value: { type: "string" }, submit: { type: "boolean" } },
      required: ["id", "value"],
    },
  },
  {
    name: "select",
    description: "Choose an option in a dropdown (select) by id. value = the option's visible text.",
    parameters: { type: "object", properties: { id: { type: "integer" }, value: { type: "string" } }, required: ["id", "value"] },
  },
  {
    name: "go_to_screen",
    description: "Jump directly to one of the product's known screens by its exact URL (faster than clicking through).",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "done",
    description:
      "Call only when the job is complete. Select the evidence type that actually proves the goal; text is required only for text/write proofs.",
    parameters: {
      type: "object",
      properties: {
        postcondition: { type: "string", description: "Short exact text visible after success; optional for URL/screen/list proofs" },
        proof: {
          type: "string",
          enum: ["text", "url_changed", "screen_reached", "record_created", "field_changed", "result_set_changed", "order_changed"],
          description: "The kind of state change that proves this goal. Navigation uses screen_reached/url_changed; searches use result_set_changed; writes use record_created/field_changed.",
        },
        capability: { type: "string" },
        entity: { type: "string", description: "The TYPE of thing this acts on (e.g. \"Task\", \"Invoice\", \"Product\") — NOT the text you typed." },
      },
      required: ["proof"],
    },
  },
  {
    name: "give_up",
    description: "Call if this job cannot be completed with the available controls.",
    parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] },
  },
];

/*
 * Show the model BOTH names when they disagree.
 *
 * `name` is the accessible name, which is the right thing to record because it
 * is what replay resolves by — but `aria-label` beats content in that
 * computation, so a control reading "Playground" on screen is listed as
 * "Open Playground". The model then reasons about a label no human can see, and
 * any narration built from it describes a button by the wrong words. The visible
 * text is already captured; it was simply never shown.
 */
/** The durable identity pair — the same one replay resolves by. */
const controlKey = (e: { role?: string; name?: string; placeholder?: string; text?: string }) =>
  `${e.role ?? ""}"${String(e.name || e.placeholder || e.text || "").toLowerCase()}"`;

/*
 * Mark what is NEW since the previous screen.
 *
 * The list was rebuilt from scratch every turn with no indication of what had
 * changed, so the model had to re-read ~30 controls and infer the effect of its
 * own last action. It routinely could not, which is the shape of most
 * goal_mismatch failures: it acted, could not see that anything happened, and
 * either declared done on no evidence or gave up after two turns. A first-run
 * dialog appearing was likewise indistinguishable from page furniture that had
 * been there all along.
 *
 * A leading "*" costs nothing and answers both questions directly.
 */
function screenText(s: PageSnapshot, prev?: PageSnapshot): string {
  const before = prev ? new Set(prev.elements.map(controlKey)) : null;
  let added = 0;
  const list = s.elements
    .map((e) => {
      const name = e.name || e.placeholder || e.text;
      const shown = (e.text || "").trim();
      const differs = shown && name && shown.toLowerCase() !== String(name).toLowerCase();
      const overlay = e.overlay ? " [overlay]" : "";
      const isNew = before ? !before.has(controlKey(e)) : false;
      if (isNew) added++;
      return `${isNew ? "*" : " "}[${e.id}] ${e.role} "${name}"${differs ? ` (shows: "${shown.slice(0, 40)}")` : ""}${overlay}`;
    })
    .join("\n");
  const legend = before
    ? added
      ? `\n(${added} control(s) marked * are NEW since your last action — that is the effect you just caused.)`
      : `\n(Nothing new appeared, so your last action changed nothing visible on this screen.)`
    : "";
  return `URL: ${s.url}\nTitle: ${s.title}\nControls:\n${list || "(none)"}${legend}`;
}

export interface ExploreResult {
  journey?: Journey;
  failure?: string;
  diagnostic?: JourneyFailure;
  metrics?: { modelTurns: number; prefilledSteps: number };
}

export interface ExplorerProgress {
  currentStep: number;
  totalSteps: number;
  message: string;
  data?: Record<string, unknown>;
}

export async function exploreJob(
  box: LiveBox,
  productName: string,
  goal: string,
  startUrl: string,
  knownScreens: { title: string; url: string }[] = [],
  allowActionsIn?: string[],
  humanInstruction?: string,
  onProgress?: (progress: ExplorerProgress) => void | Promise<void>,
  documentation?: DocumentationJourneyContext,
  /** Product knowledge base, searched for orientation on this specific goal. */
  knowledge?: BrainStore,
): Promise<ExploreResult> {
  const model = makeBrain("explorer");
  // Deep multi-screen journeys (checkout is ~8 steps on its own) need headroom.
  const maxSteps = Number(process.env.EXPLORER_MAX_STEPS ?? 26);
  const maxMs = Number(process.env.EXPLORER_MAX_MS ?? 300_000);
  const budget = new Budget(maxSteps, maxMs);
  const steps: JourneyStep[] = [];
  const origin = new URL(startUrl).origin;
  const allowedActions = allowActionsIn ?? config.allowActions; // opt-in mutations, declared in product.json
  // The box now gates replayed steps itself, so it has to be told what this
  // journey is permitted to do — otherwise it judges by the product default.
  box.setAllowedActions(allowedActions);
  let modelTurns = 0;
  let prefilledSteps = 0;
  let executionMismatch: string | undefined;
  /*
   * Alignment rejections are RECOVERABLE, up to a point.
   *
   * A bad proof string got handed back with the observed candidates and the
   * model tried again; a bad goal/evidence alignment killed the job outright on
   * the first occurrence, without ever telling the model what was wrong. That
   * asymmetry made goal_mismatch the largest single failure category — in most
   * of those runs the model had simply stopped one action short and would have
   * kept going if asked. Give it the same second chance, then fail for real.
   */
  let alignmentRejections = 0;
  const MAX_ALIGNMENT_REJECTIONS = Number(process.env.EXPLORER_MAX_ALIGNMENT_RETRIES ?? 2);
  const started = Date.now();
  emit("map.explore.start", { status: "start", data: {
    goal, startUrl, budget: { maxSteps, maxMs }, documented: !!documentation,
  } });
  const complete = (result: ExploreResult): ExploreResult => {
    emit("map.explore.done", {
      status: result.journey ? "ok" : "error", ms: Date.now() - started,
      error: result.failure,
      data: result.journey ? {
        goal, steps: result.journey.steps, postcondition: result.journey.postcondition,
        proofType: result.journey.proof, modelTurns, prefilledSteps,
      } : {
        goal, failure: result.failure, category: result.diagnostic?.category,
        steps, lastUrl: box.currentUrl(), modelTurns, prefilledSteps,
      },
    });
    return result;
  };

  await box.resetState(); // clean DATA + authenticated (startUrl may be the login page)
  let snap = await box.snapshot();
  const access = assessProductAccess(startUrl, snap);
  if (!access.ok) {
    return complete({
      failure: `Product access was lost before exploration: ${access.message}`,
      diagnostic: {
        stage: "exploration",
        category: "permission_blocked",
        reason: access.message,
        retryable: false,
        beforeUrl: snap.url,
        capturedAt: new Date().toISOString(),
      },
    });
  }
  // Remember the starting screen so we can reject a "proof" that was already true.
  const textAtStart = await box.visibleText(PROOF_TEXT_LIMIT);
  /*
   * ...and, more importantly, the screen the journey ACTS on.
   *
   * `textAtStart` is captured at the start URL, but almost every job begins by
   * navigating somewhere else — so this guard was reading the wrong page and
   * waved through proofs that were plainly visible on the destination. Three of
   * eight OrangeHRM jobs died in verification 20s later for exactly this reason
   * ("System Users", an employee's own name). Capturing the text just before the
   * first real interaction makes the guard agree with the verifier, which now
   * measures from the same point.
   */
  let textAtAction: string | null = null;
  const captureActionBaseline = async () => {
    if (textAtAction === null) textAtAction = await box.visibleText(PROOF_TEXT_LIMIT);
  };
  /**
   * Everything the journey typed.
   *
   * Kept so a proof rejection can EXPLAIN itself. A postcondition assembled from
   * two of these is what recorded a working OrangeHRM journey as broken: it
   * typed First="Ava", Middle="Marie", Last="Johnson" and asserted "Ava Johnson",
   * which the product never renders. Never a rejection reason on its own — a
   * created record's own name legitimately appears in the list it lands in.
   */
  const typedValues: string[] = [];
  /*
   * One tag per exploration. Values the model marks with {{unique}} are expanded
   * with it before typing, and collapsed back to the token before storing — so
   * the journey records a template and every future replay creates fresh data.
   */
  const runTag = newRunTag();

  /*
   * Follow the documented path only as far as the LIVE screen agrees with it.
   *
   * Documentation is guidance, not a script. This prefix used to be replayed
   * blind — whatever the manual said, executed before the model had looked at
   * anything — so a renamed control or a reordered flow produced a journey that
   * had already wandered off course by the time reasoning began, and the run was
   * written off as "documentation stale" rather than simply explored.
   *
   * Now every hinted step must be VISIBLE on the current screen before it runs.
   * The moment the app stops matching the document, we stop replaying and hand
   * control to the model with whatever the live screen actually offers. That is
   * a normal handover, not a failure: the fast path is a shortcut when the docs
   * are right, and costs nothing when they are wrong.
   */
  const onScreen = (hinted: { action: string; role?: string; name?: string }) => {
    if (hinted.action === "navigate") return true; // judged by the safety gate, not the DOM
    const wanted = String(hinted.name ?? "").toLowerCase().trim();
    if (!wanted) return false;
    return snap.elements.some((e) => {
      const name = String(e.name || e.placeholder || e.text || "").toLowerCase().trim();
      return name === wanted && (!hinted.role || (e.role ?? "") === hinted.role);
    });
  };
  if (documentation?.executablePrefix.length) {
    await captureActionBaseline();
    for (const hinted of documentation.executablePrefix) {
      if (!onScreen(hinted)) {
        executionMismatch =
          `The documented step "${hinted.name ?? hinted.url ?? hinted.action}" is not on the current screen, ` +
          `so I stopped following the document and worked from what the app actually shows.`;
        emit("map.explore.step", { status: "ok", data: {
          index: steps.length + 1, tool: hinted.action, role: hinted.role, name: hinted.name,
          outcome: executionMismatch, elementCount: snap.elements.length,
          beforeUrl: snap.url, afterUrl: snap.url, source: "documentation", handedOverToModel: true,
        } });
        break;
      }
      const verdict = checkAction(hinted, { originAllowlist: [origin], allow: allowedActions });
      if (!verdict.allowed) {
        executionMismatch = `Documented prefix blocked: ${verdict.reason}`;
        emit("map.explore.step", { status: "error", error: executionMismatch, data: {
          index: steps.length + 1, tool: hinted.action, role: hinted.role, name: hinted.name,
          value: hinted.value, outcome: executionMismatch, elementCount: snap.elements.length,
          beforeUrl: snap.url, afterUrl: snap.url, source: "documentation",
        } });
        break;
      }
      const before = snap;
      const replay = await box.runProgram([hinted]);
      if (!replay.ok) {
        executionMismatch = `The documented step did not work on the live app (${replay.error ?? replay.log.at(-1) ?? "control failed"}), so I continued from the current screen instead.`;
        documentation.staleReasons.push(executionMismatch);
        emit("map.explore.step", { status: "error", error: executionMismatch, data: {
          index: steps.length + 1, tool: hinted.action, role: hinted.role, name: hinted.name,
          value: hinted.value, outcome: executionMismatch, elementCount: snap.elements.length,
          beforeUrl: snap.url, afterUrl: box.currentUrl(), source: "documentation",
        } });
        break;
      }
      snap = await box.snapshot();
      steps.push({
        ...hinted,
        fromUrl: before.url, toUrl: snap.url,
        fromFingerprint: fingerprintSnapshot(before), toFingerprint: fingerprintSnapshot(snap),
      });
      prefilledSteps++;
      emit("map.explore.step", { status: "ok", data: {
        index: steps.length, tool: hinted.action, role: hinted.role, name: hinted.name,
        value: hinted.value, outcome: replay.log.at(-1), elementCount: snap.elements.length,
        beforeUrl: before.url, afterUrl: snap.url, source: "documentation",
      } });
      await onProgress?.({
        currentStep: prefilledSteps, totalSteps: maxSteps,
        message: `Followed documented step: ${hinted.name ?? hinted.url ?? hinted.action}`,
        data: { source: "documentation", prefilledSteps, url: snap.url },
      });
    }
  }

  const briefing = await knowledgeBriefing(goal, knowledge);

  const system = `You are learning how to use "${productName}" by actually doing a task in it.

YOUR TASK: ${goal}
${briefing}
${humanInstruction ? `\nHUMAN REVIEWER INSTRUCTION — follow this exactly unless a safety rule blocks it:\n${humanInstruction}\n` : ""}
${documentation ? `
WHAT THE PRODUCT'S DOCUMENTATION SAYS ABOUT THIS TASK — background, not instructions:
${documentation.procedure.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}
Prerequisites it mentions: ${documentation.procedure.prerequisites.join("; ") || "none stated"}
Source: ${documentation.procedure.citation.title} > ${documentation.procedure.citation.section}, paragraphs ${documentation.procedure.citation.paragraphStart}-${documentation.procedure.citation.paragraphEnd}
${documentation.procedure.successMessage
  ? `The document says you may see "${documentation.procedure.successMessage}" on success. Treat that as a hint about what to look for, NOT as something you must produce: if the app shows different wording, quote what the app actually shows.`
  : "The document promises no particular success text."}
${prefilledSteps ? `${prefilledSteps} documented step(s) matched the live screen and have already been carried out for you.` : ""}
${executionMismatch ? `NOTE: ${executionMismatch}` : ""}

HOW TO USE THAT DOCUMENTATION:
- Use it to understand what the feature is FOR, what it is called, what has to be true first,
  and roughly where it lives. That is the part documents are reliable for.
- Do NOT follow it as a script. Documents go out of date, are written for a different plan or
  role, and often describe a version of the UI that no longer exists.
- Decide every action from the CURRENT screen. If a step names a control you cannot see in the
  Controls list, it is not available to you — look for what the app does offer instead.
- Where the document and the live screen disagree, the live screen is right. Say so and adapt.
- Never invent a step, a control, a label or a confirmation message because the document implies
  one should exist. Only act on things you can actually see.
` : ""}

Before acting, decide what observable state would prove this exact goal. Do it using the controls on
screen, one action at a time, then call done() with the matching proof type. A changed page is not enough
unless it is the page the goal asked for.

Use screen_reached/url_changed for navigation; result_set_changed for search/filter; order_changed for
sorting; record_created/field_changed for writes; and text only for a new, stable confirmation. For text
proof, quote exact on-screen text that appears only AFTER success.

Never claim a customer-created record is a product capability. If a goal requires selecting a record,
use a generic record only when the selector can be parameterised; otherwise call give_up.

The proof text must be STABLE. Never quote counts, totals, dates, timestamps or other numbers that other
users or time can change (e.g. "Favorite Article (2196)") — quote the wording around them instead.

CREATING something? Put the token {{unique}} inside any NAME, CODE or REFERENCE you invent for it —
e.g. "Acme {{unique}}" or "REF-{{unique}}". It is replaced with a fresh value on every run, which is what
lets this journey be replayed: without it the second run either re-finds the first run's record (so the
proof was already on screen and proves nothing) or is rejected as a duplicate. Do NOT use it in values
you are SELECTING from existing data, or in search terms meant to match what is already there.

Rules:
- Use only ids listed in Controls.
- Do not delete anything, log out, or open billing/account settings.
- If the task is impossible here, call give_up.
- Prefer the shortest path a real user would take.
${
  knownScreens.length
    ? `\nOther screens in this product (use go_to_screen if the task belongs on one of them):\n${knownScreens
        .map((s) => `- ${s.title} → ${s.url}`)
        .join("\n")}`
    : ""
}`;

  const messages: NMessage[] = [
    { role: "user", blocks: [{ type: "text", text: `Starting screen:\n${screenText(snap)}` }, { type: "image", b64png: snap.screenshot }] },
  ];

  while (budget.consume()) {
    await onProgress?.({ currentStep: budget.spent, totalSteps: maxSteps, message: "Choosing the next safe action", data: { url: box.currentUrl(), recordedSteps: steps.length } });
    const res = await model.step(system, messages, TOOLS).catch(() => ({ texts: [], toolCalls: [], done: true }));
    modelTurns++;
    messages.push({
      role: "assistant",
      blocks: [
        ...res.texts.map((t) => ({ type: "text", text: t }) as NBlock),
        ...res.toolCalls.map((c) => ({ type: "tool_call", id: c.id, name: c.name, args: c.args }) as NBlock),
      ],
    });
    if (!res.toolCalls.length) {
      const reason = "explorer stopped without acting";
      return complete({ failure: reason, diagnostic: {
        stage: "exploration", category: "unknown", reason, retryable: true,
        beforeUrl: box.startUrl, afterUrl: box.currentUrl(), capturedAt: new Date().toISOString(),
      } });
    }

    const results: NBlock[] = [];
    for (const call of res.toolCalls) {
      const a = call.args ?? {};

      if (call.name === "give_up") {
        const reason = String(a.reason ?? "gave up");
        return complete({ failure: reason, diagnostic: {
          stage: "exploration", category: failureCategory(reason), reason, retryable: true,
          beforeUrl: box.startUrl, afterUrl: box.currentUrl(), capturedAt: new Date().toISOString(),
        } });
      }

      if (call.name === "done") {
        /*
         * What the MODEL observed outranks what the document promised.
         *
         * The documented success message used to override the model's own
         * postcondition outright, and force the proof kind to "text" with it.
         * That is documentation-as-script: it asserts a string the manual
         * predicts rather than one the product displayed, and when the product
         * had been reworded — which is most of the time, or the document would
         * not need updating — a journey that genuinely worked was failed and
         * filed as stale documentation.
         *
         * The document is still useful here, as a FALLBACK when the model
         * offered nothing, and as a hint in the prompt about what to look for.
         */
        const documentedProof = documentation?.procedure.successMessage?.trim();
        const observedProof = String(a.postcondition ?? "").trim();
        const post = observedProof || documentedProof || "";
        const evidence = buildEvidenceContract({
          goal, steps, requestedProof: String(a.proof ?? ""), postcondition: post, finalSnapshot: snap,
        });
        evidence.expectedFingerprint = fingerprintSnapshot(snap);
        const proof = evidence.kind;
        const needsText = ["text", "record_created", "field_changed"].includes(proof);
        if (needsText && !post) {
          emit("map.explore.proof", { status: "error", error: `${proof} requires exact observed proof text`, data: {
            proposedPostcondition: post, proofType: proof, accepted: false,
            rejectionReason: `${proof} requires exact observed proof text`, candidatesOffered: [],
          } });
          results.push({ type: "tool_result", id: call.id, text: `REJECTED: ${proof} requires exact observed proof text.` });
          continue;
        }
        /*
         * Validate the proposal against what is ACTUALLY on the page now, not
         * just against the baseline. The old check only asked "was this text
         * already here?", so any string the model invented or assembled from its
         * own inputs sailed through and died 20s later in verification — or,
         * worse, was recorded as broken when the journey had really worked.
         *
         * On rejection we hand back the observed candidates, so the model picks
         * from evidence instead of guessing again.
         */
        if (needsText) {
          const ctx = {
            before: [textAtAction ?? "", textAtStart].join("\n"),
            after: await box.visibleText(PROOF_TEXT_LIMIT),
            typedValues,
            overlayText: await box.overlayText(),
          };
          const verdict = validateProof(post, ctx);
          if (!verdict.ok) {
            emit("map.explore.proof", { status: "error", error: verdict.reason, data: {
              proposedPostcondition: post, proofType: proof, accepted: false,
              rejectionReason: verdict.reason, candidatesOffered: verdict.candidates ?? [],
            } });
            /*
             * A document's promised text failing to appear is NOT a dead end.
             *
             * This used to end the job outright as `documentation_stale`, which
             * treated the manual as the authority on what the product does. It
             * is not: the wording may simply have changed. Fall through to the
             * same retry the model gets for any other bad proof — it is handed
             * the text that actually appeared and picks from that.
             */
            const offer = verdict.candidates?.length
              ? `\n\nText that appeared ONLY after your actions — quote one of these verbatim:\n${verdict.candidates
                  .map((c) => `  · ${c}`)
                  .join("\n")}`
              : `\n\nNothing new appeared on the page, so the task did not visibly succeed: call give_up instead.`;
            results.push({ type: "tool_result", id: call.id, text: `REJECTED: ${verdict.reason}${offer}` });
            continue;
          }
        }
        /*
         * Store the proof as a TEMPLATE too. It was chosen from observed text,
         * which contains this run's expanded value — keeping that verbatim would
         * pin the journey to the single record this exploration happened to
         * create, and the next replay could never satisfy it.
         */
        const postStored = collapse(post, runTag);
        if (evidence.expectedText) evidence.expectedText = collapse(evidence.expectedText, runTag);
        const candidate: Journey = {
          id: "",
          goal,
          capability: String(a.capability ?? goal),
          entities: a.entity ? [String(a.entity)] : [],
          preconditions: [],
          startUrl: box.startUrl,
          steps,
          postcondition: postStored || evidence.expectedTitle || evidence.expectedUrl || goal,
          proof,
          evidence,
          status: "unverified",
          reliability: 0,
          attempts: 0,
          documentation: documentation ? {
            ...structuredClone(documentation), prefilledSteps, executionMismatch,
          } : undefined,
        };
        candidate.preconditions = documentation?.procedure.prerequisites ?? [];
        const alignment = validateGoalAlignment(candidate);
        if (!alignment.ok) {
          const reason = alignment.reason ?? "actions and evidence do not prove the requested goal";
          emit("map.explore.proof", { status: "error", error: reason, data: {
            proposedPostcondition: post, proofType: proof, accepted: false,
            rejectionReason: reason, candidatesOffered: [],
            attempt: alignmentRejections + 1, retryable: alignmentRejections + 1 < MAX_ALIGNMENT_REJECTIONS,
          } });
          alignmentRejections++;
          if (alignmentRejections < MAX_ALIGNMENT_REJECTIONS) {
            /*
             * Say what is missing, not just that something is. The judge
             * compares the goal's terms against the terms in the actions and
             * evidence, so the actionable instruction is always "act on
             * something the goal actually names".
             */
            const guidance = alignment.category === "proof_inconclusive"
              ? `Choose the proof type that matches the goal, and take whatever action that proof requires before calling done().`
              : `Nothing you did or quoted mentions the goal "${goal}". Do not call done() yet — take an action on a control whose name relates to the goal, then quote evidence from the resulting screen.`;
            results.push({ type: "tool_result", id: call.id, text: `REJECTED: ${reason}\n\n${guidance}` });
            continue;
          }
          return complete({ failure: reason, diagnostic: {
            stage: "exploration", category: alignment.category ?? "goal_mismatch", reason, retryable: false,
            beforeUrl: box.startUrl, afterUrl: box.currentUrl(), afterFingerprint: fingerprintSnapshot(snap),
            capturedAt: new Date().toISOString(),
          } });
        }
        emit("map.explore.proof", { status: "ok", data: {
          proposedPostcondition: post, proofType: proof, accepted: true,
          rejectionReason: undefined, candidatesOffered: [],
        } });
        return complete({
          journey: candidate,
          metrics: { modelTurns, prefilledSteps },
        });
      }

      if (call.name === "go_to_screen") {
        const url = String(a.url ?? "");
        const verdict = checkAction({ action: "navigate", url }, { originAllowlist: [origin] });
        if (!verdict.allowed) {
          emit("map.explore.step", { status: "error", error: verdict.reason, data: {
            index: steps.length + 1, tool: "go_to_screen", name: url,
            outcome: `BLOCKED — ${verdict.reason}`, elementCount: snap.elements.length,
            beforeUrl: snap.url, afterUrl: snap.url,
          } });
          results.push({ type: "tool_result", id: call.id, text: `BLOCKED — ${verdict.reason}` });
          continue;
        }
        const before = snap;
        await box.goto(url);
        snap = await box.snapshot();
        steps.push({
          action: "navigate", url,
          fromUrl: before.url, toUrl: snap.url,
          fromFingerprint: fingerprintSnapshot(before), toFingerprint: fingerprintSnapshot(snap),
        });
        emit("map.explore.step", { status: "ok", data: {
          index: steps.length, tool: "go_to_screen", role: undefined, name: url,
          value: undefined, outcome: `opened ${url}`, elementCount: before.elements.length,
          beforeUrl: before.url, afterUrl: snap.url,
        } });
        results.push({ type: "tool_result", id: call.id, text: `opened ${url}\n${screenText(snap, before)}`, imageB64png: snap.screenshot });
        await onProgress?.({ currentStep: budget.spent, totalSteps: maxSteps, message: `Opened known screen ${snap.title || snap.url}`, data: { action: "navigate", url: snap.url, recordedSteps: steps.length } });
        continue;
      }

      const el = snap.elements.find((e) => e.id === Number(a.id));
      if (!el) {
        const outcome = `No element ${a.id} on this screen.`;
        emit("map.explore.step", { status: "error", error: outcome, data: {
          index: steps.length + 1, tool: call.name, value: a.value, outcome,
          elementCount: snap.elements.length, beforeUrl: snap.url, afterUrl: snap.url,
        } });
        results.push({ type: "tool_result", id: call.id, text: outcome });
        continue;
      }
      // The first interaction defines "before" for proof purposes.
      await captureActionBaseline();
      // Record the product's own test hook alongside role+name. Replay prefers
      // it, which is what keeps a step working when the label is account data.
      const selector = {
        role: el.role || el.tag,
        name: el.name || el.placeholder || el.text,
        ...(el.testId ? { testId: el.testId } : {}),
      };

      // A link that leaves the product is a dead end: the explorer lands on a
      // marketing site and can never finish the job. Origin was only enforced
      // for `navigate` — links need the same guard.
      if (el.href) {
        let dest: string | null = null;
        try {
          dest = new URL(el.href, snap.url).origin;
        } catch {
          dest = null;
        }
        if (dest && dest !== origin) {
          const reason = `"${selector.name}" leaves the product for ${dest}`;
          emit("safety.block", { status: "error", error: reason, data: {
            refusedAction: call.name, role: selector.role, name: selector.name,
            value: a.value, url: el.href, reason,
          } });
          emit("map.explore.step", { status: "error", error: reason, data: {
            index: steps.length + 1, tool: call.name, role: selector.role, name: selector.name,
            value: a.value, outcome: `BLOCKED — ${reason}`, elementCount: snap.elements.length,
            beforeUrl: snap.url, afterUrl: snap.url,
          } });
          results.push({
            type: "tool_result",
            id: call.id,
            text: `BLOCKED — "${selector.name}" leaves the product for ${dest}. Stay inside the app.`,
          });
          continue;
        }
      }

      // Structural safety gate — refuse at the execution layer, not in the prompt.
      const verdict = checkAction({ action: call.name, ...selector, value: String(a.value ?? "") }, {
        originAllowlist: [origin],
        allow: allowedActions,
      });
      if (!verdict.allowed) {
        emit("map.explore.step", { status: "error", error: verdict.reason, data: {
          index: steps.length + 1, tool: call.name, role: selector.role, name: selector.name,
          value: a.value, outcome: `BLOCKED — ${verdict.reason}`, elementCount: snap.elements.length,
          beforeUrl: snap.url, afterUrl: snap.url,
        } });
        results.push({ type: "tool_result", id: call.id, text: `BLOCKED — ${verdict.reason}. Choose a different action.` });
        continue;
      }

      let outcome = "";
      const before = snap;
      let recorded: JourneyStep | undefined;
      if (call.name === "click") {
        outcome = await box.clickElement(el.id);
        recorded = { action: "click", ...selector };
      } else if (call.name === "fill") {
        const template = String(a.value ?? "");
        const typed = expand(template, runTag); // what actually goes into the field
        outcome = await box.typeText(el.id, typed, Boolean(a.submit));
        // Store the TEMPLATE, not what we typed, so replay makes new data.
        recorded = { action: "fill", ...selector, value: template, submit: Boolean(a.submit) };
        if (typed) typedValues.push(typed);
      } else if (call.name === "select") {
        outcome = await box.selectOptionById(el.id, String(a.value ?? ""));
        recorded = { action: "select", ...selector, value: String(a.value ?? "") };
      }

      // Self-recover if an action still took us off-product (JS redirects,
      // target=_blank, etc). Without this the run is unrecoverably lost.
      if (!box.currentUrl().startsWith(origin)) {
        await box.gotoStart();
        outcome += ` — that left the product, so I returned to the start screen.`;
        steps.length = 0; // the recorded path is no longer replayable; start over
        recorded = undefined;
      }

      snap = await box.snapshot();
      if (recorded) {
        Object.assign(recorded, {
          fromUrl: before.url, toUrl: snap.url,
          fromFingerprint: fingerprintSnapshot(before), toFingerprint: fingerprintSnapshot(snap),
        });
        /*
         * A click that only dismissed something is not part of the journey.
         *
         * First-run chrome — a tour, a "Got it" dialog, a cookie banner — is
         * present exactly once. Recording it as a required step produced
         * journeys that verified on the run that created them and could never
         * replay afterwards, because the dialog was gone. The tell is precise:
         * the control BELONGED to an overlay, and clicking it did not move the
         * route. Anything that navigates, or that sits on the page proper, is a
         * real step and stays required.
         */
        if (recorded.action === "click" && el.overlay && before.url === snap.url) {
          recorded.optional = true;
        }
        steps.push(recorded);
      }
      emit("map.explore.step", {
        status: /^(No element|Action failed|Could not|NOT_FOUND|error:)/i.test(outcome) ? "error" : "ok",
        error: /^(No element|Action failed|Could not|NOT_FOUND|error:)/i.test(outcome) ? outcome : undefined,
        data: {
          index: recorded ? steps.length : steps.length + 1, tool: call.name,
          role: selector.role, name: selector.name, value: a.value, outcome,
          elementCount: before.elements.length, beforeUrl: before.url, afterUrl: snap.url,
        },
      });
      results.push({ type: "tool_result", id: call.id, text: `${outcome}\n${screenText(snap, before)}`, imageB64png: snap.screenshot });
      await onProgress?.({
        currentStep: budget.spent, totalSteps: maxSteps,
        message: recorded ? `${recorded.action} ${recorded.name ?? recorded.url ?? "screen"}` : outcome,
        data: { action: recorded?.action, role: recorded?.role, control: recorded?.name, url: snap.url, recordedSteps: steps.length },
      });
    }
    // Keep context small: only the newest screenshot survives. Drop stale image
    // blocks entirely — blanking the base64 produces an invalid data URL.
    messages.forEach((m) => {
      m.blocks = m.blocks.map((b) =>
        b.type === "image" ? ({ type: "text", text: "[earlier screenshot omitted]" } as NBlock) : b,
      );
      m.blocks.forEach((b) => {
        if (b.type === "tool_result") b.imageB64png = undefined;
      });
    });
    messages.push({ role: "user", blocks: results });
  }
  const reason = `budget exhausted after ${budget.spent} steps`;
  return complete({ failure: reason, diagnostic: {
    stage: "exploration", category: "timeout", reason, retryable: true,
    beforeUrl: box.startUrl, afterUrl: box.currentUrl(), capturedAt: new Date().toISOString(),
  } });
}
