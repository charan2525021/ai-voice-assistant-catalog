import type {
  JsonValue,
  ResolvedAction,
  ScreenObservation,
  TemplateValue,
  WorkflowAssertion,
  WorkflowTarget,
} from "@sable/sdk-contracts";
import type { ActionDriver, DriverResult } from "@sable/workflow-core";
import {
  accessibleName,
  isElementEnabled,
  isElementVisible,
  isHtmlAnchorElement,
  isHtmlButtonElement,
  isHtmlElement,
  isHtmlFormElement,
  isHtmlInputElement,
  isHtmlSelectElement,
  isHtmlTextAreaElement,
} from "./dom.js";
import { SableSdkError, throwIfAborted } from "./errors.js";
import { DomScreenObserver } from "./observer.js";
import { PrivacyEngine } from "./privacy.js";
import { ScreenRecognizer } from "./recognizer.js";
import { RankedElementResolver } from "./resolver.js";
import { ToolRegistry } from "./tools.js";
import { normalizeForMatch, sleep, stableFingerprint } from "./utils.js";

export interface BrowserActionDriverOptions {
  maximumWaitMs?: number;
  root?: Document;
  onBeforeDocumentNavigation?: (request: BrowserDocumentNavigationRequest) => Promise<string | false>;
}

export interface BrowserDocumentNavigationRequest {
  action: ResolvedAction;
  currentUrl: string;
  destinationUrl: string;
  classification: "full_page" | "cross_origin";
}

export type BrowserNavigationClassification = "same_document" | "full_page" | "cross_origin" | "invalid";

/**
 * A full document load destroys this in-memory SDK and its one-time socket.
 * Only same-document navigation can be completed synchronously by this driver.
 */
export function classifyBrowserNavigation(currentUrl: string, value: string): BrowserNavigationClassification {
  let current: URL;
  let destination: URL;
  try {
    current = new URL(currentUrl);
    destination = new URL(value, current);
  } catch { return "invalid"; }
  if (destination.origin !== current.origin) return "cross_origin";
  return destination.pathname === current.pathname && destination.search === current.search
    ? "same_document"
    : "full_page";
}

export function targetMatchesRecognizedScreen(target: WorkflowTarget | undefined, recognizedScreenId: string | undefined): boolean {
  return !target?.screenId || target.screenId === recognizedScreenId;
}

function stringValue(value: JsonValue | undefined): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function literalTemplate(value: TemplateValue | undefined): JsonValue | undefined {
  if (!value) return undefined;
  if (value.kind === "literal") return value.value;
  if (value.kind === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value.properties)) {
      const resolved = literalTemplate(item);
      if (resolved !== undefined) result[key] = resolved;
    }
    return result;
  }
  if (value.kind === "array") return value.items.map(literalTemplate).filter((item): item is JsonValue => item !== undefined);
  return value.fallback;
}

function setNativeValue(element: HTMLElement, value: string): void {
  if (isHtmlInputElement(element)) {
    const prototype = element.ownerDocument.defaultView?.HTMLInputElement.prototype ?? HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    setter?.call(element, value);
  } else if (isHtmlTextAreaElement(element)) {
    const prototype = element.ownerDocument.defaultView?.HTMLTextAreaElement.prototype ?? HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    setter?.call(element, value);
  } else if (element.isContentEditable) {
    element.textContent = value;
  } else {
    throw new SableSdkError("UNSUPPORTED_ACTION", `${element.tagName.toLowerCase()} cannot be filled safely`);
  }
  element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: null }));
  element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
}

function safeRegex(pattern: string): RegExp | undefined {
  if (pattern.length > 500) return undefined;
  try { return new RegExp(pattern); } catch { return undefined; }
}

function isNativeSubmitControl(element: HTMLElement): boolean {
  return (isHtmlButtonElement(element) && element.type === "submit" && !!element.form)
    || (isHtmlInputElement(element) && ["submit", "image"].includes(element.type) && !!element.form);
}

