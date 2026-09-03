import type { PrivacyPolicy } from "@sable/sdk-contracts";
import { isElementVisible } from "./dom.js";
import { boundedString, isRecord, normalizeSpace, textValue } from "./utils.js";

const BUILT_IN_PRIVATE_SELECTORS = [
  "[data-sable-private]",
  "[data-private]",
  "[data-sable-observe='off']",
  "[data-sable-ui]",
  "input[type='password']",
  "input[autocomplete='current-password']",
  "input[autocomplete='new-password']",
  "input[autocomplete='one-time-code']",
  "input[autocomplete='cc-number']",
  "input[autocomplete='cc-csc']",
];

const SECRET_KEYS = /(?:authorization|cookie|password|passwd|secret|token|api[-_ ]?key|otp|credit[-_ ]?card|cvv|cvc)/i;
const SECRET_TEXT_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
  /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:sk|pk|api)[-_][A-Za-z0-9_-]{16,}\b/gi,
  /\b(?:\d[ -]*?){13,19}\b/g,
];

export interface PrivacyOverrides {
  excludeSelectors?: string[];
  redactSelectors?: string[];
  maxTextChars?: number;
  includeVisibleText?: boolean;
}

export interface PrivacySnapshotPolicy {
  excludeSelectors: string[];
  redactSelectors: string[];
  maxTextChars: number;
  includeVisibleText: boolean;
}

function arrayField(source: unknown, ...keys: string[]): string[] {
  if (!isRecord(source)) return [];
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && !!item.trim());
  }
  return [];
}

function booleanField(source: unknown, fallback: boolean, ...keys: string[]): boolean {
  if (!isRecord(source)) return fallback;
  for (const key of keys) if (typeof source[key] === "boolean") return source[key] as boolean;
  return fallback;
}

