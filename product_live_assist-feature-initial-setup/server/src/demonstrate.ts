import { randomUUID } from "node:crypto";
import { LiveBox } from "./livebox.js";
import { brainFor } from "./knowledge/store.js";
import { loadGraph, saveGraph } from "./mapper/graph.js";
import { verifyJourneyRepeatedly } from "./mapper/verifier.js";
import { prepareJourneyRevision } from "./mapper/journey-review.js";
import { describeMeaning, describeSteps } from "./mapper/semanticist.js";
import { deriveComposition } from "./mapper/compose.js";
import { buildTaxonomy } from "./mapper/taxonomy.js";
import { observeOutcome, proofCandidates, validateProof } from "./mapper/proof.js";
import { checkAction } from "./mapper/safety.js";
import { getProduct, type ProductRecord } from "./products.js";
import { trace } from "./events.js";
import type { Journey, JourneyStep } from "./mapper/types.js";

/**
 * Mapper M2 — learning a journey from a HUMAN demonstration.
 *
 * Autonomous exploration fails on exactly the products that matter most. On a
 * standard enterprise UI it stalls on custom widgets, multi-step wizards and
 * screens whose success state has no confirmation, and the run ends with an
 * empty catalogue — which reduces the product to a chat agent. That is the wall
 * the OrangeHRM evaluation kept hitting.
 *
 * A person, meanwhile, can do the task in twenty seconds. So: let them do it
 * once, in our own streamed browser, and induce a journey from what they did.
 *
 * The crucial property is that a demonstration earns **no** special trust. It
 * goes through the same verification gate as an explored journey: replayed from
 * a clean state, proof absent-before and present-after. A human can misclick, or
 * demonstrate something that only worked because of leftover state; if the
 * recording does not replay, it is not published. Demonstration changes where
 * candidate journeys come from, not what counts as proven.
 *
 * Nothing here is product-specific. Steps are recorded as ARIA role +
 * accessible name via the same snapshot path the explorer uses, so a
 * demonstration on any product produces the same shape of program.
 */

export interface RecordedAction extends JourneyStep {
  /** Was this selector resolvable at the moment we recorded it? */
  resolvable: boolean;
  at: number;
}

interface DemoSession {
  id: string;
  productId: string;
  organizationId: string;
  box: LiveBox;
  startedAt: number;
  lastSeenAt: number;
  steps: RecordedAction[];
  /** Page text at the moment of the first real action — the proof baseline. */
  textAtFirstAction: string | null;
  /** URL where acting began; replay must return here. */
  actionStartUrl: string | null;
  /** Field currently being typed into, flushed on blur/submit/finish. */
  pending: { id: number; role: string; name: string } | null;
  /**
   * The outcome observation, computed ONCE after acting stops.
   *
   * Observing twice does not give the same answer: the best confirmation is
   * often a toast that is gone seconds later, so a second pass sees only the
   * settled page and ranks its furniture. Invalidated whenever a new action is
   * recorded, so it always describes the latest state.
   */
  outcome: { after: string; urlChanged: boolean } | null;
  /** Risky verbs this product has opted into — a human click never grants one. */
  allowActions: string[];
  notes: string[];
}

const PROOF_TEXT_LIMIT = 30000;
const sessions = new Map<string, DemoSession>();
const TTL_MS = Number(process.env.DEMO_SESSION_TTL_MS ?? 30 * 60_000);

/** Reap abandoned recorders so we never leak a browser. */
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastSeenAt > TTL_MS) {
      void s.box.stop().catch(() => {});
      sessions.delete(id);
      console.log(`[demo] recorder ${id} expired`);
    }
  }
}, 60_000).unref?.();

export function getDemoSession(id: string): DemoSession | undefined {
  const s = sessions.get(id);
  if (s) s.lastSeenAt = Date.now();
  return s;
}

/** Open a browser at the product's start screen, ready to be driven by a human. */
export async function startDemonstration(rec: ProductRecord): Promise<{ demoId: string; url: string }> {
  const box = new LiveBox({ startUrl: rec.startUrl, auth: rec.auth, allowActions: rec.allowActions });
  await box.start();
  // Clean DATA as well as a fresh browser: a demonstration that only worked
  // because of a leftover cart or draft would never replay.
  await box.resetState().catch(() => {});
  const id = randomUUID();
  sessions.set(id, {
    id,
    productId: rec.id,
    organizationId: rec.organizationId,
    box,
    startedAt: Date.now(),
    lastSeenAt: Date.now(),
    steps: [],
    textAtFirstAction: null,
    actionStartUrl: null,
    pending: null,
    outcome: null,
    allowActions: rec.allowActions ?? [],
    notes: [],
  });
  console.log(`[demo] recording ${id} for "${rec.id}" at ${box.currentUrl()}`);
  return { demoId: id, url: box.currentUrl() };
}

