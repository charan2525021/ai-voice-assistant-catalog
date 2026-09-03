import type { CatalogControl, CatalogScreen, LocatorCandidate, ScreenAnchor, ScreenObservation, ScreenVariant, SdkCatalog } from "@sable/sdk-contracts";
import { normalizeForMatch } from "./utils.js";

export interface ScreenMatchEvidence {
  kind: "route" | "title" | "text" | "control" | "dom_marker";
  value: string;
  matched: boolean;
  weight: number;
}

export interface ScreenMatch {
  screen: CatalogScreen;
  screenId: string;
  variantId?: string;
  confidence: number;
  minimumConfidence: number;
  evidence: ScreenMatchEvidence[];
}

export interface RecognizerOptions {
  minimumConfidence?: number;
}

function routeMatches(currentUrl: string, pattern: string): boolean {
  let current: URL;
  try { current = new URL(currentUrl); } catch { return false; }
  const comparable = `${current.pathname}${current.search}${current.hash}`;
  if (pattern.startsWith("regex:")) {
    if (pattern.length > 500) return false;
    try { return new RegExp(pattern.slice(6)).test(comparable); } catch { return false; }
  }
  if (/^https?:\/\//i.test(pattern)) return current.href === pattern || current.href.startsWith(pattern);
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/:[A-Za-z][A-Za-z0-9_]*/g, "[^/]+");
  try { return new RegExp(`^${escaped}$`).test(comparable); } catch { return false; }
}

function locatorSuggestsObservedControl(locator: LocatorCandidate, observation: ScreenObservation): boolean {
  const elements = observation.elements.filter((element) => element.visible);
  if (locator.kind === "agent_id" || locator.kind === "test_id") {
    return elements.some((element) => element.id === locator.value || element.controlId === locator.value);
  }
  if (locator.kind === "aria_role_name") {
    return elements.some((element) => normalizeForMatch(element.role) === normalizeForMatch(locator.role)
      && normalizeForMatch(element.name) === normalizeForMatch(locator.name));
  }
  if (locator.kind === "label" || locator.kind === "text") {
    const text = locator.kind === "label" ? locator.text : locator.text;
    return elements.some((element) => normalizeForMatch(element.name) === normalizeForMatch(text));
  }
  return false;
}

function controlMatches(controlId: string, catalog: SdkCatalog, observation: ScreenObservation): boolean {
  const control = catalog.controls.find((candidate) => candidate.id === controlId);
  if (!control) return false;
  return observation.elements.some((element) => element.controlId === controlId || normalizeForMatch(element.name) === normalizeForMatch(control.name))
    || control.locators.some((locator) => locatorSuggestsObservedControl(locator, observation));
}

function markerMatches(anchor: Extract<ScreenAnchor, { kind: "dom_marker" }>, root?: Document): boolean {
  if (!root || !/^[A-Za-z_:][A-Za-z0-9_.:-]*$/.test(anchor.attribute)) return false;
  const value = anchor.value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  try { return !!root.querySelector(`[${anchor.attribute}="${value}"]`); } catch { return false; }
}

function evidenceFor(anchor: ScreenAnchor, catalog: SdkCatalog, observation: ScreenObservation, root?: Document): ScreenMatchEvidence {
  if (anchor.kind === "route") return { kind: "route", value: anchor.pattern, matched: routeMatches(observation.url, anchor.pattern), weight: anchor.weight };
  if (anchor.kind === "title") return { kind: "title", value: anchor.text, matched: normalizeForMatch(observation.title).includes(normalizeForMatch(anchor.text)), weight: anchor.weight };
  if (anchor.kind === "text") return { kind: "text", value: anchor.text, matched: normalizeForMatch(observation.visibleText ?? "").includes(normalizeForMatch(anchor.text)), weight: anchor.weight };
  if (anchor.kind === "control") return { kind: "control", value: anchor.controlId, matched: controlMatches(anchor.controlId, catalog, observation), weight: anchor.weight };
  return { kind: "dom_marker", value: `${anchor.attribute}=${anchor.value}`, matched: markerMatches(anchor, root), weight: anchor.weight };
}

function variantEligible(variant: ScreenVariant, root?: Document): boolean {
  const width = root?.defaultView?.innerWidth;
  if (width !== undefined && variant.viewport) {
    if (variant.viewport.minimumWidth !== undefined && width < variant.viewport.minimumWidth) return false;
    if (variant.viewport.maximumWidth !== undefined && width > variant.viewport.maximumWidth) return false;
  }
  const pageLocale = root?.documentElement.lang || globalThis.navigator?.language;
  if (variant.locale && pageLocale) {
    const wanted = variant.locale.toLocaleLowerCase();
    const current = pageLocale.toLocaleLowerCase();
    if (wanted !== current && wanted.split("-")[0] !== current.split("-")[0]) return false;
  }
  return true;
}

function scoreVariant(screen: CatalogScreen, variant: ScreenVariant, catalog: SdkCatalog, observation: ScreenObservation, root?: Document): ScreenMatch {
  const evidence = variant.anchors.map((anchor) => evidenceFor(anchor, catalog, observation, root));
  const possible = evidence.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
  const earned = evidence.reduce((sum, item) => sum + (item.matched ? Math.max(0, item.weight) : 0), 0);
  return {
    screen,
    screenId: screen.id,
    variantId: variant.id,
    confidence: possible ? earned / possible : 0,
    minimumConfidence: variant.minimumConfidence,
    evidence,
  };
}

/** Deterministic, local screen matching; alternate layouts are scored independently. */
export class ScreenRecognizer {
  private readonly minimumConfidence: number;

  constructor(
    private readonly catalog: SdkCatalog,
    options: RecognizerOptions = {},
    private readonly root: Document | undefined = typeof document === "undefined" ? undefined : document,
  ) {
    this.minimumConfidence = Math.max(0, Math.min(options.minimumConfidence ?? 0.55, 1));
  }

  ranked(observation: ScreenObservation): ScreenMatch[] {
    return this.catalog.screens.map((screen) => {
      const variants = screen.variants.filter((variant) => variantEligible(variant, this.root));
      const matches = variants.map((variant) => scoreVariant(screen, variant, this.catalog, observation, this.root));
      return matches.sort((left, right) => right.confidence - left.confidence || (left.variantId ?? "").localeCompare(right.variantId ?? ""))[0]
        ?? { screen, screenId: screen.id, confidence: 0, minimumConfidence: 1, evidence: [] };
    }).sort((left, right) => right.confidence - left.confidence || left.screenId.localeCompare(right.screenId));
  }

  recognize(observation: ScreenObservation): ScreenMatch | undefined {
    const best = this.ranked(observation)[0];
    const threshold = best ? Math.max(this.minimumConfidence, best.minimumConfidence) : 1;
    return best && best.confidence >= threshold ? best : undefined;
  }

  /** Adds the deterministic catalog screen identity used at network boundaries. */
  enrich(observation: ScreenObservation): ScreenObservation {
    const match = this.recognize(observation);
    return match ? { ...observation, matchedScreenId: match.screenId, matchConfidence: match.confidence } : observation;
  }

  /** Checks only signed route anchors before a navigation leaves the page. */
  destinationMatchesScreen(screenId: string, destinationUrl: string): boolean {
    const screen = this.catalog.screens.find((candidate) => candidate.id === screenId);
    return !!screen?.variants.some((variant) => variant.anchors.some((anchor) => anchor.kind === "route" && routeMatches(destinationUrl, anchor.pattern)));
  }
}
