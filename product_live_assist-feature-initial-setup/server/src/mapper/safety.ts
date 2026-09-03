/**
 * Structural safety for autonomous exploration.
 *
 * This is deliberately NOT a prompt instruction. An exploring agent will
 * eventually try to delete a record, send an email, or log itself out; the only
 * reliable defence is to refuse the action at the execution layer.
 */
import { emit } from "../events.js";

/** Verbs that mutate or destroy state irreversibly. */
const DEFAULT_DESTRUCTIVE = [
  "delete", "remove", "destroy", "erase", "clear all", "wipe",
  "cancel subscription", "downgrade", "deactivate", "disable account", "close account",
  "send", "publish", "submit order", "pay", "purchase", "checkout", "buy",
  "invite", "share externally", "transfer", "archive", "revoke",
];

/** Persistent or externally costly writes. These require an explicit sandbox opt-in. */
const DEFAULT_MUTATING = [
  "create", "new ", "add ", "save", "generate", "run ", "execute", "upload", "import",
];

/** Areas exploration must never enter — session loss or real-world side effects. */
const DEFAULT_NEVER_TOUCH = [
  "log out", "logout", "sign out", "signout",
  "billing", "payment", "credit card", "subscription",
  "account settings", "security", "api key", "password",
  "delete account", "danger zone",
];

/**
 * Read a term list from the environment.
 *
 * These lists are policy, not logic, and policy differs per tenant: a read-only
 * Jira demo account wants "create" and "add" refused, while a dedicated sandbox
 * wants them permitted so it can demonstrate the thing the product is FOR.
 * Editing a TypeScript array to express that was the wrong shape — it needs a
 * redeploy, it cannot differ per environment, and it is invisible to whoever
 * operates the run.
 *
 * `SAFETY_<LIST>` REPLACES the built-in list outright; `SAFETY_<LIST>_EXTRA`
 * appends to whichever list is in force, so the common case (add one term for
 * one product) does not mean restating twenty. Set a var to an empty string to
 * disable that category deliberately — an explicit, greppable choice rather
 * than the accident of an unset variable.
 *
 * Terms are compared with SUBSTRING matching, so a trailing space is
 * meaningful and is deliberately preserved: "new " matches "New Board" but not
 * "Renewal", and "add " matches "Add user" but not "Address". Only leading
 * whitespace is stripped, so `SAFETY_MUTATING="create, add "` keeps the space
 * that makes the second term safe. Trim both sides and you silently widen every
 * rule — "add" would then refuse every page mentioning an address.
 */
function termList(name: string, fallback: string[]): string[] {
  const parse = (raw: string) =>
    raw.split(",").map((term) => term.toLowerCase().replace(/^\s+/, "")).filter(Boolean);
  const raw = process.env[`SAFETY_${name}`];
  const base = raw === undefined ? fallback : parse(raw);
  const extra = parse(process.env[`SAFETY_${name}_EXTRA`] ?? "");
  return [...new Set([...base, ...extra])];
}

/*
 * Resolved once at module load. Reading process.env per call would let a rule
 * change silently mid-run, so a run is governed by one fixed policy — which is
 * also what makes the emitted `safety.policy` record below an accurate account
 * of what was enforced.
 */
const DESTRUCTIVE = termList("DESTRUCTIVE", DEFAULT_DESTRUCTIVE);
const MUTATING = termList("MUTATING", DEFAULT_MUTATING);
const NEVER_TOUCH = termList("NEVER_TOUCH", DEFAULT_NEVER_TOUCH);

/** The policy actually in force — for logs, tests and operator confirmation. */
export function safetyPolicy(): {
  destructive: string[]; mutating: string[]; neverTouch: string[];
  customised: boolean;
} {
  const customised = ["DESTRUCTIVE", "MUTATING", "NEVER_TOUCH"].some(
    (name) => process.env[`SAFETY_${name}`] !== undefined || process.env[`SAFETY_${name}_EXTRA`],
  );
  return { destructive: DESTRUCTIVE, mutating: MUTATING, neverTouch: NEVER_TOUCH, customised };
}

export interface SafetyVerdict {
  allowed: boolean;
  reason?: string;
}

export interface SafetyOptions {
  /** Journeys may explicitly opt in to specific mutations (e.g. "send" for an email demo). */
  allow?: string[];
  /** Domains the explorer may stay within. */
  originAllowlist?: string[];
}

