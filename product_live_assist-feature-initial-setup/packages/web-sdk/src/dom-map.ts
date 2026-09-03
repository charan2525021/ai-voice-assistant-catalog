import type { UIMapElement, UIMapSnapshot } from "@sable/sdk-contracts";
import {
  accessibleName,
  elementRole,
  inspectableDomRoots,
  isElementVisible,
  isHtmlAnchorElement,
  isHtmlButtonElement,
  isHtmlElement,
  isHtmlInputElement,
  isHtmlSelectElement,
  isHtmlTextAreaElement,
  meaningfulElements,
} from "./dom.js";
import { PrivacyEngine } from "./privacy.js";
import { boundedString, normalizeSpace, stableFingerprint } from "./utils.js";

/**
 * Dynamic-mode DOM snapshot builder. Produces a semantic UIMap the runtime can
 * put in an LLM prompt to reason about the live page. This is intentionally
 * separate from `DomScreenObserver`, which produces a signed-catalog-shaped
 * `ScreenObservation` — dynamic mode is not tied to any catalog and cannot
 * consume that shape without indirection.
 *
 * Invariants enforced here:
 *
 *   * Elements owned by the SDK UI itself (marked with `[data-sable-ui]`) are
 *     never included, so the assistant's own overlay does not appear in the map.
 *   * Elements excluded by `PrivacyEngine.isExcluded` are dropped entirely;
 *     elements matching a "redact" rule are kept but their `text`/`label` values
 *     are replaced with a static placeholder and `sensitive` is set to true.
 *   * The output list is capped at `maxElements` (defaults to 200); interactive
 *     controls are collected first so a large host page never drowns out the
 *     buttons/inputs the LLM actually needs.
 *   * Paths are semantic (e.g. `/main/form/input[3]`), never CSS selectors.
 *
 * See `dom-map.ts` in the docs for the design rationale.
 */

const SDK_OWNED_SELECTOR = "[data-sable-ui]";
const DEFAULT_MAX_ELEMENTS = 200;
const REDACTED_LABEL = "[redacted]";

export interface UIMapCaptureOptions {
  /** Maximum interactive + informational elements combined. */
  maxElements?: number;
  /** Include headings/labels for context (default true when interactive < half of cap). */
  includeContext?: boolean;
  /** Root document to walk. Defaults to `globalThis.document`. */
  root?: Document;
}

interface Working {
  element: HTMLElement;
  role: string;
  accessible: string;
  testId?: string;
  isInteractive: boolean;
}

function safeDocument(root: Document | undefined): Document | undefined {
  return root ?? (typeof document !== "undefined" ? document : undefined);
}

function isSdkOwnedElement(element: Element): boolean {
  return element.matches(SDK_OWNED_SELECTOR) || !!element.closest(SDK_OWNED_SELECTOR);
}

function readTestId(element: Element): string | undefined {
  if (!isHtmlElement(element)) return undefined;
  const data = element.dataset;
  return data.testid ?? data.qa ?? data.testId ?? undefined;
}

function inferInteractiveRole(element: HTMLElement): string {
  const explicit = elementRole(element);
  if (explicit) return explicit;
  const tag = element.tagName.toLowerCase();
  if (tag === "input") {
    const type = (element as HTMLInputElement).type;
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "button" || type === "submit" || type === "reset" || type === "image") return "button";
    return "textbox";
  }
  if (tag === "textarea") return "textbox";
  if (tag === "select") return "combobox";
  if (tag === "button") return "button";
  if (tag === "a") return "link";
  return tag;
}

function editableCandidate(element: HTMLElement): boolean {
  if (element.isContentEditable) return true;
  if (isHtmlInputElement(element)) {
    const type = element.type.toLowerCase();
    return !["button", "submit", "reset", "image", "hidden"].includes(type);
  }
  return isHtmlTextAreaElement(element);
}

function ancestorIndex(element: Element): number {
  const parent = element.parentElement;
  if (!parent) return 1;
  const tag = element.tagName;
  let index = 0;
  for (const sibling of Array.from(parent.children)) {
    if (sibling.tagName === tag) index += 1;
    if (sibling === element) return index;
  }
  return 1;
}

function semanticPath(element: HTMLElement): string {
  const segments: string[] = [];
  let cursor: HTMLElement | null = element;
  let depth = 0;
  while (cursor && depth < 8) {
    const tag = cursor.tagName.toLowerCase();
    const index = ancestorIndex(cursor);
    const testId = readTestId(cursor);
    const role = elementRole(cursor);
    const key = testId ? `${tag}#${testId}` : role && role !== tag ? `${tag}[${role}]` : `${tag}${index > 1 ? `[${index}]` : ""}`;
    segments.unshift(key);
    if (tag === "main" || tag === "body" || tag === "form" || tag === "html") break;
    cursor = cursor.parentElement;
    depth += 1;
  }
  const joined = "/" + segments.join("/");
  return joined.length > 600 ? joined.slice(joined.length - 600) : joined;
}

