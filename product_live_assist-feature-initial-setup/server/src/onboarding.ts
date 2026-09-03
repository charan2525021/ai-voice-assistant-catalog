import { LiveBox } from "./livebox.js";
import { BrainStore, brainFor } from "./knowledge/store.js";
import { ingestContent } from "./knowledge/ingest.js";
import { loadGraph, saveGraph, journeysToFlows } from "./mapper/graph.js";
import { surveyProductDetailed } from "./mapper/cartographer.js";
import { proposeJobsDetailed, type PlanningResult } from "./mapper/planner.js";
import { exploreJob } from "./mapper/explorer.js";
import { isJourneyMachineVerified, isJourneyPublishable, verifyJourneyRepeatedly } from "./mapper/verifier.js";
import { prepareJourneyRevision } from "./mapper/journey-review.js";
import { describeMeaning, describeSteps } from "./mapper/semanticist.js";
import { minimizeJourney } from "./mapper/minimize.js";
import { deriveComposition, pruneJourneys } from "./mapper/compose.js";
import { buildTaxonomy } from "./mapper/taxonomy.js";
import { CONTENT_ROOT, getProduct, setStatus, type ProductRecord } from "./products.js";
import { emit, trace } from "./events.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { cacheKey, readCache, writeCache } from "./tts/cache.js";
import { providerFor, synthesizeChunk, ttsEnabled } from "./tts/provider.js";
import { splitForSpeech } from "./tts/engine.js";
import { config } from "./config.js";
import type { Journey, PlannedJourneyJob, ProductGraph, TrainingRunMetric } from "./mapper/types.js";
import { probeJourneyCoverage } from "./mapper/coverage-prober.js";
import { assessProductAccess } from "./access.js";

/**
 * Onboarding a product, end to end.
 *
 * Two phases, deliberately separate:
 *   PREFLIGHT  — cheap, seconds. Does the URL load? Does it need a login? Do the
 *                supplied credentials actually work? Answering this up front is
 *                what stops the old failure mode where the mapper happily
 *                catalogued a LOGIN PAGE and reported success.
 *   ONBOARD    — minutes. Ingest docs, then autonomously map and verify journeys.
 *
 * Both are product-scoped: nothing here reads a global "current product".
 */

export interface PreflightResult {
  ok: boolean;
  reachable: boolean;
  title?: string;
  needsLogin: boolean;
  loggedIn: boolean;
  screens?: number;
  controls?: number;
  message: string;
}

/** An access failure is operational, not a mapper/model failure. */
export class TrainingAccessError extends Error {
  readonly code = "AUTH_REQUIRED";
}

export async function preflight(rec: ProductRecord): Promise<PreflightResult> {
  const box = new LiveBox({ startUrl: rec.startUrl, auth: rec.auth });
  try {
    await box.start(); // start() navigates and attempts login if configured
    const snap = await box.snapshot();
    const requiresAuthentication = rec.auth.mode === "session" || rec.auth.mode === "profile";
    const access = assessProductAccess(rec.startUrl, snap, requiresAuthentication);
    const needsLogin = access.authenticationSurface || rec.auth.mode !== "none";
    const loggedIn = access.ok && !access.authenticationSurface;

    if (!access.ok && access.reachable) {
      return {
        ok: false,
        reachable: true,
        title: snap.title,
        needsLogin: true,
        loggedIn: false,
        controls: snap.elements.length,
        message: access.message,
      };
    }

    if (!access.reachable) return { ok: false, reachable: false, needsLogin: false, loggedIn: false, message: access.message };
    // A page with nothing to click cannot be mapped. Usually it means the app is
    // still rendering, is behind a redirect, or blocked us.
    if (snap.elements.length === 0) {
      return {
        ok: false,
        reachable: true,
        title: snap.title,
        needsLogin,
        loggedIn,
        controls: 0,
        message:
          `Loaded ${snap.url} but found no interactive controls — the app may still be rendering, ` +
          `may need a different entry URL, or may be blocking automated browsers. Try the URL you'd give a new user.`,
      };
    }
    return {
      ok: true,
      reachable: true,
      title: snap.title,
      needsLogin,
      loggedIn,
      controls: snap.elements.length,
      message: `Reachable${needsLogin ? " and signed in" : ""} — "${snap.title || snap.url}" with ${snap.elements.length} controls.`,
    };
  } catch (e) {
    return { ok: false, reachable: false, needsLogin: false, loggedIn: false, message: `Preflight error: ${(e as Error).message}` };
  } finally {
    await box.stop().catch(() => {});
  }
}

