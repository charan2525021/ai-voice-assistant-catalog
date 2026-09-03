/**
 * Proof selection: what counts as evidence that a journey worked.
 *
 * A postcondition used to be a free string the model wrote. That let it assert
 * text the product never displays. The clearest case, on OrangeHRM: the journey
 * filled First="Ava", Middle="Marie", Last="Johnson", then claimed proof
 * "Ava Johnson" — a string COMPOSED from two of its own inputs. The page renders
 * "Ava Marie Johnson", so the assertion could never match, and a journey that
 * genuinely worked was recorded as broken. Nothing caught it, because the only
 * check was "was this text already on screen before?".
 *
 * The rule this module enforces: **a proof must be text we OBSERVED on the page
 * after the action, and did not observe before it.** The model no longer supplies
 * evidence; it chooses among evidence we collected.
 *
 * Everything here is structural — lengths, uniqueness, digit stability, set
 * difference. There is deliberately no vocabulary of confirmation words
 * ("saved", "success", "thank you"): that would silently bind proof quality to
 * English and to products that happen to show toasts. A short line that appears
 * only after acting is a good proof in any language.
 */

/** Text we captured around the acting steps, plus what the journey typed. */
export interface ProofContext {
  /** Visible text at the point of action (after navigation, before acting). */
  before: string;
  /** Visible text once the acting steps have run. */
  after: string;
  /** Values the journey typed — used to explain, not to reject. */
  typedValues?: string[];
  /**
   * Text that exists ONLY inside transient UI — modals, menus, tooltips, toasts
   * that are still open. Text found here and nowhere else is disqualified as
   * proof: an onboarding dialog is new on arrival (so it passes a differential
   * check) but describes the dialog, not the outcome, and usually never appears
   * again for a returning user.
   */
  overlayText?: string;
  /**
   * Did the app navigate as a result of the action?
   *
   * This flips the meaning of seeing a typed value on screen. On the SAME page,
   * "Priya" is probably just the text still sitting in the input — no evidence
   * that anything was saved. After a navigation, the same string is the created
   * record appearing on its own page, which is the best proof available: stable,
   * specific to this journey, and unambiguously caused by it.
   */
  urlChanged?: boolean;
}

/**
 * Watch for the outcome instead of sampling once.
 *
 * `settle()` returns when the network quiets, which on a real app is well before
 * the app has finished reacting. Measured on OrangeHRM's Add Employee: at +0ms
 * the page is unchanged, at +3s a "Successfully Saved" toast appears, and at +5s
 * it navigates to the new employee's page — by which time the toast is gone.
 * Sampling once at either end gets you nothing or gets you page furniture.
 *
 * So poll, and UNION everything new that appears across the window. Transient
 * confirmations and final-state text both end up as candidates, and the caller
 * gets one `after` blob to reason over.
 */
export async function observeOutcome(
  readText: () => Promise<string>,
  readUrl: () => string,
  opts: { windowMs?: number; stepMs?: number; before: string },
): Promise<{ after: string; urlChanged: boolean }> {
  const windowMs = opts.windowMs ?? 8000;
  const stepMs = opts.stepMs ?? 600;
  const startUrl = readUrl();
  const seen = new Set(splitLines(opts.before));
  const collected: string[] = [];
  let urlChanged = false;
  let stableFor = 0;

  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    const text = await readText().catch(() => "");
    if (readUrl() !== startUrl) urlChanged = true;
    let added = 0;
    for (const line of splitLines(text)) {
      if (seen.has(line)) continue;
      seen.add(line);
      collected.push(line);
      added++;
    }
    // Stop early once the app has clearly finished reacting, but only after the
    // page has actually done something — otherwise we return before it starts.
    stableFor = added === 0 ? stableFor + stepMs : 0;
    if (collected.length > 0 && stableFor >= 2000) break;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return { after: collected.join("\n"), urlChanged };
}

/**
 * Empty-state messages: differential but worthless.
 *
 * "No Records Found" really does appear only after you press Search, so it
 * passes a naive differential while proving the journey found nothing. Match the
 * PHRASE, never a leading "0"/"no" — an earlier /^(no|0)\s/ rejected "0 items
 * left" on a to-do app, which is a perfectly good proof that the last task was
 * completed. A count reaching zero is a result; "no results" is the absence of one.
 */
export const EMPTY_STATE =
  /(not found|no records|no results|no data|no matching|no items found|nothing (to show|found)|none found|no entries)/i;

const norm = (s: string) => (s || "").replace(/\s+/g, " ").trim();
const fold = (s: string) => norm(s).toLowerCase();

/** Digit-insensitive containment — live counts move between record and verify. */
export function containsText(haystack: string, needle: string): boolean {
  const h = fold(haystack);
  const n = fold(needle);
  if (!n) return false;
  if (h.includes(n)) return true;
  const strip = (s: string) => s.replace(/\d+/g, "").replace(/\s+/g, " ").trim();
  const ln = strip(n);
  return ln.length >= 6 && strip(h).includes(ln);
}

/**
 * Is this text sourced ONLY from transient chrome?
 *
 * Containment in the overlay alone is not enough to reject — the same word can
 * legitimately appear both in an open menu and in the page behind it. What
 * disqualifies a proposal is appearing in the overlay and NOWHERE else.
 */
function onlyInOverlay(p: string, ctx: ProofContext): boolean {
  const overlay = ctx.overlayText ?? "";
  if (!overlay.trim()) return false;
  if (!containsText(overlay, p)) return false;
  const overlayLines = new Set(splitLines(overlay));
  const outside = splitLines(ctx.after).filter((line) => !overlayLines.has(line)).join("\n");
  return !containsText(outside, p);
}