/** Capture the proof baseline once, at the first action rather than at open. */
async function markFirstAction(s: DemoSession): Promise<void> {
  if (s.textAtFirstAction !== null) return;
  s.textAtFirstAction = await s.box.visibleText(PROOF_TEXT_LIMIT);
  s.actionStartUrl = s.box.currentUrl();
}

/**
 * Flush a field being typed into as ONE `fill` step.
 *
 * The value is read back off the element rather than reconstructed from the
 * keystrokes we forwarded, so backspaces, selection-replacement, autocomplete,
 * IME composition and password-manager pastes all come out right without any of
 * them being handled explicitly.
 */
async function flushPending(s: DemoSession, submit = false, knownValue?: string): Promise<void> {
  const p = s.pending;
  s.pending = null;
  if (!p) return;
  /*
   * `knownValue` matters because SUBMITTING USUALLY CLEARS THE FIELD. Reading
   * the input after Enter returns "" on a to-do box, a search box, a chat
   * composer — anything that consumes its input — so the fill step was silently
   * dropped and the recording came back empty. The caller reads the value before
   * forwarding the key and hands it in.
   */
  const value = knownValue ?? (await s.box.valueOfElement(p.id));
  if (!value) return; // focused but typed nothing
  const resolvable = await s.box.canResolve(p.role, p.name);
  s.steps.push({ action: "fill", role: p.role, name: p.name, value, submit, resolvable, at: Date.now() });
  if (!resolvable) s.notes.push(`the field "${p.name}" could not be addressed durably`);
}

/**
 * Record a human click.
 *
 * Returns what we understood, so the UI can show the person their own action as
 * a step being captured — a recorder that silently drops actions is worse than
 * no recorder, because the failure only surfaces minutes later in verification.
 */
export async function recordClick(id: string, fx: number, fy: number): Promise<{ recorded: boolean; label: string }> {
  const s = getDemoSession(id);
  if (!s) return { recorded: false, label: "no such recording" };
  s.outcome = null; // the world changed; any earlier observation is stale

  // A snapshot both tags the DOM (so the click can be identified) and gives us
  // the canonical role/name for every control.
  const snap = await s.box.snapshot();
  const hit = await s.box.identifyAt(fx, fy);
  await markFirstAction(s);

  // Clicking away from a field ends that field's input.
  const target = hit ? snap.elements.find((e) => e.id === hit.id) : undefined;
  const isField = target ? /input|textarea/.test(target.tag) && !/button|submit|checkbox|radio/.test(target.type) : false;
  if (!isField || !target || s.pending?.id !== target.id) await flushPending(s, false);

  // Perform it regardless of whether we could name it — the human is driving and
  // must never feel the recorder fighting them.
  await s.box.userClick(fx, fy);

  if (!target) {
    s.notes.push("a click landed on nothing addressable and was not recorded");
    return { recorded: false, label: "(not a control — not recorded)" };
  }

  const role = target.role || target.tag;
  const name = target.name || target.placeholder || target.text;

  if (isField) {
    // Don't record focusing a field; the `fill` step will click it anyway.
    s.pending = { id: target.id, role, name };
    return { recorded: false, label: `typing into ${role} "${name}"` };
  }

  /*
   * Safety applies to a demonstration too. A person can click Delete, and a
   * journey that deletes real data is not something we will replay on every
   * demo. `allowActions` from product.json is the only thing that permits a
   * risky verb — a human demonstrating one does not authorise it.
   */
  const verdict = checkAction({ action: "click", role, name }, { allow: s.allowActions });
  if (!verdict.allowed) {
    s.notes.push(`"${name}" was not recorded: ${verdict.reason}`);
    return { recorded: false, label: `(not recorded — ${verdict.reason})` };
  }

  const resolvable = await s.box.canResolve(role, name);
  s.steps.push({ action: "click", role, name, resolvable, at: Date.now() });
  if (!resolvable) s.notes.push(`"${name}" could not be addressed durably and may not replay`);
  return { recorded: true, label: `${role} "${name}"${resolvable ? "" : " ⚠ not durably addressable"}` };
}