/** Browser implementation of workflow-core's driver; every action occurs in the host page. */
export class BrowserActionDriver implements ActionDriver {
  private readonly root: Document;
  private readonly maximumWaitMs: number;
  private readonly onBeforeDocumentNavigation?: BrowserActionDriverOptions["onBeforeDocumentNavigation"];
  private journeyId = "unknown";

  constructor(
    private readonly observer: DomScreenObserver,
    private readonly resolver: RankedElementResolver,
    private readonly recognizer: ScreenRecognizer,
    private readonly tools: ToolRegistry,
    private readonly privacy: PrivacyEngine,
    options: BrowserActionDriverOptions = {},
  ) {
    this.root = options.root ?? document;
    this.maximumWaitMs = Math.max(100, Math.min(options.maximumWaitMs ?? 30_000, 120_000));
    this.onBeforeDocumentNavigation = options.onBeforeDocumentNavigation;
  }

  setJourneyContext(journeyId: string): void {
    this.journeyId = journeyId;
  }

  observe(): Promise<ScreenObservation> {
    return this.observer.observe();
  }

  async perform(action: ResolvedAction, expected: ScreenObservation, signal?: AbortSignal): Promise<DriverResult> {
    throwIfAborted(signal);
    const current = await this.observer.observe();
    // A wait is deliberately observing an in-progress transition. Applying the
    // write-action mutation guard before it starts makes normal React renders
    // fail before the wait can do its job. All mutating actions retain the
    // strict fingerprint check below.
    if (action.action !== "wait" && (current.version !== expected.version || current.fingerprint !== expected.fingerprint)) {
      return { ok: false, detail: "The page changed before the action; the journey was stopped instead of guessing" };
    }
    try {
      if (action.action === "navigate") return this.navigate(action, signal);
      if (action.action === "scroll") {
        if (action.target?.screenId) {
          const recognized = this.recognizer.recognize(current);
          if (!targetMatchesRecognizedScreen(action.target, recognized?.screenId)) {
            return {
              ok: false,
              detail: recognized
                ? `The signed scroll target belongs to ${action.target.screenId}, but the current screen is ${recognized.screenId}`
                : `The signed scroll target belongs to ${action.target.screenId}, but the current screen could not be recognized safely`,
            };
          }
        }
        if (action.target) {
          const resolved = this.resolver.resolve(action.target, { requireVisible: false, requireEnabled: false, includeNonInteractive: true });
          resolved.element.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
          await sleep(100, signal);
          return { ok: true, detail: `scrolled to ${resolved.detail}` };
        }
        const amount = Math.max(1, Math.min(action.amount ?? Math.round((this.root.defaultView?.innerHeight ?? 800) * 0.8), 10_000));
        this.root.defaultView?.scrollBy({ top: action.direction === "up" ? -amount : amount, behavior: "smooth" });
        return { ok: true, detail: `scrolled ${action.direction ?? "down"}` };
      }
      if (action.action === "wait") {
        const timeout = Math.min(action.milliseconds ?? this.maximumWaitMs, this.maximumWaitMs);
        if (action.until) {
          const deadline = Date.now() + timeout;
          while (Date.now() < deadline) {
            throwIfAborted(signal);
            if (await this.check(action.until, expected, signal)) return { ok: true, detail: `wait condition ${action.until.kind} passed` };
            await sleep(100, signal);
          }
          return { ok: false, detail: `wait condition ${action.until.kind} timed out` };
        }
        await sleep(timeout, signal);
        return { ok: true, detail: `waited ${timeout}ms` };
      }
      if (action.action === "tool_call") {
        if (!action.toolName) return { ok: false, detail: "tool action did not identify a registered tool" };
        return this.tools.execute(action.toolName, action.input ?? null, { journeyId: this.journeyId, stepId: action.stepId }, signal);
      }

      const target = action.target;
      const active = this.root.activeElement;
      const activeElement = active && isHtmlElement(active) ? active : undefined;
      if (!target && action.action !== "keypress") return { ok: false, detail: `${action.action} requires a logical control target` };
      if (target?.screenId) {
        const recognized = this.recognizer.recognize(current);
        if (!targetMatchesRecognizedScreen(target, recognized?.screenId)) {
          return {
            ok: false,
            detail: recognized
              ? `The signed control belongs to ${target.screenId}, but the current screen is ${recognized.screenId}`
              : `The signed control belongs to ${target.screenId}, but the current screen could not be recognized safely`,
          };
        }
      }
      const resolved = target ? this.resolver.resolve(target, { requireEnabled: action.action !== "hover" }) : undefined;
      const element = resolved?.element ?? activeElement;
      if (!element) return { ok: false, detail: `${action.action} has no active or resolved target` };
      const fresh = await this.observer.observe();
      if (fresh.version !== expected.version || fresh.fingerprint !== expected.fingerprint || !element.isConnected) {
        return { ok: false, detail: "The target changed while it was being resolved; the journey was stopped" };
      }
      element.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
      element.focus({ preventScroll: true });
      const afterFocus = await this.observer.observe();
      if (afterFocus.version !== expected.version || afterFocus.fingerprint !== expected.fingerprint || !element.isConnected) {
        return { ok: false, detail: "The page changed when the target received focus; the journey was stopped" };
      }

      if (action.action === "click") {
        if (isHtmlAnchorElement(element) && element.href) {
          if (element.hasAttribute("download") || (element.target && element.target !== "_self")) {
            throw new SableSdkError("UNSUPPORTED_ACTION", "Downloads and new-window links require a direct user gesture");
          }
          const navigation = classifyBrowserNavigation(this.root.location.href, element.href);
          if (navigation === "cross_origin") {
            throw new SableSdkError("CROSS_ORIGIN_BLOCKED", "The SDK will not click a link that leaves the current origin");
          }
          if (navigation === "full_page") {
            throw new SableSdkError("UNSUPPORTED_ACTION", "This link would unload the active SDK journey; use a client router tool or cross-page resume workflow");
          }
        }
        if (isNativeSubmitControl(element)) {
          throw new SableSdkError("UNSUPPORTED_ACTION", "Native form submission can unload the SDK; register a reviewed form tool for this control");
        }
        element.click();
        return { ok: true, detail: `clicked ${resolved?.detail ?? accessibleName(element)}` };
      }
      if (action.action === "fill") {
        setNativeValue(element, stringValue(action.value));
        if (action.submit) {
          const form = element.closest("form");
          if (form && isHtmlFormElement(form)) {
            throw new SableSdkError("UNSUPPORTED_ACTION", "Native form submission can unload the SDK; register a reviewed form tool for this control");
          }
          else element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, composed: true }));
        }
        return { ok: true, detail: `filled ${resolved?.detail ?? accessibleName(element)}` };
      }
      if (action.action === "select") {
        if (!isHtmlSelectElement(element)) throw new SableSdkError("UNSUPPORTED_ACTION", "Resolved control is not a native select; register a client tool for this custom widget");
        const wanted = stringValue(action.value);
        const option = Array.from(element.options).find((candidate) => candidate.value === wanted || normalizeForMatch(candidate.text) === normalizeForMatch(wanted));
        if (!option) return { ok: false, detail: `select option “${wanted}” was not available` };
        element.value = option.value;
        element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        return { ok: true, detail: `selected an option in ${resolved?.detail ?? accessibleName(element)}` };
      }
      if (action.action === "keypress") {
        const key = action.key ?? "";
        if (!key || /(?:Meta|Control|Alt)\+/i.test(key)) throw new SableSdkError("UNSUPPORTED_ACTION", "Protected keyboard shortcuts are not SDK-direct actions");
        element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true }));
        element.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, composed: true }));
        return { ok: true, detail: `sent ${key} to ${resolved?.detail ?? accessibleName(element)}` };
      }
      if (action.action === "hover") {
        element.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, composed: true }));
        element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, composed: true }));
        return { ok: true, detail: `hovered ${resolved?.detail ?? accessibleName(element)}` };
      }
      return { ok: false, detail: `${action.action} requires a user gesture, client tool, or human handoff` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async check(assertion: WorkflowAssertion, baseline?: ScreenObservation, signal?: AbortSignal): Promise<boolean> {
    throwIfAborted(signal);
    const observation = await this.observer.observe();
    const visibleText = normalizeForMatch(observation.visibleText ?? "");
    if (assertion.kind === "text_visible") return visibleText.includes(normalizeForMatch(assertion.text));
    if (assertion.kind === "text_absent") return !visibleText.includes(normalizeForMatch(assertion.text));
    if (assertion.kind === "url_matches") {
      const pattern = safeRegex(assertion.pattern);
      return pattern ? pattern.test(observation.url) : observation.url.includes(assertion.pattern);
    }
    if (assertion.kind === "control_visible" || assertion.kind === "control_enabled") {
      try {
        const match = this.resolver.resolve(assertion.target, { requireVisible: assertion.kind === "control_visible", requireEnabled: assertion.kind === "control_enabled" });
        return assertion.kind === "control_visible" ? isElementVisible(match.element) : isElementEnabled(match.element);
      } catch { return false; }
    }
    if (assertion.kind === "screen_matches") {
      const match = this.recognizer.recognize(observation);
      return match?.screenId === assertion.screenId && match.confidence >= (assertion.minimumConfidence ?? 0);
    }
    if (assertion.kind === "screen_changed") return observation.fingerprint !== (assertion.fromFingerprint ?? baseline?.fingerprint);
    if (assertion.kind === "list_changed") {
      const signature = stableFingerprint(JSON.stringify(observation.elements.map((element) => [element.role, element.name])));
      const baselineSignature = assertion.fromSignature ?? (baseline && stableFingerprint(JSON.stringify(baseline.elements.map((element) => [element.role, element.name]))));
      return !!baselineSignature && signature !== baselineSignature;
    }
    if (assertion.kind === "tool_check") {
      return this.tools.check(assertion.toolName, assertion.operation, literalTemplate(assertion.input), { journeyId: this.journeyId, stepId: "assertion" }, signal);
    }
    return false;
  }

  private async navigate(action: ResolvedAction, signal?: AbortSignal): Promise<DriverResult> {
    throwIfAborted(signal);
    const value = action.url ?? "";
    let destination: URL;
    try { destination = new URL(value, this.root.location.href); } catch { return { ok: false, detail: "navigation URL is invalid" }; }
    const classification = classifyBrowserNavigation(this.root.location.href, destination.toString());
    if (classification === "cross_origin" || classification === "full_page") {
      if (!this.onBeforeDocumentNavigation) return { ok: false, detail: "full-document navigation requires a signed cross-page continuity checkpoint" };
      const prepared = await this.onBeforeDocumentNavigation({
        action,
        currentUrl: this.root.location.href,
        destinationUrl: destination.toString(),
        classification,
      });
      throwIfAborted(signal);
      if (!prepared) return { ok: false, detail: "cross-page navigation did not pass continuity safety checks" };
      this.root.location.assign(prepared);
      return { ok: true, detail: `started verified ${classification === "cross_origin" ? "cross-origin" : "full-page"} navigation` };
    }
    if (classification === "invalid") return { ok: false, detail: "navigation URL is invalid" };
    if (destination.href === this.root.location.href) return { ok: true, detail: "already on the requested page" };
    this.root.location.assign(destination.toString());
    return { ok: true, detail: `navigating within ${destination.pathname}` };
  }
}
