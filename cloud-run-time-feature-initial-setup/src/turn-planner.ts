import type { JsonValue, SignedCatalogEnvelope } from "@sable/sdk-contracts";
import type { ModelClient, NeutralMessage } from "@sable/model-client";
import type { RuntimeBundle, RuntimeIntent } from "@sable/runtime-core";
import type { ConversationState, TurnRequest } from "./turn-coordinator.js";
import type { RuntimeSession } from "./contracts.js";

const INTENTS: RuntimeIntent[] = ["screen_question", "how_to", "action", "product_question", "objection", "conversation"];
const RESPONSE_MODES = ["answer", "observe_then_answer", "navigate", "execute", "execute_then_observe_and_answer", "clarify"] as const;
export type TurnResponseMode = typeof RESPONSE_MODES[number];
const TASK_CONTROLS = ["none", "continue", "stop", "replace", "side_question"] as const;
export type TaskControl = typeof TASK_CONTROLS[number];

// Prefixing wire values prevents compatible models from putting a journey
// control such as "continue" into the response-strategy field.
const RESPONSE_STRATEGIES = [
  "respond_answer", "respond_observe_then_answer", "respond_navigate",
  "respond_execute", "respond_execute_then_observe_and_answer", "respond_clarify",
] as const;
type PlannerResponseStrategy = typeof RESPONSE_STRATEGIES[number];
const JOURNEY_DISPOSITIONS = ["journey_none", "journey_continue", "journey_stop", "journey_replace", "journey_side_question"] as const;
type PlannerJourneyDisposition = typeof JOURNEY_DISPOSITIONS[number];
const TARGET_KINDS = ["none", "journey", "module", "screen"] as const;
type PlannerTargetKind = typeof TARGET_KINDS[number];

const RESPONSE_MODE_BY_STRATEGY: Record<PlannerResponseStrategy, TurnResponseMode> = {
  respond_answer: "answer",
  respond_observe_then_answer: "observe_then_answer",
  respond_navigate: "navigate",
  respond_execute: "execute",
  respond_execute_then_observe_and_answer: "execute_then_observe_and_answer",
  respond_clarify: "clarify",
};
const TASK_CONTROL_BY_DISPOSITION: Record<PlannerJourneyDisposition, TaskControl> = {
  journey_none: "none",
  journey_continue: "continue",
  journey_stop: "stop",
  journey_replace: "replace",
  journey_side_question: "side_question",
};

export interface ActiveJourneyContext { journeyId: string; journeyName: string; paused: boolean; }

export interface DemoRuntimeStateContext {
  phase: string;
  activeModule?: { id: string; name: string; journeyId: string };
  journeyOutcome: "running" | "paused" | "completed" | "failed";
  resumeReason?: string;
  checkpointAvailable: boolean;
  moduleCompletedDuringInterruption: boolean;
  nextModule?: { id: string; name: string; journeyId: string };
  currentScreen?: { id: string; confidence?: number };
  pendingInterruption: boolean;
}

export interface TurnPlan {
  intent: RuntimeIntent;
  mode: TurnResponseMode;
  taskControl: TaskControl;
  needsFreshObservation: boolean;
  needsKnowledge: boolean;
  actionRequested: boolean;
  /** The user attempted an action even when no catalog authority was found. */
  actionAttempted?: boolean;
  presentationRequested: boolean;
  /** Named journey/section the answer is about; context only, never execution authority. */
  subjectJourneyId?: string;
  journeyId?: string;
  navigationTargetScreenId?: string;
  journeyInputs: Record<string, JsonValue>;
  clarification?: string;
  unavailableReason?: string;
}

interface ParsedPlannerOutput {
  intent: RuntimeIntent;
  responseStrategy: PlannerResponseStrategy;
  journeyDisposition: PlannerJourneyDisposition;
  target: { kind: PlannerTargetKind; id: string };
  journeyInputs: Record<string, JsonValue>;
  clarification: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function recentConversation(conversation: ConversationState): string {
  return conversation.messages.slice(-8).flatMap((message) => message.blocks.flatMap((block) => {
    if (block.type !== "text") return [];
    return [`${message.role}: ${block.text.slice(0, 500)}`];
  })).join("\n");
}

export function executableJourney(catalog: SignedCatalogEnvelope, role: string, journeyId: string | undefined) {
  if (!journeyId) return undefined;
  return catalog.payload.journeys.find((journey) => journey.id === journeyId && journey.state === "approved" &&
    (!journey.roles.length || journey.roles.includes(role)) &&
    journey.compatibility.every((step) => !["EXTENSION_ONLY", "HUMAN_ONLY", "UNSUPPORTED"].includes(step.classification)));
}

/** The model supplies meaning; local catalog validation supplies authority. */
export class TurnPlanner {
  constructor(private readonly model: ModelClient) {}