function numberField(source: unknown, fallback: number, ...keys: string[]): number {
  if (!isRecord(source)) return fallback;
  for (const key of keys) {
    const candidate = source[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  return fallback;
}

function validSelectors(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/**
 * Redaction happens before data is used by recognition, transport, or telemetry.
 * Local overrides can add restrictions but cannot remove catalog restrictions.
 */
export class PrivacyEngine {
  readonly policy: PrivacySnapshotPolicy;
  private readonly textRules: { pattern: RegExp; replacement: string }[] = [];
  private readonly excludedRoutes: string[];

  constructor(catalogPolicy?: PrivacyPolicy, overrides: PrivacyOverrides = {}) {
    const rules = isRecord(catalogPolicy) && Array.isArray(catalogPolicy.rules) ? catalogPolicy.rules.filter(isRecord) : [];
    const ruleSelectors = (action: "exclude" | "redact") => rules.flatMap((rule) => {
      if (rule.action !== action) return [];
      if (rule.kind === "selector" && textValue(rule.selector)) return [rule.selector as string];
      if (rule.kind === "input_type" && textValue(rule.inputType)) return [`input[type="${String(rule.inputType).replace(/"/g, '\\"')}"]`];
      if (rule.kind === "attribute" && textValue(rule.attribute)) {
        const attribute = String(rule.attribute).replace(/[^a-zA-Z0-9_:-]/g, "");
        if (!attribute) return [];
        return rule.value === undefined ? [`[${attribute}]`] : [`[${attribute}="${String(rule.value).replace(/"/g, '\\"')}"]`];
      }
      return [];
    });
    for (const rule of rules) {
      if (rule.kind !== "text_pattern" || !textValue(rule.pattern)) continue;
      try {
        this.textRules.push({
          pattern: new RegExp(rule.pattern as string, typeof rule.flags === "string" ? rule.flags : "g"),
          replacement: typeof rule.replacement === "string" ? rule.replacement : "[redacted]",
        });
      } catch {
        // Invalid signed privacy patterns fail safely by leaving built-in secret redaction active.
      }
    }
    this.excludedRoutes = isRecord(catalogPolicy) && Array.isArray(catalogPolicy.excludedRoutes)
      ? catalogPolicy.excludedRoutes.filter((item): item is string => typeof item === "string")
      : [];
    this.policy = {
      excludeSelectors: validSelectors([
        ...BUILT_IN_PRIVATE_SELECTORS,
        ...ruleSelectors("exclude"),
        ...arrayField(catalogPolicy, "excludeSelectors", "excludedSelectors"),
        ...(overrides.excludeSelectors ?? []),
      ]),
      redactSelectors: validSelectors([
        ...ruleSelectors("redact"),
        ...arrayField(catalogPolicy, "redactSelectors", "redactedSelectors"),
        ...(overrides.redactSelectors ?? []),
      ]),
      maxTextChars: Math.max(0, Math.min(
        overrides.maxTextChars ?? numberField(catalogPolicy, 20_000, "maximumVisibleTextChars", "maxTextChars", "visibleTextLimit"),
        50_000,
      )),
      includeVisibleText: overrides.includeVisibleText === false
        ? false
        : isRecord(catalogPolicy) && catalogPolicy.defaultTextTreatment === "redact"
          ? false
          : booleanField(catalogPolicy, true, "includeVisibleText", "allowVisibleText"),
    };
  }

  routeIsExcluded(url: string): boolean {
    let comparable = url;
    try {
      const parsed = new URL(url, globalThis.location?.href);
      comparable = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      // Compare the raw value when it is not a URL.
    }
    return this.excludedRoutes.some((pattern) => {
      if (pattern.startsWith("regex:")) {
        try { return new RegExp(pattern.slice(6)).test(comparable); } catch { return true; }
      }
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      try { return new RegExp(`^${escaped}$`).test(comparable); } catch { return comparable.startsWith(pattern); }
    });
  }

  private matchesAny(element: Element, selectors: readonly string[]): boolean {
    for (const selector of selectors) {
      try {
        let candidate: Element | undefined = element;
        while (candidate) {
          if (candidate.matches(selector) || candidate.closest(selector)) return true;
          const nodeRoot = candidate.getRootNode() as Node & { host?: Element };
          const shadowHost: Element | undefined = nodeRoot.host;
          candidate = shadowHost?.nodeType === 1 ? shadowHost : undefined;
        }
      } catch {
        // A malformed selector must never disable the other privacy rules.
      }
    }
    return false;
  }

  isExcluded(element: Element): boolean {
    return this.matchesAny(element, this.policy.excludeSelectors);
  }

  isRedacted(element: Element): boolean {
    if (this.isExcluded(element)) return true;
    if (this.matchesAny(element, this.policy.redactSelectors)) return true;
    const html = element as HTMLElement;
    const name = [html.getAttribute("name"), html.id, html.getAttribute("aria-label"), html.getAttribute("autocomplete")]
      .filter(Boolean).join(" ");
    return SECRET_KEYS.test(name);
  }

  redactText(value: string): string {
    let result = normalizeSpace(value);
    for (const pattern of SECRET_TEXT_PATTERNS) result = result.replace(pattern, "[redacted]");
    for (const rule of this.textRules) result = result.replace(rule.pattern, rule.replacement);
    return boundedString(result, this.policy.maxTextChars);
  }

  /** Keeps route shape for recognition while removing query credentials and values. */
  redactUrl(value: string): string {
    try {
      const url = new URL(value, globalThis.location?.href);
      url.username = "";
      url.password = "";
      for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, "[redacted]");
      if (/(?:access_token|id_token|code|secret|password|session|auth)=/i.test(url.hash)) url.hash = "#[redacted]";
      else if (url.hash.length > 500) url.hash = `${url.hash.slice(0, 499)}…`;
      return url.toString();
    } catch {
      return "[invalid-url]";
    }
  }

  /** Recursively scrubs event and command payloads before they cross the network boundary. */
  scrubPayload(value: unknown, depth = 0): unknown {
    if (depth > 8) return "[depth-limited]";
    if (typeof value === "string") return this.redactText(value);
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.slice(0, 500).map((item) => this.scrubPayload(item, depth + 1));
    const clean: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      clean[key] = SECRET_KEYS.test(key) ? "[redacted]" : this.scrubPayload(item, depth + 1);
    }
    return clean;
  }

  visibleText(root: ParentNode = document): string {
    if (!this.policy.includeVisibleText || this.policy.maxTextChars === 0) return "";
    const ownerDocument = root.nodeType === 9 ? root as Document : root.ownerDocument ?? document;
    const visibility = new WeakMap<Element, boolean>();
    const walker = ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parent = node.parentElement;
        if (!parent || this.isExcluded(parent) || this.isRedacted(parent)) return NodeFilter.FILTER_REJECT;
        if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(parent.tagName)) return NodeFilter.FILTER_REJECT;
        let visible = visibility.get(parent);
        if (visible === undefined) {
          visible = isElementVisible(parent);
          visibility.set(parent, visible);
        }
        if (!visible) return NodeFilter.FILTER_REJECT;
        return textValue(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const pieces: string[] = [];
    let length = 0;
    while (walker.nextNode() && length < this.policy.maxTextChars) {
      const text = normalizeSpace(walker.currentNode.nodeValue ?? "");
      if (!text) continue;
      const redacted = this.redactText(text);
      pieces.push(redacted);
      length += redacted.length + 1;
    }
    return boundedString(pieces.join(" "), this.policy.maxTextChars);
  }
}
