import { LiveBox } from "../livebox.js";
import { config } from "../config.js";
import { brain as kb } from "../knowledge/store.js";
import { surveyProductDetailed } from "./cartographer.js";
import { proposeJobsDetailed } from "./planner.js";
import { exploreJob } from "./explorer.js";
import { isJourneyMachineVerified, isJourneyPublishable, verifyJourneyRepeatedly } from "./verifier.js";
import { prepareJourneyRevision } from "./journey-review.js";
import { describeMeaning, describeSteps } from "./semanticist.js";
import { loadGraph, saveGraph, journeysToFlows } from "./graph.js";
import { deriveComposition, pruneJourneys } from "./compose.js";
import { buildTaxonomy } from "./taxonomy.js";
import { minimizeJourney } from "./minimize.js";
import { emit, flushEvents } from "../events.js";

/**
 * Orchestrates the mapping pipeline:
 *   Cartographer → Planner → Explorer(×jobs) → Verifier → Semanticist → Graph
 * Only VERIFIED journeys are committed.
 */
async function learn(maxJobs: number, maxScreens: number) {
  await kb.load();
  const startUrl = config.demo.startUrl;
  const name = config.demo.name;
  const graph = await loadGraph();
  graph.product = config.product;
  graph.startUrl = startUrl;

  console.log(`\n=== Learning "${name}" (${startUrl}) ===\n`);

  // 1) Cartographer — cheap surface map, read-only
  console.log("① Cartographer: surveying screens…");
  const box = new LiveBox();
  await box.start();
  let survey;
  try {
    survey = await surveyProductDetailed(box, startUrl, maxScreens);
  } finally {
    await box.stop().catch(() => {});
  }
  const screens = survey.screens;
  graph.screens = screens;
  graph.survey = {
    visits: survey.visits, maxVisits: survey.maxVisits,
    frontierRemaining: survey.frontierRemaining, stopReason: survey.stopReason,
  };
  console.log(`   ${screens.length} screen(s): ${screens.map((s) => s.title).join(" | ")}`);

  // 2) Curriculum Planner — what jobs should we learn?
  //    THE FLYWHEEL: unanswered questions and friction from real demos become
  //    the exploration curriculum, so the mapper learns what prospects ask for.
  const demand = [
    ...new Set(kb.sessions.flatMap((s) => [...(s.kbGaps ?? []), ...((s as any).frictionPoints ?? [])])),
  ].slice(0, 12);
  const alreadyLearned = graph.journeys.filter((j) => j.status === "verified").map((j) => j.goal);
  const retry = graph.backlog.filter((b) => b.status === "failed").map((b) => b.goal);

  console.log("\n② Planner: proposing jobs to learn…");
  if (demand.length) console.log(`   (curriculum informed by ${demand.length} real demo signal(s))`);
  const plan = await proposeJobsDetailed(name, screens, maxJobs, { demand, alreadyLearned, retry, kb, allowActions: config.allowActions });
  const jobs = plan.jobs;
  jobs.forEach((j, i) => console.log(`   ${i + 1}. ${j.goal}`));
  graph.backlog = [...jobs.map((j) => ({ goal: j.goal, why: j.why, status: "pending" as const, source: j.source, documentation: j.documentation })),
    ...plan.rejected.map((item) => ({
      goal: item.goal, why: item.why, status: "failed" as const, source: "documentation" as const,
      failure: { stage: "planning" as const, category: item.category, reason: item.why, retryable: true, capturedAt: new Date().toISOString() },
    }))];

  // 3+4) Explorer → Verifier, one job at a time (each in a clean box)
  for (const job of jobs) {
    console.log(`\n③ Explorer: attempting "${job.goal}"…`);
    const exBox = new LiveBox();
    let result;
    try {
      await exBox.start();
      result = await exploreJob(
        exBox, name, job.goal, startUrl,
        graph.screens.map((s) => ({ title: s.title, url: s.url })),
        config.allowActions, undefined, undefined, job.documentation,
        kb, // goal-scoped orientation, same as the onboarding path
      );
    } finally {
      await exBox.stop().catch(() => {});
    }

    if (!result.journey) {
      console.log(`   ✗ could not learn: ${result.failure}`);
      const b = graph.backlog.find((b) => b.goal === job.goal);
      if (b) { b.status = "failed"; b.failure = result.diagnostic; }
      await saveGraph(graph);
      continue;
    }
    const journey = result.journey;
    journey.id = `journey-${graph.journeys.length}-${Date.now().toString(36)}`;
    console.log(`   recorded ${journey.steps.length} step(s); postcondition: "${journey.postcondition}"`);

    console.log(`④ Verifier: replaying from a clean state…`);
    const v = await verifyJourneyRepeatedly(journey, startUrl);
    if (v.ok) {
      console.log(`   ✓ VERIFIED — ${v.detail}`);
    } else {
      console.log(`   ✗ NOT verified — ${v.detail}  (kept out of the graph's usable set)`);
    }

    // 4b) Minimise — prove the SHORTEST working path, not just a working one.
    if (v.ok && journey.steps.length > 1) {
      const provenSteps = structuredClone(journey.steps);
      const m = await minimizeJourney(journey, startUrl, { log: (l) => console.log(l), others: graph.journeys });
      if (m.changed) {
        const finalProof = await verifyJourneyRepeatedly(journey, startUrl);
        if (!finalProof.ok) {
          journey.steps = provenSteps;
          await verifyJourneyRepeatedly(journey, startUrl);
          console.log("   ! shortened path was unstable; restored and reverified the proven path");
        } else console.log(`   ✂ minimised ${m.before} → ${m.after} steps (${m.trials} replay trial(s))`);
      }
    }

    // 5) Semanticist — what does it MEAN (only worth doing for real journeys)
    if (isJourneyMachineVerified(journey)) {
      journey.meaning = await describeMeaning(name, journey).catch(() => undefined);
      if (journey.meaning) console.log(`⑤ Semanticist: ${journey.meaning}`);
      // Per-step spoken lines — what makes replay sound like a person guiding you.
      const says = await describeSteps(name, journey).catch(() => [] as string[]);
      if (says.length === journey.steps.length) {
        journey.steps.forEach((st, i) => (st.say = says[i]));
        console.log(`   ⑤b narration: ${says.length} step line(s) — e.g. "${says[0]}"`);
      }
      emit("map.semantics", { product: graph.product, status: "ok", data: {
        goal: journey.goal,
        meaning: journey.meaning,
        narrationLines: journey.steps.map((step) => step.say ?? ""),
      } });
    }

    const previous = graph.journeys.find((j) => j.goal === journey.goal);
    prepareJourneyRevision(journey, previous, job.source === "documentation" ? "documentation" : "autonomous");
    graph.journeys = graph.journeys.filter((j) => j.goal !== journey.goal).concat(journey);
    const b = graph.backlog.find((b) => b.goal === job.goal);
    if (b) {
      b.status = isJourneyMachineVerified(journey) ? "done" : "failed";
      b.failure = isJourneyMachineVerified(journey) ? undefined : journey.failure;
    }
    await saveGraph(graph);
  }

  // Prune dead weight, then derive how journeys depend on each other.
  const pruned = pruneJourneys(graph);
  const composed = deriveComposition(graph);
  if (pruned.removed) console.log(`\nPruned ${pruned.removed} superseded/duplicate journey(s); ${pruned.keptBroken} left as repair backlog.`);
  if (composed.linked) console.log(`Linked ${composed.linked} journey(s) to their prerequisite journey.`);

  // Real capability taxonomy — group journeys into buyer-facing areas rather
  // than emitting one "capability" per journey (which carried no information).
  console.log("\n⑥ Taxonomy: grouping journeys into capability areas…");
  graph.capabilities = await buildTaxonomy(graph).catch(() => graph.capabilities);
  graph.capabilities.forEach((c) => console.log(`   • ${c.name} — ${c.journeys.length} flow(s)`));
  graph.builtAt = new Date().toISOString();
  await saveGraph(graph);

  // 6) Publish verified journeys into the Brain so the live agent uses them
  const flows = await publishFlows(graph);

  const machineVerified = graph.journeys.filter(isJourneyMachineVerified).length;
  const verified = graph.journeys.filter(isJourneyPublishable).length;
  console.log(`\n=== Done ===`);
  console.log(`Screens: ${graph.screens.length} | Journeys: ${graph.journeys.length} (${machineVerified} machine-verified, ${verified} approved) | Capabilities: ${graph.capabilities.length}`);
  console.log(`Published ${flows.length} approved flow(s) to the Brain; unapproved revisions remain in review.`);
}

