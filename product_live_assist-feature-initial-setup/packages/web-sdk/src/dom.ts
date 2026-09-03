import { normalizeSpace } from "./utils.js";

const IMPLICIT_ROLES: Readonly<Record<string, string>> = {
  A: "link",
  BUTTON: "button",
  SUMMARY: "button",
  TEXTAREA: "textbox",
  SELECT: "combobox",
  OPTION: "option",
  IMG: "img",
  NAV: "navigation",
  MAIN: "main",
  FORM: "form",
  TABLE: "table",
};

function realmInstance<T extends Element>(element: Element, constructorName: string, fallbackTag?: string): element is T {
  const constructor = (element.ownerDocument.defaultView as unknown as Record<string, unknown> | null)?.[constructorName];
  if (typeof constructor === "function") return element instanceof constructor;
  return !!fallbackTag && element.tagName === fallbackTag;
}

export function isHtmlElement(element: Element): element is HTMLElement {
  return realmInstance<HTMLElement>(element, "HTMLElement");
}

export function isHtmlInputElement(element: Element): element is HTMLInputElement {
  return realmInstance<HTMLInputElement>(element, "HTMLInputElement", "INPUT");
}

export function isHtmlTextAreaElement(element: Element): element is HTMLTextAreaElement {
  return realmInstance<HTMLTextAreaElement>(element, "HTMLTextAreaElement", "TEXTAREA");
}

export function isHtmlSelectElement(element: Element): element is HTMLSelectElement {
  return realmInstance<HTMLSelectElement>(element, "HTMLSelectElement", "SELECT");
}

export function isHtmlAnchorElement(element: Element): element is HTMLAnchorElement {
  return realmInstance<HTMLAnchorElement>(element, "HTMLAnchorElement", "A");
}

export function isHtmlButtonElement(element: Element): element is HTMLButtonElement {
  return realmInstance<HTMLButtonElement>(element, "HTMLButtonElement", "BUTTON");
}

export function isHtmlFormElement(element: Element): element is HTMLFormElement {
  return realmInstance<HTMLFormElement>(element, "HTMLFormElement", "FORM");
}

export function elementRole(element: Element): string {
  const explicit = element.getAttribute("role")?.trim().split(/\s+/)[0];
  if (explicit) return explicit;
  if (isHtmlInputElement(element)) {
    const type = element.type.toLowerCase();
    if (["button", "submit", "reset", "image"].includes(type)) return "button";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "range") return "slider";
    return "textbox";
  }
  return IMPLICIT_ROLES[element.tagName] ?? element.tagName.toLowerCase();
}

function referencedText(element: Element, attribute: string): string {
  const ownerDocument = element.ownerDocument;
  return (element.getAttribute(attribute) ?? "")
    .split(/\s+/)
    .map((id) => ownerDocument.getElementById(id)?.textContent ?? "")
    .join(" ");
}

export function accessibleName(element: Element): string {
  const labelledBy = normalizeSpace(referencedText(element, "aria-labelledby"));
  if (labelledBy) return labelledBy;
  const ariaLabel = normalizeSpace(element.getAttribute("aria-label") ?? "");
  if (ariaLabel) return ariaLabel;
  if (isHtmlElement(element) && element.id) {
    const label = element.ownerDocument.querySelector(`label[for="${cssAttributeValue(element.id)}"]`);
    const labelText = normalizeSpace(label?.textContent ?? "");
    if (labelText) return labelText;
  }
  const wrappingLabel = element.closest("label");
  const wrappingText = normalizeSpace(wrappingLabel?.textContent ?? "");
  if (wrappingText) return wrappingText;
  if (isHtmlInputElement(element)) {
    const value = ["button", "submit", "reset"].includes(element.type) ? element.value : "";
    if (normalizeSpace(value)) return normalizeSpace(value);
    if (normalizeSpace(element.placeholder)) return normalizeSpace(element.placeholder);
  }
  const alternative = element.getAttribute("alt") ?? element.getAttribute("title") ?? "";
  if (normalizeSpace(alternative)) return normalizeSpace(alternative);
  return normalizeSpace(element.textContent ?? "");
}

function cssAttributeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function isElementVisible(element: Element): boolean {
  const isSvg = element.namespaceURI === "http://www.w3.org/2000/svg";
  if (!isHtmlElement(element) && !isSvg) return false;
  let candidate: Element | undefined = element;
  while (candidate) {
    if (candidate.hasAttribute("hidden") || candidate.getAttribute("aria-hidden") === "true") return false;
    const style = candidate.ownerDocument.defaultView?.getComputedStyle(candidate);
    if (style && (
      style.display === "none"
      || style.visibility === "hidden"
      || style.visibility === "collapse"
      || style.contentVisibility === "hidden"
      || Number(style.opacity) === 0
    )) return false;
    const nodeRoot = candidate.getRootNode() as Node & { host?: Element };
    candidate = candidate.parentElement ?? (nodeRoot.host?.nodeType === 1 ? nodeRoot.host : undefined);
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

export function isElementEnabled(element: Element): boolean {
  const formControl = element as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  return !formControl.disabled && element.getAttribute("aria-disabled") !== "true" && !element.closest("[inert]");
}

export const INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "input:not([type='hidden'])",
  "textarea",
  "select",
  "summary",
  "[role]",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
  "[data-sable-id]",
].join(",");

export interface InspectableDomRootOptions {
  includeSameOriginFrames?: boolean;
  maximumRoots?: number;
}

/** Open Shadow DOM and same-origin frames are browser-readable; SDK-owned UI is never product state. */
export function inspectableDomRoots(root: Document = document, options: InspectableDomRootOptions = {}): ParentNode[] {
  const maximum = Math.max(1, Math.min(options.maximumRoots ?? 200, 1_000));
  const roots: ParentNode[] = [root];
  const seen = new Set<ParentNode>(roots);
  for (let index = 0; index < roots.length && roots.length < maximum; index++) {
    const current = roots[index];
    for (const element of Array.from(current.querySelectorAll("*"))) {
      if (element.matches("[data-sable-ui]") || element.closest("[data-sable-ui]")) continue;
      if (element.shadowRoot && !seen.has(element.shadowRoot)) {
        seen.add(element.shadowRoot);
        roots.push(element.shadowRoot);
      }
      if (options.includeSameOriginFrames && element.tagName === "IFRAME") {
        try {
          const frameDocument = (element as HTMLIFrameElement).contentDocument;
          if (frameDocument && !seen.has(frameDocument)) {
            seen.add(frameDocument);
            roots.push(frameDocument);
          }
        } catch {
          // The browser enforces the same-origin boundary.
        }
      }
      if (roots.length >= maximum) break;
    }
  }
  return roots;
}

export function meaningfulElements(root: ParentNode = document): Element[] {
  return Array.from(root.querySelectorAll(INTERACTIVE_SELECTOR));
}
