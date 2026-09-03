import type { DocumentProcedure } from "../knowledge/procedures.js";
import { checkAction } from "./safety.js";
import type { DocumentControlMatch, DocumentationJourneyContext, JourneyStep, ScreenNode } from "./types.js";

const STOP = new Set("a an the this that your you to on in into from with then and or of for by please button link tab menu field page screen".split(" "));

function tokens(value: string): string[] {
  return (value.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((token) => token.length > 1 && !STOP.has(token));
}

function similarity(a: string, b: string): number {
  const aa = new Set(tokens(a));
  const bb = new Set(tokens(b));
  if (!aa.size || !bb.size) return 0;
  let overlap = 0;
  for (const token of aa) if (bb.has(token)) overlap++;
  const containment = overlap / Math.min(aa.size, bb.size);
  const jaccard = overlap / new Set([...aa, ...bb]).size;
  const exact = a.toLowerCase().includes(b.toLowerCase()) || b.toLowerCase().includes(a.toLowerCase()) ? 0.2 : 0;
  return Math.min(1, containment * 0.55 + jaccard * 0.25 + exact);
}

function controlParts(control: string): { role: string; name: string } {
  const match = control.match(/^([^\s]+)\s+["']([\s\S]*)["']$/);
  return { role: (match?.[1] ?? "button").toLowerCase(), name: match?.[2] ?? control };
}

function actionOf(step: string, role?: string): JourneyStep["action"] {
  if (/\b(type|enter|fill|write)\b/i.test(step)) return "fill";
  if (/\b(select|choose|pick)\b/i.test(step) || role === "combobox") return "select";
  if (/\b(scroll)\b/i.test(step)) return "scroll";
  return "click";
}

function expectedLabel(step: string): string {
  const quoted = step.match(/["“']([^"”']{2,})["”']/)?.[1];
  if (quoted) return quoted;
  return step
    .replace(/^\s*(?:then\s+)?(?:click|tap|press|open|go to|navigate to|select|choose|pick|type|enter|fill in)\s+/i, "")
    .replace(/\s+(?:button|link|tab|menu|field|page|screen)\.?$/i, "")
    .trim();
}

export function safetyForDocumentProcedure(
  procedure: DocumentProcedure,
  startUrl: string,
  allowActions: string[] = [],
): { allowed: boolean; reason?: string } {
  const origin = new URL(startUrl).origin;
  for (const wording of [procedure.goal, ...procedure.steps]) {
    const verdict = checkAction({ action: "document_candidate", name: wording }, { allow: allowActions, originAllowlist: [origin] });
    if (!verdict.allowed) return verdict;
  }
  return { allowed: true };
}

/** Plain-code vocabulary matching; it spends no browser or model budget. */
export function matchDocumentProcedure(procedure: DocumentProcedure, screens: ScreenNode[]): DocumentationJourneyContext {
  const matches: DocumentControlMatch[] = procedure.steps.map((documentedStep, stepIndex) => {
    const label = expectedLabel(documentedStep);
    let best: { score: number; screen: ScreenNode; control?: string; executable: JourneyStep } | undefined;
    for (const screen of screens) {
      const screenScore = Math.max(similarity(label, screen.title), similarity(label, screen.url));
      if (screenScore >= 0.72) {
        const candidate = { score: screenScore, screen, executable: { action: "navigate" as const, url: screen.url } };
        if (!best || candidate.score > best.score) best = candidate;
      }
      for (const control of screen.controls) {
        const parsed = controlParts(control);
        const score = similarity(label, parsed.name);
        if (!best || score > best.score) {
          best = {
            score, screen, control,
            executable: { action: actionOf(documentedStep, parsed.role), role: parsed.role, name: parsed.name },
          };
        }
      }
    }
    if (!best || best.score < 0.52) {
      return { stepIndex, documentedStep, status: "unmatched", score: best?.score ?? 0, reason: `No observed control confidently matches "${label}"` };
    }
    const canPrefill = best.executable.action === "click" || best.executable.action === "navigate";
    return {
      stepIndex, documentedStep, status: "matched", score: best.score,
      screenTitle: best.screen.title, control: best.control,
      executable: canPrefill ? best.executable : undefined,
      reason: canPrefill ? undefined : "Control matched, but a value must be resolved in the live UI",
    };
  });

  // Only a consecutive prefix is safe to execute. A match after an unknown step
  // may be on a page that has not yet been reached.
  const executablePrefix: JourneyStep[] = [];
  for (const match of matches) {
    if (match.status !== "matched" || !match.executable) break;
    executablePrefix.push(match.executable);
  }
  const matched = matches.filter((match) => match.status === "matched").length;
  return {
    procedure,
    matches,
    executablePrefix,
    matchStatus: matched === matches.length ? "full" : matched ? "partial" : "none",
    staleReasons: matches.filter((match) => match.status === "unmatched").map((match) => match.reason!).filter(Boolean),
  };
}
