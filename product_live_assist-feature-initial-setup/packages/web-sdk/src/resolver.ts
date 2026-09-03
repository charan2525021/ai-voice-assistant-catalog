import type { CatalogControl, LocatorCandidate, SdkCatalog, WorkflowTarget } from "@sable/sdk-contracts";
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