export interface OnboardOptions {
  maxJobs?: number;
  maxScreens?: number;
  log?: (line: string) => void;
  /** Durable callers keep the working graph in the job checkpoint, not files. */
  initialGraph?: ProductGraph;
  persistGraph?: (graph: ProductGraph) => Promise<void>;
  durable?: boolean;
  /** Tenant-scoped planner corpus supplied by the durable worker. */
  knowledgeStore?: BrainStore;
  demand?: string[];
  targetedJobs?: { goal: string; why: string; instruction?: string; source?: "human_rework" | "manual" }[];
  skipSurvey?: boolean;
  skipExistingVerification?: boolean;
  progress?: (event: TrainingProgressEvent) => void | Promise<void>;
}

export interface TrainingProgressEvent {
  stage: "access_check" | "ingesting" | "surveying" | "planning" | "exploring" | "verifying" | "review" | "complete";
  journeyGoal?: string;
  journeyStatus?: "planned" | "exploring" | "candidate" | "verifying" | "machine_passed" | "failed" | "awaiting_review";
  currentStep?: number;
  totalSteps?: number;
  message: string;
  data?: Record<string, unknown>;
}

/**
 * Full catalogue run for ONE product: ingest content, survey, plan, explore,
 * verify, minimise, narrate, group, then publish only VERIFIED journeys into
 * that product's Brain.
 */
export async function onboardProduct(rec: ProductRecord, opts: OnboardOptions = {}) {
  /*
   * Tracing lives HERE, not at the HTTP route.
   *
   * It used to wrap `startOnboardingJob` inside `server.ts` only, so the single
   * traced entry point was `POST /api/products/:id/onboard`. Every CLI path —
   * `npm run product:onboard`, `npm run map:learn`, the ones the docs actually
   * tell a maintainer to use — ran completely untraced and produced no events at
   * all, while the event log claims to be the system of record. Wrapping the
   * pipeline itself covers both callers and cannot be forgotten by a new one.
   */
  return trace(rec.id, "mapping", "map.run", {
    maxJobs: opts.maxJobs ?? Number(process.env.MAPPING_MAX_JOBS ?? 30),
    maxScreens: opts.maxScreens ?? Number(process.env.MAPPING_MAX_SCREENS ?? 50),
  }, () =>
    runOnboarding(rec, opts),
  );
}