  async plan(
    session: RuntimeSession,
    catalog: SignedCatalogEnvelope,
    bundle: RuntimeBundle,
    conversation: ConversationState,
    request: TurnRequest,
    options: { signal?: AbortSignal; activeJourney?: ActiveJourneyContext; demoRuntimeState?: DemoRuntimeStateContext } = {},
  ): Promise<TurnPlan> {
    const signedById = new Map(catalog.payload.journeys.map((journey) => [journey.id, journey]));
    const candidates = bundle.journeys.map((journey) => {
      const signed = signedById.get(journey.key);
      return {
        id: journey.key,
        name: journey.name,
        phrases: journey.intentPhrases.slice(0, 8),
        approvedForThisSession: !!executableJourney(catalog, session.role, journey.key),
        state: signed?.state ?? "not_in_signed_catalog",
        risk: signed?.risk ?? journey.workflow.risk,
        description: signed?.description ?? "",
        requiredInputs: signed?.inputSchema.required ?? [],
        inputProperties: signed?.inputSchema.properties ?? {},
      };
    });
    const modules = (catalog.payload.demoProfile?.modules ?? []).map((module) => ({
      id: module.id,
      name: module.name,
      journeyId: module.journeyId,
      approvedForThisSession: !!executableJourney(catalog, session.role, module.journeyId) && signedById.get(module.journeyId)?.demoSafe === true,
    }));
    const screenNames = new Map((bundle.screens ?? []).map((screen) => [screen.key, screen.name]));
    const navigationOptions = (bundle.transitions ?? []).flatMap((transition) => {
      const source = (bundle.screens ?? []).find((screen) => screen.key === transition.fromScreenKey);
      const target = transition.toScreenKey ? (bundle.screens ?? []).find((screen) => screen.key === transition.toScreenKey) : undefined;
      const control = source?.controls.find((candidate) => candidate.key === transition.controlKey);
      if (!target || !control || control.risk !== "read" || transition.reliability < 0.9) return [];
      return [{ fromScreenId: transition.fromScreenKey, fromScreenName: source?.name, targetScreenId: target.key, targetScreenName: target.name, controlName: control.accessibleName }];
    });
    const system = [
      "You are Sable's semantic turn planner. Interpret one user utterance in the context of the conversation, catalog, and live demo state. Call submit_turn_plan exactly once. Do not write a user-facing answer.",
      "Your job is to describe the user's meaning and requested handling. The deterministic runtime—not you—validates catalog authority, executes browser actions, controls playback, retrieves knowledge, and produces the final answer.",
      "Reason semantically. Resolve pronouns and follow-ups such as 'it', 'that', 'continue', 'go back', and 'tell me more' from RECENT CONVERSATION and DEMO RUNTIME STATE. Do not rely on exact keyword or phrase matching.",
      "Return three independent decisions. responseStrategy describes how the request should be fulfilled. journeyDisposition describes what should happen to the current demo journey. target identifies what the request is about. Never put a value belonging to one decision into another field.",
      "INTENTS: screen_question asks about the visible page; how_to asks how to use something; action requests a UI or demo action; product_question asks about the product, service, feature, or value; objection raises a concern or buying objection; conversation covers ordinary dialogue and playback-only commands such as stop or continue.",
      "RESPONSE STRATEGIES: respond_answer answers from approved knowledge without needing a fresh page; respond_observe_then_answer first obtains a fresh DOM observation and then answers about the current screen; respond_navigate moves to one exact mapped read-only screen; respond_execute runs one approved journey or demo module; respond_execute_then_observe_and_answer runs the approved journey/module, observes its resulting screen, and then explains it; respond_clarify asks one necessary clarification question.",
      "JOURNEY DISPOSITIONS: journey_none means no journey exists to preserve; journey_continue resumes or advances the current demo according to its live state; journey_stop ends it; journey_replace discards the current journey position and starts the requested different journey/module; journey_side_question answers or handles the request while preserving the current journey as resumable.",
      "TARGETS: use module for an exact guided-demo module, journey for an exact catalog route, screen for an exact mapped screen, and none with an empty id when no listed target applies. A target identifies subject or destination but never grants execution authority. Copy IDs exactly from the supplied indexes.",
      "First determine whether the utterance asks only for playback control, only for information, only for an action, or for an action plus an explanation. Then identify its subject or destination. Finally decide what happens to the current journey using DEMO RUNTIME STATE.",
      "A bare 'continue' refers to the current demo state. If the active module is paused mid-journey, continue resumes it. If it is completed and a next module is listed, continue advances to that next module. If the user names a different module, the named target overrides the bare continuation interpretation.",
      "An informational question about another module is normally a side question: answer about that target while preserving the interrupted journey. If the user explicitly asks to go, open, show, switch, return, or take them to another module, use an execution strategy with journey_replace. A compound request such as 'go to X and explain it' uses respond_execute_then_observe_and_answer with journey_replace and target X.",
      "A question about the active or just-completed module uses journey_side_question when the current journey should remain resumable. Do not silently advance merely because a product question was answered. Use journey_continue only when the user actually asks to resume, continue, proceed, or move onward.",
      "Use respond_observe_then_answer for a question whose answer depends on what is currently visible. Use respond_navigate only for an explicit destination that exactly exists in MAPPED READ-ONLY NAVIGATION OPTIONS; the runtime derives any intermediate path. Reading or explaining a screen is not permission to click it.",
      "Use respond_execute for an explicit request to play or show a complete approved journey/module. Use respond_execute_then_observe_and_answer when the user requests both presentation/navigation and an explanation. A request for explanation alone does not automatically authorize replay or navigation.",
      "Use respond_clarify only when one genuinely missing subject, destination, or required journey input prevents a safe decision. Do not clarify when conversation and runtime state make the reference clear. Do not invent unavailable details.",
      "If an explicit action has no exact approved target, preserve intent action, choose target none, and do not fabricate a mapping; the runtime will explain the limitation.",
      "journeyInputsJson must be a JSON object encoded as a string, for example \"{}\". Never guess required input values. If a required input is missing, use respond_clarify and ask one short question in clarification; otherwise clarification must be empty.",
      "CONSISTENCY EXAMPLES: paused A + 'continue' => respond_answer, journey_continue, target none. Completed A with next B + 'continue to B' => respond_execute, journey_continue, target B. Active A + 'go to C' => respond_execute, journey_replace, target C. Active A + 'what does C include?' => respond_answer, journey_side_question, target C. Active A + 'go to C and explain it' => respond_execute_then_observe_and_answer, journey_replace, target C. Completed A + 'tell me more about A' => respond_answer, journey_side_question, target A. Active A + 'show A again' => respond_execute, journey_replace, target A.",
      options.activeJourney
        ? `ACTIVE JOURNEY CONTEXT:\n${JSON.stringify(options.activeJourney)}`
        : "ACTIVE JOURNEY CONTEXT:\n(none)",
      options.demoRuntimeState
        ? `DEMO RUNTIME STATE:\n${JSON.stringify(options.demoRuntimeState)}`
        : "DEMO RUNTIME STATE:\n(none; this is not a guided-demo interruption)",
      `PRODUCT: ${session.installation.productId}. ROLE: ${session.role}. CURRENT ORIGIN: ${session.origin}.`,
      `CATALOG ROUTE INDEX:\n${JSON.stringify(candidates)}`,
      `GUIDED-DEMO MODULE INDEX:\n${JSON.stringify(modules)}`,
      `MAPPED READ-ONLY NAVIGATION OPTIONS:\n${JSON.stringify(navigationOptions)}`,
      `RECENT CONVERSATION:\n${recentConversation(conversation) || "(none)"}`,
    ].join("\n\n");
    const tools = [{
      name: "submit_turn_plan",
      description: "Return one bounded semantic routing decision for this user turn.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          intent: { type: "string", enum: INTENTS },
          responseStrategy: { type: "string", enum: RESPONSE_STRATEGIES },
          journeyDisposition: { type: "string", enum: JOURNEY_DISPOSITIONS },
          target: {
            type: "object",
            properties: {
              kind: { type: "string", enum: TARGET_KINDS },
              id: { type: "string", description: "Exact listed ID, or empty for target kind none." },
            },
            required: ["kind", "id"],
            additionalProperties: false,
          },
          journeyInputsJson: { type: "string", description: "A JSON object encoded as a string; use {} for no inputs." },
          clarification: { type: "string", description: "One short question, or empty when none is needed." },
        },
        required: ["intent", "responseStrategy", "journeyDisposition", "target", "journeyInputsJson", "clarification"],
        additionalProperties: false,
      },
    }];
    const planningMessage: NeutralMessage = { role: "user", blocks: [{ type: "text", text: request.text.trim() }] };
    const requestPlan = async (repair?: string) => this.model.step(
      repair ? `${system}\n\nYOUR PREVIOUS PLAN WAS INVALID: ${repair}\nReturn one corrected plan using the exact schema and enum values.` : system,
      [planningMessage], tools, { signal: options.signal, toolChoice: "required" },
    );
    const parseRaw = (result: Awaited<ReturnType<typeof requestPlan>>): ParsedPlannerOutput => {
      const call = result.toolCalls.find((candidate) => candidate.name === "submit_turn_plan");
      if (!call || !isRecord(call.args)) throw new Error("the required submit_turn_plan tool was not returned");
      const raw = call.args;
      if (typeof raw.intent !== "string" || !INTENTS.includes(raw.intent as RuntimeIntent)) throw new Error(`intent ${JSON.stringify(raw.intent)} is unsupported`);
      if (typeof raw.responseStrategy !== "string" || !RESPONSE_STRATEGIES.includes(raw.responseStrategy as PlannerResponseStrategy)) throw new Error(`responseStrategy ${JSON.stringify(raw.responseStrategy)} is unsupported`);
      if (typeof raw.journeyDisposition !== "string" || !JOURNEY_DISPOSITIONS.includes(raw.journeyDisposition as PlannerJourneyDisposition)) throw new Error(`journeyDisposition ${JSON.stringify(raw.journeyDisposition)} is unsupported`);
      if (!isRecord(raw.target) || typeof raw.target.kind !== "string" || !TARGET_KINDS.includes(raw.target.kind as PlannerTargetKind) || typeof raw.target.id !== "string") throw new Error("target must contain one allowed kind and an ID string");
      const target = { kind: raw.target.kind as PlannerTargetKind, id: raw.target.id.trim() };
      if ((target.kind === "none") !== (target.id.length === 0)) throw new Error("target none requires an empty ID; every named target requires an ID");
      const strategy = raw.responseStrategy as PlannerResponseStrategy;
      if (strategy === "respond_navigate" && target.kind !== "screen") throw new Error("respond_navigate requires a screen target");
      if ((strategy === "respond_execute" || strategy === "respond_execute_then_observe_and_answer") && target.kind !== "journey" && target.kind !== "module") throw new Error(`${strategy} requires a journey or module target`);
      if (typeof raw.clarification !== "string") throw new Error("clarification must be a string");
      if (strategy === "respond_clarify" && !raw.clarification.trim()) throw new Error("respond_clarify requires one clarification question");
      if (typeof raw.journeyInputsJson !== "string") throw new Error("journeyInputsJson must be a JSON object string");
      let journeyInputs: unknown;
      try { journeyInputs = JSON.parse(raw.journeyInputsJson); }
      catch { throw new Error("journeyInputsJson is not valid JSON"); }
      if (!isRecord(journeyInputs) || !isJsonValue(journeyInputs)) throw new Error("journeyInputsJson must encode one JSON object");
      return {
        intent: raw.intent as RuntimeIntent,
        responseStrategy: strategy,
        journeyDisposition: raw.journeyDisposition as PlannerJourneyDisposition,
        target,
        journeyInputs: journeyInputs as Record<string, JsonValue>,
        clarification: raw.clarification.trim().slice(0, 300),
      };
    };

