import { createHash, randomUUID } from "node:crypto";
import type { LiveBox, PageSnapshot } from "../livebox.js";

export interface ObservedControl {
  id: number;
  role?: string;
  name?: string;
  tag: string;
  type: string;
  value?: string;
  href?: string;
}

/** A fresh, versioned observation. Actions can refuse stale observations. */
export interface ScreenState {
  observationId: string;
  sessionId: string;
  version: number;
  url: string;
  title: string;
  visibleText: string;
  controls: ObservedControl[];
  fingerprint: string;
  loading: boolean;
  capturedAt: string;
  screenshot?: string;
}

/**
 * Identity of a SCREEN, which is not the same as identity of a moment.
 *
 * Overlays are excluded deliberately. Expanding a nav section or opening the
 * organisation switcher changes the control list without changing what screen
 * you are on, so including them made one dashboard hash three different ways and
 * inflated the survey with near-duplicate screens. The cartographer already
 * computes its own overlay-free identity for exactly this reason
 * (`cartographer.ts`); this brings the runtime fingerprint into agreement with
 * it, which matters because journey steps record from/to fingerprints that the
 * evidence router later has to match against a live page.
 */
export function fingerprintSnapshot(snapshot: Pick<PageSnapshot, "url" | "title" | "text" | "elements">): string {
  const persistent = snapshot.elements.filter((e) => !e.overlay);
  const stable = JSON.stringify({
    url: snapshot.url,
    title: snapshot.title,
    text: snapshot.text.replace(/\s+/g, " ").trim().slice(0, 20_000),
    controls: persistent.map((e) => [e.role, e.name, e.tag, e.type, e.href]),
  });
  return createHash("sha256").update(stable).digest("hex");
}

/** Maintains monotonic screen versions for one live browser session. */
export class LiveScreenObserver {
  private version = 0;
  private lastFingerprint = "";
  private last?: ScreenState;

  constructor(private readonly sessionId: string, private readonly box: LiveBox) {}

  current(): ScreenState | undefined {
    return this.last;
  }

  async observe(withScreenshot = false): Promise<ScreenState> {
    const snapshot = await this.box.snapshot(withScreenshot);
    const fingerprint = fingerprintSnapshot(snapshot);
    if (fingerprint !== this.lastFingerprint) {
      this.version++;
      this.lastFingerprint = fingerprint;
    }
    const state: ScreenState = {
      observationId: randomUUID(),
      sessionId: this.sessionId,
      version: this.version,
      url: snapshot.url,
      title: snapshot.title,
      visibleText: snapshot.text,
      controls: snapshot.elements.map((e) => ({
        id: e.id,
        role: e.role,
        name: e.name,
        tag: e.tag,
        type: e.type,
        value: e.value,
        href: e.href,
      })),
      fingerprint,
      // DOM readiness is a better real-time signal than waiting for global
      // network-idle, which many SaaS applications never reach.
      loading: /\b(loading|please wait|working)\b/i.test(snapshot.text.slice(0, 500)),
      capturedAt: new Date().toISOString(),
      screenshot: withScreenshot ? snapshot.screenshot : undefined,
    };
    this.last = state;
    return state;
  }
}
