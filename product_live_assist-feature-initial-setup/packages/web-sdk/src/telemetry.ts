import {
  SDK_TELEMETRY_SCHEMA_VERSION,
  type SdkTelemetryBatch,
  type SdkTelemetryEvent,
  type SessionDescriptor,
  type TelemetryPolicy,
} from "@sable/sdk-contracts";
import { PrivacyEngine } from "./privacy.js";
import { randomId } from "./utils.js";

type TelemetryBaseKeys = "kind" | "schemaVersion" | "eventId" | "sequence" | "sessionId" | "installationId" | "catalogVersionId" | "occurredAt";
type NewTelemetryEvent = SdkTelemetryEvent extends infer Event
  ? Event extends SdkTelemetryEvent ? Omit<Event, TelemetryBaseKeys> : never
  : never;

export interface TelemetryClientOptions {
  endpoint: string;
  session: SessionDescriptor;
  policy: TelemetryPolicy;
  privacy: PrivacyEngine;
  fetcher?: typeof fetch;
}

/** Best-effort, batched telemetry. It never blocks page actions. */
export class TelemetryClient {
  private queue: SdkTelemetryEvent[] = [];
  private sequence = 0;
  private timer?: number;
  private flushing = false;
  private stopped = false;
  private readonly sampled: boolean;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: TelemetryClientOptions) {
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.sampled = options.policy.enabled && Math.random() <= options.policy.sampleRate;
    if (this.sampled) {
      this.timer = globalThis.setInterval(() => { void this.flush(); }, Math.max(1_000, options.policy.flushIntervalMs));
      globalThis.addEventListener?.("pagehide", this.onPageHide);
    }
  }

  record(event: NewTelemetryEvent): void {
    if (!this.sampled || this.stopped || !this.options.policy.allowedEvents.includes(event.type)) return;
    const full = {
      ...event,
      kind: "sable.sdk.telemetry_event" as const,
      schemaVersion: SDK_TELEMETRY_SCHEMA_VERSION,
      eventId: randomId("event"),
      sequence: ++this.sequence,
      sessionId: this.options.session.sessionId,
      installationId: this.options.session.installationId,
      catalogVersionId: this.options.session.catalogVersionId,
      occurredAt: new Date().toISOString(),
    } as SdkTelemetryEvent;
    this.queue.push(this.options.privacy.scrubPayload(full) as SdkTelemetryEvent);
    const maximum = Math.max(1, Math.min(this.options.policy.batchMaximumEvents, 500));
    if (this.queue.length >= maximum) void this.flush();
    if (this.queue.length > maximum * 4) this.queue.splice(0, this.queue.length - maximum * 4);
  }

  async flush(): Promise<void> {
    if (this.flushing || !this.queue.length || this.stopped) return;
    this.flushing = true;
    const maximum = Math.max(1, Math.min(this.options.policy.batchMaximumEvents, 500));
    const events = this.queue.splice(0, maximum);
    const batch: SdkTelemetryBatch = {
      kind: "sable.sdk.telemetry_batch",
      schemaVersion: SDK_TELEMETRY_SCHEMA_VERSION,
      batchId: randomId("batch"),
      sessionId: this.options.session.sessionId,
      sentAt: new Date().toISOString(),
      events,
    };
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort("telemetry timeout"), 5_000);
    try {
      const response = await this.fetcher(this.options.endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${this.options.session.sessionToken}`, "content-type": "application/json" },
        credentials: "omit",
        cache: "no-store",
        keepalive: true,
        signal: controller.signal,
        body: JSON.stringify(batch),
      });
      if (!response.ok) this.queue.unshift(...events);
    } catch {
      this.queue.unshift(...events);
    } finally {
      globalThis.clearTimeout(timeout);
      const queueLimit = Math.max(1, Math.min(this.options.policy.batchMaximumEvents, 500)) * 4;
      if (this.queue.length > queueLimit) this.queue.splice(0, this.queue.length - queueLimit);
      this.flushing = false;
    }
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) globalThis.clearInterval(this.timer);
    this.timer = undefined;
    globalThis.removeEventListener?.("pagehide", this.onPageHide);
    await this.flush();
    this.stopped = true;
  }

  private readonly onPageHide = (): void => { void this.flush(); };
}
