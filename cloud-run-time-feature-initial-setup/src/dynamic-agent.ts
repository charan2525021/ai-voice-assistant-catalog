import type {
  DynamicToolKind,
  DynamicToolResult,
  DynamicToolTarget,
  JsonValue,
  RiskLevel,
  SignedCatalogEnvelope,
  UIMapSnapshot,
} from "@sable/sdk-contracts";
import type { ModelClient, NeutralMessage } from "@sable/model-client";
import type { RuntimeBundle } from "@sable/runtime-core";
import type { ConversationState, TurnRequest } from "./turn-coordinator.js";
import type { DynamicModeConfig, RuntimeSession } from "./contracts.js";
import type { RuntimeConfig } from "./config.js";

const DEFAULT_MAX_ITERATIONS = 8;
const HARD_ITERATION_CAP = 15;
const DEFAULT_ALLOWED_TOOLS: DynamicToolKind[] = ["click", "fill", "select", "check", "uncheck", "hover", "scroll", "navigate", "wait", "read"];
const TERMINAL_ACTIONS = new Set(["answer", "ask", "done", "error"]);
const LOW_RISK_TOOLS: ReadonlySet<DynamicToolKind> = new Set(["read", "hover", "scroll", "wait"]);
const MEDIUM_RISK_TOOLS: ReadonlySet<DynamicToolKind> = new Set(["click", "fill", "select", "check", "uncheck", "navigate"]);
// No tool is currently classified as external_side_effect or destructive by shape alone;
// the runtime keeps that classification signed-only in this MVP. If the LLM claims a
// destructive intent we still down-classify to medium — the SDK's approval gate can be
// invoked from the runtime side if a policy adds a heuristic later.

export interface DynamicPlanStep {
  id: string;
  title: string;
  status?: "pending" | "in_progress" | "done" | "failed";
  detail?: string;
}

export interface DynamicPlan {
  version: number;
  steps: DynamicPlanStep[];
  reason?: string;
}

export interface DynamicToolCallProposal {
  stepId: string;
  tool: DynamicToolKind;
  target?: DynamicToolTarget;
  arguments: Record<string, JsonValue>;
  reasoning?: string;
  title?: string;
  risk: RiskLevel;
  requiresConfirmation: boolean;
}

export interface DynamicAgentEvents {
  /** Dispatches a tool call to the SDK, resolves with the SDK's result. */
  executeTool(call: DynamicToolCallProposal): Promise<DynamicToolResult>;
  /** Emits the current plan snapshot. Useful for UI progress. */
  onPlan?(plan: DynamicPlan): void;
  /** Streams a short narration sentence to the SDK for TTS + display. */
  onNarration?(sentence: string): void;
  signal?: AbortSignal;
}

export interface DynamicAgentContext {
  session: RuntimeSession;
  catalog: SignedCatalogEnvelope;
  bundle: RuntimeBundle;
  conversation: ConversationState;
  request: TurnRequest;
  uiMap?: UIMapSnapshot;
}

export interface DynamicAgentRunResult {
  finalText: string;
  status: "answered" | "asked" | "done" | "error" | "iteration_cap";
  iterations: number;
  plan?: DynamicPlan;
  toolCallsRun: number;
  reasoning: string[];
}

interface StepRun {
  stepId: string;
  tool: DynamicToolKind;
  success: boolean;
  detail?: string;
  /** Stable JSON signature of tool+target+arguments used to detect duplicate calls. */
  signature?: string;
  /** Resolved element label / navigated path — used to build a confirmation string. */
  label?: string;
}

/**
 * Build a stable signature of the tool call so we can detect the model
 * proposing the exact same action twice in a row (which happens on
 * gpt-4o-mini after a successful single-action click when it fails to
 * self-terminate). The signature includes the tool name, target keys sorted,
 * and the target values. arguments.path/url are also included so navigate
 * repeat detection works too.
 */
function toolCallSignature(
  tool: DynamicToolKind,
  target: Record<string, unknown> | undefined,
  args: Record<string, unknown> | undefined,
): string {
  const keys: string[] = [];
  const pairs: string[] = [];
  if (target) {
    for (const k of Object.keys(target).sort()) {
      const v = target[k];
      if (v === undefined || v === null) continue;
      keys.push(k);
      pairs.push(`${k}=${typeof v === "string" ? v.toLowerCase().trim() : JSON.stringify(v)}`);
    }
  }
  if (args) {
    for (const k of ["path", "url"]) {
      const v = args[k];
      if (typeof v === "string" && v.trim()) pairs.push(`${k}=${v.toLowerCase().trim()}`);
    }
  }
  return `${tool}::${pairs.join("|")}`;
}