function readValueText(element: HTMLElement): string {
  if (isHtmlInputElement(element)) return normalizeSpace(element.value || element.getAttribute("value") || "");
  if (isHtmlTextAreaElement(element)) return normalizeSpace(element.value || "");
  if (isHtmlSelectElement(element)) return normalizeSpace(element.selectedOptions[0]?.text ?? "");
  return "";
}

function readLabel(element: HTMLElement, computedName: string): string {
  if (computedName) return computedName;
  const forId = element.id ? element.ownerDocument.querySelector(`label[for="${CSS.escape(element.id)}"]`) : null;
  if (forId?.textContent) return normalizeSpace(forId.textContent);
  const wrapping = element.closest("label");
  if (wrapping?.textContent) return normalizeSpace(wrapping.textContent);
  if (isHtmlInputElement(element) || isHtmlTextAreaElement(element)) {
    return element.placeholder ? normalizeSpace(element.placeholder) : "";
  }
  return "";
}

function shortText(element: HTMLElement): string {
  const raw = normalizeSpace(element.textContent ?? "");
  return raw ? boundedString(raw, 300) : "";
}

function contextualCandidates(root: ParentNode, limit: number): HTMLElement[] {
  if (limit <= 0) return [];
  const selectors = ["h1", "h2", "h3", "h4", "[role='heading']", "label", "[data-testid]"] as const;
  const found: HTMLElement[] = [];
  for (const selector of selectors) {
    for (const element of Array.from(root.querySelectorAll(selector))) {
      if (!isHtmlElement(element) || isSdkOwnedElement(element)) continue;
      if (!isElementVisible(element)) continue;
      found.push(element);
      if (found.length >= limit) return found;
    }
  }
  return found;
}

function isInteractiveElement(element: HTMLElement): boolean {
  const tag = element.tagName.toLowerCase();
  return (
    tag === "button" ||
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    (tag === "a" && isHtmlAnchorElement(element) && !!element.getAttribute("href")) ||
    (tag === "summary") ||
    !!element.getAttribute("role") ||
    element.tabIndex >= 0 ||
    element.hasAttribute("contenteditable")
  );
}

/**
 * Captures a bounded semantic UIMap of the current DOM. Fast enough to run once
 * per user turn; callers are expected to gate it behind a debounce or trigger.
 */