async function runOnboarding(rec: ProductRecord, opts: OnboardOptions = {}) {
  const log = opts.log ?? (() => {});
  const maxJobs = opts.maxJobs ?? Number(process.env.MAPPING_MAX_JOBS ?? 30);
  const maxScreens = opts.maxScreens ?? Number(process.env.MAPPING_MAX_SCREENS ?? 50);
  const target = { startUrl: rec.startUrl, auth: rec.auth, allowActions: rec.allowActions };
  const progress = async (event: TrainingProgressEvent) => {
    await opts.progress?.(event);
    emit(`training.${event.stage}`, {
      product: rec.id,
      status: event.journeyStatus === "failed" ? "error" : "ok",
      data: {
        journeyGoal: event.journeyGoal, journeyStatus: event.journeyStatus,
        currentStep: event.currentStep, totalSteps: event.totalSteps,
        message: event.message, ...event.data,
      },
    });
  };

  // Access is a hard prerequisite, not a journey the agent should try to solve.
  // Run this for every caller (HTTP, CLI and durable worker) before reading docs,
  // planning, spending model tokens or touching the existing graph.
  await progress({ stage: "access_check", message: "Checking that the saved sign-in replays inside the training browser" });
  const access = await preflight(rec);
  if (!access.ok) {
    await setStatus(rec.id, "preflight_failed", access.message);
    throw new TrainingAccessError(access.message);
  }

  // ---- 1. Content → Brain (docs are what stop Aidan inventing features) ----
  await setStatus(rec.id, "ingesting", "Reading product content…");
  await progress({ stage: "ingesting", message: "Reading and indexing product knowledge" });
  const kb = opts.knowledgeStore ?? (opts.durable ? new BrainStore(rec.id) : await brainFor(rec.id));
  if (!opts.durable) await ingestContent(path.join(CONTENT_ROOT, rec.id), kb);
  log(`ingested ${kb.docs.length} doc chunk(s)`);

  // ---- 2. Autonomous catalogue ----
  await setStatus(rec.id, "mapping", "Mapping product journeys…", { docChunks: kb.docs.length });
  const graph = opts.initialGraph ? structuredClone(opts.initialGraph) : await loadGraph(rec.id, rec.startUrl);
  const persistGraph = opts.persistGraph ?? saveGraph;
  graph.product = rec.id;
  graph.startUrl = rec.startUrl;

  if (!opts.skipSurvey || !graph.screens.length) {
    await progress({ stage: "surveying", message: "Discovering product screens and controls" });
    const surveyBox = new LiveBox(target);
    try {
      await surveyBox.start();
      const survey = await surveyProductDetailed(surveyBox, rec.startUrl, maxScreens);
      graph.screens = survey.screens;
      graph.survey = {
        visits: survey.visits,
        maxVisits: survey.maxVisits,
        frontierRemaining: survey.frontierRemaining,
        stopReason: survey.stopReason,
      };
    } finally {
      await surveyBox.stop().catch(() => {});
    }
  }
  log(`mapped ${graph.screens.length} screen(s): ${graph.screens.map((s) => s.title).join(" | ")}`);
  await persistGraph(graph);

  /*
   * Re-check what we already believe before learning anything new.
   *
   * A journey's "verified" badge was permanent once earned, so it survived both
   * UI drift in the customer's product AND any bug fix in the gate itself. Both
   * happened here: three OrangeHRM journeys stayed "verified" across a re-map
   * even though a corrected verifier rejects all three. A stale badge is worse
   * than no badge — it is what puts a broken walkthrough in front of a prospect.
   */
  /*
   * One browser for every verification in this run.
   *
   * Each verifyJourney() used to launch its own Chromium and sign in again —
   * measured at p50 17.6s / p95 25.6s per journey, almost all of it startup, and
   * re-verification now doubles the number of attempts. resetState() already
   * restores a clean data state between journeys, which is the property that
   * actually matters.
   */
  /*
   * ...but NOT when the product uses a real Chrome profile.
   *
   * Every LiveBox in profile mode opens the same on-disk profile directory, and
   * Chrome allows exactly one browser per profile. Holding this verification
   * browser open for the whole run therefore blocked the per-job exploration
   * browser below: Chrome saw the directory was taken, handed off to the running
   * instance and exited (code 21), which Playwright reports as "Target page,
   * context or browser has been closed". Survey succeeded (nothing else open)
   * and then every single exploration failed.
   *
   * Sharing is an optimisation; correctness wins. In profile mode each
   * verification opens its own browser, exactly as it did before the shared box
   * existed — slower, but it is the only arrangement the profile lock permits.
   */
  const sharesOneProfile = rec.auth?.mode === "profile";
  const verifyBox = sharesOneProfile ? null : new LiveBox(target);
  if (verifyBox) await verifyBox.start();
  /** One exploration browser for the whole run — see the loop below for why. */
  const exploreBox = sharesOneProfile ? null : new LiveBox(target);
  if (exploreBox) await exploreBox.start();
  let exploreBoxClosed = false;
  const closeExploreBox = async () => {
    if (exploreBoxClosed || !exploreBox) return;
    exploreBoxClosed = true;
    await exploreBox.stop().catch((e) => console.warn(`[onboard] explore browser did not close: ${e.message}`));
  };
  process.once("beforeExit", closeExploreBox);
  const verifyRepeatedly = async (journey: Journey) => {
    const result = await verifyJourneyRepeatedly(journey, rec.startUrl, target, verifyBox ?? undefined);
    if (!result.ok && result.last.category === "permission_blocked") {
      throw new TrainingAccessError(result.detail);
    }
    return result;
  };
  // A mapping run that throws must not leave a Chromium behind; over a demo day
  // that is how a host runs out of memory.
  let verifyBoxClosed = false;
  const closeVerifyBox = async () => {
    if (verifyBoxClosed || !verifyBox) return;
    verifyBoxClosed = true;
    await verifyBox.stop().catch((e) => console.warn(`[onboard] verify browser did not close: ${e.message}`));
  };
  process.once("beforeExit", closeVerifyBox);

  try {

  const previously = opts.skipExistingVerification ? [] : graph.journeys.filter((j) => j.status === "verified");
  if (previously.length) {
    log(`re-checking ${previously.length} previously verified journey(s)…`);
    let demoted = 0;
    for (const j of previously) {
      const v = await verifyRepeatedly(j);
      if (!v.ok) {
        demoted++;
        log(`  ✗ demoted "${j.goal.slice(0, 50)}" — ${v.detail.slice(0, 90)}`);
      }
    }
    log(demoted ? `  ${demoted} no longer verified` : "  all still verified");
    if (demoted) await persistGraph(graph);
  }

  // Curriculum: real demo demand first, then what's still unlearned.
  const demand = [...new Set([
    ...(opts.demand ?? []),
    ...kb.sessions.flatMap((s) => [...(s.kbGaps ?? []), ...(s.frictionPoints ?? [])]),
  ])].slice(0, 12);
  const alreadyLearned = graph.journeys.filter((j) => j.status === "verified").map((j) => j.goal);
  const retry = graph.backlog.filter((b) => b.status === "failed").map((b) => b.goal);
  await progress({ stage: "planning", message: opts.targetedJobs?.length ? "Preparing requested journey rework" : "Planning journeys from observed product surfaces" });
  const plan: PlanningResult = opts.targetedJobs?.length
    ? {
        jobs: opts.targetedJobs as PlannedJourneyJob[], rejected: [],
        metrics: { mode: "exploration_only", documentCandidates: 0, safeDocumentCandidates: 0, plannedFromDocuments: 0, plannedFromUi: opts.targetedJobs.length, staleOrUngrounded: 0 },
      }
    : await proposeJobsDetailed(rec.name, graph.screens, maxJobs, {
        demand, alreadyLearned, retry, kb,
        // Tell the planner what the execution layer will refuse, so it doesn't spend
        // the job budget on tasks that get blocked (sign-up, login, deletes).
        hasCredentials: rec.auth.mode === "session" || rec.auth.mode === "profile" ||
          (rec.auth.mode === "login" && !!rec.auth.username),
        allowActions: rec.allowActions,
      });
  const jobs = plan.jobs;
  const metric: TrainingRunMetric = {
    id: randomUUID(), startedAt: new Date().toISOString(), ...plan.metrics,
    prefilledSteps: 0, explored: 0, machineVerified: 0, proofFailures: 0, documentationStaleFailures: 0,
  };
  graph.trainingMetrics ??= { runs: [] };
  graph.trainingMetrics.runs = [...graph.trainingMetrics.runs, metric].slice(-20);
  log(`planned ${jobs.length} job(s): ${jobs.map((j) => j.goal).join(" · ")}`);
  const previousFailures = new Map(graph.backlog.filter((item) => item.failure).map((item) => [item.goal, item.failure]));
  graph.backlog = [...jobs.map((j) => ({
    goal: j.goal,
    why: j.why,
    status: "pending" as const,
    failure: previousFailures.get(j.goal),
    instruction: j.instruction,
    source: j.source ?? (j.instruction ? "human_rework" : "planner"),
    documentation: j.documentation,
  })), ...plan.rejected.map((item) => ({
    goal: item.goal, why: item.why, status: "failed" as const, source: "documentation" as const,
    failure: {
      stage: "planning" as const, category: item.category, reason: item.why,
      retryable: item.category === "documentation_stale", capturedAt: new Date().toISOString(),
    },
  }))];

  for (const job of jobs) {
    log(`exploring "${job.goal}"…`);
    await progress({
      stage: "exploring", journeyGoal: job.goal, journeyStatus: "exploring",
      message: job.instruction ? `Reworking with reviewer instruction: ${job.instruction}` : "Exploring the journey",
    });
    /*
     * Reuse ONE exploration browser across jobs.
     *
     * Starting Chromium and signing in cost 6.1s on llmapi.ai, against 7.2s of
     * actual exploration for the job it served — nearly half the wall clock,
     * paid again for every job in the run. `exploreJob` opens with resetState(),
     * which restores a clean data state and is the property that actually
     * matters between jobs; a fresh process was never what provided isolation.
     *
     * Profile mode is excluded for the same reason the verification box is
     * (see above): Chrome permits one browser per profile directory, so a
     * long-lived box here would lock out everything else in the run.
     */
    const box = exploreBox ?? new LiveBox(target);
    let result;
    try {
      if (!exploreBox) await box.start();
      result = await exploreJob(
        box, rec.name, job.goal, rec.startUrl,
        graph.screens.map((s) => ({ title: s.title, url: s.url })),
        rec.allowActions, job.instruction,
        async (step) => progress({
          stage: "exploring", journeyGoal: job.goal, journeyStatus: "exploring",
          currentStep: step.currentStep, totalSteps: step.totalSteps,
          message: step.message, data: step.data,
        }),
        job.documentation,
        // Goal-scoped orientation: terminology, intent and prerequisites the
        // matched procedure alone does not carry.
        kb,
      );
    } finally {
      if (!exploreBox) await box.stop().catch(() => {});
    }
    metric.explored++;
    metric.prefilledSteps += result.metrics?.prefilledSteps ?? 0;
    if (!result.journey) {
      if (result.diagnostic?.category === "permission_blocked") {
        throw new TrainingAccessError(result.failure ?? "Product access was lost during exploration. Re-authenticate before mapping.");
      }
      log(`  ✗ ${result.failure}`);
      const b = graph.backlog.find((b) => b.goal === job.goal);
      if (b) {
        b.status = "failed";
        b.failure = result.diagnostic ?? {
          stage: "exploration",
          category: "unknown",
          reason: result.failure ?? "exploration failed without a reason",
          retryable: true,
          capturedAt: new Date().toISOString(),
        };
      }
      await persistGraph(graph);
      await progress({ stage: "exploring", journeyGoal: job.goal, journeyStatus: "failed", message: result.failure ?? "Exploration failed" });
      if (result.diagnostic?.category === "documentation_stale") metric.documentationStaleFailures++;
      if (["proof_missing", "proof_inconclusive", "documentation_stale"].includes(result.diagnostic?.category ?? "")) metric.proofFailures++;
      continue;
    }

    const journey = result.journey;
    journey.id = `journey-${graph.journeys.length}-${Date.now().toString(36)}`;
    await progress({
      stage: "verifying", journeyGoal: job.goal, journeyStatus: "verifying",
      totalSteps: journey.steps.length, message: "Replaying the candidate from a clean state",
    });
    const v = await verifyRepeatedly(journey);
    log(`  ${v.ok ? "✓ verified" : "✗ not verified"} — ${v.detail}`);
    if (v.ok) metric.machineVerified++;
    else {
      if (v.last.category === "documentation_stale") metric.documentationStaleFailures++;
      if (["proof_missing", "proof_inconclusive", "documentation_stale"].includes(v.last.category ?? "")) metric.proofFailures++;
    }

    if (v.ok) {
      if (journey.steps.length > 1) {
        const provenSteps = structuredClone(journey.steps);
        const minimized = await minimizeJourney(journey, rec.startUrl, { others: graph.journeys, target });
        if (minimized.changed) {
          const finalProof = await verifyRepeatedly(journey);
          if (!finalProof.ok) {
            journey.steps = provenSteps;
            const restored = await verifyRepeatedly(journey);
            if (!restored.ok) log(`  ! original path also failed after minimisation: ${restored.detail}`);
            else log("  ! rejected an unstable shortened path and restored the proven path");
          }
        }
      }
      let meaningError = "";
      journey.meaning = await describeMeaning(rec.name, journey, kb).catch((error) => {
        meaningError = (error as Error).message;
        return undefined;
      });
      // Per-step spoken lines — required for TTS to guide step by step.
      let narrationError = "";
      const says = await describeSteps(rec.name, journey).catch((error) => {
        narrationError = (error as Error).message;
        return [] as string[];
      });
      if (says.length === journey.steps.length) journey.steps.forEach((st, i) => (st.say = says[i]));
      const semanticsError = [meaningError, narrationError].filter(Boolean).join("; ");
      emit("map.semantics", { status: semanticsError ? "error" : "ok", error: semanticsError || undefined, data: {
        goal: journey.goal,
        meaning: journey.meaning,
        narrationLines: journey.steps.map((step) => step.say ?? ""),
      } });
      let coverageError = "";
      if (verifyBox) {
        journey.coverage = await probeJourneyCoverage(journey, graph, verifyBox).catch((error) => {
          coverageError = (error as Error).message;
          return undefined;
        });
      } else {
        // Profile mode has no shared browser to borrow, so open one just for the
        // probe. Safe here because nothing else holds the profile at this point,
        // and a failed probe must not fail an already-verified journey.
        const probeBox = new LiveBox(target);
        try {
          await probeBox.start();
          journey.coverage = await probeJourneyCoverage(journey, graph, probeBox);
        } catch (e) {
          coverageError = (e as Error).message;
        } finally {
          await probeBox.stop().catch(() => {});
        }
      }
      emit("map.coverage", {
        status: journey.coverage ? "ok" : "error",
        error: journey.coverage ? undefined : coverageError || "coverage probe produced no result",
        data: {
          goal: journey.goal,
          dimensions: Object.entries(journey.coverage ?? {}).map(([dimension, evidence]) => ({
            dimension,
            status: evidence.status,
            detail: evidence.detail,
            depth: evidence.depth,
            checkedAt: evidence.checkedAt,
          })),
        },
      });
    }

    const previous = graph.journeys.find((item) => item.goal === journey.goal);
    prepareJourneyRevision(
      journey,
      previous,
      job.source === "human_rework" ? "human_rework" : job.source === "documentation" ? "documentation" : previous ? "remap" : "autonomous",
    );
    graph.journeys = graph.journeys.filter((j) => j.goal !== journey.goal).concat(journey);
    const b = graph.backlog.find((b) => b.goal === job.goal);
    if (b) {
      b.status = isJourneyMachineVerified(journey) ? "done" : "failed";
      b.failure = isJourneyMachineVerified(journey) ? undefined : journey.failure;
    }
    await persistGraph(graph);
    await progress({
      stage: "review", journeyGoal: job.goal,
      journeyStatus: isJourneyMachineVerified(journey) ? "awaiting_review" : "failed",
      message: isJourneyMachineVerified(journey)
        ? `Machine verification passed; revision ${journey.revision} is awaiting human approval`
        : journey.failure?.reason ?? "Machine verification failed",
      data: { revision: journey.revision, checksum: journey.revisionChecksum },
    });
  }

  // ---- 2b. Pre-synthesise narration (T2) ----
  // Every per-step line is known NOW, so synthesise once here and the guided
  // walkthrough plays at zero latency and zero cost in every future demo.
  if (!opts.durable && ttsEnabled()) {
    const voice = rec.voice ?? {};
    const provider = providerFor(voice);
    /*
     * Measured: BOTH providers take ~4s for a short line, so pre-synthesis isn't
     * an optimisation — it's the only way voice feels responsive. Warm:
     *   1. every per-step narration line (the whole guided walkthrough)
     *   2. each journey's meaning
     *   3. the greeting + common conversational phrases, because the FIRST thing
     *      a user hears would otherwise stall for four seconds.
     */
    const verified = graph.journeys.filter(isJourneyPublishable);
    const lines = [
      `Hi! I'm ${config.assistantName}. I can walk you through ${rec.name} live — what would you like to see?`,
      "Sure, let me show you.",
      "Let me walk you through that.",
      "Done.",
      "Would you like me to continue?",
      "I'm not certain about that from what I have, so I'll flag it for follow-up rather than guess.",
      ...verified.flatMap((j) => j.steps.map((s) => s.say).filter(Boolean) as string[]),
      ...(verified.map((j) => j.meaning).filter(Boolean) as string[]),
    ];
    let made = 0;
    let cached = 0;
    for (const line of lines) {
      for (const chunk of splitForSpeech(line, provider.maxChars)) {
        const key = cacheKey(chunk, voice);
        if (await readCache(rec.id, key)) { cached++; continue; }
        try {
          const audio = await synthesizeChunk(chunk, voice);
          await writeCache(rec.id, key, audio);
          made++;
        } catch (e) {
          // Voice is an enhancement — never fail onboarding over it.
          log(`  ! could not pre-synthesise a line: ${(e as Error).message}`);
        }
      }
    }
    if (made || cached) log(`pre-synthesised narration: ${made} new, ${cached} already cached (voice=${provider.id}/${voice.speaker ?? provider.defaultSpeaker})`);
  }

  // ---- 3. Structure: prune, link prerequisites, group into capabilities ----
  pruneJourneys(graph);
  deriveComposition(graph);
  graph.capabilities = await buildTaxonomy(graph).catch(() => graph.capabilities);
  graph.builtAt = new Date().toISOString();
  metric.finishedAt = new Date().toISOString();
  metric.durationMs = Date.parse(metric.finishedAt) - Date.parse(metric.startedAt);
  await persistGraph(graph);

  // ---- 4. Stage candidates for review. Publication happens atomically only
  // after every machine-verified journey in this batch has human approval.
  const flows = journeysToFlows(graph);

  await closeExploreBox(); // exploration finished long before this point
  await closeVerifyBox(); // done replaying; release it before the slow publish steps
  const machineVerified = graph.journeys.filter(isJourneyMachineVerified).length;
  const verified = graph.journeys.filter(isJourneyPublishable).length;
  const releaseReady = machineVerified > 0 && verified === machineVerified;
  emit("map.publish", { status: "ok", data: {
    published: false,
    reason: releaseReady
      ? "all journeys are approved; the review release endpoint will publish atomically"
      : machineVerified > 0 ? "waiting for human approval" : "no machine-verified journeys",
    candidateFlows: flows.map((flow) => flow.name),
    flowCount: flows.length,
    executablePrograms: flows.filter((flow: any) => Array.isArray(flow.program) && flow.program.length > 0).length,
  } });
  const finalStatus = releaseReady ? "ready" : machineVerified > 0 ? "awaiting_review" : "failed";
  const finalMessage = releaseReady
    ? `Ready — ${verified} approved journey(s).`
    : machineVerified > 0
      ? `Training complete — ${machineVerified} machine-verified journey(s) await human approval.`
      : "No journey could be machine-verified.";
  await setStatus(rec.id, finalStatus, finalMessage, {
    docChunks: kb.docs.length,
    verifiedJourneys: verified,
  });
  await progress({ stage: "complete", message: finalMessage, data: { machineVerified, approved: verified } });
  log(`done: ${machineVerified} machine-verified, ${verified} approved journey(s), ${graph.capabilities.length} capability area(s)`);
  return { screens: graph.screens.length, journeys: graph.journeys.length, verified, machineVerified, capabilities: graph.capabilities.length, flows: releaseReady ? flows.length : 0, graph };
  } finally {
    await closeExploreBox();
    await closeVerifyBox();
  }
}

