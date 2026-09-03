import type { LiveBox } from "../livebox.js";
import type { ScreenNode } from "./types.js";
import { checkAction } from "./safety.js";
import { classifyScreenKind } from "./journey-evidence.js";
import { createHash } from "node:crypto";
import { fingerprintSnapshot } from "../runtime/screen-state.js";
import { emit } from "../events.js";

/**
 * Cartographer — breadth-first surface map.
 *
 * Handles BOTH navigation styles found in real products:
 *   • classic links (<a href>) — visited by URL
 *   • SPA navigation (nav items / tabs that change the view via JS, no href)
 *     — visited by clicking, then returning to the start screen
 *
 * Read-only by construction: it never submits forms or mutates data, and every
 * candidate move passes the safety interlock first.
 */
/**
 * Collapse instance-specific URLs into a screen TYPE:
 *   /item/3?id=4  →  /item/:id     /orders/8821/edit → /orders/:id/edit
 * Numeric, uuid and long-hash segments become `:id`, and query values are dropped.
 */
/** A path segment that identifies one RECORD rather than one kind of screen. */
export function isIdSegment(seg: string): boolean {
  return (
    /^\d+$/.test(seg) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) ||
    /^[0-9a-f]{16,}$/i.test(seg)
  );
}

export function urlTemplate(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname
      .split("/")
      .map((seg) => (isIdSegment(seg) ? ":id" : seg))
      .join("/");
    const params = [...u.searchParams.keys()].sort().join(",");
    const hash = u.hash
      .split("/")
      .map((segment) => /^\d+$/.test(segment) || /^[0-9a-f]{16,}$/i.test(segment) ? ":id" : segment)
      .join("/");
    return `${u.origin}${path}${params ? `?${params}` : ""}${hash}`;
  } catch {
    return url;
  }
}

/**
 * Many SPAs give every screen the same <title> ("Swag Labs"), which is useless
 * to the planner. Derive a distinguishing label from the URL path instead.
 */
