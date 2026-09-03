import type { ModelClient, NeutralMessage } from "@sable/model-client";
import type { DemoModule, RestoredTranscriptMessage, SignedCatalogEnvelope } from "@sable/sdk-contracts";
import type { RuntimeSession } from "./contracts.js";
import type { GuidedDemoSessionState } from "./demo-director.js";
import type { TurnRequest } from "./turn-coordinator.js";

export const DEMO_INTERRUPTION_INTENTS = ["screen_question", "product_question", "how_to", "objection", "action", "conversation"] as const;
export type DemoInterruptionIntent = typeof DEMO_INTERRUPTION_INTENTS[number];
export const DEMO_RESPONSE_MODES = ["answer", "observe_then_answer", "clarify"] as const;
export type DemoInterruptionResponseMode = typeof DEMO_RESPONSE_MODES[number];
export const DEMO_PLAYBACK_DIRECTIVES = ["resume_after_answer", "remain_paused", "resume_now", "stop", "replace_module"] as const;
export type DemoPlaybackDirective = typeof DEMO_PLAYBACK_DIRECTIVES[number];

export interface DemoInterruptionPlan {
  intent: DemoInterruptionIntent;
  responseMode: DemoInterruptionResponseMode;
  playbackDirective: DemoPlaybackDirective;
  needsFreshObservation: boolean;
  needsKnowledge: boolean;
  requestedModuleId?: string;
  clarification?: string;
  unavailableReason?: string;
  policyAdjustments: string[];
}

interface RawDemoInterruptionPlan {
  intent: DemoInterruptionIntent;
  responseMode: DemoInterruptionResponseMode;
  playbackDirective: DemoPlaybackDirective;
  needsKnowledge: boolean;
  requestedModuleId?: string;
  clarification?: string;
}

