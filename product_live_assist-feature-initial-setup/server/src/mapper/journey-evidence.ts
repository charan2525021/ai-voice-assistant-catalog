import type { PageSnapshot } from "../livebox.js";
import type {
  Journey,
  JourneyEvidenceContract,
  JourneyFailureCategory,
  JourneyProofKind,
  JourneyStep,
  ScreenNode,
} from "./types.js";

const UUID_OR_ID = /\/(?:[0-9a-f]{8}-[0-9a-f-]{20,}|\d{3,})(?=\/|\?|#|$)/i;
const UUID_OR_ID_GLOBAL = /\/(?:[0-9a-f]{8}-[0-9a-f-]{20,}|\d{3,})(?=\/|\?|#|$)/ig;
const LONG_SLUG = /\/[a-z0-9_-]{24,}(?=\/|\?|#|$)/i;
const LONG_SLUG_GLOBAL = /\/[a-z0-9_-]{24,}(?=\/|\?|#|$)/ig;
const LEGAL_PATH = /\/(privacy|cookie(?:-policy)?|terms(?:-of-[^/?#]+)?|legal)(?:[/?#]|$)/i;
const BILLING_PATH = /\/(billing|plans?|pricing|payment|subscription|credits?)(?:[/?#]|$)/i;
const ACCOUNT_PATH = /\/(account|profile|security|password|2fa)(?:[/?#]|$)/i;
const RECORD_PATH = /\/(projects?|items?|records?|tickets?|orders?|customers?|users?|tasks?)\/(?:[0-9a-f-]{16,}|\d+|[a-z0-9_-]{24,})(?:[/?#]|$)/i;

const STOP = new Set(
  "a an and or the to from in on at for of with into by is are be as this that it my our your their view open inspect explore check review navigate access available details page screen manage use using".split(/\s+/),
);

const fold = (value: string) => (value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const singular = (word: string) => word.length > 4 && word.endsWith("ies") ? `${word.slice(0, -3)}y`
  : word.length > 4 && word.endsWith("s") && !/(ss|us|is)$/.test(word) ? word.slice(0, -1)
  : word;
const terms = (value: string) => [...new Set(fold(value).split(/\s+/).filter((word) => word.length > 2 && !STOP.has(word)).map(singular))];

/** Stable, origin-free URL assertion which survives record ids and query order. */
export function urlTemplate(value: string): string {
  try {
    const url = new URL(value);
    const pathname = url.pathname.replace(UUID_OR_ID_GLOBAL, "/:id").replace(LONG_SLUG_GLOBAL, "/:id");
    const query = [...url.searchParams.keys()].sort().map((key) => `${key}=:value`).join("&");
    return `${pathname}${query ? `?${query}` : ""}${url.hash ? "#" + url.hash.slice(1).replace(/\d+/g, ":id") : ""}`;
  } catch {
    return value;
  }
}

export function matchesUrlTemplate(actual: string, expected?: string): boolean {
  if (!expected) return false;
  return urlTemplate(actual) === expected;
}

/** Product-neutral page classification. It labels; policy decides what to do. */
export function classifyScreenKind(url: string, title = ""): NonNullable<ScreenNode["kind"]> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return "external"; }
  const path = `${parsed.pathname}${parsed.hash}`;
  if (LEGAL_PATH.test(path) || /\b(privacy|cookie policy|terms|legal)\b/i.test(title)) return "legal";
  if (BILLING_PATH.test(path) || /\b(billing|plans?|pricing|payment|subscription|credits?)\b/i.test(title)) return "billing";
  if (ACCOUNT_PATH.test(path) || /\b(account|profile|security|password|2fa)\b/i.test(title)) return "account";
  if (RECORD_PATH.test(path) || UUID_OR_ID.test(path) || LONG_SLUG.test(path)) return "tenant_content";
  return "product";
}

export const plannerEligibleScreen = (screen: ScreenNode): boolean =>
  !["legal", "billing", "account", "external"].includes(screen.kind ?? classifyScreenKind(screen.url, screen.title));

/** A planned goal must share a meaningful product concept with observed UI. */
export function goalGroundedInScreens(goal: string, screens: ScreenNode[]): boolean {
  const wanted = terms(goal);
  if (!wanted.length) return false;
  const material = screens
    .filter(plannerEligibleScreen)
    .flatMap((screen) => [screen.title, screen.url, ...screen.controls])
    .join(" ");
  const observed = new Set(terms(material));
  return wanted.some((word) => observed.has(word));
}

const navigationGoal = /\b(open|view|navigate|access|browse|explore|inspect|check|review)\b/i;
const searchGoal = /\b(search|filter|find|sort|order)\b/i;
const createGoal = /\b(create|add|new|upload|import|generate)\b/i;
const changeGoal = /\b(update|edit|change|save|configure|set|enable|disable|mark)\b/i;

export function inferProofKind(goal: string, steps: JourneyStep[], requested?: string): JourneyProofKind {
  const allowed: JourneyProofKind[] = [
    "text", "url_changed", "screen_reached", "record_created", "field_changed", "result_set_changed", "order_changed",
  ];
  if (allowed.includes(requested as JourneyProofKind)) return requested as JourneyProofKind;
  if (/\b(sort|reorder)\b/i.test(goal)) return "order_changed";
  if (searchGoal.test(goal) && steps.some((step) => step.action === "fill" || step.action === "select")) return "result_set_changed";
  if (createGoal.test(goal)) return "record_created";
  if (changeGoal.test(goal)) return "field_changed";
  const firstUrl = steps.find((step) => step.fromUrl)?.fromUrl;
  const lastUrl = [...steps].reverse().find((step) => step.toUrl)?.toUrl;
  if (navigationGoal.test(goal) && firstUrl && lastUrl && urlTemplate(firstUrl) !== urlTemplate(lastUrl)) return "screen_reached";
  return "text";
}

function stableControls(snapshot?: PageSnapshot): string[] {
  if (!snapshot) return [];
  const noisy = /^(home|dashboard|menu|close|open|search|notifications?|account menu|toggle sidebar)$/i;
  return snapshot.elements
    .filter((item) => item.name && !noisy.test(item.name.trim()))
    .map((item) => `${item.role || item.tag} "${item.name}"`)
    .filter((item, index, all) => all.indexOf(item) === index)
    .slice(-3);
}

export function buildEvidenceContract(input: {
  goal: string;
  steps: JourneyStep[];
  requestedProof?: string;
  postcondition?: string;
  finalSnapshot?: PageSnapshot;
}): JourneyEvidenceContract {
  const kind = inferProofKind(input.goal, input.steps, input.requestedProof);
  const lastUrl = input.finalSnapshot?.url ?? [...input.steps].reverse().find((step) => step.toUrl)?.toUrl;
  return {
    kind,
    expectedText: ["text", "record_created", "field_changed"].includes(kind) ? input.postcondition : undefined,
    expectedUrl: ["url_changed", "screen_reached"].includes(kind) && lastUrl ? urlTemplate(lastUrl) : undefined,
    expectedTitle: kind === "screen_reached" ? input.finalSnapshot?.title : undefined,
    requiredControls: kind === "screen_reached" ? stableControls(input.finalSnapshot) : undefined,
    rationale:
      kind === "screen_reached" ? "destination route and stable controls identify the requested screen" :
      kind === "url_changed" ? "the requested navigation must reach a different route" :
      kind === "result_set_changed" ? "the visible result set must change after the query/filter" :
      kind === "order_changed" ? "the ordered list signature must change" :
      kind === "record_created" ? "a unique record must appear only after creation" :
      kind === "field_changed" ? "the updated value or confirmation must appear only after saving" :
      "observed text must appear only after the action",
  };
}

/**
 * Independent deterministic goal gate. The explorer is not allowed to certify
 * its own work merely because *something* changed.
 */
export function validateGoalAlignment(journey: Pick<Journey, "goal" | "steps" | "postcondition" | "evidence">): { ok: boolean; reason?: string; category?: JourneyFailureCategory } {
  const contract = journey.evidence;
  const actionMaterial = journey.steps.flatMap((step) => [step.name ?? "", step.url ?? "", step.toUrl ?? ""]).join(" ");
  const evidenceMaterial = [
    journey.postcondition,
    contract?.expectedUrl ?? "",
    contract?.expectedTitle ?? "",
    ...(contract?.requiredControls ?? []),
  ].join(" ");
  const material = [
    actionMaterial, evidenceMaterial,
  ].join(" ");
  const wanted = terms(journey.goal);
  const observed = new Set(terms(material));
  if (wanted.length && !wanted.some((word) => observed.has(word))) {
    return { ok: false, category: "goal_mismatch", reason: `actions/evidence do not mention any meaningful concept from goal "${journey.goal}"` };
  }

  const inferred = inferProofKind(journey.goal, journey.steps);
  const compatible =
    inferred === (contract?.kind ?? "text") ||
    (inferred === "screen_reached" && contract?.kind === "url_changed");
  if (!compatible && inferred !== "text") {
    return {
      ok: false,
      category: "proof_inconclusive",
      reason: `goal requires ${inferred} evidence, but explorer supplied ${contract?.kind ?? "text"}`,
    };
  }

  if (["screen_reached", "url_changed"].includes(contract?.kind ?? "")) {
    const destination = new Set(terms(evidenceMaterial));
    if (wanted.length && !wanted.some((word) => destination.has(word))) {
      return {
        ok: false,
        category: "goal_mismatch",
        reason: `destination evidence does not identify the requested goal "${journey.goal}"`,
      };
    }
  }

  const finalUrl = [...journey.steps].reverse().find((step) => step.toUrl)?.toUrl ?? "";
  const finalClick = [...journey.steps].reverse().find((step) => step.action === "click");
  let recordSpecific = false;
  try { recordSpecific = RECORD_PATH.test(new URL(finalUrl).pathname); } catch { /* no URL */ }
  if (recordSpecific && finalClick?.name && !/\{\{[^}]+\}\}/.test(finalClick.name)) {
    return {
      ok: false,
      category: "record_specific",
      reason: `journey is pinned to tenant record "${finalClick.name}"; parameter binding is required before publication`,
    };
  }
  return { ok: true };
}

export function failureCategory(message: string): JourneyFailureCategory {
  if (/documentation.*stale|manual.*out of date|document wording no longer matches/i.test(message)) return "documentation_stale";
  if (/not found|no element|selector/i.test(message)) return "selector_missing";
  if (/timeout|timed out/i.test(message)) return "timeout";
  if (/permission|forbidden|unauthori[sz]ed|upgrade|plan/i.test(message)) return "permission_blocked";
  if (/blocked|unsafe|destructive/i.test(message)) return "unsafe_action";
  if (/already.*screen|inconclusive|only navigates/i.test(message)) return "proof_inconclusive";
  if (/postcondition|proof|expected/i.test(message)) return "proof_missing";
  return "unknown";
}
