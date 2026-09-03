import type { DynamicToolKind, DynamicToolResult, JsonValue, SdkServerCommand } from "@sable/sdk-contracts";
import {
  accessibleName,
  elementRole,
  isHtmlAnchorElement,
  isHtmlButtonElement,
  isHtmlElement,
  isHtmlInputElement,
  isHtmlSelectElement,
  isHtmlTextAreaElement,
} from "./dom.js";
import { PrivacyEngine } from "./privacy.js";
import { isDynamicMatchAcceptable, resolveDynamicTarget, type DynamicResolution } from "./resolver.js";
import { boundedString, normalizeSpace } from "./utils.js";

/**
 * Dynamic-mode tool runner. Executes a bounded browser primitive against the
 * live DOM using a semantic target (never a CSS selector or coordinates).
 *
 * The runner never throws. It always returns a `DynamicToolResult` so the
 * runtime's Plan-then-Execute loop can react to failure. This is deliberately
 * separate from `BrowserActionDriver`, which throws SableSdkError values that
 * bubble up as journey-level failures.
 */

type ExecuteDynamicToolCommand = Extract<SdkServerCommand, { kind: "sable.sdk.server.execute_dynamic_tool" }>;

const TOOLS_REQUIRING_TARGET: ReadonlySet<DynamicToolKind> = new Set(["click", "fill", "select", "check", "uncheck", "hover"]);
const REQUIRE_ENABLED: ReadonlySet<DynamicToolKind> = new Set(["click", "fill", "select", "check", "uncheck", "hover"]);

export interface DynamicToolRunOptions {
  root?: Document;
  signal?: AbortSignal;
  onBeforeNavigation?: (destination: string) => Promise<boolean> | boolean;
}

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

function readArgString(args: Record<string, JsonValue>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function readArgNumber(args: Record<string, JsonValue>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readArgBoolean(args: Record<string, JsonValue>, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

function matchedFor(resolution: DynamicResolution): DynamicToolResult["matchedElement"] {
  return {
    role: elementRole(resolution.element) || undefined,
    label: accessibleName(resolution.element) || undefined,
    testId: resolution.element.dataset?.testid ?? resolution.element.dataset?.testId ?? resolution.element.dataset?.qa ?? undefined,
    strategy: resolution.strategy,
    confidence: Number(resolution.confidence.toFixed(3)),
  };
}

function setNativeValue(element: HTMLElement, value: string): boolean {
  if (isHtmlInputElement(element)) {
    const prototype = element.ownerDocument.defaultView?.HTMLInputElement.prototype ?? HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (!setter) return false;
    setter.call(element, value);
  } else if (isHtmlTextAreaElement(element)) {
    const prototype = element.ownerDocument.defaultView?.HTMLTextAreaElement.prototype ?? HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (!setter) return false;
    setter.call(element, value);
  } else if (element.isContentEditable) {
    element.textContent = value;
  } else {
    return false;
  }
  element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: null }));
  element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  return true;
}

function fire(element: HTMLElement, type: string, init?: EventInit): void {
  element.dispatchEvent(new Event(type, { bubbles: true, composed: true, ...init }));
}

function fireClick(element: HTMLElement): void {
  const view = element.ownerDocument.defaultView ?? window;
  const rect = element.getBoundingClientRect();
  const clientX = rect.left + rect.width / 2;
  const clientY = rect.top + rect.height / 2;
  const opts = { bubbles: true, cancelable: true, composed: true, view, clientX, clientY, button: 0 };
  // Some frameworks (Vue, sticky-nav MutationObservers) listen for pointer/mouse
  // events, not just `click`. Fire the whole synthesized sequence so both
  // React-style event delegation and pointer-first frameworks catch it.
  try { element.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerType: "mouse", isPrimary: true })); } catch {}
  element.dispatchEvent(new MouseEvent("mousedown", opts));
  try { element.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerType: "mouse", isPrimary: true })); } catch {}
  element.dispatchEvent(new MouseEvent("mouseup", opts));
  element.dispatchEvent(new MouseEvent("click", opts));
  // Fall back to the native .click() so router links (e.g. anchor with an
  // href) navigate via the browser's default action, not just the JS event.
  try { element.click(); } catch {}
}