export interface DemoInterruptionContext {
  session: RuntimeSession;
  catalog: SignedCatalogEnvelope;
  demo: GuidedDemoSessionState;
  request: TurnRequest;
  transcript: RestoredTranscriptMessage[];
  currentScreenId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function eligibleReplacementModules(context: DemoInterruptionContext): DemoModule[] {
  const profile = context.catalog.payload.demoProfile;
  if (!profile) return [];
  return profile.modules.filter((module) => {
    const journey = context.catalog.payload.journeys.find((candidate) => candidate.id === module.journeyId);
    return !!journey && journey.state === "approved" && journey.demoSafe === true
      && (!journey.roles.length || journey.roles.includes(context.session.role))
      && journey.compatibility.every((step) => !["EXTENSION_ONLY", "HUMAN_ONLY", "UNSUPPORTED"].includes(step.classification));
  });
}

/**
 * The model describes meaning; this policy owns authority. It converts every
 * model field into a safe, internally consistent plan and never executes it.
 */
export function validateDemoInterruptionPlan(raw: RawDemoInterruptionPlan, context: DemoInterruptionContext): DemoInterruptionPlan {
  const adjustments: string[] = [];
  let responseMode = raw.responseMode;
  let playbackDirective = raw.playbackDirective;
  let requestedModuleId = raw.requestedModuleId?.trim() || undefined;
  let clarification = raw.clarification?.trim().slice(0, 300) || undefined;
  let unavailableReason: string | undefined;

  if (raw.intent === "screen_question" && responseMode !== "observe_then_answer") {
    responseMode = "observe_then_answer";
    adjustments.push("Screen questions require a fresh privacy-filtered observation.");
  }
  if (raw.intent !== "screen_question" && responseMode === "observe_then_answer" && raw.intent !== "how_to") {
    responseMode = "answer";
    adjustments.push("Fresh page observation is restricted to screen questions and contextual how-to questions.");
  }
  if (responseMode === "clarify" && !clarification) {
    clarification = "Could you clarify what you would like me to explain or show?";
    adjustments.push("Clarify mode requires one bounded clarification question.");
  }
  if (responseMode !== "clarify" && clarification) {
    clarification = undefined;
    adjustments.push("Clarification text was removed because the selected response mode is not clarify.");
  }

  if (playbackDirective === "replace_module") {
    const eligible = eligibleReplacementModules(context);
    const selected = requestedModuleId ? eligible.find((module) => module.id === requestedModuleId) : undefined;
    if (raw.intent !== "action" || !selected) {
      unavailableReason = requestedModuleId
        ? `Demo module ${requestedModuleId} is not an approved demo-safe replacement for this session.`
        : "No approved demo module was selected for the replacement request.";
      playbackDirective = "remain_paused";
      requestedModuleId = undefined;
      responseMode = "answer";
      adjustments.push("An invalid or non-action module replacement was reduced to a paused answer.");
    } else if (selected.id === context.demo.activeModuleId) {
      playbackDirective = "resume_after_answer";
      requestedModuleId = undefined;
      adjustments.push("Replacing the current module with itself was reduced to resuming the current module.");
    }
  } else if (requestedModuleId) {
    requestedModuleId = undefined;
    adjustments.push("A requested module is allowed only with replace_module.");
  }

  if (playbackDirective === "stop" || playbackDirective === "resume_now") {
    requestedModuleId = undefined;
    if (responseMode === "clarify") {
      responseMode = "answer";
      clarification = undefined;
      adjustments.push("Immediate playback controls cannot also wait for clarification.");
    }
  }
  if (responseMode === "clarify" && playbackDirective !== "remain_paused") {
    playbackDirective = "remain_paused";
    adjustments.push("The demo must remain paused while waiting for clarification.");
  }
  if (raw.intent !== "action" && ["stop", "resume_now", "replace_module"].includes(playbackDirective)) {
    playbackDirective = responseMode === "clarify" ? "remain_paused" : "resume_after_answer";
    requestedModuleId = undefined;
    adjustments.push("Playback-changing directives require an action intent.");
  }

  const needsKnowledge = raw.intent === "product_question" || raw.intent === "objection" || raw.intent === "how_to"
    || unavailableReason !== undefined || raw.needsKnowledge === true;
  return {
    intent: raw.intent,
    responseMode,
    playbackDirective,
    needsFreshObservation: responseMode === "observe_then_answer",
    needsKnowledge,
    ...(requestedModuleId ? { requestedModuleId } : {}),
    ...(clarification ? { clarification } : {}),
    ...(unavailableReason ? { unavailableReason } : {}),
    policyAdjustments: adjustments,
  };
}

function recentTranscript(transcript: RestoredTranscriptMessage[]): Array<{ role: "user" | "assistant"; text: string }> {
  return transcript.slice(-6).map((entry) => ({ role: entry.role, text: entry.text.slice(0, 400) }));
}

function leadContext(demo: GuidedDemoSessionState): Record<string, string> {
  return Object.fromEntries(Object.entries(demo.answers).slice(0, 12).map(([key, value]) => [key.slice(0, 120), value.slice(0, 400)]));
}

export class DemoInterruptionPlanner {
  constructor(private readonly model: ModelClient) {}