/** Forward a keystroke, flushing the field on Enter (which usually submits). */
export async function recordKey(id: string, key: string, text: string, modifiers: string[] = []): Promise<void> {
  const s = getDemoSession(id);
  if (!s) return;
  s.outcome = null;
  await markFirstAction(s);
  // Read the field BEFORE the key that may submit and empty it.
  const stashed = key === "Enter" && s.pending ? await s.box.valueOfElement(s.pending.id) : undefined;
  await s.box.userKey(key, text, modifiers);
  if (key === "Enter") await flushPending(s, true, stashed);
}

export async function recordPaste(id: string, text: string): Promise<void> {
  const s = getDemoSession(id);
  if (!s) return;
  await markFirstAction(s);
  await s.box.userPaste(text);
}

export async function recordScroll(id: string, dy: number): Promise<void> {
  const s = getDemoSession(id);
  if (!s) return;
  await s.box.userWheel(dy);
}

/** Explicit navigation by the human becomes a `navigate` step. */
export async function recordNavigate(id: string, url: string): Promise<void> {
  const s = getDemoSession(id);
  if (!s) return;
  s.outcome = null;
  await flushPending(s, false);
  await s.box.goto(url);
  await markFirstAction(s);
  s.steps.push({ action: "navigate", url, resolvable: true, at: Date.now() });
}

/** What has been captured so far — drives the recorder UI. */
export async function demonstrationStatus(id: string) {
  const s = getDemoSession(id);
  if (!s) return null;
  return {
    demoId: s.id,
    productId: s.productId,
    url: s.box.currentUrl(),
    steps: s.steps.map((st) => ({
      action: st.action,
      role: st.role,
      name: st.name,
      value: st.value,
      resolvable: st.resolvable,
    })),
    unresolvable: s.steps.filter((st) => !st.resolvable).length,
    notes: [...new Set(s.notes)],
  };
}

/** Proof options observed since acting began, best first. */
export async function demonstrationProofOptions(id: string): Promise<string[]> {
  const s = getDemoSession(id);
  if (!s) return [];
  return proofCandidates(await proofContext(s)).slice(0, 10);
}

/** Observe the outcome once, then reuse it. */
async function proofContext(s: DemoSession) {
  if (!s.outcome) {
    const obs = await observeOutcome(() => s.box.visibleText(PROOF_TEXT_LIMIT), () => s.box.currentUrl(), {
      before: s.textAtFirstAction ?? "",
    });
    /*
     * Whether the app moved is measured against where ACTING began, not against
     * wherever we happened to start watching. Comparing to the latter reported
     * "no navigation" for a journey that had already navigated before this call
     * — which inverted the meaning of seeing a typed value on screen.
     */
    s.outcome = { after: obs.after, urlChanged: s.box.currentUrl() !== (s.actionStartUrl ?? "") || obs.urlChanged };
  }
  return {
    before: s.textAtFirstAction ?? "",
    after: s.outcome.after,
    typedValues: s.steps.filter((st) => st.action === "fill").map((st) => String(st.value ?? "")),
    urlChanged: s.outcome.urlChanged,
  };
}

export interface FinishResult {
  ok: boolean;
  detail: string;
  journey?: Journey;
  verified?: boolean;
  proof?: string;
  candidates?: string[];
}

/**
 * Turn the recording into a journey: pick proof, VERIFY it, then publish.
 *
 * `postcondition` is optional — when omitted we take the highest-ranked observed
 * candidate, so the common path needs no judgement from the person. Whatever is
 * supplied must still be text we saw appear; the human is not trusted to invent
 * evidence either.
 */
