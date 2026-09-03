import { SDK_OBSERVATION_SCHEMA_VERSION, type ObservedElement, type ScreenObservation } from "@sable/sdk-contracts";
import { accessibleName, elementRole, inspectableDomRoots, isElementEnabled, isElementVisible, meaningfulElements } from "./dom.js";
import { PrivacyEngine } from "./privacy.js";
import { boundedString, bytesToHex, normalizeSpace, randomId, stableFingerprint } from "./utils.js";

export interface ObserverOptions {
  debounceMs?: number;
  maximumElements?: number;
  root?: Document;
}

export type ObservationListener = (observation: ScreenObservation) => void;

interface HistoryPatch {
  pushState: History["pushState"];
  replaceState: History["replaceState"];
  patchedPushState: History["pushState"];
  patchedReplaceState: History["replaceState"];
}

/** Observes the real page without screenshots and without reading form values. */
export class DomScreenObserver {
  private readonly root: Document;
  private readonly debounceMs: number;
  private readonly maximumElements: number;
  private version = 0;
  private lastFingerprint = "";
  private lastChangeFingerprint = "";
  private last?: ScreenObservation;
  private mutationObserver?: MutationObserver;
  private observedRoots = new Set<ParentNode>();
  private timer?: number;
  private historyPatch?: HistoryPatch;
  private listeners = new Set<ObservationListener>();
  private started = false;
  private observationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly privacy: PrivacyEngine, options: ObserverOptions = {}) {
    this.root = options.root ?? document;
    this.debounceMs = Math.max(25, Math.min(options.debounceMs ?? 100, 2_000));
    this.maximumElements = Math.max(1, Math.min(options.maximumElements ?? 500, 2_000));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.mutationObserver = new MutationObserver(() => this.schedule());
    this.observeInspectableRoots();
    this.root.addEventListener("load", this.onEmbeddedLoad, true);
    const view = this.root.defaultView;
    view?.addEventListener("popstate", this.onNavigation);
    view?.addEventListener("hashchange", this.onNavigation);
    if (view) {
      const history = view.history;
      const schedule = this.onNavigation;
      const originalPushState = history.pushState;
      const originalReplaceState = history.replaceState;
      const patchedPushState: History["pushState"] = function (this: History, ...args: Parameters<History["pushState"]>) {
        const result = originalPushState.apply(this, args);
        schedule();
        return result;
      };
      const patchedReplaceState: History["replaceState"] = function (this: History, ...args: Parameters<History["replaceState"]>) {
        const result = originalReplaceState.apply(this, args);
        schedule();
        return result;
      };
      this.historyPatch = { pushState: originalPushState, replaceState: originalReplaceState, patchedPushState, patchedReplaceState };
      history.pushState = patchedPushState;
      history.replaceState = patchedReplaceState;
    }
    this.schedule();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.mutationObserver?.disconnect();
    this.mutationObserver = undefined;
    this.observedRoots.clear();
    this.root.removeEventListener("load", this.onEmbeddedLoad, true);
    if (this.timer !== undefined) globalThis.clearTimeout(this.timer);
    this.timer = undefined;
    const view = this.root.defaultView;
    view?.removeEventListener("popstate", this.onNavigation);
    view?.removeEventListener("hashchange", this.onNavigation);
    if (view && this.historyPatch) {
      if (view.history.pushState === this.historyPatch.patchedPushState) view.history.pushState = this.historyPatch.pushState;
      if (view.history.replaceState === this.historyPatch.patchedReplaceState) view.history.replaceState = this.historyPatch.replaceState;
    }
    this.historyPatch = undefined;
  }

  subscribe(listener: ObservationListener): () => void {
    this.listeners.add(listener);
    if (this.last) listener(this.last);
    return () => this.listeners.delete(listener);
  }

  current(): ScreenObservation | undefined {
    return this.last;
  }

  observe(): Promise<ScreenObservation> {
    const pending = this.observationQueue.then(() => this.capture());
    this.observationQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async capture(): Promise<ScreenObservation> {
    const location = this.root.location;
    const routeExcluded = this.privacy.routeIsExcluded(location.href);
    const safeUrl = this.privacy.redactUrl(location.href);
    const roots = routeExcluded ? [] : inspectableDomRoots(this.root, { includeSameOriginFrames: true });
    this.observeInspectableRoots(roots);
    const allElements = [...new Set(roots.flatMap((root) => meaningfulElements(root)))];
    const elements = allElements
      .filter((element) => !this.privacy.isExcluded(element))
      .slice(0, this.maximumElements)
      .map((element, index): ObservedElement => ({
        id: element.getAttribute("data-sable-id") ?? element.getAttribute("data-testid") ?? `element-${index + 1}`,
        role: boundedString(elementRole(element), 64),
        name: this.privacy.isRedacted(element) ? "[redacted]" : boundedString(accessibleName(element), 300),
        visible: isElementVisible(element),
        enabled: isElementEnabled(element),
      }));
    const visibleText = routeExcluded ? "" : this.privacy.redactText(roots.map((root) => this.privacy.visibleText(root)).join(" "));
    const fingerprintMaterial = JSON.stringify({
      // The raw URL stays local and only contributes to the cryptographic hash.
      // This detects SPA state changes without exposing query values.
      url: location.href,
      title: this.root.title,
      elements: elements.map((element) => [element.role, element.name, element.visible, element.enabled]),
    });
    const fingerprint = globalThis.crypto?.subtle
      ? `sha256-${bytesToHex(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(fingerprintMaterial)))}`
      : stableFingerprint(fingerprintMaterial);
    const changeMaterial = `${fingerprintMaterial}\n${visibleText}`;
    this.lastChangeFingerprint = globalThis.crypto?.subtle
      ? `sha256-${bytesToHex(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(changeMaterial)))}`
      : stableFingerprint(changeMaterial);
    if (fingerprint !== this.lastFingerprint) {
      this.version++;
      this.lastFingerprint = fingerprint;
    }
    const observation = {
      kind: "sable.screen_observation" as const,
      schemaVersion: SDK_OBSERVATION_SCHEMA_VERSION,
      observationId: randomId("observation"),
      version: this.version,
      capturedAt: new Date().toISOString(),
      url: safeUrl,
      origin: location.origin,
      title: normalizeSpace(this.root.title),
      fingerprint,
      elements,
      // The contract intentionally permits this optional, already-redacted context.
      visibleText,
    } satisfies ScreenObservation & { visibleText?: string };
    this.last = observation;
    return observation;
  }

  private readonly onNavigation = (): void => this.schedule();
  private readonly onEmbeddedLoad = (): void => {
    this.observeInspectableRoots();
    this.schedule();
  };

  private observeInspectableRoots(roots = inspectableDomRoots(this.root, { includeSameOriginFrames: true })): void {
    if (!this.mutationObserver) return;
    const options: MutationObserverInit = {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
      attributeFilter: ["aria-label", "aria-labelledby", "aria-disabled", "aria-hidden", "class", "disabled", "hidden", "href", "open", "role", "style"],
    };
    for (const root of roots) {
      if (this.observedRoots.has(root)) continue;
      const target = root instanceof Document ? root.documentElement : root;
      try {
        this.mutationObserver.observe(target, options);
        this.observedRoots.add(root);
      } catch {
        // A frame can navigate between discovery and observation; retry on its next load.
      }
    }
  }

  private schedule(): void {
    if (!this.started || this.timer !== undefined) return;
    this.timer = globalThis.setTimeout(() => {
      this.timer = undefined;
      const priorChangeFingerprint = this.lastChangeFingerprint;
      void this.observe().then((observation) => {
        if (this.lastChangeFingerprint === priorChangeFingerprint) return;
        for (const listener of this.listeners) listener(observation);
      }).catch(() => undefined);
    }, this.debounceMs);
  }
}
