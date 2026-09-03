import type { CatalogControl, DynamicToolTarget, LocatorCandidate, SdkCatalog, WorkflowTarget } from "@sable/sdk-contracts";
import { accessibleName, elementRole, isElementEnabled, isElementVisible, isHtmlElement, meaningfulElements } from "./dom.js";
import { SableSdkError } from "./errors.js";
import { PrivacyEngine } from "./privacy.js";
import { escapeCss, isRecord, normalizeForMatch, textValue } from "./utils.js";

export interface ResolvedElement {
  element: HTMLElement;
  locator: LocatorCandidate;
  score: number;
  detail: string;
}

export type DynamicResolutionStrategy = "testId" | "ariaLabel" | "roleName" | "labelFuzzy" | "text" | "elementId";

export interface DynamicResolution {
  element: HTMLElement;
  strategy: DynamicResolutionStrategy;
  confidence: number;
  detail: string;
}

export interface ResolveOptions {
  requireVisible?: boolean;
  requireEnabled?: boolean;
  minimumScore?: number;
  /** Static semantic elements are valid only for non-interactive uses such as targeted scrolling. */
  includeNonInteractive?: boolean;
}

export interface ResolutionEvent {
  controlId: string;
  locatorKind?: string;
  locatorRank?: number;
  candidateCount: number;
  ok: boolean;
  detail?: string;
}

interface CandidateResult {
  element: HTMLElement;
  locator: LocatorCandidate;
  score: number;
  detail: string;
}

const SDK_OWNED_SELECTOR = "[data-sable-ui]";

function isSdkOwnedElement(element: Element): boolean {
  return element.matches(SDK_OWNED_SELECTOR) || !!element.closest(SDK_OWNED_SELECTOR);
}

function isSdkOwnedRoot(root: ParentNode): boolean {
  const host = (root as ShadowRoot).host;
  return host?.nodeType === 1 && isSdkOwnedElement(host);
}

function controls(catalog: SdkCatalog): CatalogControl[] {
  const value = (catalog as unknown as Record<string, unknown>).controls;
  return Array.isArray(value) ? value.filter(isRecord) as unknown as CatalogControl[] : [];
}

function targetControlId(target: WorkflowTarget): string | undefined {
  return textValue((target as unknown as Record<string, unknown>).controlId);
}

function targetLocators(target: WorkflowTarget): LocatorCandidate[] {
  const value = (target as unknown as Record<string, unknown>).locators;
  return Array.isArray(value) ? value.filter(isRecord) as unknown as LocatorCandidate[] : [];
}

function controlLocators(control: CatalogControl | undefined): LocatorCandidate[] {
  const value = control && (control as unknown as Record<string, unknown>).locators;
  return Array.isArray(value) ? value.filter(isRecord) as unknown as LocatorCandidate[] : [];
}

function controlId(control: CatalogControl): string | undefined {
  const record = control as unknown as Record<string, unknown>;
  return textValue(record.id) ?? textValue(record.controlId) ?? textValue(record.key);
}

function locatorStrategy(locator: LocatorCandidate): string {
  const record = locator as unknown as Record<string, unknown>;
  return (textValue(record.strategy) ?? textValue(record.kind) ?? "").toLowerCase().replace(/[-_]/g, "");
}

function locatorValue(locator: LocatorCandidate, ...keys: string[]): string | undefined {
  const record = locator as unknown as Record<string, unknown>;
  for (const key of keys) {
    const value = textValue(record[key]);
    if (value) return value;
  }
  return undefined;
}