function screenLabel(url: string, title: string): string {
  let path = "";
  try {
    const u = new URL(url);
    /*
     * Drop record ids and routing prefixes before prettifying.
     *
     * The raw path was used verbatim, so LangSmith's org-scoped URLs produced
     * screen names like "Tracing - LangSmith — O D6792f5e C089 41bb 86cf
     * 3b838dd6fc6e Projects". The UUID identifies the tenant, not the screen,
     * and a one- or two-letter segment ("o", "u", "ws") is a routing prefix —
     * neither tells a human which screen this is.
     */
    path = (u.pathname + u.hash)
      .replace(/\.(html?|php)$/i, "")
      .split(/[#/]/)
      .filter((seg) => seg && !isIdSegment(seg) && seg.length > 2)
      .join(" ")
      .replace(/[_-]+/g, " ")
      .trim();
  } catch {
    /* ignore */
  }
  if (!path) return title || url;
  const pretty = path.replace(/\b\w/g, (c) => c.toUpperCase());
  return title && !title.toLowerCase().includes(pretty.toLowerCase()) ? `${title} — ${pretty}` : pretty;
}

/**
 * Read-only verbs a button may carry and still be safe to click.
 *
 * Deliberately a POSITIVE allowlist rather than "anything the interlock does not
 * block". checkAction() catches destructive and mutating verbs, but plenty of
 * committing labels slip through it — "Apply", "Confirm", "Continue" — and a
 * survey that clicks those is no longer read-only. Anything not listed here is
 * only followed when it advertises the ARIA disclosure contract.
 */
const READ_VERB = /^(open|view|show|see|browse|explore|expand|collapse|more|details?|preview|next|previous|prev|back|filter|sort|search|find|menu)\b/i;

/** Should the survey click this control to see what is behind it? */
function isNavigable(element: { role?: string; name?: string; discloses?: boolean }): boolean {
  if (element.role === "link" || element.role === "tab" || element.role === "menuitem") return true;
  if (element.role !== "button") return false;
  if (!FOLLOW_BUTTONS) return false;
  // A control that advertises aria-haspopup / aria-expanded / aria-controls
  // reveals UI rather than committing an action — that is exactly what a survey
  // wants to look behind, and it is a standards contract, not a per-product guess.
  if (element.discloses) return true;
  return READ_VERB.test(element.name ?? "");
}

const FOLLOW_BUTTONS = (process.env.SURVEY_FOLLOW_BUTTONS ?? "true") !== "false";
const CONTROLS_PER_SCREEN = Number(process.env.SURVEY_CONTROLS_PER_SCREEN ?? 30);
/**
 * How much of the smaller control set must be shared for two states at the same
 * URL and title to count as ONE screen. 0.6 merges a swapped side panel while
 * still separating two genuinely different views that happen to share chrome.
 */
const MERGE_THRESHOLD = Number(process.env.SURVEY_MERGE_THRESHOLD ?? 0.6);

/** Fraction of the SMALLER set that also appears in the larger one. */
function containment(a: readonly string[], b: ReadonlySet<string>): number {
  const smallerIsA = a.length <= b.size;
  const small = smallerIsA ? a : [...b];
  const large = smallerIsA ? b : new Set(a);
  if (!small.length) return 0;
  let shared = 0;
  for (const item of small) if (large.has(item)) shared++;
  return shared / small.length;
}

/** `role "name"` — the durable addressing pair the whole mapper is built on. */
const label = (e: { role?: string; name?: string }) => `${e.role} "${e.name}"`;

export interface SurveyResult {
  screens: ScreenNode[];
  visits: number;
  maxVisits: number;
  frontierRemaining: number;
  stopReason: "frontier_exhausted" | "screen_limit" | "visit_limit";
}

/** Backward-compatible surface for CLI/tests which only need the screens. */
export async function surveyProduct(box: LiveBox, startUrl: string, maxScreens = 50): Promise<ScreenNode[]> {
  return (await surveyProductDetailed(box, startUrl, maxScreens)).screens;
}

export async function surveyProductDetailed(box: LiveBox, startUrl: string, maxScreens = 50): Promise<SurveyResult> {
  const origin = new URL(startUrl).origin;
  const screens: ScreenNode[] = [];
  const seenUrls = new Set<string>();
  /** Base-screen identity → the node, so an overlay can be merged into its parent. */
  const seenStates = new Map<string, ScreenNode>();
  /** urlTemplate+title → nodes at that address, for the overlap check. */
  const byPage = new Map<string, ScreenNode[]>();
  /** node id → its base control set, grown as variants of the screen are seen. */
  const baseByNode = new Map<string, Set<string>>();
  const seenPaths = new Set<string>();
  type Move = { url?: string; path: { role: string; name: string }[] };
  const frontier: Move[] = [{ url: startUrl, path: [] }];
  const MAX_NAV_DEPTH = Number(process.env.MAPPING_NAV_DEPTH ?? 6);
  const skipped: Record<string, number> = {};
  const skip = (reason: string) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };

  /**
   * Record what is on screen.
   *
   * Returns the snapshot ALWAYS, so the frontier can still be expanded from a
   * state that did not earn its own node. `node` is null when this state is a
   * transient overlay on a screen we already have — in that case the overlay's
   * controls are merged into the parent instead.
   *
   * Splitting those two cases is the whole point. Previously any change in
   * visible text minted a new screen, so on a single-page canvas app (draw.io)
   * opening File, Edit, View, Arrange and Extras produced five "screens" that
   * were one page with a different dropdown open — and the entire screen budget
   * was spent before anything else was reached.
   */
  const record = async (
    path: { role: string; name: string }[],
  ): Promise<{ node: ScreenNode | null; snap: Awaited<ReturnType<LiveBox["snapshot"]>> }> => {
    const snap = await box.snapshot(false);
    const named = snap.elements.filter((e) => e.name);
    const base = named.filter((e) => !e.overlay);
    const overlay = named.filter((e) => e.overlay);

    /*
     * IDENTITY excludes overlay controls and overlay text.
     *
     * A screen is the page underneath. An open menu adds items on top of it and
     * removes nothing, so the base control set is what stays constant while a
     * user browses — and it is therefore what identity must key on.
     */
    const baseControls = [...new Set(base.map(label))];
    /*
     * Page TEXT is deliberately no longer part of identity.
     *
     * It used to be (digit-normalised, 2k), to separate a list from an empty
     * state — but body.innerText also contains whatever the open menu just
     * added, which is precisely how one canvas page became six screens. The
     * base control set carries the same signal without the volatility: an empty
     * state almost always offers different controls ("Create your first
     * diagram") than a populated one. The trade is that two screens with the
     * same URL, title and controls but different prose now collapse into one —
     * which for a data-driven list is the correct answer anyway.
     */
    const identity = createHash("sha256")
      .update(JSON.stringify([urlTemplate(snap.url), snap.title, baseControls]))
      .digest("hex");
    /** Same address, same title — a candidate for "this is that screen, changed". */
    const pageKey = createHash("sha256")
      .update(JSON.stringify([urlTemplate(snap.url), snap.title]))
      .digest("hex");

    /*
     * Same screen with something expanded — decided by OVERLAP, not by ARIA.
     *
     * The first version of this keyed on aria-haspopup / role="menu", which is
     * the correct contract and is simply not what real apps emit: draw.io's
     * shape palette is plain <a> elements in <div>s, so expanding "General" or
     * "Misc" swapped the base control set, produced a different identity hash,
     * and minted another copy of the editor. Six screens, one page, again.
     *
     * Overlap is DOM-agnostic. If we are at the same URL template and title AND
     * most of one control set is present in the other, this is the same screen
     * with a region swapped — a menu, an accordion, a tab, a side panel. The
     * url+title precondition is what stops it merging genuinely different pages
     * that happen to share a nav bar, because those differ in address or title.
     */
    const exact = seenStates.get(identity);
    const sibling = exact ?? (byPage.get(pageKey) ?? []).find((node) => containment(baseControls, baseByNode.get(node.id)!) >= MERGE_THRESHOLD);
    if (sibling) {
      /*
       * Fold everything newly on screen into the parent — the revealed overlay
       * AND whatever the expanded region added. That is the useful half of what
       * the click discovered, and it reaches the planner without spending a
       * screen slot on a near-duplicate.
       */
      const revealed = [...overlay.map(label), ...baseControls];
      const known = baseByNode.get(sibling.id)!;
      for (const c of baseControls) known.add(c);
      sibling.controls = [...new Set([...sibling.controls, ...revealed])].slice(0, CONTROLS_PER_SCREEN);
      if (!exact) seenStates.set(identity, sibling); // remember this variant resolves here
      skip(exact ? "exact screen already recorded" : "screen variant merged with existing screen");
      return { node: null, snap };
    }

    const identifiedControls = [...new Set([...baseControls, ...overlay.map(label)])];
    const controls = identifiedControls.slice(0, CONTROLS_PER_SCREEN);
    const node: ScreenNode = {
      id: `screen-${screens.length}`, url: snap.url, title: screenLabel(snap.url, snap.title),
      purpose: path.length ? `Reached through ${path.map((step) => `${step.role} "${step.name}"`).join(" → ")}` : "Entry state",
      controls,
      // `fingerprint` is the survey's dedup key; it now also excludes overlays,
      // so re-visiting a screen with a menu open resolves to the same node.
      fingerprint: identity,
      // Recomputed from the live snapshot, and NOT used for dedup: it hashes the
      // raw URL, 20k of text and all 320 controls, so it is strictly more
      // sensitive than identity above and would split a screen per open menu.
      // It exists so the runtime can match the live page to this node.
      runtimeFingerprint: fingerprintSnapshot(snap),
      /*
       * Stored page text is capped at 4,000 characters, on top of the
       * snapshot's own PAGE_TEXT_LIMIT (livebox.ts). This copy is only read to
       * classify empty/error states, so it costs disk rather than tokens — but
       * a full-app map holds one of these per screen, and the graph is loaded
       * whole. Raise it when a product's screens carry evidence past 4k.
       */
      reachedBy: path, visibleText: snap.text.slice(0, 4_000),
      kind: classifyScreenKind(snap.url, snap.title),
    };
    screens.push(node);
    seenStates.set(identity, node);
    baseByNode.set(node.id, new Set(baseControls));
    byPage.set(pageKey, [...(byPage.get(pageKey) ?? []), node]);
    emit("map.survey.screen", { status: "ok", data: {
      url: node.url, title: node.title, controlCount: identifiedControls.length,
      fingerprint: node.fingerprint, reachedBy: node.reachedBy,
      controls: identifiedControls,
    } });
    return { node, snap };
  };

  /*
   * A visit budget, separate from maxScreens.
   *
   * Overlay states no longer consume a screen slot — which is the point — but
   * that also means `screens.length` can stop growing while the frontier keeps
   * producing work. Without a second bound the survey would run until every
   * menu on the product had been opened. Each visit costs a page load plus a
   * click replay, so this is the real wall-clock control.
   */
  const maxVisits = Number(process.env.SURVEY_MAX_VISITS ?? maxScreens * 8);
  let visits = 0;

  while (frontier.length && screens.length < maxScreens && visits < maxVisits) {
    visits++;
    const move = frontier.shift()!;
    if (move.url) {
      const key = urlTemplate(move.url);
      if (seenUrls.has(key)) { skip("URL already visited"); continue; }
      seenUrls.add(key);
      await box.goto(move.url);
      await box.loginIfNeeded().catch(() => false);
    } else {
      await box.gotoStart();
      let reached = true;
      for (const step of move.path) {
        const result = await box.clickByRole(step.role, step.name);
        if (result.startsWith("NOT_FOUND") || result.startsWith("error:")) { reached = false; break; }
      }
      if (!reached) { skip("saved click path no longer replayed"); continue; }
    }
    /*
     * Expand the frontier from EVERY visited state, including one that turned
     * out to be an overlay on a screen we already had. That state is exactly
     * where the newly revealed controls are — refusing to look at them was the
     * other half of why menu contents never reached the planner.
     */
    const { snap } = await record(move.path);
    for (const e of snap.elements) {
      if (!e.name) { skip("control had no accessible name"); continue; }
      if (!isNavigable(e)) { skip("control is not read-only navigation"); continue; }

      if (e.href && !/^javascript:|^#$/.test(e.href)) {
        let abs: string;
        try {
          abs = new URL(e.href, snap.url).toString();
        } catch {
          skip("control had an invalid destination URL");
          continue;
        }
        if (!abs.startsWith(origin)) { skip("destination leaves the product origin"); continue; }
        if (seenUrls.has(urlTemplate(abs))) { skip("destination URL already visited"); continue; }
        // These pages may still be ingested as documentation, but they are not
        // product journeys and billing/account areas must never be explored.
        if (["legal", "billing", "account"].includes(classifyScreenKind(abs, e.name))) { skip("legal, billing, or account screen excluded"); continue; }
        if (!checkAction({ action: "navigate", url: abs, name: e.name }, { originAllowlist: [origin] }).allowed) { skip("navigation blocked by safety policy"); continue; }
        frontier.push({ url: abs, path: [] });
      } else if (move.path.length < MAX_NAV_DEPTH && checkAction({ action: "click", role: e.role, name: e.name }).allowed) {
        const path = [...move.path, { role: e.role!, name: e.name! }];
        const pathKey = path.map((step) => `${step.role}:${step.name}`).join("/");
        if (!seenPaths.has(pathKey)) {
          seenPaths.add(pathKey);
          frontier.push({ path });
        } else skip("click path already queued");
      } else if (move.path.length >= MAX_NAV_DEPTH) {
        skip("navigation depth limit reached");
      } else {
        skip("click blocked by safety policy");
      }
    }
  }

  const result: SurveyResult = {
    screens,
    visits,
    maxVisits,
    frontierRemaining: frontier.length,
    stopReason: screens.length >= maxScreens ? "screen_limit" : visits >= maxVisits ? "visit_limit" : "frontier_exhausted",
  };
  emit("map.survey.done", { status: "ok", data: {
    screensFound: screens.length, visits, maxVisits, frontierRemaining: frontier.length,
    stopReason: result.stopReason, screensSkipped: skipped,
  } });
  return result;
}