  async plan(context: DemoInterruptionContext, options: { signal?: AbortSignal } = {}): Promise<DemoInterruptionPlan> {
    const profile = context.catalog.payload.demoProfile;
    if (!profile) throw new Error("The session has no signed guided-demo profile");
    if (!context.demo.activeModuleId || (!context.demo.checkpoint && !context.demo.moduleCompletedDuringInterruption)) {
      throw new Error("The demo interruption has no verified active-module position");
    }
    const activeModule = profile.modules.find((module) => module.id === context.demo.activeModuleId);
    if (!activeModule) throw new Error("The active demo module is not in the signed profile");
    const replacementModules = eligibleReplacementModules(context).map((module) => ({ id: module.id, name: module.name, journeyId: module.journeyId }));
    const system = [
      "You are the bounded interruption planner for a guided product demo. Call submit_demo_interruption_plan exactly once and produce no user-facing prose.",
      "You classify meaning only. Deterministic runtime policy validates every field and owns all execution authority.",
      "Use screen_question for what is visibly on the current page; product_question for product/service facts; how_to for instructions; objection for concern or resistance; action for stop, continue, or an explicit request to show another configured module; conversation for greetings and non-product talk.",
      "Use observe_then_answer only when a fresh privacy-filtered page observation is required. Use clarify only when one missing detail prevents a safe response.",
      "Use resume_now only for a direct continue request, stop only for a direct stop request, replace_module only for an explicit request to show one exact configured module, resume_after_answer for a normal interruption that should return to the demo after answering, and remain_paused when the user asks to wait or clarification is needed. If the interrupted module already completed, resume_after_answer or resume_now advances to the next signed module.",
      "Do not invent module IDs, journeys, tools, selectors, inputs, facts, or sales content. Do not decide qualification or sales strategy.",
      `SESSION: ${JSON.stringify({ productId: context.session.installation.productId, role: context.session.role, personaId: context.demo.personaId ?? null })}`,
      `DEMO POSITION: ${JSON.stringify({ profileId: profile.id, activeModule: { id: activeModule.id, name: activeModule.name, journeyId: activeModule.journeyId }, phase: context.demo.phase, moduleCompletedDuringInterruption: context.demo.moduleCompletedDuringInterruption === true, currentScreenId: context.currentScreenId ?? null })}`,
      `CAPTURED LEAD CONTEXT: ${JSON.stringify(leadContext(context.demo))}`,
      `ALLOWED REPLACEMENT MODULES: ${JSON.stringify(replacementModules)}`,
      `RECENT TRANSCRIPT: ${JSON.stringify(recentTranscript(context.transcript))}`,
    ].join("\n\n");
    const tool = {
      name: "submit_demo_interruption_plan",
      description: "Return one bounded semantic plan for the paused guided-demo interruption.",
      parameters: {
        type: "object",
        properties: {
          intent: { type: "string", enum: DEMO_INTERRUPTION_INTENTS },
          responseMode: { type: "string", enum: DEMO_RESPONSE_MODES },
          playbackDirective: { type: "string", enum: DEMO_PLAYBACK_DIRECTIVES },
          needsKnowledge: { type: "boolean" },
          requestedModuleId: { type: "string", description: "Exact allowed module ID, or an empty string." },
          clarification: { type: "string", description: "One short question, or an empty string." },
        },
        required: ["intent", "responseMode", "playbackDirective", "needsKnowledge", "requestedModuleId", "clarification"],
        additionalProperties: false,
      },
    };
    const userMessage: NeutralMessage = { role: "user", blocks: [{ type: "text", text: context.request.text.trim().slice(0, 2_000) }] };
    const call = async (repair?: string) => this.model.step(
      repair ? `${system}\n\nThe previous structured plan was invalid: ${repair}. Return one corrected plan.` : system,
      [userMessage],
      [tool],
      { signal: options.signal, toolChoice: "required" },
    );
    const parse = (response: Awaited<ReturnType<typeof call>>): RawDemoInterruptionPlan => {
      const result = response.toolCalls.find((candidate) => candidate.name === tool.name);
      if (!result || !isRecord(result.args)) throw new Error("submit_demo_interruption_plan was not returned");
      const raw = result.args;
      if (typeof raw.intent !== "string" || !DEMO_INTERRUPTION_INTENTS.includes(raw.intent as DemoInterruptionIntent)) throw new Error("intent is unsupported");
      if (typeof raw.responseMode !== "string" || !DEMO_RESPONSE_MODES.includes(raw.responseMode as DemoInterruptionResponseMode)) throw new Error("responseMode is unsupported");
      if (typeof raw.playbackDirective !== "string" || !DEMO_PLAYBACK_DIRECTIVES.includes(raw.playbackDirective as DemoPlaybackDirective)) throw new Error("playbackDirective is unsupported");
      if (typeof raw.needsKnowledge !== "boolean") throw new Error("needsKnowledge must be boolean");
      if (typeof raw.requestedModuleId !== "string" || typeof raw.clarification !== "string") throw new Error("requestedModuleId and clarification must be strings");
      return {
        intent: raw.intent as DemoInterruptionIntent,
        responseMode: raw.responseMode as DemoInterruptionResponseMode,
        playbackDirective: raw.playbackDirective as DemoPlaybackDirective,
        needsKnowledge: raw.needsKnowledge,
        requestedModuleId: raw.requestedModuleId,
        clarification: raw.clarification,
      };
    };
    const first = await call();
    let raw: RawDemoInterruptionPlan;
    try { raw = parse(first); }
    catch (error) { raw = parse(await call(error instanceof Error ? error.message : "invalid plan")); }
    return validateDemoInterruptionPlan(raw, context);
  }
}
