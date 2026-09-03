import type { DemoModule, RestoredTranscriptMessage, SignedCatalogEnvelope } from "@sable/sdk-contracts";
import type { RuntimeSession } from "./contracts.js";
import type { GuidedDemoSessionState } from "./demo-director.js";
import type { TurnRequest } from "./turn-coordinator.js";
import type { TaskControl, TurnPlan, TurnResponseMode } from "./turn-planner.js";

export const DEMO_PLAYBACK_DIRECTIVES = ["resume_after_answer", "remain_paused", "resume_now", "stop", "replace_module"] as const;
export type DemoPlaybackDirective = typeof DEMO_PLAYBACK_DIRECTIVES[number];

/**
 * The semantic decision is the normal TurnPlan. These extra fields describe
 * only how the deterministic guided-demo conductor should treat playback.
 */
export interface DemoInterruptionPlan {
  intent: TurnPlan["intent"];
  responseMode: TurnResponseMode;
  taskControl: TaskControl;
  playbackDirective: DemoPlaybackDirective;
  needsFreshObservation: boolean;
  needsKnowledge: boolean;
  actionRequested: boolean;
  presentationRequested: boolean;
  journeyInputs: TurnPlan["journeyInputs"];
  subjectJourneyId?: string;
  journeyId?: string;
  navigationTargetScreenId?: string;
  /** Module that may replace playback after an explicitly validated action. */
  requestedModuleId?: string;
  /** Subject used for knowledge and follow-up wording; it never changes the resumable checkpoint. */
  answerSubjectModuleId?: string;
  clarification?: string;
  unavailableReason?: string;
  policyAdjustments: string[];
}

export interface DemoInterruptionContext {
  session: RuntimeSession;
  catalog: SignedCatalogEnvelope;
  demo: GuidedDemoSessionState;
  request: TurnRequest;
  transcript: RestoredTranscriptMessage[];
  currentScreenId?: string;
}

function eligibleModules(context: DemoInterruptionContext): DemoModule[] {
  const profile = context.catalog.payload.demoProfile;
  if (!profile) return [];
  return profile.modules.filter((module) => {
    const journey = context.catalog.payload.journeys.find((candidate) => candidate.id === module.journeyId);
    return !!journey && journey.state === "approved" && journey.demoSafe === true
      && (!journey.roles.length || journey.roles.includes(context.session.role))
      && journey.compatibility.every((step) => !["EXTENSION_ONLY", "HUMAN_ONLY", "UNSUPPORTED"].includes(step.classification));
  });
}

function moduleForJourney(modules: DemoModule[], journeyId: string | undefined): DemoModule | undefined {
  return journeyId ? modules.find((module) => module.journeyId === journeyId) : undefined;
}

/**
 * Adds playback policy to the normal planner result. The model describes the
 * request once; this adapter owns demo authority and cannot invent a module.
 */