export function captureUIMapSnapshot(privacy: PrivacyEngine, options: UIMapCaptureOptions = {}): UIMapSnapshot | undefined {
  const root = safeDocument(options.root);
  if (!root || !root.body) return undefined;
  const max = Math.max(20, Math.min(options.maxElements ?? DEFAULT_MAX_ELEMENTS, 500));
  const roots = inspectableDomRoots(root, { maximumRoots: 40 }).filter((candidate) => {
    const host = (candidate as ShadowRoot).host;
    return !host || !isHtmlElement(host) || !isSdkOwnedElement(host);
  });

  const collected = new Map<HTMLElement, Working>();
  for (const parent of roots) {
    for (const element of meaningfulElements(parent)) {
      if (!isHtmlElement(element)) continue;
      if (isSdkOwnedElement(element)) continue;
      if (privacy.isExcluded(element)) continue;
      if (collected.has(element)) continue;
      const role = inferInteractiveRole(element);
      const accessible = accessibleName(element);
      collected.set(element, {
        element,
        role,
        accessible,
        testId: readTestId(element),
        isInteractive: true,
      });
      if (collected.size >= max) break;
    }
    if (collected.size >= max) break;
  }

  // Add contextual headings/labels only after interactive controls are captured.
  const contextLimit = options.includeContext === false ? 0 : Math.max(0, Math.floor(max / 4));
  if (contextLimit > 0 && collected.size < max) {
    for (const parent of roots) {
      for (const element of contextualCandidates(parent, max - collected.size)) {
        if (collected.has(element)) continue;
        if (privacy.isExcluded(element)) continue;
        collected.set(element, {
          element,
          role: elementRole(element) || element.tagName.toLowerCase(),
          accessible: accessibleName(element),
          testId: readTestId(element),
          isInteractive: false,
        });
        if (collected.size >= max) break;
      }
      if (collected.size >= max) break;
    }
  }

  const elements: UIMapElement[] = [];
  for (const working of collected.values()) {
    const element = working.element;
    const visible = isElementVisible(element);
    const editable = editableCandidate(element);
    const label = readLabel(element, working.accessible);
    const rawText = shortText(element);
    const valueText = readValueText(element);
    const placeholder = isHtmlInputElement(element) || isHtmlTextAreaElement(element) ? element.placeholder || undefined : undefined;
    const id = stableFingerprint(`${working.role}::${label}::${working.testId ?? ""}::${semanticPath(element)}`);

    // Redact sensitive elements: keep them in the map so the LLM can see their
    // role, but never leak the underlying values or labels.
    const redactedNode = element.matches?.("[data-sable-privacy='redact']") ?? false;
    const sensitive = redactedNode || (isHtmlInputElement(element) && ["password", "credit-card", "cc-number", "otp"].some((token) => element.autocomplete?.includes?.(token) ?? false));

    elements.push({
      id,
      role: working.role,
      ...(label && !sensitive ? { label } : sensitive && working.role ? { label: REDACTED_LABEL } : {}),
      ...(working.accessible && !sensitive ? { accessibleName: working.accessible } : {}),
      ...(working.testId ? { testId: working.testId } : {}),
      ...(rawText && !sensitive ? { text: valueText ? `${valueText} • ${rawText.slice(0, 200)}` : rawText } : {}),
      ...(placeholder && !sensitive ? { placeholder } : {}),
      path: semanticPath(element),
      ...(sensitive ? { sensitive: true } : {}),
      ...(editable ? { editable: true } : {}),
      visible,
    });
  }

  return {
    url: root.location?.href ? boundedString(privacy.redactUrl(root.location.href), 4_000) : "",
    path: root.location?.pathname ? boundedString(root.location.pathname, 2_000) : "/",
    ...(root.title ? { title: boundedString(root.title, 2_000) } : {}),
    elements: elements.slice(0, max),
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Lightweight change detector. Wraps `captureUIMapSnapshot` behind a
 * MutationObserver so callers can request the most-recent bounded snapshot
 * without re-walking the DOM on every request. Invalidation is debounced by
 * `settleMs` (default 250 ms) to match AIVP semantics.
 */
export class DynamicUIMapWatcher {
  private cached?: UIMapSnapshot;
  private dirty = true;
  private timer?: ReturnType<typeof setTimeout>;
  private mutationObserver?: MutationObserver;
  private routeUnbind?: () => void;

  constructor(
    private readonly privacy: PrivacyEngine,
    private readonly options: UIMapCaptureOptions & { settleMs?: number } = {},
  ) {}

  start(): void {
    const doc = safeDocument(this.options.root);
    if (!doc || this.mutationObserver) return;
    this.mutationObserver = new MutationObserver(() => this.markDirty());
    this.mutationObserver.observe(doc.body, { childList: true, subtree: true, attributes: true, characterData: true });

    const win = doc.defaultView;
    const onPop = () => this.markDirty();
    win?.addEventListener("popstate", onPop);
    // History API monkey-patch is common in SDKs; keep it scoped to the routeUnbind lifetime.
    const originalPush = win?.history?.pushState;
    const originalReplace = win?.history?.replaceState;
    if (win?.history && originalPush) {
      win.history.pushState = function (this: History, ...args) {
        const value = originalPush.apply(this, args as never);
        win.dispatchEvent(new Event("sable:route"));
        return value;
      } as History["pushState"];
    }
    if (win?.history && originalReplace) {
      win.history.replaceState = function (this: History, ...args) {
        const value = originalReplace.apply(this, args as never);
        win.dispatchEvent(new Event("sable:route"));
        return value;
      } as History["replaceState"];
    }
    const onRoute = () => this.markDirty();
    win?.addEventListener("sable:route", onRoute);

    this.routeUnbind = () => {
      win?.removeEventListener("popstate", onPop);
      win?.removeEventListener("sable:route", onRoute);
      if (win?.history && originalPush) win.history.pushState = originalPush;
      if (win?.history && originalReplace) win.history.replaceState = originalReplace;
    };
  }

  stop(): void {
    this.mutationObserver?.disconnect();
    this.mutationObserver = undefined;
    this.routeUnbind?.();
    this.routeUnbind = undefined;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  snapshot(): UIMapSnapshot | undefined {
    if (!this.dirty && this.cached) return this.cached;
    const built = captureUIMapSnapshot(this.privacy, this.options);
    this.cached = built;
    this.dirty = !built;
    return built;
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.timer) return;
    const settle = Math.max(50, Math.min(this.options.settleMs ?? 250, 5_000));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // Do not eagerly recompute. Next `snapshot()` call will refresh.
    }, settle);
  }
}