/** Tools where "acting on the same thing twice in a row" is almost never intended. */
const SINGLE_ACTION_TOOLS = new Set<DynamicToolKind>(["click", "navigate", "check", "uncheck", "hover", "read"]);

function buildRepeatConfirmation(tool: DynamicToolKind, label: string | undefined, readText?: string): string {
  const target = label ?? "the requested element";
  switch (tool) {
    case "click": return `Clicked ${target}.`;
    case "navigate": return `Navigated to ${target}.`;
    case "check": return `Checked ${target}.`;
    case "uncheck": return `Unchecked ${target}.`;
    case "hover": return `Hovered over ${target}.`;
    case "read": {
      if (readText && readText.trim()) return readText.trim().slice(0, 600);
      return `Here is what I found on ${target}.`;
    }
    default: return `Done — ${tool} on ${target}.`;
  }
}

function extractReadText(data: unknown): string | undefined {
  const record = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined;
  if (!record) return undefined;
  const text = record.text;
  return typeof text === "string" && text.trim() ? text : undefined;
}

function ensureRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function isJson(value: unknown): value is JsonValue {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJson);
  const record = ensureRecord(value);
  return !!record && Object.values(record).every(isJson);
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function inferRiskForTool(tool: DynamicToolKind): RiskLevel {
  if (LOW_RISK_TOOLS.has(tool)) return "read";
  if (MEDIUM_RISK_TOOLS.has(tool)) return "reversible_write";
  return "reversible_write";
}

function shouldConfirmForRisk(risk: RiskLevel, autoConfirmLowRisk: boolean): boolean {
  if (risk === "destructive" || risk === "external_side_effect") return true;
  if (risk === "reversible_write") return !autoConfirmLowRisk;
  return false;
}

function compactUIMap(snapshot: UIMapSnapshot | undefined, limit = 60): string {
  if (!snapshot || snapshot.elements.length === 0) return "(no UI map available for this turn)";
  const lines: string[] = [];
  const interactive = snapshot.elements.filter((element) => element.visible !== false);
  for (const element of interactive.slice(0, limit)) {
    const attrs: string[] = [`[${element.role}]`];
    if (element.testId) attrs.push(`testId=${element.testId}`);
    // Show label, accessibleName, and text (up to 80 chars) so the LLM has all
    // three signals to choose the most reliable target expression.
    if (element.label) attrs.push(`label=${JSON.stringify(element.label.slice(0, 80))}`);
    if (element.accessibleName && element.accessibleName !== element.label) attrs.push(`name=${JSON.stringify(element.accessibleName.slice(0, 80))}`);
    if (element.text && element.text !== element.label && element.text !== element.accessibleName) attrs.push(`text=${JSON.stringify(element.text.slice(0, 80))}`);
    if (element.placeholder) attrs.push(`placeholder=${JSON.stringify(element.placeholder)}`);
    if (element.editable) attrs.push("editable");
    if (element.sensitive) attrs.push("sensitive");
    lines.push(`  ${attrs.join(" ")}`);
  }
  const truncated = interactive.length > limit ? `\n  … ${interactive.length - limit} more visible elements omitted` : "";
  return `PAGE ${JSON.stringify(snapshot.path)}${snapshot.title ? ` — ${JSON.stringify(snapshot.title)}` : ""}\n${lines.join("\n")}${truncated}`;
}

function catalogJourneySummary(catalog: SignedCatalogEnvelope, session: RuntimeSession): string {
  const approved = catalog.payload.journeys.filter((journey) => journey.state === "approved" && (!journey.roles.length || journey.roles.includes(session.role)));
  if (!approved.length) return "(no signed journeys are visible for this role)";
  const rows = approved.slice(0, 12).map((journey) => `  - ${JSON.stringify(journey.id)}: ${journey.name} (risk=${journey.risk})`);
  return `SIGNED JOURNEYS (LLM can recommend one, but cannot run it directly in dynamic mode):\n${rows.join("\n")}`;
}