    // Provider/network failures remain operational errors. Only malformed tool
    // results are repaired; two bad results become a harmless clarification.
    const firstResult = await requestPlan();
    let parsed: ParsedPlannerOutput;
    try {
      parsed = parseRaw(firstResult);
    } catch (firstError) {
      const repairedResult = await requestPlan(firstError instanceof Error ? firstError.message : "invalid plan");
      try {
        parsed = parseRaw(repairedResult);
      } catch (secondError) {
        const firstReason = firstError instanceof Error ? firstError.message : "invalid plan";
        const secondReason = secondError instanceof Error ? secondError.message : "invalid plan";
        console.warn(`[turn-planner] rejected two structured plans; using safe clarification: first=${JSON.stringify(firstReason)} second=${JSON.stringify(secondReason)}`);
        parsed = {
          intent: "conversation",
          responseStrategy: "respond_clarify",
          journeyDisposition: options.activeJourney ? "journey_side_question" : "journey_none",
          target: { kind: "none", id: "" },
          journeyInputs: {},
          clarification: "Could you clarify whether you want me to explain something or show a specific section?",
        };
      }
    }

    const requestedMode = RESPONSE_MODE_BY_STRATEGY[parsed.responseStrategy];
    const targetModule = parsed.target.kind === "module" ? modules.find((module) => module.id === parsed.target.id) : undefined;
    const targetJourneyId = parsed.target.kind === "journey" ? parsed.target.id : targetModule?.journeyId;
    const candidate = targetJourneyId ? candidates.find((journey) => journey.id === targetJourneyId) : undefined;
    const subjectJourneyId = targetJourneyId && candidates.some((journey) => journey.id === targetJourneyId) ? targetJourneyId : undefined;
    const eligible = executableJourney(catalog, session.role, targetJourneyId);
    const navigationTargetScreenId = requestedMode === "navigate" && parsed.target.kind === "screen" && screenNames.has(parsed.target.id) ? parsed.target.id : undefined;
    const requestedAction = requestedMode === "navigate" || requestedMode === "execute" || requestedMode === "execute_then_observe_and_answer";
    const unavailableReason = parsed.intent === "action" && requestedMode === "answer" && parsed.target.kind === "none"
      ? "No approved catalog journey matches the requested action."
      : requestedMode === "navigate" && !navigationTargetScreenId
      ? "No mapped read-only destination matches the requested action."
      : (requestedMode === "execute" || requestedMode === "execute_then_observe_and_answer") && !eligible
        ? candidate
          ? `${candidate.name} is unavailable for SDK execution: ${candidate.description || `catalog state is ${candidate.state}`}`
          : "The requested action does not match any journey in this catalog."
        : undefined;
    const clarification = parsed.clarification || undefined;
    const mode: TurnResponseMode = clarification ? "clarify" : requestedAction && !eligible && !navigationTargetScreenId ? "answer" : requestedMode;
    const actionRequested = mode === "navigate" ? !!navigationTargetScreenId : (mode === "execute" || mode === "execute_then_observe_and_answer") && !!eligible;
    const actionAttempted = requestedAction || (parsed.intent === "action" && !!unavailableReason);
    const presentationRequested = mode === "execute_then_observe_and_answer" && !!eligible && eligible.risk === "read";
    let taskControl: TaskControl = options.activeJourney ? TASK_CONTROL_BY_DISPOSITION[parsed.journeyDisposition] : "none";
    if (options.activeJourney && (mode === "execute" || mode === "execute_then_observe_and_answer") && taskControl !== "continue") taskControl = "replace";
    if (options.activeJourney && taskControl === "replace" && !actionRequested) taskControl = "side_question";
    if (options.activeJourney && taskControl === "none") taskControl = "side_question";
    return {
      intent: parsed.intent,
      mode,
      taskControl,
      actionRequested,
      actionAttempted,
      presentationRequested,
      ...(subjectJourneyId ? { subjectJourneyId } : {}),
      ...(eligible && actionRequested && mode !== "navigate" ? { journeyId: eligible.id } : {}),
      ...(navigationTargetScreenId ? { navigationTargetScreenId } : {}),
      journeyInputs: eligible && actionRequested ? parsed.journeyInputs : {},
      clarification,
      unavailableReason,
      needsFreshObservation: mode === "observe_then_answer" || mode === "navigate",
      needsKnowledge: parsed.intent === "product_question" || parsed.intent === "objection" || parsed.intent === "how_to" || mode === "execute_then_observe_and_answer" || !!unavailableReason,
    };
  }
}
