import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { productDataDir } from "./store.js";

/**
 * Per-product retrieval calibration.
 *
 * Every tuning constant in retrieval used to be a process-wide env var with a
 * default measured ONCE, on one product (Swag Labs: 9 flows, 2 doc chunks).
 * Two things are wrong with that:
 *
 *  1. It cannot be right for every product. The hybrid semantic/lexical weight
 *     that is optimal on 4,378 chunks of prose documentation is not the weight
 *     that is optimal on a handful of hand-written paragraphs, and the flow
 *     floor that separates 9 flows does not separate 50.
 *  2. Nobody could tell when it drifted. A global constant has no owner and no
 *     re-measurement trigger, so it silently ages as the corpus grows.
 *
 * These values are therefore MEASURED per product and persisted next to that
 * product's store. Precedence is env > calibration file > built-in default, so
 * an operator can always override, and a product that has never been calibrated
 * behaves exactly as it did before.
 */

export interface Calibration {
  /** Weight on semantic similarity; lexical gets the remainder. */
  semWeight: number;
  /**
   * Minimum top-1 score for retrieved facts to count as grounding at all.
   *
   * The product's central trust property is that it refuses rather than invents.
   * That used to hold for free: with a 2-chunk corpus an off-topic question
   * matched nothing above the score filter, so `facts` came back empty and the
   * agent had no choice but to refuse. At 4,378 chunks SOMETHING always clears
   * an absolute filter — "does this integrate with SAP S/4HANA?" retrieved four
   * chunks about chatflows and NetSuite — and the refusal then depends on the
   * model noticing the facts do not answer the question. Fixing the empty-corpus
   * gap therefore quietly weakened the guarantee it was meant to support.
   *
   * Measured on HubSpot: answerable questions score p05 0.744, off-domain
   * questions max 0.626 — a clean gap, unlike the flow distributions which
   * genuinely overlap. So a floor here is meaningful where a flow floor is not.
   *
   * 0 disables it, which is the default: a product too small to measure the two
   * distributions keeps exactly its previous behaviour.
   */
  groundingFloor: number;
  /** Flow-match acceptance thresholds. */
  flowFloor: number;
  flowStrong: number;
  flowDominance: number;
  calibratedAt: string;
  /** How much evidence this was measured on — small n means treat with care. */
  sampleSize: number;
  notes?: string;
}

export const DEFAULT_CALIBRATION: Omit<Calibration, "calibratedAt" | "sampleSize"> = {
  semWeight: 0.7,
  groundingFloor: 0, // off until measured — see the field's note
  flowFloor: 0.3,
  flowStrong: 0.45,
  flowDominance: 1.02,
};

const file = (product: string) => path.join(productDataDir(product), "calibration.json");

export async function loadCalibration(product: string): Promise<Calibration | null> {
  const f = file(product);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(await fs.readFile(f, "utf8")) as Calibration;
  } catch {
    return null;
  }
}

export async function saveCalibration(product: string, c: Calibration): Promise<void> {
  const f = file(product);
  await fs.mkdir(path.dirname(f), { recursive: true });
  await fs.writeFile(f, JSON.stringify(c, null, 2));
}

/**
 * Resolve one parameter: env override wins, then the product's measurement,
 * then the built-in default. Env is checked first so an operator debugging a
 * live demo can always force a value without editing stored state.
 */
export function resolveParam(
  envName: string,
  key: keyof Omit<Calibration, "calibratedAt" | "sampleSize" | "notes">,

  cal: Calibration | null,
): number {
  const env = process.env[envName];
  if (env !== undefined && env !== "" && Number.isFinite(Number(env))) return Number(env);
  const measured = cal?.[key];
  if (typeof measured === "number" && Number.isFinite(measured)) return measured;
  return DEFAULT_CALIBRATION[key];
}