function recentConversation(conversation: ConversationState): string {
  return conversation.messages.slice(-8).flatMap((message) => message.blocks.flatMap((block) => {
    if (block.type !== "text") return [];
    return [`${message.role}: ${block.text.slice(0, 500)}`];
  })).join("\n");
}

function planBlock(plan: DynamicPlan | undefined): string {
  if (!plan || plan.steps.length === 0) return "(no plan yet — emit `plan` on the first iteration for any multi-step goal)";
  return plan.steps.map((step) => `  ${step.status === "done" ? "✓" : step.status === "failed" ? "✗" : step.status === "in_progress" ? "→" : "·"} [${step.id}] ${step.title}${step.detail ? ` — ${step.detail}` : ""}`).join("\n");
}

function stepsSoFarBlock(steps: StepRun[]): string {
  if (steps.length === 0) return "(no actions have run this turn)";
  return steps.map((step, index) => `  ${index + 1}. [${step.stepId}] ${step.tool} — ${step.success ? "success" : `failed: ${step.detail ?? "unknown"}`}`).join("\n");
}

/**
 * Runs one dynamic-mode user turn using a bounded Plan-then-Execute loop. The
 * loop delegates every tool execution back to the caller via
 * `events.executeTool` so the caller (typically TurnCoordinator) owns the WS
 * command lifecycle and command IDs.
 */
export class DynamicAgent {
  constructor(private readonly model: ModelClient, private readonly config: RuntimeConfig) {}

