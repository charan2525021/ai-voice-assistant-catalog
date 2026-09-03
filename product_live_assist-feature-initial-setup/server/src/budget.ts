import { currentTrace, emit, readEvents } from "./events.js";

/**
 * Spend limits.
 *
 * Nothing bounded model spend before this. An agent that loops — and agents do
 * loop, on a page it cannot make progress on — would keep calling until someone
 * noticed the bill. That is an unacceptable property to hand to a client, and the
 * failure mode is worse than a refusal: silent, unbounded, and discovered late.
 *
 * Two ceilings, because they catch different failures:
 *  - **per trace** catches one runaway demo or mapping run;
 *  - **per product per day** catches slow bleed across many sessions.
 *
 * Deliberately fail-closed: when a cap is hit the call is refused rather than
 * trimmed, so the operator sees a clear stop instead of a demo that silently
 * degrades into something worse than useless.
 */

const DAILY_USD = Number(process.env.BUDGET_DAILY_USD ?? 10);
const TRACE_USD = Number(process.env.BUDGET_TRACE_USD ?? 1);

/**
 * Money, printed so it never reads as a bug. A fixed 2 decimals turns a $0.00001
 * test limit into "reached its $0.00 limit (used $0.0000)", which looks broken
 * rather than informative.
 */
const usd = (n: number): string => {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toPrecision(2)}`;
  return `$${n.toFixed(2)}`;
};

export class BudgetExceeded extends Error {
  constructor(
    readonly scope: "trace" | "daily",
    readonly spent: number,
    readonly limit: number,
    readonly product: string,
  ) {
    super(
      scope === "trace"
        ? `This session reached its ${usd(limit)} spend limit (used ${usd(spent)}). Raise BUDGET_TRACE_USD to continue.`
        : `"${product}" reached its ${usd(limit)} daily spend limit (used ${usd(spent)}). Raise BUDGET_DAILY_USD to continue.`,
    );
    this.name = "BudgetExceeded";
  }
}

const traceSpend = new Map<string, number>();
/** product → { day, usd } so the counter resets on a date change without a cron. */
const dailySpend = new Map<string, { day: string; usd: number }>();
const seeded = new Set<string>();

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Seed today's spend from the event log so a restart does not silently reset the
 * daily cap — otherwise the limit could be bypassed simply by restarting.
 */
async function seedDaily(product: string): Promise<void> {
  if (seeded.has(product)) return;
  seeded.add(product);
  try {
    const since = `${today()}T00:00:00.000Z`;
    const events = await readEvents(product, { kind: "model.call", since, limit: 100000 });
    const usd = events.reduce((n, e) => n + Number(e.data?.costUsd ?? 0), 0);
    const cur = dailySpend.get(product);
    if (!cur || cur.day !== today()) dailySpend.set(product, { day: today(), usd });
    else cur.usd = Math.max(cur.usd, usd);
    if (usd > 0) console.log(`[budget] "${product}" has already spent $${usd.toFixed(4)} today`);
  } catch (e) {
    console.warn(`[budget] could not seed today's spend for "${product}": ${(e as Error).message}`);
  }
}

function dailyFor(product: string): number {
  const cur = dailySpend.get(product);
  if (!cur || cur.day !== today()) return 0;
  return cur.usd;
}

export function limitsFor(product: string) {
  return { traceLimitUsd: TRACE_USD, dailyLimitUsd: DAILY_USD, spentToday: dailyFor(product) };
}

/**
 * Called BEFORE a model call. Throws if a ceiling is already reached.
 *
 * Checking before rather than after means the cap is a real stop: charging first
 * would let every ceiling be exceeded by one unbounded call.
 */
export async function assertWithinBudget(): Promise<void> {
  const ctx = currentTrace();
  if (!ctx) return; // untraced work (CLI, evals) is not metered
  await seedDaily(ctx.product);

  const spentTrace = traceSpend.get(ctx.trace) ?? 0;
  if (spentTrace >= TRACE_USD) {
    emit("budget.exceeded", { status: "error", data: { scope: "trace", spent: spentTrace, limit: TRACE_USD } });
    throw new BudgetExceeded("trace", spentTrace, TRACE_USD, ctx.product);
  }

  const spentDay = dailyFor(ctx.product);
  if (spentDay >= DAILY_USD) {
    emit("budget.exceeded", { status: "error", data: { scope: "daily", spent: spentDay, limit: DAILY_USD } });
    throw new BudgetExceeded("daily", spentDay, DAILY_USD, ctx.product);
  }
}

/** Called AFTER a model call with its actual cost. */
export function charge(usd: number): void {
  const ctx = currentTrace();
  if (!ctx || !(usd > 0)) return;
  traceSpend.set(ctx.trace, (traceSpend.get(ctx.trace) ?? 0) + usd);
  const cur = dailySpend.get(ctx.product);
  if (!cur || cur.day !== today()) dailySpend.set(ctx.product, { day: today(), usd });
  else cur.usd += usd;

  // Warn at 80% so an operator can react before a demo stops mid-sentence.
  const t = traceSpend.get(ctx.trace) ?? 0;
  if (t >= TRACE_USD * 0.8 && t - usd < TRACE_USD * 0.8) {
    console.warn(`[budget] session ${ctx.trace.slice(0, 8)} is at $${t.toFixed(4)} of $${TRACE_USD.toFixed(2)}`);
    emit("budget.warning", { status: "ok", data: { scope: "trace", spent: t, limit: TRACE_USD } });
  }
}

/** Free a finished trace's counter so the map cannot grow without bound. */
export function releaseTrace(trace: string): void {
  traceSpend.delete(trace);
}