/** Background job tracking plus the live, human-controllable training state. */
interface TrainingJobState {
  runId: string;
  running: boolean;
  paused: boolean;
  cancelRequested: boolean;
  startedAt: string;
  updatedAt: string;
  stage: TrainingProgressEvent["stage"] | "idle";
  current?: TrainingProgressEvent;
  journeys: Record<string, TrainingProgressEvent & { updatedAt: string }>;
  lines: string[];
  error?: string;
  promise?: Promise<void>;
}
const jobs = new Map<string, TrainingJobState>();
const trainingListeners = new Map<string, Set<(state: ReturnType<typeof jobState>) => void>>();
const MAX_JOB_LINES = Number(process.env.MAX_MAPPING_JOB_LINES ?? 2000);

function appendJobLine(product: string, state: { lines: string[] }, line: string): void {
  console.log(`[onboard:${product}] ${line}`);
  state.lines.push(`${new Date().toISOString()}  ${line}`);
  if (state.lines.length > MAX_JOB_LINES) state.lines.splice(0, state.lines.length - MAX_JOB_LINES);
}

export function jobState(id: string) {
  const state = jobs.get(id);
  if (!state) return { running: false, paused: false, cancelRequested: false, stage: "idle" as const, lines: [], journeys: {} };
  const { promise: _promise, ...publicState } = state;
  return structuredClone(publicState);
}