  async run(ctx: DynamicAgentContext, events: DynamicAgentEvents, dynamicConfig: DynamicModeConfig): Promise<DynamicAgentRunResult> {
    const maxIterations = Math.max(1, Math.min(dynamicConfig.maxIterationsPerTurn ?? DEFAULT_MAX_ITERATIONS, HARD_ITERATION_CAP));
    const allowedTools = (dynamicConfig.allowedTools?.length ? dynamicConfig.allowedTools : DEFAULT_ALLOWED_TOOLS)
      .filter((tool): tool is DynamicToolKind => DEFAULT_ALLOWED_TOOLS.includes(tool));
    const autoConfirmLowRisk = dynamicConfig.autoConfirmLowRisk ?? true;

    let plan: DynamicPlan | undefined;
    const stepsSoFar: StepRun[] = [];
    const reasoning: string[] = [];
    let iteration = 0;
    let finalText = "";
    let terminalStatus: DynamicAgentRunResult["status"] | undefined;
    let toolCallsRun = 0;

    while (iteration < maxIterations) {
      iteration += 1;
      const trailingFailures = countTrailingFailures(stepsSoFar);
      // Structurally forbid another tool call after 2 consecutive failures so
      // the model cannot ignore the give-up policy encoded in the prompt.
      const forbidTool = trailingFailures >= 2;
      const system = this.buildSystemPrompt(ctx, allowedTools, plan, stepsSoFar, iteration, maxIterations);
      const message: NeutralMessage = { role: "user", blocks: [{ type: "text", text: ctx.request.text }] };
      // On iter1 we let the model emit either text or a tool call so that
      // knowledge / conversational questions (e.g. "explain what is X") can be
      // answered directly. From iter2 onward we force a tool call so it must
      // commit to done/answer/next-tool. The prompt still tells it to use the
      // click/fill tools whenever the user requests an action.
      const result = await this.model.step(system, [message], [this.decisionTool(allowedTools, forbidTool)], {
        signal: events.signal,
        toolChoice: iteration === 1 ? "auto" : "required",
      });
      const decision = this.parseDecision(result);
      if (!decision) {
        // Diagnostic: log what the model actually returned so we can adjust
        // the prompt / schema if the model is emitting text instead of a tool
        // call, or a tool call with unexpected shape.
        const rawToolCalls = result.toolCalls?.map((c) => ({ name: c.name, args: c.args })) ?? [];
        const rawText = safeString(result.texts?.join("\n"))?.slice(0, 800);
        console.log(`[dynamic-agent] iter${iteration} decision=<none> — model output: toolCalls=${JSON.stringify(rawToolCalls).slice(0, 600)} text=${JSON.stringify(rawText)}`);
        // FALLBACK: if the model returned plain text (which happens on
        // knowledge / conversational questions when the schema confuses it),
        // use that text as an answer. Better UX than a hard error.
        if (rawText && iteration === 1) {
          finalText = rawText;
          terminalStatus = "answered";
          console.log(`[dynamic-agent] iter${iteration} FALLBACK-ANSWER (model emitted plain text on iter1)`);
          break;
        }
        finalText = "I couldn't decide how to help with that safely. Please try again.";
        terminalStatus = "error";
        break;
      }
      console.log(`[dynamic-agent] iter${iteration} action=${decision.action}${decision.tool ? ` tool=${decision.tool.name}` : ""}${decision.text ? ` text=${JSON.stringify(decision.text.slice(0, 120))}` : ""}${decision.reasoning ? ` reasoning=${JSON.stringify(decision.reasoning.slice(0, 200))}` : ""}`);
      if (decision.reasoning) reasoning.push(decision.reasoning);

      if (decision.action === "plan" || decision.action === "update_plan") {
        const steps = decision.steps ?? [];
        plan = {
          version: (plan?.version ?? 0) + 1,
          steps: steps.map((step) => ({ id: step.id, title: step.title, status: "pending" })),
          ...(decision.reason ? { reason: decision.reason } : {}),
        };
        events.onPlan?.(plan);
        continue;
      }

      if (decision.action === "tool") {
        if (!decision.tool) {
          finalText = "The agent proposed a tool without a name; the run was stopped.";
          terminalStatus = "error";
          break;
        }
        if (!allowedTools.includes(decision.tool.name)) {
          finalText = `The agent proposed the tool ${decision.tool.name}, which is not enabled for this installation.`;
          terminalStatus = "error";
          break;
        }

        // RUNTIME SAFETY NET: if the last step just succeeded with the exact
        // same tool + target signature, the model has failed to self-terminate
        // (gpt-4o-mini regularly does this on single-action clicks). Auto-conclude
        // with a one-line confirmation rather than re-clicking and hitting the
        // iteration cap.
        const proposedSignature = toolCallSignature(
          decision.tool.name,
          decision.tool.target as Record<string, unknown> | undefined,
          decision.tool.arguments as Record<string, unknown> | undefined,
        );
        const lastStep = stepsSoFar[stepsSoFar.length - 1];
        // RUNTIME GIVE-UP GUARD: if the same target has already failed N times
        // this turn (regardless of what plan/narrate actions the model
        // interspersed), stop trying and produce a helpful message. This is a
        // hard safety net for when gpt-4o-mini bypasses the schema-level
        // `forbidTool` switch.
        const sameTargetFailures = stepsSoFar.filter(
          (s) => !s.success && s.signature === proposedSignature,
        ).length;
        if (sameTargetFailures >= 2) {
          const failedLabel = (decision.tool.target as Record<string, unknown> | undefined)?.text
            ?? (decision.tool.target as Record<string, unknown> | undefined)?.accessibleName
            ?? "the requested target";
          const message = `I couldn't find '${String(failedLabel)}' on this page. Could you say the label exactly as it appears, or point me to a different section?`;
          console.log(`[dynamic-agent] iter${iteration} GIVE-UP (${decision.tool.name} on same target failed ${sameTargetFailures}x already) — text=${JSON.stringify(message.slice(0, 120))}`);
          finalText = message;
          terminalStatus = "answered";
          break;
        }

        // RUNTIME FORBID-TOOL ENFORCEMENT: if the model bypassed the
        // `submit_next_action_no_tool` schema switch and proposed a tool call
        // after 2+ consecutive failures, convert to a graceful answer.
        if (trailingFailures >= 2) {
          const message = "I've tried a couple of times and couldn't find that on the page. Could you describe it differently — for example, a nearby heading or button label?";
          console.log(`[dynamic-agent] iter${iteration} FORBID-TOOL-ENFORCED (${trailingFailures} trailing failures, model ignored schema) — text=${JSON.stringify(message.slice(0, 120))}`);
          finalText = message;
          terminalStatus = "answered";
          break;
        }

        if (
          lastStep &&
          lastStep.success &&
          SINGLE_ACTION_TOOLS.has(decision.tool.name) &&
          lastStep.signature === proposedSignature
        ) {
          // If the last call was a `read`, its detail carries `read="..."` — extract
          // that snippet and use it as the natural-language answer.
          const readSnippet = decision.tool.name === "read" && lastStep.detail?.startsWith("read=\"")
            ? lastStep.detail.slice(6, -1)
            : undefined;
          const confirmation = buildRepeatConfirmation(decision.tool.name, lastStep.label, readSnippet);
          console.log(`[dynamic-agent] iter${iteration} AUTO-DONE (model proposed duplicate ${decision.tool.name} after success) — text=${JSON.stringify(confirmation.slice(0, 120))}`);
          finalText = confirmation;
          terminalStatus = decision.tool.name === "read" ? "answered" : "done";
          break;
        }

        const risk = inferRiskForTool(decision.tool.name);
        const requiresConfirmation = shouldConfirmForRisk(risk, autoConfirmLowRisk);
        const stepId = decision.stepId ?? `step-${iteration}`;
        markPlanStep(plan, stepId, "in_progress");
        events.onPlan?.(plan!);
        let toolResult: DynamicToolResult;
        try {
          console.log(`[dynamic-agent] iter${iteration} tool=${decision.tool.name} target=${JSON.stringify(decision.tool.target ?? {})} args=${JSON.stringify(decision.tool.arguments ?? {})}`);
          toolResult = await events.executeTool({
            stepId,
            tool: decision.tool.name,
            ...(decision.tool.target ? { target: decision.tool.target } : {}),
            arguments: decision.tool.arguments ?? {},
            ...(decision.reasoning ? { reasoning: decision.reasoning } : {}),
            ...(decision.tool.title ? { title: decision.tool.title } : {}),
            risk,
            requiresConfirmation,
          });
          console.log(`[dynamic-agent] iter${iteration} result success=${toolResult.success} strategy=${toolResult.matchedElement?.strategy ?? "n/a"} confidence=${toolResult.matchedElement?.confidence ?? "n/a"} error=${toolResult.error?.code ?? "none"}`);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          markPlanStep(plan, stepId, "failed", detail);
          events.onPlan?.(plan!);
          stepsSoFar.push({ stepId, tool: decision.tool.name, success: false, detail });
          continue;
        }
        toolCallsRun += 1;
        const resolvedLabel = toolResult.matchedElement?.label
          ?? (typeof (decision.tool.target as Record<string, unknown> | undefined)?.text === "string"
              ? String((decision.tool.target as Record<string, unknown>).text)
              : undefined)
          ?? (typeof (decision.tool.arguments as Record<string, unknown> | undefined)?.path === "string"
              ? String((decision.tool.arguments as Record<string, unknown>).path)
              : undefined);
        // For `read` tool, thread the actual returned text back so the LLM can
        // synthesize a user-facing answer on the next iteration instead of
        // re-reading the same element.
        const readText = toolResult.success && decision.tool.name === "read"
          ? extractReadText(toolResult.data)
          : undefined;
        const stepDetail = toolResult.success
          ? (readText ? `read="${readText.slice(0, 400)}"` : toolResult.matchedElement?.label ?? undefined)
          : toolResult.error?.message;
        stepsSoFar.push({
          stepId,
          tool: decision.tool.name,
          success: toolResult.success,
          detail: stepDetail,
          signature: proposedSignature,
          ...(resolvedLabel ? { label: resolvedLabel } : {}),
        });
        markPlanStep(plan, stepId, toolResult.success ? "done" : "failed", toolResult.error?.message);
        events.onPlan?.(plan!);
        continue;
      }

      if (decision.action === "narrate") {
        const text = safeString(decision.text);
        if (text) events.onNarration?.(text);
        continue;
      }

      if (decision.action === "answer" || decision.action === "done") {
        finalText = safeString(decision.text) ?? (decision.action === "done" ? "Done." : "");
        terminalStatus = decision.action === "done" ? "done" : "answered";
        break;
      }

      if (decision.action === "ask") {
        finalText = safeString(decision.text) ?? "Could you tell me a little more?";
        terminalStatus = "asked";
        break;
      }

      if (decision.action === "error") {
        finalText = safeString(decision.text) ?? "I ran into a problem I could not recover from.";
        terminalStatus = "error";
        break;
      }
    }

    if (!terminalStatus) {
      terminalStatus = "iteration_cap";
      if (!finalText) {
        const failures = stepsSoFar.filter((step) => !step.success);
        if (failures.length) {
          finalText = `I couldn't find that on the page. Try naming it exactly as it appears.`;
        } else {
          finalText = "I need a bit more direction — could you say what to do next?";
        }
      }
    }

    return { finalText, status: terminalStatus, iterations: iteration, ...(plan ? { plan } : {}), toolCallsRun, reasoning };
  }