function norm(s: string): string {
  return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The destination, as words the keyword rules can actually match.
 *
 * A bare `navigate` carries no accessible name, so matching on name+value alone
 * made every rule a no-op for it. The cartographer happens to pass `name`
 * alongside the url and was correctly refused; the explorer's go_to_screen
 * passes only the url, so the SAME destination was blocked during the survey
 * and allowed during exploration — which is how a journey to
 * /dashboard/api-keys was recorded, verified and shipped while "api key" was
 * on the never-touch list.
 *
 * Separators become spaces so "/dashboard/api-keys" reads as
 * "dashboard api keys" and matches the phrase "api key" the same way a link
 * label would.
 */
function urlWords(url?: string): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    return decodeURIComponent(`${u.pathname} ${u.hash}`).replace(/[-_/.+]+/g, " ");
  } catch {
    return url.replace(/[-_/.+]+/g, " ");
  }
}

/** Gate a single candidate action before it is executed. */
export function checkAction(
  action: { action: string; name?: string; role?: string; url?: string; value?: string },
  opts: SafetyOptions = {},
): SafetyVerdict {
  const label = norm(`${action.name ?? ""} ${action.value ?? ""}`);
  const path = norm(urlWords(action.url));
  /*
   * A NAVIGATION cannot mutate anything; only the control you press once you
   * are there can. Conflating the two made the rules match user CONTENT.
   *
   * On Jira every work item is a link whose accessible name is its summary, and
   * summaries are written by users: "Start here: Add your team's work",
   * "Create Wallet Integration". Matching mutation verbs against that text
   * refused to OPEN those tickets — twenty-nine refusals in one run, every one
   * of them a plain GET to /browse/KAN-1 that would have changed nothing. The
   * agent was left unable to read the product's primary record type.
   *
   * So mutation verbs apply to controls, not destinations. Destinations are
   * judged on where they GO, which is the url:
   *   · NEVER_TOUCH  — name and path both. Reaching billing or an API-key
   *                    screen is forbidden however you got there.
   *   · DESTRUCTIVE  — path only for a navigate, so /issues/3/delete is still
   *                    refused while a ticket TITLED "Delete old records" opens.
   *   · MUTATING     — controls only. /projects/new is a create FORM; landing
   *                    on it is harmless and its Save button is checked when
   *                    pressed.
   */
  const isNavigation = action.action === "navigate";
  const area = norm(`${label} ${path}`);
  const destructiveScope = isNavigation ? path : label;
  const mutatingScope = isNavigation ? "" : label;
  const allow = (opts.allow ?? []).map(norm);
  const blocked = (reason: string): SafetyVerdict => {
    emit("safety.block", { status: "error", error: reason, data: {
      refusedAction: action.action, role: action.role, name: action.name,
      value: action.value, url: action.url, reason,
    } });
    return { allowed: false, reason };
  };

  for (const forbidden of NEVER_TOUCH) {
    if (area.includes(forbidden)) return blocked(`never-touch area: "${forbidden}"`);
  }
  for (const verb of DESTRUCTIVE) {
    if (destructiveScope.includes(verb) && !allow.some((a) => a.includes(verb))) {
      return blocked(`destructive action blocked: "${verb}" (not allowlisted for this journey)`);
    }
  }
  const mutationOptIn = allow.some((item) => /(^|\b)(create|write|mutate)(\b|$)/.test(item));
  for (const verb of MUTATING) {
    if (mutatingScope.includes(verb) && !mutationOptIn && !allow.some((item) => item.includes(verb.trim()))) {
      return blocked(`state-changing action blocked: "${verb.trim()}" (not allowlisted for this environment)`);
    }
  }
  if (action.action === "navigate" && action.url) {
    try {
      const origin = new URL(action.url).origin;
      const allowed = opts.originAllowlist ?? [];
      if (allowed.length && !allowed.includes(origin)) {
        return blocked(`off-site navigation blocked: ${origin}`);
      }
    } catch {
      return blocked("malformed URL");
    }
  }
  return { allowed: true };
}

/** Hard budget so an explorer dies rather than wandering. */
export class Budget {
  private steps = 0;
  private startedAt = Date.now();
  constructor(private maxSteps = 18, private maxMs = 180_000) {}
  consume(): boolean {
    this.steps++;
    return this.steps <= this.maxSteps && Date.now() - this.startedAt < this.maxMs;
  }
  get spent() {
    return this.steps;
  }
  get exhausted() {
    return this.steps > this.maxSteps || Date.now() - this.startedAt >= this.maxMs;
  }
}
