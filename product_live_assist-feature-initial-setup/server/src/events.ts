import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The event log — what the product actually did, recorded step by step.
 *
 * Before this, the only record of a run was `telemetry.ts`: a module-level array
 * of model calls. That is enough to answer "what did this cost" and nothing else.
 * It vanished on restart, was not scoped to a product or a session, recorded no
 * failures, and grew without bound. You could not answer the questions that matter
 * when a demo is handed to a client — what happened, in what order, how long each
 * step took, where it broke, what the model was asked.
 *
 * Design choices worth knowing:
 *
 *  - **Append-only JSONL per product.** Cheap to write, trivially tailable, and
 *    survives a crash mid-write (a torn last line costs one event, not the file).
 *    No database to run for a local demo; the same shape ships to ClickHouse or
 *    BigQuery later without a rewrite.
 *
 *  - **Ambient trace context via AsyncLocalStorage.** A model call happens six
 *    frames below the request that caused it. Threading a trace id through every
 *    signature would touch the whole codebase and get dropped somewhere. Instead
 *    the trace is ambient: open one at the entry point and every event emitted
 *    underneath — including deep in `makeBrain` — attaches to it automatically.
 *
 *  - **Scrubbed by default.** Events are written to disk and shown in a console
 *    the client will see. Anything that looks like a credential is dropped and
 *    long strings are truncated, at the point of writing rather than the point of
 *    display, so a leak cannot happen by forgetting to redact in a new view.
 */

const EVENT_ROOT = fileURLToPath(new URL("../../data/events", import.meta.url));
/** Rotate rather than grow without bound; a long-lived server would otherwise fill the disk. */
const MAX_BYTES = Number(process.env.EVENT_LOG_MAX_BYTES ?? 64 * 1024 * 1024);
/**
 * Detailed trace events intentionally carry complete prompts and individual
 * retrieval chunks. This is still bounded so a malformed producer cannot write
 * an unbounded value; whole documents/pages are forbidden at their producers.
 */
const MAX_STRING = Number(process.env.EVENT_LOG_MAX_STRING ?? 250_000);
const MAX_ARRAY = Number(process.env.EVENT_LOG_MAX_ARRAY ?? 2_000);

export type EventStatus = "start" | "ok" | "error";

export interface AidanEvent {
  id: string;
  ts: string;
  /** Product this belongs to; "_system" for things that precede a product. */
  product: string;
  /** Groups one whole activity: a demo session, a mapping run, a sign-in. */
  trace: string;
  /** This event's own id within the trace, so children can point at it. */
  span: string;
  parent?: string;
  /** Dotted namespace: demo.turn, map.verify, model.call, auth.granted … */
  kind: string;
  status?: EventStatus;
  ms?: number;
  data?: Record<string, unknown>;
  error?: string;
}

export interface TraceCtx {
  product: string;
  trace: string;
  span?: string;
  /** Labels every event in the trace, e.g. "mapping" or "demo". */
  activity: string;
}

const store = new AsyncLocalStorage<TraceCtx>();

export const currentTrace = (): TraceCtx | undefined => store.getStore();

/**
 * Redact anything credential-shaped and cap size. Applied on write, not on read.
 *
 * The key pattern alone is not sufficient, and being too eager is its own bug:
 * this matched "token" inside `inTokens`, so token *counts* came out as
 * "[redacted]" and the console reported 0 tokens next to a non-zero cost. A
 * credential is always a string (or a structure of them) — a number never is —
 * so numeric values are exempt, which keeps every token/cost metric readable
 * while still catching `accessToken: "ya29…"`.
 */
const SECRET_KEY = /pass|secret|token|cookie|session_?state|authorization|api[-_]?key|credential/i;
const isSecret = (key: string, value: unknown) => SECRET_KEY.test(key) && typeof value !== "number" && typeof value !== "boolean";