/**
 * Publish VERIFIED journeys into the Brain and rebuild the semantic index.
 * Must run after learn AND after reverify — a journey repaired by reverify is
 * useless if it never reaches the flows the live agent reads.
 */
async function publishFlows(graph: Awaited<ReturnType<typeof loadGraph>>) {
  await kb.load();
  const flows = journeysToFlows(graph);
  kb.setMappedFlows(flows as any);
  await kb.buildEmbeddings(); // semantic index so real phrasing routes to these journeys
  await kb.save("docs", "flows");
  emit("map.publish", { product: graph.product, status: "ok", data: {
    flowsPublished: flows.map((flow) => flow.name),
    flowCount: flows.length,
    executablePrograms: flows.filter((flow: any) => Array.isArray(flow.program) && flow.program.length > 0).length,
  } });
  return flows;
}

async function show() {
  const g = await loadGraph();
  console.log(`Product graph: ${g.product} (${g.startUrl})  built ${g.builtAt}`);
  console.log(`\nScreens (${g.screens.length}):`);
  g.screens.forEach((s) => console.log(`  • ${s.title} — ${s.controls.length} controls`));
  console.log(`\nCapabilities (${g.capabilities.length}):`);
  g.capabilities.forEach((c) => console.log(`  • ${c.name} → ${c.journeys.length} journey(s), entities: ${c.entities.join(", ") || "—"}`));
  console.log(`\nJourneys (${g.journeys.length}):`);
  for (const j of g.journeys) {
    const badge = j.status === "verified" ? "✓" : j.status === "broken" ? "✗" : "?";
    console.log(`  ${badge} ${j.goal}  [${j.capability}]  ${j.steps.length} steps`);
    j.steps.forEach((s, i) => console.log(`      ${i + 1}. ${s.action} ${s.role ? `${s.role} "${s.name}"` : ""}${s.value ? ` = "${s.value}"` : ""}`));
    console.log(`      ⇒ expect: "${j.postcondition}"`);
    if (j.meaning) console.log(`      ⇒ means: ${j.meaning}`);
  }
  const pending = g.backlog.filter((b) => b.status !== "done");
  if (pending.length) console.log(`\nBacklog: ${pending.map((b) => `${b.goal} (${b.status})`).join(", ")}`);
}