  private buildSystemPrompt(
    ctx: DynamicAgentContext,
    allowedTools: DynamicToolKind[],
    plan: DynamicPlan | undefined,
    stepsSoFar: StepRun[],
    iteration: number,
    maxIterations: number,
  ): string {
    const consecutiveFailures = countTrailingFailures(stepsSoFar);
    return [
      "You are Sable's dynamic browser agent operating on a live web page.",
      "",
      "### MOST IMPORTANT RULE",
      "When the user says click / fill / select / scroll / navigate / open — YOUR FIRST ITERATION MUST EMIT action=\"tool\". Never emit \"answer\", \"ask\", or \"done\" as a first response to such a request. Try the tool call. The resolver is forgiving: testId → aria-label → role+name exact → role+name contains → label fuzzy → text exact → text contains → clickable ancestor of a matching text node. Approximate labels almost always resolve.",
      "",
      "Concrete example. User says: `click on User Journey`. Your first submit_next_action MUST look like:",
      "  { action: \"tool\", stepId: \"s1\", tool: { name: \"click\", target: { text: \"User Journey\" }, arguments: {} } }",
      "You may also include accessibleName or role in the target, but you MUST include the tool call. Do not emit action=\"answer\" saying you cannot find the element without having tried at least once.",
      "",
      "### SINGLE-ACTION COMPLETION (READ THIS BEFORE EVERY ITERATION)",
      "For single-action user requests (\"click on X\", \"navigate to Y\", \"scroll down\", \"check the box\", \"hover on Z\"), the task is COMPLETE the moment STEPS_SO_FAR shows that action as `success`. On the very next iteration you MUST emit action=\"done\" with a one-line confirmation like:",
      "  { action: \"done\", text: \"Clicked User Journey.\" }",
      "or for navigation:",
      "  { action: \"done\", text: \"Navigated to /pricing.\" }",
      "DO NOT propose the same tool+target combination twice. If STEPS_SO_FAR already contains a successful `click` on \"User Journey\" this turn, and the user's original request was just \"click on User Journey\", the answer is done — not another click. Repeating the same click after success is a bug and will be intercepted by the runtime.",
      "",
      "### KNOWLEDGE / EXPLAIN QUESTIONS",
      "For questions like \"what is X\", \"explain X\", \"tell me about X\", \"describe X\", \"what does X do\", \"hello\", \"who are you\" — DO NOT call the `read` tool. These are pure conversational questions.",
      "You have TWO valid ways to respond:",
      "  A) The preferred way: call submit_next_action with { action: \"answer\", text: \"<a 1-3 sentence reply grounded in LIVE_ELEMENTS or your own knowledge about the product>\" }.",
      "  B) Equally valid: just reply with plain text (no tool call). The runtime will forward that text to the user.",
      "Look at LIVE_ELEMENTS below for context. The visible headings and body copy (e.g. \"Engagement +50%\", \"Personalized Health Insights\") tell you what the page is about; use them as your source of truth for grounding.",
      "Only call the `read` tool if the LIVE_ELEMENTS entry for the requested item is truncated and you genuinely cannot see the body text. If you do call `read`, do it EXACTLY ONCE, then on the very next iteration emit action=\"answer\" using the returned text as your source. STEPS_SO_FAR will contain the read text in the form `detail=read=\"...\"` — use that.",
      "Reading or clicking the same target twice in a row will be intercepted as a bug.",
      "",
      "### FIELDS",
      "You MUST return exactly one call to submit_next_action per iteration. Do not include user-facing prose outside the tool's `text` fields.",
      "For a multi-step goal (three+ discrete actions), emit action=\"plan\" first with a short ordered list, then one action=\"tool\" per step with a matching stepId. For a one-step request skip the plan and emit action=\"tool\" directly.",
      "Emit action=\"narrate\" to speak a short one-line sentence BEFORE a tool. Emit action=\"answer\" or action=\"done\" only when the goal is met, OR after two consecutive failed tool calls. Emit action=\"ask\" only when a specific required input is missing (e.g., what value to fill).",
      "",
      "### TOOLS",
      `Tools available: ${allowedTools.join(", ")}.`,
      "Target-required (target must include at least one of testId, ariaLabel, role, accessibleName, text): click, fill, select, check, uncheck, hover.",
      "Target-optional (target may be omitted): scroll, wait, read.",
      "Tool navigate takes arguments.path or arguments.url instead of a target.",
      "",
      "### TARGETING STRATEGY",
      "Prefer text targeting for short human phrases (\"User Journey\", \"Engagement\", \"Schedule a Demo\"). The resolver strips trailing icons and badges — if an element's rendered text is \"Engagement +50%\", { text: \"Engagement\" } still matches. If the user gives you an exact accessible name, use accessibleName. Use testId only when you see one in LIVE_ELEMENTS.",
      "",
      "### ALREADY-THERE AWARENESS",
      "Before proposing a `click` or `navigate`, check the CURRENT_PAGE line and RECENT_CONVERSATION. If the user is asking to click on / navigate to something and the page path already reflects that destination (e.g. user asks 'go to User Journey' and the path is `/user-journey`, or asks 'click on Smart Reporting' and the page title / URL already shows 'Smart Reporting'), respond with action=\"answer\" and a one-line acknowledgment like \"You're already on the User Journey section.\" DO NOT click again. This applies even if the user repeats the same request twice.",
      "",
      "### CONSTRAINTS",
      "Cross-origin navigation is blocked. Sensitive fields (password, credit card, OTP) are masked in LIVE_ELEMENTS.",
      `You have at most ${maxIterations} iterations per turn (currently on iteration ${iteration}). Prefer the shortest safe path.`,
      "Give-up policy applies AFTER two consecutive failed tool calls. If your first tool call fails, retry with ONE different target expression (switch strategy — e.g., text→accessibleName, or full phrase→shorter substring). Only after the SECOND failure emit action=\"answer\" describing what you saw.",
      consecutiveFailures >= 2 ? "The previous two tool calls failed. Do NOT emit another tool call this iteration — emit action=\"answer\" now and describe what you saw or suggest a closer label from LIVE_ELEMENTS." : "",
      `PRODUCT: ${ctx.session.installation.productId}. ROLE: ${ctx.session.role}. ORIGIN: ${ctx.session.origin}.`,
      `USER_GOAL: ${ctx.request.text}`,
      compactUIMap(ctx.uiMap),
      "",
      catalogJourneySummary(ctx.catalog, ctx.session),
      "",
      "CURRENT_PLAN:",
      planBlock(plan),
      "",
      "STEPS_SO_FAR (this turn):",
      stepsSoFarBlock(stepsSoFar),
      "",
      "RECENT_CONVERSATION:",
      recentConversation(ctx.conversation) || "(none)",
    ].join("\n");
  }