function scrubString(value: string): string {
  // Prompt/message text can contain credentials even when its object key is
  // merely `text`. Preserve the full trace while removing common wire secrets.
  const redacted = value
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+\/-]+=*/gi, "$1 [redacted]")
    .replace(/["']?\b(password|passwd|pwd|api[-_ ]?key|authorization|cookie|access[-_ ]?token|refresh[-_ ]?token)["']?\s*[:=]\s*["']?([^\s,"';}]+)/gi, "$1=[redacted]")
    .replace(/\b(password|passwd|pwd|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token)\s+(?:is|was|will be)\s+["']?([^\s,"';}]+)/gi, "$1 is [redacted]");
  return redacted.length > MAX_STRING ? `${redacted.slice(0, MAX_STRING)}…[+${redacted.length - MAX_STRING}]` : redacted;
}

function scrub(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === "string") return scrubString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 10) return "[deep]";
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((v) => scrub(v, depth + 1));
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const targetDescription = [record.name, record.label, record.control, record.accessibleName]
      .filter((item): item is string => typeof item === "string")
      .join(" ");
    const sensitiveTarget = /password|passwd|secret|api\s*key|authorization|cookie|access\s*token|refresh\s*token/i.test(targetDescription);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      out[k] = isSecret(k, v) || (sensitiveTarget && /^(value|text|input)$/i.test(k))
        ? "[redacted]"
        : scrub(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

// Serialise appends per file so concurrent emits cannot interleave a partial line.
const queues = new Map<string, Promise<void>>();

function fileFor(product: string): string {
  // Product ids are slugs, but this path is built from user-supplied names, so
  // never let one escape the events directory.
  const safe = product.replace(/[^a-zA-Z0-9._-]/g, "_") || "_system";
  return path.join(EVENT_ROOT, `${safe}.jsonl`);
}

async function append(file: string, line: string): Promise<void> {
  await fs.mkdir(EVENT_ROOT, { recursive: true });
  try {
    const st = await fs.stat(file).catch(() => null);
    if (st && st.size > MAX_BYTES) await fs.rename(file, `${file}.1`).catch(() => {});
  } catch {
    /* rotation is best-effort; never block the write */
  }
  await fs.appendFile(file, line + "\n", "utf8");
}

/**
 * Record something that happened. Never throws and never blocks the caller:
 * losing an event must not be able to fail a demo.
 */
export function emit(kind: string, opts: Partial<Omit<AidanEvent, "kind" | "id" | "ts">> = {}): AidanEvent {
  const ctx = store.getStore();
  const ev: AidanEvent = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    product: opts.product ?? ctx?.product ?? "_system",
    trace: opts.trace ?? ctx?.trace ?? "untraced",
    span: opts.span ?? randomUUID(),
    parent: opts.parent ?? ctx?.span,
    kind,
    status: opts.status,
    ms: opts.ms,
    data: opts.data ? (scrub(opts.data) as Record<string, unknown>) : undefined,
    error: opts.error ? String(scrub(opts.error)) : undefined,
  };

  const file = fileFor(ev.product);
  const prev = queues.get(file) ?? Promise.resolve();
  const next = prev
    .then(() => append(file, JSON.stringify(ev)))
    .catch((e) => console.warn(`[events] could not write ${ev.kind}: ${e.message}`));
  queues.set(file, next);
  return ev;
}

/**
 * Wait for every queued append to reach disk.
 *
 * `emit()` is deliberately fire-and-forget so a live demo turn never blocks on a
 * log write — but that means a process which exits promptly kills the pending
 * `appendFile` mid-flight and the event is lost with NO error and no warning.
 * Every CLI in this repo ends with `process.exit()`, so a full mapping run could
 * complete, report success, and write not one line to the log that calls itself
 * the system of record. That is exactly what happened: a smoke-test trace
 * printed "trace emitted" and produced no file.
 *
 * Anything with a defined end must flush before exiting.
 */
export async function flushEvents(): Promise<void> {
  await Promise.allSettled([...queues.values()]);
}

/**
 * Run `fn` inside a new trace. Everything it emits — however deep — is grouped
 * under one activity, with timing and failure captured automatically.
 */
export async function trace<T>(
  product: string,
  activity: string,
  kind: string,
  data: Record<string, unknown>,
  fn: (ctx: TraceCtx) => Promise<T>,
): Promise<T> {
  const ctx: TraceCtx = { product, trace: randomUUID(), activity, span: undefined };
  const started = Date.now();
  return store.run(ctx, async () => {
    const opened = emit(kind, { status: "start", data });
    ctx.span = opened.span; // children nest under the opening event
    try {
      const out = await fn(ctx);
      emit(kind, { status: "ok", ms: Date.now() - started, parent: opened.span, data });
      return out;
    } catch (e) {
      // The failure path is the whole point: an unrecorded crash is the one event
      // you most need when a client demo goes wrong.
      emit(kind, { status: "error", ms: Date.now() - started, parent: opened.span, error: (e as Error).message, data });
      throw e;
    }
  });
}

/** Attach to an already-open trace (used when the caller owns the lifecycle, e.g. a websocket). */
export function withTrace<T>(ctx: TraceCtx, fn: () => T): T {
  return store.run(ctx, fn);
}

/** Open a long-lived trace by hand — for sessions that outlive a single function. */
export function openTrace(product: string, activity: string): TraceCtx {
  return { product, trace: randomUUID(), activity, span: undefined };
}

export interface ReadOpts {
  limit?: number;
  /** ISO timestamp — only events at or after this. */
  since?: string;
  /** Prefix match, e.g. "model." for every model call. */
  kind?: string;
  trace?: string;
}

/** Read a product's events, newest last. */
export async function readEvents(product: string, opts: ReadOpts = {}): Promise<AidanEvent[]> {
  const file = fileFor(product);
  if (!existsSync(file) && !existsSync(`${file}.1`)) return [];
  // Include the immediately previous segment so one long mapping trace remains
  // inspectable if it crossed a rotation boundary.
  const raw = (await Promise.all([
    fs.readFile(`${file}.1`, "utf8").catch(() => ""),
    fs.readFile(file, "utf8").catch(() => ""),
  ])).filter(Boolean).join("\n");
  const out: AidanEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let ev: AidanEvent;
    try {
      ev = JSON.parse(line);
    } catch {
      continue; // a torn final line from a crash — skip it, don't fail the read
    }
    if (opts.since && ev.ts < opts.since) continue;
    if (opts.kind && !ev.kind.startsWith(opts.kind)) continue;
    if (opts.trace && ev.trace !== opts.trace) continue;
    out.push(ev);
  }
  const limit = opts.limit ?? 500;
  return out.slice(-limit);
}

/** Which products have events, for the console's global view. */
export async function eventProducts(): Promise<string[]> {
  if (!existsSync(EVENT_ROOT)) return [];
  const files = await fs.readdir(EVENT_ROOT).catch(() => [] as string[]);
  return files.filter((f) => f.endsWith(".jsonl")).map((f) => f.replace(/\.jsonl$/, ""));
}

/**
 * Roll events up into the numbers a console should show: activity counts, failure
 * rate, p50/p95 latency and model spend, per kind.
 */
export function rollup(events: AidanEvent[]) {
  const byKind = new Map<string, { n: number; errors: number; ms: number[] }>();
  let costUsd = 0;
  let inTokens = 0;
  let outTokens = 0;

  for (const e of events) {
    if (e.status === "start") continue; // the paired terminal event carries the timing
    const k = byKind.get(e.kind) ?? { n: 0, errors: 0, ms: [] };
    k.n++;
    if (e.status === "error") k.errors++;
    if (typeof e.ms === "number") k.ms.push(e.ms);
    byKind.set(e.kind, k);

    if (e.kind === "model.call" && e.data) {
      costUsd += Number(e.data.costUsd ?? 0);
      inTokens += Number(e.data.inTokens ?? 0);
      outTokens += Number(e.data.outTokens ?? 0);
    }
  }

  const pct = (xs: number[], p: number) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  };

  return {
    total: events.length,
    errors: events.filter((e) => e.status === "error").length,
    costUsd: Number(costUsd.toFixed(5)),
    inTokens,
    outTokens,
    kinds: Object.fromEntries(
      [...byKind.entries()]
        .sort((a, b) => b[1].n - a[1].n)
        .map(([kind, v]) => [kind, { n: v.n, errors: v.errors, p50: pct(v.ms, 50), p95: pct(v.ms, 95) }]),
    ),
  };
}