function targetSameOrigin(current: URL, destination: URL): boolean {
  return current.origin === destination.origin;
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const abort = () => {
      cleanup();
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  });
}

function textSummary(element: HTMLElement): string {
  const raw = normalizeSpace(element.textContent ?? "");
  return boundedString(raw, 800);
}

/**
 * Executes one dynamic tool command against the live DOM. Never throws; always
 * returns a DynamicToolResult with `success` set. The caller is responsible for
 * forwarding the result over the WS transport.
 */
export async function executeDynamicTool(
  command: ExecuteDynamicToolCommand,
  privacy: PrivacyEngine,
  options: DynamicToolRunOptions = {},
): Promise<DynamicToolResult> {
  const start = nowMs();
  const args = command.arguments ?? {};
  const failure = (code: string, message: string, matchedElement?: DynamicToolResult["matchedElement"]): DynamicToolResult => ({
    commandId: command.commandId,
    turnId: command.turnId,
    stepId: command.stepId,
    success: false,
    ...(matchedElement ? { matchedElement } : {}),
    error: { code, message },
    durationMs: Math.round(nowMs() - start),
  });
  const success = (data?: JsonValue, matchedElement?: DynamicToolResult["matchedElement"]): DynamicToolResult => ({
    commandId: command.commandId,
    turnId: command.turnId,
    stepId: command.stepId,
    success: true,
    ...(data !== undefined ? { data } : {}),
    ...(matchedElement ? { matchedElement } : {}),
    durationMs: Math.round(nowMs() - start),
  });

  const requiresTarget = TOOLS_REQUIRING_TARGET.has(command.tool);
  if (requiresTarget && !command.target) return failure("TARGET_REQUIRED", `tool ${command.tool} requires a target`);

  const resolution = command.target
    ? resolveDynamicTarget(command.target, privacy, {
        root: options.root,
        requireVisible: command.tool !== "scroll",
        requireEnabled: REQUIRE_ENABLED.has(command.tool),
      })
    : undefined;

  const accepted: DynamicResolution | undefined = isDynamicMatchAcceptable(resolution) ? resolution : undefined;
  if (requiresTarget && !accepted) {
    const detail = resolution
      ? `no confident match for target (${resolution.detail}, confidence ${resolution.confidence.toFixed(2)})`
      : "no element matched the requested target";
    const matchedElement = resolution ? matchedFor(resolution) : undefined;
    return failure("CONTROL_NOT_FOUND", detail, matchedElement);
  }

  const element = accepted?.element ?? resolution?.element;
  const matched = accepted ? matchedFor(accepted) : resolution ? matchedFor(resolution) : undefined;
  const signal = options.signal;
  if (signal?.aborted) return failure("ABORTED", "tool was aborted before execution", matched);

  try {
    switch (command.tool) {
      case "click": {
        element!.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
        // Give the smooth scroll a beat before dispatching — some navs
        // slide-in and would otherwise capture the click at an offset.
        await new Promise<void>((resolve) => setTimeout(resolve, 120));
        fireClick(element!);
        return success({ tool: "click" }, matched);
      }
      case "fill": {
        const value = readArgString(args, "value");
        if (value === undefined) return failure("MISSING_ARGUMENT", "fill requires an argument.value", matched);
        element!.focus?.();
        const ok = setNativeValue(element!, value);
        if (!ok) return failure("UNSUPPORTED_ACTION", `${element!.tagName.toLowerCase()} cannot be filled safely`, matched);
        if (readArgBoolean(args, "submit")) {
          element!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }));
          const form = isHtmlInputElement(element!) || isHtmlButtonElement(element!) || isHtmlSelectElement(element!) || isHtmlTextAreaElement(element!)
            ? element!.form
            : element!.closest("form");
          form?.requestSubmit?.();
        }
        return success({ tool: "fill", length: value.length }, matched);
      }
      case "select": {
        const value = readArgString(args, "value");
        if (value === undefined) return failure("MISSING_ARGUMENT", "select requires an argument.value", matched);
        if (!isHtmlSelectElement(element!)) return failure("UNSUPPORTED_ACTION", "select tool requires a <select> element", matched);
        const wanted = value.trim().toLowerCase();
        let chosen: HTMLOptionElement | undefined;
        for (const option of Array.from(element!.options)) {
          if (option.value.toLowerCase() === wanted || option.text.trim().toLowerCase() === wanted) {
            chosen = option;
            break;
          }
        }
        if (!chosen) return failure("OPTION_NOT_FOUND", `select has no option matching ${JSON.stringify(value)}`, matched);
        element!.value = chosen.value;
        fire(element!, "input");
        fire(element!, "change");
        return success({ tool: "select", selected: chosen.value }, matched);
      }
      case "check":
      case "uncheck": {
        if (!isHtmlInputElement(element!) || !(element!.type === "checkbox" || element!.type === "radio")) {
          return failure("UNSUPPORTED_ACTION", `${command.tool} requires a checkbox or radio input`, matched);
        }
        const desired = command.tool === "check";
        if (element!.checked !== desired) {
          element!.checked = desired;
          fire(element!, "input");
          fire(element!, "change");
        }
        return success({ tool: command.tool, checked: element!.checked }, matched);
      }
      case "hover": {
        element!.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
        element!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, composed: true, view: element!.ownerDocument.defaultView }));
        element!.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false, composed: true, view: element!.ownerDocument.defaultView }));
        return success({ tool: "hover" }, matched);
      }
      case "scroll": {
        const direction = readArgString(args, "direction") ?? "down";
        const amount = readArgNumber(args, "amount");
        const doc = options.root ?? (typeof document !== "undefined" ? document : undefined);
        if (element) {
          element.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
        } else if (doc?.defaultView) {
          const step = amount && amount > 0 ? amount : Math.round((doc.defaultView.innerHeight ?? 800) * 0.8);
          doc.defaultView.scrollBy({ top: direction === "up" ? -step : step, behavior: "smooth" });
        }
        return success({ tool: "scroll" }, matched);
      }
      case "navigate": {
        const path = readArgString(args, "path") ?? readArgString(args, "url");
        if (!path) return failure("MISSING_ARGUMENT", "navigate requires an argument.path or argument.url");
        const doc = options.root ?? (typeof document !== "undefined" ? document : undefined);
        if (!doc?.defaultView) return failure("NO_WINDOW", "navigate has no browsing context");
        const current = new URL(doc.defaultView.location.href);
        let destination: URL;
        try {
          destination = new URL(path, current);
        } catch {
          return failure("INVALID_ARGUMENT", `navigate destination is not a valid URL: ${JSON.stringify(path)}`);
        }
        if (!targetSameOrigin(current, destination)) return failure("CROSS_ORIGIN_BLOCKED", "cross-origin navigation is not allowed in dynamic mode");
        const proceed = options.onBeforeNavigation ? await options.onBeforeNavigation(destination.toString()) : true;
        if (!proceed) return failure("NAV_REJECTED", "navigation was rejected before dispatch");
        if (destination.pathname === current.pathname && destination.search === current.search) {
          doc.defaultView.location.hash = destination.hash;
          return success({ tool: "navigate", path: destination.pathname });
        }
        doc.defaultView.history.pushState({}, "", destination.toString());
        doc.defaultView.dispatchEvent(new PopStateEvent("popstate"));
        return success({ tool: "navigate", path: destination.pathname });
      }
      case "wait": {
        const ms = readArgNumber(args, "ms") ?? readArgNumber(args, "milliseconds") ?? 250;
        const clamped = Math.max(0, Math.min(ms, 15_000));
        await delay(clamped, signal);
        return success({ tool: "wait", ms: clamped });
      }
      case "read": {
        if (element) return success({ tool: "read", text: textSummary(element) }, matched);
        const doc = options.root ?? (typeof document !== "undefined" ? document : undefined);
        return success({ tool: "read", text: doc ? textSummary(doc.body) : "" });
      }
      default: {
        return failure("UNSUPPORTED_TOOL", `dynamic tool ${String(command.tool)} is not supported`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure("TOOL_FAILED", `${command.tool} failed: ${message}`, matched);
  }
}
