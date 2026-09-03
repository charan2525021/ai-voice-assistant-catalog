import { config } from "../config.js";

/**
 * Semantic embeddings for the Brain.
 *
 * Why this exists: lexical (TF-IDF) retrieval only matches shared words. Real
 * prospects say "tick it off" when the docs say "mark complete", and keyword
 * matching silently fails — measured at 5/6 misses before this was added.
 */

const MODEL = process.env.EMBEDDINGS_MODEL ?? "text-embedding-3-small";

export function embeddingsEnabled(): boolean {
  return (process.env.EMBEDDINGS ?? "on") !== "off" && !!config.openai.apiKey;
}

/**
 * How many times we fell back to lexical because the embedding endpoint failed.
 *
 * Warning on the console is enough for a live demo — a degraded turn is worse
 * than a good one but still serves the user. It is NOT enough for anything that
 * MEASURES the system: a calibration run that silently loses half its vectors
 * computes thresholds from noise and then persists them, converting a transient
 * 429 into a permanently mis-tuned product. Callers that derive stored values
 * must reset this, do their work, and refuse to write if it moved.
 */
let degraded = 0;
export function degradedCount(): number { return degraded; }
export function resetDegraded(): void { degraded = 0; }

/*
 * How hard to fight a rate limit.
 *
 * A live demo turn should give up quickly — a degraded answer now beats a
 * correct one thirty seconds late. CALIBRATION is the opposite: its output is
 * written to disk and used forever, so a 429 there must be waited out rather
 * than absorbed. Calibration kept dying on the same burst and refusing to save,
 * which meant no product ever got measured parameters at all.
 */
let attemptBudget = 3;
let waitCeilingMs = 8000;
export function setEmbeddingPatience(attempts: number, ceilingMs: number): void {
  attemptBudget = attempts;
  waitCeilingMs = ceilingMs;
}

/** Embed a batch of texts. Returns [] if embeddings are unavailable (graceful degrade to lexical). */
export async function embed(texts: string[]): Promise<number[][]> {
  if (!texts.length || !embeddingsEnabled()) return [];
  const BATCH = 64;
  const slices: string[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) slices.push(texts.slice(i, i + BATCH).map((t) => t.slice(0, 6000)));

  /*
   * Batches run in PARALLEL.
   *
   * They used to be a serial for-loop, which is invisible at the 1–2 documents
   * each product had and becomes the dominant cost the moment a real doc site is
   * indexed: a 400-page manual is ~2,000 chunks — 32 sequential round trips.
   * Bounded rather than unbounded, because firing 32 requests at once is how you
   * earn the 429 that the retry logic below then has to fight.
   */
  const embedConcurrency = Math.max(1, Number(process.env.EMBEDDING_CONCURRENCY ?? 4));
  const results: (number[][] | null)[] = new Array(slices.length).fill(null);
  let cursor = 0;

  const runBatch = async (slice: string[]): Promise<number[][] | null> => {
    /*
     * Retry transient failures. Without this, an intermittent embedding error
     * silently degraded retrieval to lexical-only — which produced FLAKY flow
     * routing (identical queries alternating between the right flow and none at
     * all). Silent degradation is the worst failure mode here, so it also warns.
     */
    let got: number[][] | null = null;
    let lastErr = "";
    for (let attempt = 0; attempt < attemptBudget && !got; attempt++) {
      try {
        const res = await fetch(`${config.openai.baseUrl.replace(/\/$/, "")}/embeddings`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${config.openai.apiKey}` },
          body: JSON.stringify({ model: MODEL, input: slice }),
          /*
           * The timeout SCALES with the batch.
           *
           * A flat 1200ms is right for the one-text query on a live demo turn
           * and far too tight for 64 texts of up to 6000 chars each — at ingest
           * scale it timed out, and because a failed batch discards every vector
           * in the whole call, one slow request cost the entire corpus its
           * semantic index and degraded it silently to lexical.
           */
          signal: AbortSignal.timeout(
            Math.max(100, Number(process.env.EMBEDDING_HTTP_TIMEOUT_MS ?? 1200)) +
              slice.length * Number(process.env.EMBEDDING_MS_PER_ITEM ?? 120),
          ),
        });
        if (!res.ok) {
          lastErr = `HTTP ${res.status}`;
          const body = await res.text();
          // Auth problems never succeed on retry; transient ones will.
          if (res.status === 401 || res.status === 403) break;
          if (res.status === 429) {
            // Honour the server's own pacing when it tells us; else back off hard.
            const wait = Number(res.headers.get("retry-after")) * 1000 || 1500 * 2 ** attempt;
            await new Promise((r) => setTimeout(r, Math.min(wait, waitCeilingMs)));
            continue;
          }
          if (!/temporarily unavailable|provider_error|overloaded|timeout|try again|5\d\d/i.test(`${res.status} ${body}`) && res.status < 500)
            break;
        } else {
          const data: any = await res.json();
          const vecs = (data.data ?? []).map((d: any) => d.embedding as number[]);
          if (vecs.length === slice.length) got = vecs;
          else lastErr = `expected ${slice.length} vectors, got ${vecs.length}`;
        }
      } catch (e) {
        lastErr = (e as Error).message;
      }
      if (!got && attempt < attemptBudget - 1) await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** attempt, waitCeilingMs)));
    }
    if (!got) {
      degraded++;
      console.warn(`  ! embeddings unavailable (${lastErr}) — DEGRADING to lexical search for this query`);
      return null;
    }
    return got;
  };

  const runners = Array.from({ length: Math.min(embedConcurrency, slices.length) }, async () => {
    while (cursor < slices.length) {
      const i = cursor++;
      results[i] = await runBatch(slices[i]);
    }
  });
  await Promise.all(runners);

  /*
   * All-or-nothing, unchanged. buildEmbeddings() only assigns vectors when the
   * count matches the input exactly, so a partial result would be silently
   * dropped there anyway — returning [] keeps that contract explicit.
   */
  if (results.some((r) => r === null)) return [];
  return results.flat() as number[][];
}

/**
 * Query-embedding cache.
 *
 * One turn embeds the SAME query twice (once to search docs, once to match
 * flows), and evals/demos repeat phrasings constantly. That doubled request
 * volume was enough to trip HTTP 429 rate limits, which silently degraded
 * retrieval to lexical and made flow routing flaky. Caching removes both the
 * duplication and most of the load.
 */
const queryCache = new Map<string, number[]>();
const QUERY_CACHE_MAX = 500;

export async function embedOne(text: string): Promise<number[] | null> {
  const key = text.trim().toLowerCase();
  const hit = queryCache.get(key);
  if (hit) {
    queryCache.delete(key); // refresh recency (LRU)
    queryCache.set(key, hit);
    return hit;
  }
  const [v] = await embed([text]);
  if (!v) return null;
  if (queryCache.size >= QUERY_CACHE_MAX) queryCache.delete(queryCache.keys().next().value as string);
  queryCache.set(key, v);
  return v;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