export interface ProofVerdict {
  ok: boolean;
  reason?: string;
  /** Observed alternatives to offer when a proposal is rejected. */
  candidates?: string[];
}

/**
 * Is this string admissible as proof?
 *
 * Order matters: the "not observed" check comes FIRST, because it is the one
 * that catches invented and composed text, and its message is the one that
 * teaches the caller what went wrong.
 */
export function validateProof(post: string, ctx: ProofContext): ProofVerdict {
  const p = norm(post);
  const candidates = proofCandidates(ctx).slice(0, 8);

  if (!p) return { ok: false, reason: "no postcondition given", candidates };
  if (p.length < 3) return { ok: false, reason: `"${p}" is too short to identify anything`, candidates };
  if (p.length > 160) return { ok: false, reason: "postcondition is too long to assert reliably", candidates };

  if (!containsText(ctx.after, p)) {
    const echoed = (ctx.typedValues ?? []).filter((v) => v && fold(p).includes(fold(v)));
    const hint =
      echoed.length >= 2
        ? ` It looks assembled from values you typed (${echoed.map((e) => `"${e}"`).join(", ")}) — the product may render them differently, e.g. with a middle name or different order.`
        : "";
    return {
      ok: false,
      reason: `"${p}" is NOT visible on the page after the action, so it cannot be evidence.${hint} Quote text you can actually see.`,
      candidates,
    };
  }

  if (containsText(ctx.before, p)) {
    return {
      ok: false,
      reason: `"${p}" was already visible before the action, so it only proves you navigated here.`,
      candidates,
    };
  }

  if (EMPTY_STATE.test(p)) {
    return {
      ok: false,
      reason: `"${p}" is an empty-state message — it proves the journey found nothing, which is a poor demo.`,
      candidates,
    };
  }

  if (onlyInOverlay(p, ctx)) {
    return {
      ok: false,
      reason:
        `"${p}" only appears inside a dialog, menu or tooltip that is currently open. That is UI chrome, ` +
        `not the outcome — and a first-visit dialog will not be there on the next run. Quote text from the page itself.`,
      candidates,
    };
  }

  // A proof made only of digits/punctuation cannot survive live data moving.
  if (!/[a-z]/i.test(p)) {
    return { ok: false, reason: `"${p}" has no words — numbers alone change between runs.`, candidates };
  }

  return { ok: true };
}

/**
 * Rank the text that appeared as a result of the action.
 *
 * Scoring is structural on purpose:
 *  · new  — present after, absent before (the definition of evidence here)
 *  · short — a label or confirmation beats a paragraph, and stays true longer
 *  · wordy — must contain letters, or live data will break it
 *  · unique — appearing once in the page is more specific than a repeated cell
 *  · stable — digits are penalised, not banned (a count CAN be the result)
 */
export function proofCandidates(ctx: ProofContext): string[] {
  const beforeLines = new Set(splitLines(ctx.before));
  const afterLines = splitLines(ctx.after);
  const afterFolded = fold(ctx.after);

  // Never offer transient chrome as a suggestion — rejecting it above and then
  // handing it back as a candidate would just teach the model to try it again.
  const overlayLines = new Set(splitLines(ctx.overlayText ?? ""));

  const seen = new Set<string>();
  const scored: { text: string; score: number }[] = [];

  for (const line of afterLines) {
    if (beforeLines.has(line)) continue; // not new
    if (overlayLines.has(line)) continue;
    const t = norm(line);
    if (t.length < 3 || t.length > 160) continue;
    if (!/[a-z]/i.test(t)) continue;
    if (EMPTY_STATE.test(t)) continue;
    const key = fold(t);
    if (seen.has(key)) continue;
    seen.add(key);

    let score = 0;
    // Peak usefulness around a short phrase; falls away in both directions.
    const len = t.length;
    score += len >= 8 && len <= 60 ? 3 : len < 8 ? 1 : 0;
    if (!/\d/.test(t)) score += 2; // stable across runs
    // Unique on the page → identifies this outcome rather than a common cell.
    if (occurrences(afterFolded, key) === 1) score += 2;
    /*
     * A typed value appearing in the captured text is the STRONGEST proof there
     * is: the record this journey created, rendered by the product, specific to
     * this run and unambiguously caused by it.
     *
     * This is safe because of how the text is captured. `innerText` does not
     * include the value of an `<input>`, so a value still sitting in the form
     * field never reaches us — if we can see it, the product has rendered it as
     * content. That reasoning replaces an earlier "only trust this after a
     * navigation" rule, which was too narrow: a single-page app that adds a row
     * without changing the URL produces exactly this evidence, and the rule
     * demoted it in favour of whatever furniture appeared alongside.
     *
     * Caveat worth knowing: a `<textarea>`'s value IS its text content, so a
     * long-form field can still echo. Length and uniqueness scoring handle that.
     */
    const echoesInput = (ctx.typedValues ?? []).some((v) => v && v.length > 1 && key.includes(fold(v)));
    if (echoesInput) score += 4;
    scored.push({ text: t, score });
  }

  return scored.sort((a, b) => b.score - a.score || a.text.length - b.text.length).map((s) => s.text);
}

function splitLines(s: string): string[] {
  return (s || "")
    .split("\n")
    .map((l) => norm(l))
    .filter(Boolean);
}

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}
