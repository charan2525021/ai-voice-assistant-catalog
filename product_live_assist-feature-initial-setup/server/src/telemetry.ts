/**
 * Cost + latency telemetry.
 *
 * The cost claims in VISION_PLAN.md were estimates. This measures the real thing:
 * every model call is recorded with its purpose, latency and (estimated) tokens,
 * so per-demo cost can be reported instead of asserted.
 */

export type CallPurpose = "agent" | "observer" | "planner" | "explorer" | "semanticist" | "embeddings" | "tts" | "other";

interface CallRecord {
  purpose: CallPurpose;
  ms: number;
  inTokens: number;
  outTokens: number;
  images: number;
}

// Per-1M-token prices for the configured model (override via env when it changes).
const IN_PER_M = Number(process.env.PRICE_IN_PER_M ?? 1.0);
const OUT_PER_M = Number(process.env.PRICE_OUT_PER_M ?? 6.0);
/** A 1280x800 screenshot costs roughly this many image tokens. */
const IMAGE_TOKENS = Number(process.env.IMAGE_TOKENS ?? 1200);

const calls: CallRecord[] = [];
/**
 * This array is a rolling window, not a ledger. It used to grow forever, which is
 * a slow leak in a server that stays up for a demo day. The durable record lives
 * in the event log (events.ts); this only backs the live header counter.
 */
const MAX_CALLS = Number(process.env.TELEMETRY_WINDOW ?? 5000);

/** Rough token estimate — good enough for cost accounting, no tokenizer needed. */
export const estTokens = (s: string): number => Math.ceil((s || "").length / 4);

export function record(r: CallRecord): void {
  calls.push(r);
  if (calls.length > MAX_CALLS) calls.splice(0, calls.length - MAX_CALLS);
}

/** Dollar cost of one call, so the event log can carry cost per call rather than only in aggregate. */
export function costOf(inTokens: number, outTokens: number, images = 0): number {
  const inTok = inTokens + images * IMAGE_TOKENS;
  return Number(((inTok / 1e6) * IN_PER_M + (outTokens / 1e6) * OUT_PER_M).toFixed(6));
}

/** Token accounting for one call, shared by the telemetry window and the event log. */
export const priceModel = () => ({ inPerM: IN_PER_M, outPerM: OUT_PER_M, imageTokens: IMAGE_TOKENS });

export function summary(purpose?: CallPurpose) {
  const rows = purpose ? calls.filter((c) => c.purpose === purpose) : calls;
  const inTok = rows.reduce((a, c) => a + c.inTokens + c.images * IMAGE_TOKENS, 0);
  const outTok = rows.reduce((a, c) => a + c.outTokens, 0);
  const cost = (inTok / 1e6) * IN_PER_M + (outTok / 1e6) * OUT_PER_M;
  const ms = rows.reduce((a, c) => a + c.ms, 0);
  return {
    calls: rows.length,
    images: rows.reduce((a, c) => a + c.images, 0),
    inTokens: inTok,
    outTokens: outTok,
    costUsd: Number(cost.toFixed(5)),
    avgMs: rows.length ? Math.round(ms / rows.length) : 0,
    totalMs: ms,
  };
}

export function byPurpose() {
  const purposes = [...new Set(calls.map((c) => c.purpose))];
  return Object.fromEntries(purposes.map((p) => [p, summary(p)]));
}

export function reset(): void {
  calls.length = 0;
}