function notifyTraining(product: string): void {
  const value = jobState(product);
  for (const listener of trainingListeners.get(product) ?? []) listener(value);
}

export function subscribeTraining(product: string, listener: (state: ReturnType<typeof jobState>) => void): () => void {
  const listeners = trainingListeners.get(product) ?? new Set();
  listeners.add(listener);
  trainingListeners.set(product, listeners);
  listener(jobState(product));
  return () => {
    listeners.delete(listener);
    if (!listeners.size) trainingListeners.delete(product);
  };
}

export function controlTrainingJob(product: string, action: "pause" | "resume" | "cancel"): ReturnType<typeof jobState> {
  const state = jobs.get(product);
  if (!state?.running) return jobState(product);
  if (action === "pause") state.paused = true;
  if (action === "resume") state.paused = false;
  if (action === "cancel") { state.cancelRequested = true; state.paused = false; }
  state.updatedAt = new Date().toISOString();
  notifyTraining(product);
  return jobState(product);
}

export function trainingJobPromise(product: string): Promise<void> {
  return jobs.get(product)?.promise ?? Promise.resolve();
}

/**
 * Starts the job and returns a promise for its completion. The API route does not
 * await it (it must answer immediately so the UI can poll), but returning the
 * promise lets the caller time and trace the real run — previously this returned
 * void, so any wrapper would have recorded a multi-minute mapping as 0ms.
 */
