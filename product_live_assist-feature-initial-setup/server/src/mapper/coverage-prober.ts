import type { LiveBox } from "../livebox.js";
import { EMPTY_STATE } from "./proof.js";
import type { Journey, ProductGraph } from "./types.js";
import { expandProgram, newRunTag } from "./unique.js";

type Evidence = NonNullable<Journey["coverage"]>;

const VALIDATION = /(required|invalid|not valid|must |cannot|can't |please (enter|select|provide)|missing|too (short|long)|error)/i;

function signal(text: string): string | undefined {
  return text.split(/\n+/).map((line) => line.trim()).find((line) => line.length <= 180 && VALIDATION.test(line));
}

/**
 * Close the branches that can be tested generically and safely. Permission
 * denial and injected server faults need explicit fixtures; recording them as
 * blocked is deliberate evidence, not an optimistic placeholder.
 */
export async function probeJourneyCoverage(journey: Journey, graph: ProductGraph, box: LiveBox): Promise<Evidence> {
  const checkedAt = new Date().toISOString();
  const coverage: Evidence = {
    permission: {
      status: "discovered", depth: 2, checkedAt,
      detail: "successful replay proves this role can perform the journey; denial behavior requires a restricted-role credential",
    },
    error: {
      status: "blocked", depth: 1, checkedAt,
      detail: "server/network failure cannot be induced safely without a product-specific fault fixture",
    },
  };

  const journeyFingerprints = new Set(journey.steps.flatMap((step) =>
    [step.fromFingerprint, step.toFingerprint].filter((value): value is string => !!value)));
  const observedEmpty = graph.screens.find((screen) =>
    (!journeyFingerprints.size || (!!screen.fingerprint && journeyFingerprints.has(screen.fingerprint))) &&
    EMPTY_STATE.test(screen.visibleText ?? ""));
  coverage.empty_state = observedEmpty ? {
    status: "verified", depth: 2, checkedAt,
    detail: `observed an empty state on ${observedEmpty.title}`,
  } : {
    status: "blocked", depth: 1, checkedAt,
    detail: "no empty-state fixture was observed for this journey",
  };

  const fieldIndex = journey.steps.findIndex((step) => step.action === "fill" || step.action === "select");
  if (fieldIndex < 0) {
    coverage.validation = {
      status: "blocked", depth: 1, checkedAt,
      detail: "journey has no input boundary to validate",
    };
    return coverage;
  }

  const field = journey.steps[fieldIndex];
  const submitOffset = journey.steps.slice(fieldIndex).findIndex((step, index) =>
    (index === 0 && step.submit) || (index > 0 && step.action === "click"));
  if (submitOffset < 0) {
    coverage.validation = {
      status: "discovered", depth: 2, checkedAt,
      detail: `input boundary found at ${field.role ?? field.action} "${field.name ?? ""}", but no submission control was recorded`,
    };
    return coverage;
  }

  try {
    await box.resetState();
    const tag = newRunTag();
    const prefix = expandProgram(journey.steps.slice(0, fieldIndex) as any[], tag);
    if (prefix.length) {
      const reached = await box.runProgram(prefix as any);
      if (!reached.ok) {
        coverage.validation = { status: "broken", depth: 1, checkedAt, detail: reached.error ?? "could not reach validation boundary" };
        return coverage;
      }
    }
    const before = await box.visibleText(4_000);
    const invalidBefore = new Set((await box.validationEvidence()).map((item) => item.toLowerCase()));
    const probe = expandProgram(journey.steps.slice(fieldIndex, fieldIndex + submitOffset + 1) as any[], tag);
    probe[0] = { ...probe[0], value: "" };
    const result = await box.runProgram(probe as any);
    const after = await box.visibleText(4_000);
    const structural = (await box.validationEvidence()).find((item) => !invalidBefore.has(item.toLowerCase()));
    const message = structural ?? signal(after);
    const wasAlreadyVisible = message ? before.toLowerCase().includes(message.toLowerCase()) : false;
    coverage.validation = message && !wasAlreadyVisible ? {
      status: "verified", depth: 3, checkedAt,
      detail: `blank-input replay produced validation evidence: "${message}"`,
    } : {
      status: result.ok ? "discovered" : "broken", depth: result.ok ? 2 : 1, checkedAt,
      detail: result.ok
        ? "blank-input boundary was replayed, but no distinct validation message was observable"
        : (result.error ?? "validation replay failed without observable validation evidence"),
    };
  } catch (error) {
    coverage.validation = { status: "broken", depth: 1, checkedAt, detail: `validation probe failed: ${(error as Error).message}` };
  }
  return coverage;
}
