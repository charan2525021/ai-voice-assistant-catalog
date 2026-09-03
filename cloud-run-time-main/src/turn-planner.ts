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

export interface ActiveJourneyContext {
  journeyId: string;
  journeyName: string;
  paused: boolean;
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
  journeyId?: string;
  navigationTargetScreenId?: string;
  journeyInputs: Record<string, JsonValue>;
  clarification?: string;
  unavailableReason?: string;
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

/**
 * Uses the configured reasoning model to understand the turn semantically.
 * The result is data, not authority: catalog state and SDK compatibility are
 * checked again locally before any journey can be returned.
 */
export class TurnPlanner {
  constructor(private readonly model: ModelClient) {}

  async plan(
    session: RuntimeSession,
    catalog: SignedCatalogEnvelope,
    bundle: RuntimeBundle,
    conversation: ConversationState,
    request: TurnRequest,
    options: { signal?: AbortSignal; activeJourney?: ActiveJourneyContext } = {},
  ): Promise<TurnPlan> {
    const signedById = new Map(catalog.payload.journeys.map((journey) => [journey.id, journey]));
    const candidates = bundle.journeys.map((journey) => {
      const signed = signedById.get(journey.key);
      const executable = !!executableJourney(catalog, session.role, journey.key);
      return {
        id: journey.key,
        name: journey.name,
        phrases: journey.intentPhrases.slice(0, 8),
        approvedForThisSession: executable,
        state: signed?.state ?? "not_in_signed_catalog",
        risk: signed?.risk ?? journey.workflow.risk,
        description: signed?.description ?? "",
        requiredInputs: signed?.inputSchema.required ?? [],
        inputProperties: signed?.inputSchema.properties ?? {},
      };
    });
    const screenNames = new Map((bundle.screens ?? []).map((screen) => [screen.key, screen.name]));
    const navigationOptions = (bundle.transitions ?? []).flatMap((transition) => {
      const source = (bundle.screens ?? []).find((screen) => screen.key === transition.fromScreenKey);
      const target = transition.toScreenKey ? (bundle.screens ?? []).find((screen) => screen.key === transition.toScreenKey) : undefined;
      const control = source?.controls.find((candidate) => candidate.key === transition.controlKey);
      if (!target || !control || control.risk !== "read" || transition.reliability < 0.9) return [];
      return [{ fromScreenId: transition.fromScreenKey, fromScreenName: source?.name, targetScreenId: target.key, targetScreenName: target.name, controlName: control.accessibleName, risk: control.risk }];
    });
    const system = [
      "You are the semantic turn planner for Sable. Always call submit_turn_plan exactly once and produce no user-facing answer.",
      "Understand meaning and follow-up references from the recent conversation; do not depend on exact phrases.",
      "Choose one primary intent and exactly one response mode. Do not express the execution sequence through separate booleans.",
      "Use answer for a grounded answer without page movement; observe_then_answer for a current-page answer that needs a fresh DOM; navigate for an explicit move to one mapped read-only destination, even when the runtime must compose several trained transitions to reach it; execute for an approved complete journey; execute_then_observe_and_answer for an approved complete journey followed by explanation; clarify when one missing detail prevents a safe decision.",
      "For questions about the page currently visible—its text, description, price, status, section, control, or meaning—use observe_then_answer with an empty journeyId. Reading or explaining the current screen is never permission to click or replay a journey.",
      "Use execute modes only when the user explicitly asks to move, click, open, change, submit, or otherwise act. Do not select a journey merely because it previously led to the current screen.",
      "A request for a complete, full, or multi-section walkthrough must use execute and the approved walkthrough journey, not a single-section jump.",
      "When the user asks to reach one named mapped page or section, use navigate with its exact final targetScreenId and an empty journeyId. The deterministic runtime—not you—will derive any required intermediate route. Never use navigate for writes, unknown destinations, or a complete walkthrough.",
      "A request to explain, describe, or tell what a NAMED PAGE SECTION contains must use execute_then_observe_and_answer when an approved read-only journey can show it.",
      "Never treat a general factual question as permission to act. Never request a screenshot.",
      options.activeJourney
        ? `There is an active journey: ${JSON.stringify(options.activeJourney)}. Classify this turn with taskControl. Use continue only to resume it, stop only to end it, replace when the user wants a new journey instead, and side_question when they ask something without ending it. A side question leaves the journey paused until the user explicitly resumes or replaces it.`
        : "There is no active journey. Use taskControl none.",
      "Select only an exact journey ID listed below. You may select a non-approved journey only to identify a known limitation; it will never execute.",
      "If the intended journey needs an input the user has not supplied, put one short question in clarification and do not guess.",
      "Clarify only when the requested object or a required journey input is genuinely missing. If the user explicitly names a control and asks to click, submit, fill, or select it, never ask what outcome they expect; classify the request as action even when no approved route exists.",
      "Use needsKnowledge for product facts, objections, limitations, broken links, or when no approved journey can satisfy an action.",
      `PRODUCT: ${session.installation.productId}. ROLE: ${session.role}. CURRENT ORIGIN: ${session.origin}.`,
      `CATALOG ROUTE INDEX:\n${JSON.stringify(candidates)}`,
      `MAPPED READ-ONLY NAVIGATION OPTIONS:\n${JSON.stringify(navigationOptions)}`,
      `RECENT CONVERSATION:\n${recentConversation(conversation) || "(none)"}`,
    ].join("\n\n");
    const tools = [{
      name: "submit_turn_plan",
      description: "Return the single bounded routing decision for this user turn.",
      parameters: {
        type: "object",
        properties: {
          intent: { type: "string", enum: INTENTS },
          mode: { type: "string", enum: RESPONSE_MODES },
          needsKnowledge: { type: "boolean" },
          journeyId: { type: "string", description: "Exact catalog journey ID, or an empty string when none applies." },
          targetScreenId: { type: "string", description: "Exact mapped destination screen ID for navigate mode, or an empty string otherwise." },
          journeyInputs: { type: "object", additionalProperties: true },
          clarification: { type: "string", description: "One short question, or an empty string when no clarification is needed." },
          taskControl: { type: "string", enum: TASK_CONTROLS, description: "How this turn relates to the active journey, or none when no journey is active." },
        },
        required: ["intent", "mode", "needsKnowledge", "journeyId", "targetScreenId", "journeyInputs", "clarification", "taskControl"],
        additionalProperties: false,
      },
    }];
    const planningMessage: NeutralMessage = { role: "user", blocks: [{ type: "text", text: request.text.trim() }] };
    const requestPlan = async (repair?: string) => this.model.step(
      repair ? `${system}\n\nYOUR PREVIOUS PLAN WAS INVALID: ${repair}\nReturn one corrected plan using only the allowed enum values and consistent fields.` : system,
      [planningMessage], tools, { signal: options.signal, toolChoice: "required" },
    );
    const parseRaw = (result: Awaited<ReturnType<typeof requestPlan>>): { raw: Record<string, unknown>; adjustment?: string } => {
      const call = result.toolCalls.find((candidate) => candidate.name === "submit_turn_plan");
      if (!call || !isRecord(call.args)) throw new Error("the required submit_turn_plan tool was not returned");
      const raw = { ...call.args };
      if (typeof raw.intent !== "string" || !INTENTS.includes(raw.intent as RuntimeIntent)) throw new Error(`intent ${JSON.stringify(raw.intent)} is unsupported`);
      if (typeof raw.mode !== "string" || !RESPONSE_MODES.includes(raw.mode as TurnResponseMode)) throw new Error(`mode ${JSON.stringify(raw.mode)} is unsupported`);
      if (raw.mode === "clarify" && (typeof raw.clarification !== "string" || !raw.clarification.trim())) throw new Error("clarify mode requires one clarification question");
      const hasJourney = typeof raw.journeyId === "string" && raw.journeyId.length > 0;
      const targetScreenId = typeof raw.targetScreenId === "string" && raw.targetScreenId.length > 0 ? raw.targetScreenId : undefined;
      if (raw.taskControl !== undefined && (typeof raw.taskControl !== "string" || !TASK_CONTROLS.includes(raw.taskControl as TaskControl))) throw new Error(`taskControl ${JSON.stringify(raw.taskControl)} is unsupported`);
      if ((raw.mode === "execute" || raw.mode === "execute_then_observe_and_answer") && !hasJourney) {
        raw.mode = "answer";
        raw.needsKnowledge = true;
        raw.journeyId = "";
        raw.journeyInputs = {};
        return { raw, adjustment: "No approved catalog journey matches the requested action." };
      }
      if (raw.mode === "navigate" && (!targetScreenId || !screenNames.has(targetScreenId))) {
        raw.mode = "answer";
        raw.needsKnowledge = true;
        raw.targetScreenId = "";
        return { raw, adjustment: "No mapped read-only destination matches the requested action." };
      }
      if (raw.mode === "navigate") {
        raw.journeyId = "";
        raw.journeyInputs = {};
      }
      if (raw.mode !== "navigate" && targetScreenId) raw.targetScreenId = "";
      if ((raw.mode === "answer" || raw.mode === "observe_then_answer" || raw.mode === "clarify") && hasJourney) {
        if (raw.intent === "action") throw new Error(`${raw.mode} cannot also select a journey for an action request`);
        raw.journeyId = "";
        raw.journeyInputs = {};
        return { raw };
      }
      return { raw };
    };
    // A provider/network failure is not an invalid plan. Only retry when the
    // provider actually returned a tool call whose arguments failed validation;
    // otherwise preserve the real operational error for the SDK and logs.
    const firstResult = await requestPlan();
    let parsed: ReturnType<typeof parseRaw>;
    try {
      parsed = parseRaw(firstResult);
    } catch (firstError) {
      const repairedResult = await requestPlan(firstError instanceof Error ? firstError.message : "invalid plan");
      try { parsed = parseRaw(repairedResult); }
      catch (secondError) {
        const firstReason = firstError instanceof Error ? firstError.message : "invalid plan";
        const secondReason = secondError instanceof Error ? secondError.message : "invalid plan";
        console.warn(`[turn-planner] rejected two structured plans: first=${JSON.stringify(firstReason)} second=${JSON.stringify(secondReason)}`);
        throw new Error("I couldn't understand how to handle that request safely. Please try asking it another way.");
      }
    }
    const { raw, adjustment } = parsed;
    const intent = raw.intent as RuntimeIntent;
    const requestedMode = raw.mode as TurnResponseMode;
    const requestedJourneyId = typeof raw.journeyId === "string" && raw.journeyId ? raw.journeyId : undefined;
    const navigationTargetScreenId = requestedMode === "navigate" && typeof raw.targetScreenId === "string" && raw.targetScreenId ? raw.targetScreenId : undefined;
    const candidate = requestedJourneyId ? candidates.find((journey) => journey.id === requestedJourneyId) : undefined;
    const eligible = executableJourney(catalog, session.role, requestedJourneyId);
    const rawInputs = isRecord(raw.journeyInputs) && isJsonValue(raw.journeyInputs) ? raw.journeyInputs as Record<string, JsonValue> : {};
    const clarification = typeof raw.clarification === "string" && raw.clarification.trim() ? raw.clarification.trim().slice(0, 300) : undefined;
    const requestedAction = requestedMode === "navigate" || requestedMode === "execute" || requestedMode === "execute_then_observe_and_answer";
    const requestedNavigationValid = requestedMode === "navigate" && !!navigationTargetScreenId;
    const unavailableReason = adjustment ?? (requestedJourneyId && !eligible
      ? candidate
        ? `${candidate.name} is unavailable for SDK execution: ${candidate.description || `catalog state is ${candidate.state}`}`
        : "The requested action does not match any journey in this catalog."
      : undefined);
    const mode: TurnResponseMode = clarification ? "clarify" : requestedAction && !eligible && !requestedNavigationValid ? "answer" : requestedMode;
    const actionRequested = mode === "navigate" ? !!navigationTargetScreenId : (mode === "execute" || mode === "execute_then_observe_and_answer") && !!eligible;
    const actionAttempted = requestedAction || (intent === "action" && !!unavailableReason);
    const presentationRequested = mode === "execute_then_observe_and_answer" && !!eligible && eligible.risk === "read";
    const requestedTaskControl = typeof raw.taskControl === "string" ? raw.taskControl as TaskControl : "none";
    let taskControl: TaskControl = options.activeJourney ? requestedTaskControl : "none";
    if (options.activeJourney && actionRequested && taskControl !== "continue") taskControl = "replace";
    if (options.activeJourney && taskControl === "replace" && !actionRequested) taskControl = "side_question";
    if (options.activeJourney && taskControl === "none") taskControl = "side_question";
    return {
      intent,
      mode,
      taskControl,
      actionRequested,
      actionAttempted,
      presentationRequested,
      journeyId: eligible?.id,
      ...(navigationTargetScreenId ? { navigationTargetScreenId } : {}),
      journeyInputs: eligible ? rawInputs : {},
      clarification,
      unavailableReason,
      needsFreshObservation: mode === "observe_then_answer" || mode === "navigate",
      needsKnowledge: raw.needsKnowledge === true || intent === "product_question" || intent === "objection" || !!unavailableReason,
    };
  }
}