export function startOnboardingJob(rec: ProductRecord, opts: OnboardOptions = {}): Promise<void> {
  if (jobs.get(rec.id)?.running) return jobs.get(rec.id)!.promise ?? Promise.resolve();
  const now = new Date().toISOString();
  const state: TrainingJobState = {
    runId: randomUUID(), running: true, paused: false, cancelRequested: false,
    startedAt: now, updatedAt: now, stage: "idle", journeys: {}, lines: [], error: undefined,
  };
  jobs.set(rec.id, state);
  const waitForControl = async () => {
    while (state.paused && !state.cancelRequested) await new Promise((resolve) => setTimeout(resolve, 250));
    if (state.cancelRequested) throw new Error("training cancelled by reviewer");
  };
  state.promise = (async () => {
    try {
      await onboardProduct(rec, {
        ...opts,
        log: (line) => { appendJobLine(rec.id, state, line); notifyTraining(rec.id); },
        progress: async (event) => {
          await waitForControl();
          state.stage = event.stage;
          state.current = event;
          state.updatedAt = new Date().toISOString();
          if (event.journeyGoal) state.journeys[event.journeyGoal] = { ...event, updatedAt: state.updatedAt };
          await opts.progress?.(event);
          notifyTraining(rec.id);
        },
      });
    } catch (e) {
      state.error = (e as Error).message;
      appendJobLine(rec.id, state, `failed: ${state.error}`);
      if (!state.cancelRequested && !(e instanceof TrainingAccessError)) await setStatus(rec.id, "failed", state.error).catch(() => {});
    } finally {
      state.running = false;
      state.paused = false;
      state.updatedAt = new Date().toISOString();
      notifyTraining(rec.id);
    }
  })();
  notifyTraining(rec.id);
  return state.promise;
}