export function planDemoInterruption(turnPlan: TurnPlan, context: DemoInterruptionContext): DemoInterruptionPlan {
  const adjustments: string[] = [];
  const modules = eligibleModules(context);
  const requestedModule = moduleForJourney(modules, turnPlan.journeyId);
  const subjectModule = moduleForJourney(modules, turnPlan.subjectJourneyId ?? turnPlan.journeyId);
  const activeModuleId = context.demo.activeModuleId;
  let replacementModule: DemoModule | undefined;
  let playbackDirective: DemoPlaybackDirective = "remain_paused";
  let unavailableReason = turnPlan.unavailableReason;

  if (turnPlan.taskControl === "continue") playbackDirective = "resume_now";
  else if (turnPlan.taskControl === "stop") playbackDirective = "stop";
  else if (turnPlan.taskControl === "replace") {
    if ((turnPlan.mode === "execute" || turnPlan.mode === "execute_then_observe_and_answer") && requestedModule) {
      playbackDirective = "replace_module";
      replacementModule = requestedModule;
    } else if (turnPlan.mode === "navigate" && subjectModule && subjectModule.id !== activeModuleId) {
      // "Go directly to Smart Reporting" is often a mapped navigation rather
      // than an execute plan. When the named subject is also a signed demo
      // module, commit the requested module replacement instead of leaving the
      // old module active behind the newly displayed page.
      playbackDirective = "replace_module";
      replacementModule = subjectModule;
    } else if (turnPlan.mode === "navigate" && turnPlan.navigationTargetScreenId) {
      // A mapped navigation is executed as the interruption request itself.
      // It does not silently discard the original module checkpoint.
      playbackDirective = "remain_paused";
      adjustments.push("Mapped navigation runs while the interrupted demo module remains resumable.");
    } else {
      unavailableReason ??= "No approved demo-safe module matches the requested replacement.";
      adjustments.push("The unverified replacement was reduced to a paused answer.");
    }
  }

  if ((turnPlan.mode === "execute" || turnPlan.mode === "execute_then_observe_and_answer") && !requestedModule) {
    playbackDirective = "remain_paused";
    unavailableReason ??= "The requested journey is not an approved demo-safe module for this session.";
    adjustments.push("Guided-demo execution is restricted to approved demo modules.");
  }
  if (turnPlan.mode === "clarify") playbackDirective = "remain_paused";
  if (turnPlan.taskControl === "side_question" || turnPlan.taskControl === "none") playbackDirective = "remain_paused";
  if (context.demo.resumeReason === "failure" && playbackDirective === "resume_now") {
    playbackDirective = "remain_paused";
    unavailableReason ??= "The failed module cannot continue from an uncertain position; it must be retried, skipped, stopped, or replaced.";
    adjustments.push("A failed module cannot resume without an explicit safe retry.");
  }

  return {
    intent: turnPlan.intent,
    responseMode: turnPlan.mode,
    taskControl: turnPlan.taskControl,
    playbackDirective,
    needsFreshObservation: turnPlan.mode === "observe_then_answer" || turnPlan.mode === "navigate",
    needsKnowledge: turnPlan.needsKnowledge,
    actionRequested: turnPlan.actionRequested,
    presentationRequested: turnPlan.presentationRequested,
    journeyInputs: { ...turnPlan.journeyInputs },
    ...(turnPlan.subjectJourneyId ? { subjectJourneyId: turnPlan.subjectJourneyId } : {}),
    ...(turnPlan.journeyId ? { journeyId: turnPlan.journeyId } : {}),
    ...(turnPlan.navigationTargetScreenId ? { navigationTargetScreenId: turnPlan.navigationTargetScreenId } : {}),
    ...(replacementModule && playbackDirective === "replace_module" ? { requestedModuleId: replacementModule.id } : {}),
    ...(subjectModule ? { answerSubjectModuleId: subjectModule.id } : {}),
    ...(turnPlan.clarification ? { clarification: turnPlan.clarification } : {}),
    ...(unavailableReason ? { unavailableReason } : {}),
    policyAdjustments: adjustments,
  };
}

/** Reconstruct the normal plan for deterministic execution by TurnCoordinator. */
export function turnPlanFromDemoInterruption(plan: DemoInterruptionPlan): TurnPlan {
  return {
    intent: plan.intent,
    mode: plan.responseMode,
    taskControl: plan.taskControl,
    needsFreshObservation: plan.needsFreshObservation,
    needsKnowledge: plan.needsKnowledge,
    actionRequested: plan.actionRequested,
    presentationRequested: plan.presentationRequested,
    journeyInputs: { ...plan.journeyInputs },
    ...(plan.subjectJourneyId ? { subjectJourneyId: plan.subjectJourneyId } : {}),
    ...(plan.journeyId ? { journeyId: plan.journeyId } : {}),
    ...(plan.navigationTargetScreenId ? { navigationTargetScreenId: plan.navigationTargetScreenId } : {}),
    ...(plan.clarification ? { clarification: plan.clarification } : {}),
    ...(plan.unavailableReason ? { unavailableReason: plan.unavailableReason } : {}),
  };
}