/** Re-verify every journey — scheduled UI-drift detection + self-repair signal. */
async function reverify() {
  const g = await loadGraph();
  console.log(`Re-verifying ${g.journeys.length} journey(s)…`);
  const inconclusive: string[] = [];
  for (const j of g.journeys) {
    const v = await verifyJourneyRepeatedly(j, g.startUrl);
    if (v.last.inconclusive) inconclusive.push(j.goal);
    console.log(`  ${v.ok ? "✓" : "✗"} ${j.goal} — ${v.detail} (reliability ${j.reliability.toFixed(2)})`);
  }
  pruneJourneys(g);
  deriveComposition(g);
  await saveGraph(g);
  const published = await publishFlows(g); // repaired journeys must reach the live agent
  console.log(`Published ${published.length} verified flow(s) to the Brain.`);
  if (inconclusive.length)
    console.log(
      `\n⚠ ${inconclusive.length} journey(s) have a WEAK PROOF (the text was already on screen before they ran, so it proves nothing).\n` +
        `  Re-run "learn" — the explorer now rejects proofs that were already true.`,
    );
  const broken = g.journeys.filter((j) => j.status === "broken" && !inconclusive.includes(j.goal));
  if (broken.length) console.log(`\n⚠ ${broken.length} journey(s) failed to replay — the product UI likely changed. Re-run "learn" to repair.`);
}

const [cmd, a, b] = process.argv.slice(2);
console.log(`(product: ${config.product})`);
if (cmd === "learn") await learn(a ? Number(a) : 5, b ? Number(b) : 4);
else if (cmd === "show") await show();
else if (cmd === "reverify") await reverify();
else if (cmd === "publish") {
  /*
   * Repair path: push the graph's verified journeys into flows.json without
   * re-verifying. Needed because the two writers of flows.json used to clobber
   * each other, leaving stores where a journey was verified in the graph but had
   * no executable program for the live agent. The eval's consistency layer now
   * detects that state; this is the fix for it.
   */
  const g = await loadGraph();
  const flows = await publishFlows(g);
  console.log(`Published ${flows.length} verified flow(s) (${flows.filter((f) => f.program?.length).length} with an executable program).`);
} else {
  console.error("commands: learn [maxJobs] [maxScreens] | show | reverify | publish");
  await flushEvents();
  process.exit(1);
}
await flushEvents();
process.exit(0);