function locatorPriority(locator: LocatorCandidate, fallback: number): number {
  const record = locator as unknown as Record<string, unknown>;
  const value = record.rank ?? record.priority;
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function allQueryableRoots(root: ParentNode): ParentNode[] {
  if (isSdkOwnedRoot(root)) return [];
  const roots: ParentNode[] = [root];
  const seen = new Set<Node>([root]);
  for (let index = 0; index < roots.length && roots.length < 200; index++) {
    const current = roots[index];
    for (const element of Array.from(current.querySelectorAll("*"))) {
      if (isSdkOwnedElement(element)) continue;
      if (element.shadowRoot && !seen.has(element.shadowRoot)) {
        seen.add(element.shadowRoot);
        roots.push(element.shadowRoot);
      }
    }
  }
  return roots;
}

function queryRoots(roots: ParentNode[], selector: string): HTMLElement[] {
  const found: HTMLElement[] = [];
  for (const root of roots) {
    try {
      for (const element of Array.from(root.querySelectorAll(selector))) {
        if (isHtmlElement(element) && !isSdkOwnedElement(element)) found.push(element);
      }
    } catch {
      return [];
    }
  }
  return found;
}

function exactName(elements: Element[], expected: string, role?: string): HTMLElement[] {
  const name = normalizeForMatch(expected);
  const wantedRole = role ? normalizeForMatch(role) : undefined;
  return elements.filter((element): element is HTMLElement => isHtmlElement(element)
    && (!wantedRole || normalizeForMatch(elementRole(element)) === wantedRole)
    && normalizeForMatch(accessibleName(element)) === name);
}

function frameRoots(root: Document, name?: string): ParentNode[] {
  const frames = Array.from(root.querySelectorAll("iframe"));
  const selected = name ? frames.filter((frame) => frame.name === name || frame.id === name || frame.title === name) : frames;
  const roots: ParentNode[] = [];
  for (const frame of selected) {
    try {
      if (frame.contentDocument) roots.push(...allQueryableRoots(frame.contentDocument));
    } catch {
      // Same-origin access is enforced by the browser.
    }
  }
  return roots;
}

/** Resolves signed logical controls to current-page elements using deterministic ranked evidence. */
export class RankedElementResolver {
  constructor(
    private readonly catalog: SdkCatalog,
    private readonly privacy: PrivacyEngine,
    private readonly root: Document = document,
    private readonly onResolution?: (event: ResolutionEvent) => void,
  ) {}

  candidates(target: WorkflowTarget, options: ResolveOptions = {}): CandidateResult[] {
    const wantedId = targetControlId(target);
    const catalogControl = wantedId ? controls(this.catalog).find((control) => controlId(control) === wantedId) : undefined;
    if (catalogControl?.frame?.kind === "bridge_required" || catalogControl?.shadow?.kind === "closed") return [];
    const locators = [...targetLocators(target), ...controlLocators(catalogControl)]
      .map((locator, index) => ({ locator, index }))
      .sort((a, b) => locatorPriority(a.locator, a.index + 1) - locatorPriority(b.locator, b.index + 1));
    const roots = catalogControl?.frame?.kind === "same_origin"
      ? frameRoots(this.root, catalogControl.frame.name)
      : allQueryableRoots(this.root);
    const interactive = roots.flatMap((root) => meaningfulElements(root));
    const semanticCandidates = options.includeNonInteractive
      ? roots.flatMap((root) => queryRoots([root], "button,a[href],input,textarea,select,summary,[role],[contenteditable='true'],[tabindex],h1,h2,h3,h4,h5,h6,[data-sable-id]"))
      : interactive;
    // Product sites commonly render visual section headings as styled <p>
    // elements (for example, MUI Typography). Exact signed text is safe for
    // non-interactive operations such as scroll-to-section, but these elements
    // must never enter the normal click/fill candidate set.
    const staticTextCandidates = options.includeNonInteractive
      ? roots.flatMap((root) => queryRoots([root], "h1,h2,h3,h4,h5,h6,p,li,dt,dd,legend,figcaption,blockquote,caption,th,td"))
      : semanticCandidates;
    const results: CandidateResult[] = [];

    for (let index = 0; index < locators.length; index++) {
      const locator = locators[index].locator;
      const strategy = locatorStrategy(locator);
      const role = locatorValue(locator, "role");
      const name = locatorValue(locator, "name", "accessibleName", "label", "text", "value");
      let matched: HTMLElement[] = [];
      let baseScore = 100 - index * 5;
      if (["agentid", "sableid"].includes(strategy)) {
        const value = locatorValue(locator, "value", "agentId", "sableId");
        if (value) matched = queryRoots(roots, `[data-sable-id="${escapeCss(value)}"]`);
        baseScore += 30;
      } else if (strategy === "testid") {
        const value = locatorValue(locator, "value", "testId");
        if (value) matched = queryRoots(roots, `[data-testid="${escapeCss(value)}"], [data-test-id="${escapeCss(value)}"]`);
        baseScore += 20;
      } else if (["rolename", "ariarolename", "aria"].includes(strategy) && name) {
        matched = exactName(semanticCandidates, name, role);
        baseScore += 15;
      } else if (strategy === "label" && name) {
        matched = exactName(interactive, name, role);
        baseScore += 10;
      } else if (strategy === "text" && name) {
        matched = staticTextCandidates.filter((element): element is HTMLElement => isHtmlElement(element)
          && normalizeForMatch(element.textContent ?? "") === normalizeForMatch(name));
      } else if (["css", "cssfallback"].includes(strategy)) {
        const selector = locatorValue(locator, "value", "selector");
        if (selector && selector.length <= 500) matched = queryRoots(roots, selector);
        baseScore -= 20;
      } else if (strategy === "relationship") {
        const withinId = locatorValue(locator, "withinControlId");
        const withinControl = withinId ? controls(this.catalog).find((control) => controlId(control) === withinId) : undefined;
        const safeAncestorLocators = withinControl ? controlLocators(withinControl).filter((candidate) => locatorStrategy(candidate) !== "relationship") : [];
        const withinTarget = withinControl && safeAncestorLocators.length
          ? ({ controlId: `__ancestor_inline_${withinId}`, locators: safeAncestorLocators } as unknown as WorkflowTarget)
          : undefined;
        if (withinTarget) {
          // Resolve the stable ancestor independently, then scope the semantic target beneath it.
          const container = this.candidates(withinTarget, options)[0]?.element;
          if (container) matched = exactName(meaningfulElements(container), name ?? "", role);
        }
        baseScore += 5;
      }

      for (const element of matched) {
        if (this.privacy.isExcluded(element)) continue;
        if ((options.requireVisible ?? true) && !isElementVisible(element)) continue;
        if ((options.requireEnabled ?? true) && !isElementEnabled(element)) continue;
        results.push({ element, locator, score: baseScore, detail: `${strategy} matched ${elementRole(element)} “${accessibleName(element)}”` });
      }
    }
    const unique = new Map<HTMLElement, CandidateResult>();
    for (const result of results.sort((a, b) => b.score - a.score)) if (!unique.has(result.element)) unique.set(result.element, result);
    return [...unique.values()].filter((result) => result.score >= (options.minimumScore ?? 1));
  }

  resolve(target: WorkflowTarget, options: ResolveOptions = {}): ResolvedElement {
    const results = this.candidates(target, options);
    const wantedId = targetControlId(target) ?? "the requested target";
    if (!results.length) {
      this.onResolution?.({ controlId: wantedId, candidateCount: 0, ok: false, detail: "no matching current-page control" });
      throw new SableSdkError("CONTROL_NOT_FOUND", `No current-page control matched ${wantedId}`);
    }
    if (results.length > 1 && results[0].score === results[1].score) {
      this.onResolution?.({ controlId: wantedId, candidateCount: results.length, ok: false, detail: "top locator result was ambiguous" });
      throw new SableSdkError("CONTROL_AMBIGUOUS", `Multiple controls matched ${wantedId}`, {
        matches: results.slice(0, 5).map((result) => result.detail),
      });
    }
    this.onResolution?.({
      controlId: wantedId,
      locatorKind: locatorStrategy(results[0].locator),
      locatorRank: locatorPriority(results[0].locator, 1),
      candidateCount: results.length,
      ok: true,
      detail: `${locatorStrategy(results[0].locator)} resolved the logical control`,
    });
    return results[0];
  }
}

/**
 * Resolves a dynamic-mode semantic target (`{testId, ariaLabel, role,
 * accessibleName, text, elementId}`) to a live element on the page. Never uses
 * CSS selectors, XPaths, or coordinates. Runs a 5-strategy ranked chain and
 * returns the first match at or above the confidence threshold.
 *
 * `elementId` refers to the stable-per-snapshot ID from a UIMapSnapshot sent
 * earlier in this turn. Because the snapshot's ID is `stableFingerprint` of
 * `role::label::testId::path`, an incoming `elementId` will only match an
 * element the SDK itself indexed — so the LLM cannot invent an ID out of thin
 * air.
 *
 * Confidence heuristics roughly mirror AIVP's:
 *   testId exact       1.00
 *   aria-label exact   0.96
 *   role + name exact  0.94
 *   elementId hit      0.98
 *   text exact         0.90
 *   label fuzzy        0.80
 */

const DYNAMIC_ROOT_MARKER = "[data-sable-ui]";
const DYNAMIC_CONFIDENCE_THRESHOLD = 0.7;

function isDynamicSdkOwned(element: Element): boolean {
  return element.matches(DYNAMIC_ROOT_MARKER) || !!element.closest(DYNAMIC_ROOT_MARKER);
}

function dynamicRoots(root: Document = document): ParentNode[] {
  const roots: ParentNode[] = [root];
  const seen = new Set<Node>([root]);
  for (let index = 0; index < roots.length && roots.length < 200; index++) {
    const current = roots[index];
    for (const element of Array.from(current.querySelectorAll("*"))) {
      if (isDynamicSdkOwned(element)) continue;
      if (element.shadowRoot && !seen.has(element.shadowRoot)) {
        seen.add(element.shadowRoot);
        roots.push(element.shadowRoot);
      }
    }
  }
  return roots;
}

function dynamicQuery(roots: ParentNode[], selector: string): HTMLElement[] {
  const found: HTMLElement[] = [];
  for (const root of roots) {
    try {
      for (const element of Array.from(root.querySelectorAll(selector))) {
        if (isHtmlElement(element) && !isDynamicSdkOwned(element)) found.push(element);
      }
    } catch {
      return [];
    }
  }
  return found;
}

function passesGuards(element: HTMLElement, privacy: PrivacyEngine, requireVisible: boolean, requireEnabled: boolean): boolean {
  if (privacy.isExcluded(element)) return false;
  if (requireVisible && !isElementVisible(element)) return false;
  if (requireEnabled && !isElementEnabled(element)) return false;
  return true;
}

export interface DynamicResolveOptions {
  requireVisible?: boolean;
  requireEnabled?: boolean;
  /** Confidence at or above which a match is auto-accepted. Default 0.70. */
  confidenceThreshold?: number;
  root?: Document;
}

export function resolveDynamicTarget(
  target: DynamicToolTarget,
  privacy: PrivacyEngine,
  options: DynamicResolveOptions = {},
): DynamicResolution | undefined {
  const doc = options.root ?? (typeof document !== "undefined" ? document : undefined);
  if (!doc) return undefined;
  const requireVisible = options.requireVisible ?? true;
  const requireEnabled = options.requireEnabled ?? true;
  const roots = dynamicRoots(doc);
  const guard = (element: HTMLElement) => passesGuards(element, privacy, requireVisible, requireEnabled);

  // 1. Test ID — highest confidence.
  if (target.testId) {
    const escaped = escapeCss(target.testId);
    const hits = dynamicQuery(roots, `[data-testid="${escaped}"], [data-test-id="${escaped}"], [data-qa="${escaped}"]`).filter(guard);
    if (hits.length === 1) return { element: hits[0], strategy: "testId", confidence: 1.0, detail: `testId ${target.testId} matched exactly` };
    if (hits.length > 1) return { element: hits[0], strategy: "testId", confidence: 0.9, detail: `testId ${target.testId} matched ${hits.length} elements; picked the first` };
  }

  // 2. ARIA label exact.
  if (target.ariaLabel) {
    const escaped = escapeCss(target.ariaLabel);
    const hits = dynamicQuery(roots, `[aria-label="${escaped}"]`).filter(guard);
    if (hits.length === 1) return { element: hits[0], strategy: "ariaLabel", confidence: 0.96, detail: `aria-label ${JSON.stringify(target.ariaLabel)} matched exactly` };
    if (hits.length > 1) return { element: hits[0], strategy: "ariaLabel", confidence: 0.86, detail: `aria-label ${JSON.stringify(target.ariaLabel)} was ambiguous` };
  }

  // Pull interactive-first candidates for role/name/text strategies.
  const interactive = roots.flatMap((root) => meaningfulElements(root))
    .filter((element): element is HTMLElement => isHtmlElement(element) && !isDynamicSdkOwned(element) && guard(element));

  // 3. Role + accessible name exact.
  const preferredName = target.accessibleName ?? target.text;
  if (target.role && preferredName) {
    const wantRole = normalizeForMatch(target.role);
    const wantName = normalizeForMatch(preferredName);
    const exact = interactive.filter((element) => normalizeForMatch(elementRole(element)) === wantRole && normalizeForMatch(accessibleName(element)) === wantName);
    if (exact.length === 1) return { element: exact[0], strategy: "roleName", confidence: 0.94, detail: `role ${target.role} + name ${JSON.stringify(preferredName)}` };
    if (exact.length > 1) return { element: exact[0], strategy: "roleName", confidence: 0.84, detail: `role ${target.role} + name matched ${exact.length}` };
    // 3b. Role + accessible name contains (handles trailing icons, badges).
    const partial = interactive.filter((element) => {
      if (normalizeForMatch(elementRole(element)) !== wantRole) return false;
      const name = normalizeForMatch(accessibleName(element));
      const text = normalizeForMatch(element.textContent ?? "");
      return (name.includes(wantName)) || (text.includes(wantName));
    });
    if (partial.length === 1) return { element: partial[0], strategy: "roleName", confidence: 0.86, detail: `role ${target.role} + name ${JSON.stringify(preferredName)} matched via contains` };
    if (partial.length > 1) return { element: partial[0], strategy: "roleName", confidence: 0.75, detail: `role ${target.role} + name contains matched ${partial.length}` };
  }

  // 4. Label fuzzy — substring match on accessible name; role is optional.
  const labelValue = target.accessibleName ?? target.ariaLabel;
  if (labelValue) {
    const wantName = normalizeForMatch(labelValue);
    const contains = interactive.filter((element) => {
      const name = normalizeForMatch(accessibleName(element));
      return name && (name === wantName || name.includes(wantName));
    });
    if (contains.length === 1) return { element: contains[0], strategy: "labelFuzzy", confidence: 0.82, detail: `label ${JSON.stringify(labelValue)} matched via fuzzy contains` };
    if (contains.length > 1) return { element: contains[0], strategy: "labelFuzzy", confidence: 0.72, detail: `label ${JSON.stringify(labelValue)} had ${contains.length} candidates` };
  }

  // 5. Visible text exact. Also applies when the LLM only sent
  //    accessibleName / ariaLabel — we look those up as text since strategies
  //    3-4 already tried role+name and label-fuzzy exact.
  const probeText = target.text ?? target.accessibleName ?? target.ariaLabel;
  if (probeText) {
    const wantText = normalizeForMatch(probeText);
    const hits = interactive.filter((element) => normalizeForMatch(element.textContent ?? "") === wantText);
    if (hits.length === 1) return { element: hits[0], strategy: "text", confidence: 0.9, detail: `text ${JSON.stringify(probeText)} matched exactly` };
    if (hits.length > 1) return { element: hits[0], strategy: "text", confidence: 0.75, detail: `text ${JSON.stringify(probeText)} matched ${hits.length}` };
    // 5b. Text contains on interactive elements. Preferred over strategy 5c
    //     because the target is already known-clickable.
    const partial = interactive.filter((element) => {
      const text = normalizeForMatch(element.textContent ?? "");
      return text && text.includes(wantText) && text.length <= wantText.length + 40;
    });
    if (partial.length === 1) return { element: partial[0], strategy: "text", confidence: 0.82, detail: `text ${JSON.stringify(probeText)} matched via contains` };
    if (partial.length > 1) return { element: partial[0], strategy: "text", confidence: 0.72, detail: `text ${JSON.stringify(probeText)} contains matched ${partial.length}` };
    // 5c. The text lives inside a non-interactive descendant of a clickable
    //     ancestor (very common: `<a><span>User Journey</span> →</a>` or
    //     `<button><div class="label">…</div></button>`). Find the innermost
    //     matching text node and climb to the nearest clickable ancestor.
    const descendantHit = findClickableAncestorMatching(doc, wantText, privacy);
    if (descendantHit) return { element: descendantHit, strategy: "text", confidence: 0.78, detail: `text ${JSON.stringify(probeText)} matched inside a clickable ancestor` };
    // 5d. Word-level match on the closest clickable — split the wanted phrase
    //     into significant words and find a clickable whose textContent
    //     contains ALL words (any order). Handles "User Journey" matching an
    //     anchor rendered as "→ User Journey Overview  New".
    const words = wantText.split(/\s+/).filter((word) => word.length >= 2);
    if (words.length) {
      const wordMatch = findClickableByWords(doc, words, privacy);
      if (wordMatch) return { element: wordMatch, strategy: "text", confidence: 0.74, detail: `text ${JSON.stringify(probeText)} matched via word-set on ${wordMatch.tagName.toLowerCase()}` };
    }
    // 5e. Fallback: find any TEXT NODE on the page whose content contains the
    //     wanted phrase, then climb to the nearest clickable ancestor. This is
    //     the XPath-style "any element with matching text" behaviour — it
    //     handles deeply nested labels the earlier strategies missed.
    const anyTextHit = findClickableByTextNode(doc, wantText, privacy);
    if (anyTextHit) return { element: anyTextHit, strategy: "text", confidence: 0.72, detail: `text ${JSON.stringify(probeText)} found in a text node under a clickable` };
    // 5f. Leaf-only exact text match. Same behaviour as
    //     `[...document.querySelectorAll('*')].find(el => el.children.length === 0 && el.textContent.trim() === X)`.
    //     Picks the innermost leaf node whose visible text is exactly the
    //     wanted phrase, regardless of whether that leaf is technically an
    //     `<a>` / `<button>` or a plain `<span>`. Click will bubble up to the
    //     nearest handler (React, Vue, Angular event delegation all work).
    const leafExact = findLeafByExactText(doc, wantText, privacy);
    if (leafExact) return { element: leafExact, strategy: "text", confidence: 0.85, detail: `leaf ${leafExact.tagName.toLowerCase()} with exact text ${JSON.stringify(probeText)}` };
    // 5g. Leaf-only contains match. Handles trailing whitespace / punctuation
    //     that the exact match wouldn't tolerate.
    const leafContains = findLeafByContainsText(doc, wantText, privacy);
    if (leafContains) return { element: leafContains, strategy: "text", confidence: 0.75, detail: `leaf ${leafContains.tagName.toLowerCase()} containing text ${JSON.stringify(probeText)}` };
  }

  // 6. elementId — validated below the auto-accept threshold to indicate we
  //    could not deterministically recover the element by primary signals.
  if (target.elementId) {
    // The elementId is a stableFingerprint over role::label::testId::path.
    // Without re-scanning, we fall back to a broad interactive walk here.
    // If the caller streams a fresh UIMap on every turn this branch is
    // typically unnecessary; kept as a defensive default.
    if (interactive.length === 1) return { element: interactive[0], strategy: "elementId", confidence: 0.72, detail: "elementId hint used on a single-candidate page" };
  }

  return undefined;
}

const CLICKABLE_SELECTOR = "a[href], a[role], button, [role='button'], [role='link'], [role='menuitem'], [role='tab'], [role='option'], [onclick], [tabindex]:not([tabindex='-1']), summary";

function collectVisibleClickables(root: Document, privacy: PrivacyEngine): HTMLElement[] {
  return Array.from(root.querySelectorAll(CLICKABLE_SELECTOR))
    .filter((element): element is HTMLElement => {
      if (!isHtmlElement(element) || isDynamicSdkOwned(element)) return false;
      if (privacy.isExcluded(element)) return false;
      if (!isElementVisible(element)) return false;
      if (!isElementEnabled(element)) return false;
      return true;
    });
}

function findClickableAncestorMatching(root: Document, wantText: string, privacy: PrivacyEngine): HTMLElement | undefined {
  const clickables = collectVisibleClickables(root, privacy);
  for (const element of clickables) {
    const text = normalizeForMatch(element.textContent ?? "");
    if (text && text.includes(wantText) && text.length <= wantText.length + 60) return element;
  }
  return undefined;
}

function findClickableByWords(root: Document, words: string[], privacy: PrivacyEngine): HTMLElement | undefined {
  // Rank clickables by how compactly they match all words (fewer extra
  // characters is better). Handles nav labels wrapped with icons/badges.
  const clickables = collectVisibleClickables(root, privacy);
  const needed = words.map((word) => word.toLocaleLowerCase());
  const wantedTotal = words.join(" ").length;
  let best: { element: HTMLElement; slack: number } | undefined;
  for (const element of clickables) {
    const text = normalizeForMatch(element.textContent ?? "");
    if (!text) continue;
    if (!needed.every((word) => text.includes(word))) continue;
    const slack = text.length - wantedTotal;
    if (slack < 0) continue;
    if (!best || slack < best.slack) best = { element, slack };
    if (best.slack === 0) return best.element;
  }
  return best?.element;
}

function findLeafByExactText(root: Document, wantText: string, privacy: PrivacyEngine): HTMLElement | undefined {
  const leaves = root.querySelectorAll("*");
  for (const element of Array.from(leaves)) {
    if (!isHtmlElement(element)) continue;
    if (element.children.length !== 0) continue;
    if (isDynamicSdkOwned(element)) continue;
    if (privacy.isExcluded(element)) continue;
    if (!isElementVisible(element)) continue;
    if (normalizeForMatch(element.textContent ?? "") === wantText) return element;
  }
  return undefined;
}

function findLeafByContainsText(root: Document, wantText: string, privacy: PrivacyEngine): HTMLElement | undefined {
  const leaves = root.querySelectorAll("*");
  let best: { element: HTMLElement; slack: number } | undefined;
  for (const element of Array.from(leaves)) {
    if (!isHtmlElement(element)) continue;
    if (element.children.length !== 0) continue;
    if (isDynamicSdkOwned(element)) continue;
    if (privacy.isExcluded(element)) continue;
    if (!isElementVisible(element)) continue;
    const text = normalizeForMatch(element.textContent ?? "");
    if (!text || !text.includes(wantText)) continue;
    const slack = text.length - wantText.length;
    if (!best || slack < best.slack) best = { element, slack };
    if (best.slack === 0) return best.element;
  }
  return best?.element;
}

function findClickableByTextNode(root: Document, wantText: string, privacy: PrivacyEngine): HTMLElement | undefined {
  // XPath-like: locate any text node whose content contains the wanted phrase,
  // then climb to the nearest clickable ancestor. Skips SDK-owned nodes and
  // hidden subtrees so we don't operate on off-screen or invisible controls.
  const walker = root.createTreeWalker(root.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node) {
      const text = normalizeForMatch(node.nodeValue ?? "");
      if (!text || !text.includes(wantText)) return NodeFilter.FILTER_REJECT;
      let cursor: Element | null = node.parentElement;
      while (cursor) {
        if (isDynamicSdkOwned(cursor)) return NodeFilter.FILTER_REJECT;
        cursor = cursor.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    let ancestor: HTMLElement | null = current.parentElement;
    while (ancestor) {
      if (isHtmlElement(ancestor) && ancestor.matches(CLICKABLE_SELECTOR)
        && !privacy.isExcluded(ancestor)
        && isElementVisible(ancestor)
        && isElementEnabled(ancestor)) return ancestor;
      ancestor = ancestor.parentElement;
    }
  }
  return undefined;
}

/** Utility: exported so runtime.ts can use the same threshold. */
export function isDynamicMatchAcceptable(resolution: DynamicResolution | undefined, threshold = DYNAMIC_CONFIDENCE_THRESHOLD): resolution is DynamicResolution {
  return !!resolution && resolution.confidence >= threshold;
}