export async function finishDemonstration(
  id: string,
  opts: { goal: string; postcondition?: string; capability?: string; publish?: boolean } = { goal: "" },
): Promise<FinishResult> {
  const s = getDemoSession(id);
  if (!s) return { ok: false, detail: "no such recording" };
  const rec = await getProduct(s.productId);
  if (!rec) return { ok: false, detail: `product ${s.productId} is gone` };

  return trace(s.productId, "mapping", "demo.induce", { goal: opts.goal }, async () => {
    await flushPending(s, false);

    const goal = opts.goal.trim();
    if (!goal) return { ok: false, detail: "give the demonstration a goal, e.g. \"Create and submit a leave request\"" };

    const acting = s.steps.filter((st) => st.action !== "navigate");
    if (!acting.length) {
      return { ok: false, detail: "nothing was demonstrated — the recording only navigated, which proves nothing" };
    }
    const unresolvable = s.steps.filter((st) => !st.resolvable);
    if (unresolvable.length) {
      // Not fatal: verification is the real arbiter. But say it plainly, because
      // this is the most likely reason a good demonstration fails to replay.
      console.warn(`[demo] ${unresolvable.length} step(s) were not durably addressable`);
    }

    /*
     * Reuse the ONE observation taken when acting stopped — never observe again
     * here. A second pass does not see the same thing: the most useful
     * confirmation is often a toast that has already gone, so re-observing
     * returns only the settled page and ranks its furniture. That is exactly
     * what happened — "Successfully Saved" on the first pass became "Other Id"
     * on the second.
     */
    const ctx = await proofContext(s);
    const candidates = proofCandidates(ctx);
    const chosen = (opts.postcondition ?? candidates[0] ?? "").trim();
    if (!chosen) {
      return {
        ok: false,
        detail:
          "no text appeared as a result of the demonstration, so there is nothing to assert. " +
          "Either the task produced no visible change, or it needs a step that confirms it.",
        candidates: [],
      };
    }
    const verdict = validateProof(chosen, ctx);
    if (!verdict.ok) return { ok: false, detail: verdict.reason ?? "unusable proof", candidates: verdict.candidates };

    // Steps are stored without the recorder's own bookkeeping.
    const steps: JourneyStep[] = s.steps.map(({ resolvable, at, ...step }) => step);

    const journey: Journey = {
      id: `journey-demo-${Date.now().toString(36)}`,
      goal,
      capability: (opts.capability || goal).trim(),
      entities: [],
      preconditions: [],
      startUrl: s.actionStartUrl ?? rec.startUrl,
      steps,
      postcondition: chosen,
      proof: "text",
      status: "unverified",
      reliability: 0,
      attempts: 0,
    };

    /*
     * THE GATE. A demonstration is a candidate, not a fact — replay it from a
     * clean state exactly as an explored journey would be. This is what stops a
     * misclick, or a task that only worked because of leftover state, from being
     * published as proven.
     */
    const v = await verifyJourneyRepeatedly(journey, rec.startUrl, {
      startUrl: rec.startUrl,
      auth: rec.auth,
      allowActions: rec.allowActions,
    });

    if (!v.ok) {
      return {
        ok: false,
        verified: false,
        journey,
        proof: chosen,
        detail:
          `The demonstration did not replay: ${v.detail}` +
          (unresolvable.length
            ? ` (${unresolvable.length} step(s) were not durably addressable, which is the likely cause)`
            : ""),
        candidates: candidates.slice(0, 8),
      };
    }

    // Meaning + spoken narration, same as an explored journey.
    const kb = await brainFor(s.productId);
    journey.meaning = await describeMeaning(rec.name, journey, kb).catch(() => undefined);
    const says = await describeSteps(rec.name, journey).catch(() => [] as string[]);
    if (says.length === journey.steps.length) journey.steps.forEach((st, i) => (st.say = says[i]));

    if (opts.publish !== false) {
      const graph = await loadGraph(s.productId, rec.startUrl);
      const previous = graph.journeys.find((item) => item.goal === journey.goal);
      prepareJourneyRevision(journey, previous, "human_demonstration");
      graph.journeys = graph.journeys.filter((j) => j.goal !== journey.goal).concat(journey);
      deriveComposition(graph);
      graph.capabilities = await buildTaxonomy(graph).catch(() => graph.capabilities);
      graph.builtAt = new Date().toISOString();
      await saveGraph(graph);
      // The demonstration is staged only. The review endpoint atomically
      // releases a fully approved batch, so the currently live catalog is not
      // partially replaced by a candidate.
    }

    return {
      ok: true,
      verified: true,
      journey,
      proof: chosen,
      detail: `Machine-verified from a clean state — revision ${journey.revision} now awaits human approval.`,
    };
  });
}

export async function cancelDemonstration(id: string): Promise<void> {
  const s = sessions.get(id);
  if (!s) return;
  await s.box.stop().catch(() => {});
  sessions.delete(id);
}