  private decisionTool(allowedTools: DynamicToolKind[], forbidTool = false) {
    // Deliberately no "error" — gpt-4o-mini abuses it as a way to give up
    // before ever attempting a tool call. If truly unrecoverable, the loop
    // exits via the parser guard or the iteration cap. The user always gets a
    // useful reply.
    const actionEnum = forbidTool
      ? ["plan", "update_plan", "narrate", "answer", "ask", "done"]
      : ["plan", "update_plan", "tool", "narrate", "answer", "ask", "done"];
    return {
      name: forbidTool ? "submit_next_action_no_tool" : "submit_next_action",
      description: forbidTool
        ? "Return exactly one non-tool action for this iteration. The previous tool calls failed and tool retries are disabled — respond with answer, ask, or done."
        : "Return exactly one action for this iteration.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["action"],
        properties: {
          action: { type: "string", enum: actionEnum },
          reasoning: { type: "string", description: "One short internal reasoning line for the runtime. Not shown to the user directly." },
          steps: {
            type: "array",
            description: "Ordered plan steps. Required for action=plan and action=update_plan; ignored otherwise.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "title"],
              properties: {
                id: { type: "string" },
                title: { type: "string" },
              },
            },
          },
          reason: { type: "string", description: "Short explanation for update_plan." },
          stepId: { type: "string", description: "Plan step this tool call belongs to." },
          text: { type: "string", description: "Text for narrate, answer, ask, done, or error." },
          tool: {
            type: "object",
            additionalProperties: false,
            required: ["name"],
            properties: {
              name: { type: "string", enum: allowedTools },
              title: { type: "string", description: "Optional short title shown in the flow overlay." },
              target: {
                type: "object",
                additionalProperties: false,
                properties: {
                  testId: { type: "string" },
                  ariaLabel: { type: "string" },
                  role: { type: "string" },
                  accessibleName: { type: "string" },
                  text: { type: "string" },
                  elementId: { type: "string" },
                },
              },
              arguments: {
                type: "object",
                additionalProperties: true,
              },
            },
          },
        },
      },
    };
  }

  private parseDecision(result: Awaited<ReturnType<ModelClient["step"]>>):
    | undefined
    | {
        action: "plan" | "update_plan" | "tool" | "narrate" | "answer" | "ask" | "done" | "error";
        reasoning?: string;
        steps?: DynamicPlanStep[];
        reason?: string;
        stepId?: string;
        text?: string;
        tool?: {
          name: DynamicToolKind;
          title?: string;
          target?: DynamicToolTarget;
          arguments?: Record<string, JsonValue>;
        };
      } {
    const call = result.toolCalls.find((candidate) => candidate.name === "submit_next_action" || candidate.name === "submit_next_action_no_tool");
    const args = call ? ensureRecord(call.args) : undefined;
    if (!args) return undefined;
    const action = safeString(args.action);
    if (!action || !["plan", "update_plan", "tool", "narrate", "answer", "ask", "done", "error"].includes(action)) return undefined;

    const decision: ReturnType<DynamicAgent["parseDecision"]> = { action: action as never };
    const reasoning = safeString(args.reasoning);
    if (reasoning) decision!.reasoning = reasoning;
    const reason = safeString(args.reason);
    if (reason) decision!.reason = reason;
    const stepId = safeString(args.stepId);
    if (stepId) decision!.stepId = stepId;
    const text = typeof args.text === "string" ? args.text.slice(0, 4000) : undefined;
    if (text) decision!.text = text;

    if (Array.isArray(args.steps)) {
      const steps = args.steps
        .map((raw) => ensureRecord(raw))
        .filter((raw): raw is Record<string, unknown> => !!raw)
        .map((raw) => {
          const id = safeString(raw.id);
          const title = safeString(raw.title);
          return id && title ? { id, title } : undefined;
        })
        .filter((step): step is DynamicPlanStep => !!step);
      if (steps.length) decision!.steps = steps;
    }

    if (action === "tool") {
      const rawTool = ensureRecord(args.tool);
      const name = safeString(rawTool?.name);
      if (!rawTool || !name) return undefined;
      if (!DEFAULT_ALLOWED_TOOLS.includes(name as DynamicToolKind)) return undefined;
      const target = ensureRecord(rawTool.target);
      const targetShape: DynamicToolTarget = {};
      for (const key of ["testId", "ariaLabel", "role", "accessibleName", "text", "elementId"] as const) {
        const value = target ? safeString(target[key]) : undefined;
        if (value) targetShape[key] = value;
      }
      const argsRecord = ensureRecord(rawTool.arguments);
      const cleaned: Record<string, JsonValue> = {};
      if (argsRecord) {
        for (const [key, value] of Object.entries(argsRecord)) {
          if (isJson(value)) cleaned[key] = value;
        }
      }
      decision!.tool = {
        name: name as DynamicToolKind,
        ...(Object.keys(targetShape).length ? { target: targetShape } : {}),
        arguments: cleaned,
        ...(safeString(rawTool.title) ? { title: safeString(rawTool.title)! } : {}),
      };
    }
    return decision;
  }
}

function markPlanStep(plan: DynamicPlan | undefined, stepId: string, status: DynamicPlanStep["status"], detail?: string): void {
  if (!plan) return;
  const step = plan.steps.find((candidate) => candidate.id === stepId);
  if (!step) return;
  step.status = status;
  if (detail) step.detail = detail;
}

function countTrailingFailures(steps: StepRun[]): number {
  let count = 0;
  for (let index = steps.length - 1; index >= 0; index--) {
    if (steps[index].success) break;
    count += 1;
  }
  return count;
}
