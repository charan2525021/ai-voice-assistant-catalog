import { makeBrain, normalizeToolHistory, pruneNeutralHistory, type Brain, type NMessage, type NBlock, type ToolDef } from "./brain.js";
import { config } from "./config.js";
import type { LiveBox, PageSnapshot } from "./livebox.js";
import { brain as defaultKb, type BrainStore } from "./knowledge/store.js";
import { retrieveContext } from "./knowledge/retrieve.js";
import { SessionMemory } from "./knowledge/memory.js";
import { emit } from "./events.js";
import { expandProgram, newRunTag } from "./mapper/unique.js";
import { checkAction } from "./mapper/safety.js";
import { WorkflowExecutor } from "./workflow/executor.js";
import { LiveBoxActionDriver } from "./workflow/livebox-driver.js";
import { legacyProgramToWorkflow, type WorkflowDefinition } from "./workflow/schema.js";
import { LiveScreenObserver, type ScreenState } from "./runtime/screen-state.js";
import { classifyRuntimeIntent } from "./runtime/evidence-router.js";

export interface AgentRuntimeContext {
  intent: "screen_question" | "how_to" | "action" | "product_question" | "objection" | "conversation";
  system: string;
  workflow?: WorkflowDefinition;
  flowName?: string;
}

/** Tools = Aidan's Hands (browser) + Brain capture (memory/learning). */
const TOOLS: ToolDef[] = [
  { name: "navigate", description: "Open a URL in the shared browser.", parameters: obj({ url: str() }, ["url"]) },
  { name: "click", description: "Click an interactive element by its id from the current screen list.", parameters: obj({ id: int() }, ["id"]) },
  {
    name: "type",
    description: "Type text into an input/textarea by id. Set submit=true to press Enter.",
    parameters: obj({ id: int(), text: str(), submit: { type: "boolean" } }, ["id", "text"]),
  },
  { name: "scroll", description: "Scroll the page up or down.", parameters: obj({ direction: { type: "string", enum: ["up", "down"] } }, ["direction"]) },
  {
    /*
     * On-demand eyes.
     *
     * Predicting BEFORE a turn whether it will need to see was the wrong shape:
     * the screen is live, the prospect can drive it, and content can arrive after
     * the turn began. A guess made at turn start is stale by the time it matters,
     * and when the guess was wrong the agent answered about a screen it had never
     * looked at. Letting it ask for a fresh view when it notices it needs one
     * costs the image only on the turns that actually require it.
     */
    name: "look",
    description:
      "Look at the live screen RIGHT NOW and get a fresh view with a screenshot. Use this whenever the prospect asks what is on screen, what a chart or number says, what just changed, or whether something finished — and any time the screen may have moved on since you last saw it, including after they drove it themselves. Set watch_ms to keep watching for a moment when something is still loading, animating or updating.",
    parameters: obj({ watch_ms: int() }, []),
  },
  {
    name: "run_verified_flow",
    description:
      "Run the VERIFIED demo flow provided in your context, exactly as it was proven to work. Use this whenever a verified flow is available for what the prospect asked — it is faster and more reliable than clicking step by step. Narrate before and after.",
    parameters: obj({}, []),
  },
  {
    name: "resume_flow",
    description:
      "Continue the walkthrough that was interrupted, from the step where it stopped. Use this when the prospect says to carry on, or after you've answered the question that interrupted you.",
    parameters: obj({}, []),
  },
  // Brain capture tools (no screen effect)
  { name: "note_need", description: "Record a need/goal the prospect stated.", parameters: obj({ need: str() }, ["need"]) },
  { name: "record_qualification", description: "Record a qualification fact you learned (e.g. team_size, current_tool, role, timeline).", parameters: obj({ field: str(), value: str() }, ["field", "value"]) },
  { name: "note_unanswered", description: "Call when the prospect asks something the provided knowledge does NOT cover, so it can be added later.", parameters: obj({ question: str() }, ["question"]) },
  { name: "note_objection", description: "Record an objection/concern the prospect raised.", parameters: obj({ text: str() }, ["text"]) },
  {
    name: "finish",
    description:
      "Call when you've handled the request. Give a ONE-LINE handover of at most 12 words that moves things forward, e.g. \"Want me to place the order?\" — never a recap of what you just did.",
    parameters: obj({ summary: str() }, ["summary"]),
  },
];
const CAPTURE_TOOLS = new Set(["note_need", "record_qualification", "note_unanswered", "note_objection"]);

/** Do not send twelve tool schemas on a turn that can only produce an answer. */
export function toolsForTurn(
  intent: AgentRuntimeContext["intent"] | undefined,
  hasVerifiedFlow: boolean,
  paused: boolean,
  hasFreshScreen: boolean,
): ToolDef[] {
  if (!intent) return TOOLS;
  // A fresh screen is already the tool result. Sending more function schemas
  // puts simple read-only answers through a slower tool-capable model path.
  if (intent === "screen_question" && hasFreshScreen && !paused) return [];
  const names = new Set<string>([...CAPTURE_TOOLS, "finish"]);
  if (intent === "screen_question" && !hasFreshScreen) names.add("look");
  if (intent === "action" || intent === "how_to") {
    if (hasVerifiedFlow) names.add("run_verified_flow");
    // Durable mode is verification-first: an unmatched request may be
    // explained or captured as a gap, but never improvised against a live
    // customer account. The legacy path (no intent) retains its old tools while
    // products migrate.
    else if (!hasFreshScreen) names.add("look");
  }
  if (paused) names.add("resume_flow");
  return TOOLS.filter((tool) => names.has(tool.name));
}

/**
 * An explicit action with a verified workflow is a deterministic commitment,
 * not a suggestion to the language model. Providers occasionally return a
 * natural "I'll click it now" sentence without the corresponding tool call.
 */
export function shouldAutoRunVerifiedFlow(
  intent: AgentRuntimeContext["intent"] | undefined,
  hasVerifiedWorkflow: boolean,
  toolNames: string[],
): boolean {
  return intent === "action" && hasVerifiedWorkflow &&
    !toolNames.includes("run_verified_flow") && !toolNames.includes("resume_flow");
}

function needsPixelVision(text: string): boolean {
  return /\b(color|chart|graph|image|picture|icon|layout|position|where on|look like|visual)\b/i.test(text);
}

function baseSystem(productName: string): string {
  return `You are ${config.assistantName}, an AI sales engineer running a LIVE, interactive product demo of ${productName} for a prospect.
You share a real browser with them: you drive it (click, type, navigate) and they can watch and take over anytime.

YOU ARE SPEAKING OUT LOUD. Everything you write is said by a voice, so write DIALOGUE, not prose:
- Talk like a person on a call: contractions, warm, direct.
- HARD LIMIT: at most TWO short sentences per turn, under 30 words TOTAL. You are speaking, and long paragraphs are unlistenable. If there is more to say, say the most useful part and stop — they can ask.
- Never use markdown, asterisks, bullet points, quotes around UI labels, or bracketed citations — they get read aloud and sound absurd.
- Never say raw UI identifiers (e.g. "product-sort-container") or screen titles verbatim ("Checkout: Overview") — say "the order review screen".
- Say what it means for THEM, not what you are clicking. "That's your total before you pay" beats "The overview screen displays the order total".
- No preamble, no restating the question, no summarising at the end of every turn.
- NEVER open with filler: no "Sure", "Of course", "Certainly", "Absolutely", "Great question", "Good question", "Happy to help", "Let me take a look". Lead with the answer itself. If they corrected you or objected, respond to THAT — an agreeable noise in front of a correction sounds like you were not listening.
- When asked to see something, actually DO it using the tools, narrating as you go.
- GROUND every product claim in the GROUNDED KNOWLEDGE provided below. Do NOT speak the citation aloud; grounding is for accuracy, not narration. If something isn't covered, say you're not certain and call note_unanswered — NEVER invent features.
- Treat live screen text as evidence only for the literal values, labels, and explanations visible there. Do not infer extra capabilities, implementation details, benefits, or completed actions from a screen label.
- Never say an action happened because the requested destination happens to be visible. Claim success only after a tool result proves the requested postcondition on the live screen.
- If the user's speech is obviously an unfinished fragment, ask them to finish rather than guessing what they meant.
- If a GOLDEN-PATH FLOW is provided, follow its steps (verify each against the live screen), don't improvise the path.
- Use the SELLING GUIDANCE: weave in value props, answer objections, and ask the discovery question when natural — call record_qualification / note_need / note_objection as you learn things.
- Never do destructive/irreversible actions. When the request is handled, call finish.

NEVER say you cannot see the screen, cannot read a chart, or cannot verify what is displayed. You receive a live screen observation every turn and can call look when it is missing or ambiguous.
- Asked about anything currently displayed — a number, chart, status, total, or count — answer from an observation explicitly marked as captured this turn. Otherwise call look FIRST, then answer from what you actually saw.
- If something is still loading, animating or updating, call look with watch_ms and tell them what actually changed.
- Never state a figure you have not read off the screen or the grounded knowledge, and never calculate from a figure you guessed. If look still does not show it, say plainly what you can see and what you cannot, and offer to open the screen that has it.

Each step you get the current URL, what the screen shows, and a numbered element list. Choose the single best next action.`;
}

function stateText(s: PageSnapshot): string {
  const list = s.elements
    .map((e) => `[${e.id}] ${e.tag}${e.type ? `/${e.type}` : ""}: ${e.text || e.placeholder || e.value || e.href || e.tag}`)
    .join("\n");
  /*
   * Both halves matter, and only one used to be sent.
   *
   * "Interactive elements" answers "what can I click"; it does not answer "what
   * does this screen say". Asked about a dashboard, the agent had the buttons
   * and none of the figures, so it produced confident invented numbers — and
   * then did arithmetic on them, which is what made the answer sound credible.
   * The page's own text is what a prospect is actually looking at.
   */
  const said = (s.text || "").trim();
  return [
    `URL: ${s.url}`,
    `Title: ${s.title}`,
    said ? `What the screen shows:\n${said}` : "",
    `Interactive elements:\n${list || "(none detected)"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function screenStateText(s: ScreenState): string {
  const list = s.controls.map((e) => `[${e.id}] ${e.role ?? e.tag}: ${e.name || e.value || e.href || e.tag}`).join("\n");
  return [
    `Observation: v${s.version} ${s.observationId}`,
    `URL: ${s.url}`,
    `Title: ${s.title}`,
    s.visibleText.trim() ? `What the screen shows:\n${s.visibleText.trim()}` : "",
    `Interactive elements:\n${list || "(none detected)"}`,
  ].filter(Boolean).join("\n");
}

/** Holds conversation state for one demo session and runs the grounded talk+act loop. */
export class Agent {
  private messages: NMessage[] = [];
  private model: Brain = makeBrain("agent");
  /**
   * One agent per session, bound to ONE product's brain. The server runs several
   * products at once, so the agent must never reach for a global store.
   */
  /**
   * A walkthrough that was interrupted part-way. Kept so it can be RESUMED from
   * the exact step it stopped at — abandoning it would make an interruption
   * destroy the demo, which is the opposite of how a person behaves.
   */
  private paused: { flowName: string; workflow: WorkflowDefinition; nextIndex: number; url: string } | null = null;
  /**
   * Did the previous turn actually drive the UI?
   *
   * If so the next turn gets a screenshot, because the agent is mid-interaction
   * and pixel grounding is worth its latency. Purely conversational turns skip
   * it — see the note where the turn is assembled.
   */
  private lastTurnUsedUiTool = false;
  /** Most recent view of the screen — used to resolve an element id to its label. */
  private lastSnapshot: PageSnapshot | null = null;
  private lastScreenState: ScreenState | null = null;
  private turnDecision: { intent?: string; matchedFlow?: string } = {};

  /**
   * Voice hooks, injected by the server when a socket exists:
   *  - speakAndWait: say a line and resolve when it has actually been HEARD
   *  - isInterrupted: true once the user starts talking (checked between steps)
   */
  private voice: {
    speakAndWait?: (t: string) => Promise<void>;
    isInterrupted?: () => boolean;
    /** A short "right, where were we" line when picking a walkthrough back up. */
    reconnectLine?: () => string;
  } = {};
  setVoice(v: {
    speakAndWait?: (t: string) => Promise<void>;
    isInterrupted?: () => boolean;
    reconnectLine?: () => string;
  }): void {
    this.voice = v;
  }
  get pausedFlow() {
    return this.paused;
  }

  /** Routing decision for the most recently started turn, exposed to the trace owner. */
  get lastTurnDecision(): Readonly<{ intent?: string; matchedFlow?: string }> {
    return this.turnDecision;
  }

  constructor(
    private box: LiveBox,
    public memory: SessionMemory = new SessionMemory(),
    private kb: BrainStore = defaultKb,
    private productName: string = config.demo.name,
    /*
     * Verbs this product explicitly permits. Empty means "nothing destructive",
     * which is the safe default for a demo running against a customer's real
     * tenant. This was previously accepted by LiveBox and never consulted on the
     * live path — only the mapper enforced it — so a demo could click Delete on
     * production data while the manifest claimed no actions were allowed.
     */
    private allowActions: string[] = [],
    /** Durable catalog/evidence path. Omitted while a legacy JSON product is migrating. */
    private runtimeContext?: (text: string, screen?: ScreenState) => Promise<AgentRuntimeContext>,
    private screenObserver?: LiveScreenObserver,
  ) {}

  /** Display name of the product this session is demoing. */
  get productLabel(): string {
    return this.productName;
  }

  brainLabel(): string {
    return this.model.label;
  }

  /** Handle one prospect message: retrieve Brain context, then talk + act. */
  /** Narration failures must never abort a turn — the demo continues silently. */
  private async saySafely(onSay: (line: string) => void | Promise<void>, text: string): Promise<void> {
    try {
      await onSay(text);
    } catch (e) {
      console.warn(`[agent] narration failed (continuing): ${(e as Error).message}`);
    }
  }

  async handleUserMessage(text: string, onSay: (line: string) => void | Promise<void>, signal?: AbortSignal): Promise<void> {
    this.memory.noteUser(text);
    const usedUiOnPreviousTurn = this.lastTurnUsedUiTool;
    const preliminaryIntent = this.runtimeContext ? classifyRuntimeIntent(text) : undefined;
    this.turnDecision = { intent: preliminaryIntent };
    const pixelQuestion = preliminaryIntent === "screen_question" && needsPixelVision(text);
    let observed = this.runtimeContext && this.screenObserver
      ? await this.screenObserver.observe(pixelQuestion || usedUiOnPreviousTurn)
      : undefined;
    const durable = this.runtimeContext ? await this.runtimeContext(text, observed) : null;
    const legacy = durable ? null : await retrieveContext(text, this.memory, this.kb);
    const packet = legacy?.packet;
    const brainContext = durable ? `${durable.system}\n\nPROSPECT CONTEXT SO FAR:\n${this.memory.summary()}` : legacy!.system;
    // The verified program for this turn's matched flow (if the mapper learned one).
    const verifiedProgram = (packet?.flow as any)?.program as
      | { action: string; role?: string; name?: string; value?: string; submit?: boolean; url?: string; say?: string }[]
      | undefined;
    const verifiedWorkflow = durable?.workflow;
    const flowName = durable?.flowName ?? packet?.flow?.name ?? "flow";
    this.turnDecision = {
      intent: durable?.intent ?? packet?.intent ?? preliminaryIntent,
      matchedFlow: durable?.flowName ?? packet?.flow?.name,
    };
    const pausedNote = this.paused
      ? `\n\nPAUSED WALKTHROUGH: "${this.paused.flowName}" stopped at step ${this.paused.nextIndex + 1} of ${this.paused.workflow.steps.length} because the prospect interrupted. Answer what they asked, then offer to continue — call resume_flow, which picks up where you left off (or safely restarts the flow if the screen has moved on since).`
      : "";
    const freshScreenNote = durable?.intent === "screen_question" && observed
      ? "\n\nThe LIVE SCREEN OBSERVATION below was captured immediately before this turn. Answer directly from it when it contains the requested value; call look only if it is loading, missing, or visually ambiguous."
      : "";
    const turnSystem = `${baseSystem(this.productName)}\n\n${brainContext}${pausedNote}${freshScreenNote}`;

    /*
     * Send the SCREENSHOT only when the turn might actually need to look.
     *
     * A screenshot on every turn was the single largest source of latency in a
     * spoken conversation: measured on this gateway, an identical prompt takes
     * ~1.4s to first token without an image and ~4.9s with one. The prospect
     * hears that as several seconds of silence before Aidan says anything.
     *
     * The element list (`stateText`) is always sent, so the agent still knows
     * exactly what is on screen and can click anything — vision only adds pixel
     * grounding, which matters when improvising against an unfamiliar layout and
     * not at all when answering from the Brain or replaying a verified journey.
     * If a tool call needs to see, the tool RESULT carries a fresh screenshot
     * (below), so vision arrives exactly when it becomes useful.
     */
    const hasVerifiedFlow = !!verifiedWorkflow || !!verifiedProgram?.length;
    const turnTools = toolsForTurn(durable?.intent, hasVerifiedFlow, !!this.paused, !!observed);
    const needsVision = pixelQuestion || (!hasVerifiedFlow && (packet?.intent === "show_me" || this.lastTurnUsedUiTool));
    this.lastTurnUsedUiTool = false;
    if (observed && needsVision && !observed.screenshot) observed = await this.screenObserver!.observe(true);
    const snap = observed ? undefined : await this.box.snapshot(needsVision);
    this.lastScreenState = observed ?? null;
    this.lastSnapshot = snap ?? null;
    const screenText = observed ? screenStateText(observed) : stateText(snap!);
    const blocks: NBlock[] = [{ type: "text", text: `Prospect says: "${text}"\n\nCurrent screen:\n${screenText}` }];
    const screenshot = observed?.screenshot ?? snap?.screenshot;
    if (needsVision && screenshot) blocks.push({ type: "image", b64png: screenshot });
    this.messages.push({ role: "user", blocks });

    /*
     * Fast deterministic lane for explicit, already-verified actions.
     *
     * Asking a model to decide whether to call run_verified_flow added a model
     * round trip and sometimes produced only "I'll click it now". The evidence
     * router has already selected the immutable, role-scoped journey; execute it
     * directly. Its recorded step narration remains product-specific data, so
     * this contains no client workflow and still sounds natural.
     */
    if (shouldAutoRunVerifiedFlow(durable?.intent, !!verifiedWorkflow, [])) {
      const outcome = await this.replay(verifiedWorkflow!, flowName, onSay, 0, undefined, signal);
      this.messages.push({ role: "assistant", blocks: [{ type: "text", text: `[Verified workflow outcome] ${outcome}` }] });
      return;
    }

    for (let step = 0; step < 12; step++) {
      /*
       * STOP MEANS STOP.
       *
       * The walkthrough path honoured isInterrupted(); this improvised loop never
       * checked it, so once a turn started it ran all 12 steps no matter what the
       * prospect said. Worse, barge-in calls audioSync.reset(), which RELEASES the
       * narration wait — so interrupting actually made it move on faster. That is
       * why saying "wait" produced more talking, not less.
       */
      if (signal?.aborted || this.voice.isInterrupted?.()) {
        this.messages.push({ role: "user", blocks: [{ type: "text", text: "[the prospect interrupted; stop and listen]" }] });
        return;
      }
      this.pruneOldImages();
      this.messages = normalizeToolHistory(this.messages); // never send a conversation the provider will reject
      /*
       * Speak each sentence the MOMENT the model finishes writing it.
       *
       * Waiting for the whole reply before synthesising anything was the single
       * largest source of dead air — measured at 5.6s of silence between the
       * user's question and Aidan's first word on a live demo. Streaming turns
       * that into roughly the time to write one sentence.
       *
       * Sentences spoken here are remembered so the loop below does not repeat
       * them, and interruption is honoured mid-stream: if the prospect starts
       * talking we stop feeding the speech engine immediately rather than
       * queueing the rest of a paragraph at them.
       */
      const spokenLive = new Set<string>();
      // Keep generation streaming at full speed while serialising speech. The
      // chain is awaited before tool execution, so actions can never outrun the
      // words that describe them.
      let streamedSpeech = Promise.resolve();
      const result = await this.model.step(turnSystem, this.messages, turnTools, {
        signal,
        onSentence: (line) => {
          if (signal?.aborted || this.voice.isInterrupted?.()) return;
          spokenLive.add(line);
          this.memory.noteAidan(line);
          streamedSpeech = streamedSpeech.then(() => this.saySafely(onSay, line));
        },
      });
      await streamedSpeech;
      /*
       * AWAIT the narration before acting on the tool calls below.
       *
       * This used to be fire-and-forget, so the model's text went off to be
       * synthesised (~400ms) and played (several seconds) while the very next
       * lines of this loop clicked and navigated. The screen therefore changed
       * BEFORE the sentence describing it was heard — the prospect watched tabs
       * switch and then heard about them afterwards.
       *
       * The verified-journey path already did this correctly via speakAndWait;
       * only the improvised path raced. It matters most exactly where it was
       * missing: a product with no verified journeys improvises every step.
       */
      for (const t of result.texts) {
        if (signal?.aborted || this.voice.isInterrupted?.()) break; // don't keep reading lines at someone
        if (spokenLive.has(t)) continue; // already spoken as it streamed
        this.memory.noteAidan(t);
        await this.saySafely(onSay, t);
      }

      const assistantBlocks: NBlock[] = [
        ...result.texts.map((t) => ({ type: "text", text: t }) as NBlock),
        ...result.toolCalls.map((c) => ({ type: "tool_call", id: c.id, name: c.name, args: c.args }) as NBlock),
      ];
      this.messages.push({ role: "assistant", blocks: assistantBlocks });
      if (result.toolCalls.length === 0) return;

      const resultBlocks: NBlock[] = [];
      let finished = false;
      /*
       * EVERY tool_call must get a matching tool_result, no matter what fails.
       *
       * The provider rejects a conversation where an assistant message carries
       * tool_calls that are not each answered — and because the bad pair stays in
       * history, the session is then dead FOREVER: every later turn fails with the
       * same 400. One unprotected throw in this loop (a screenshot timeout, a
       * narration error) permanently bricked the demo. The finally block below
       * backfills anything missing, so a failed action degrades one step instead
       * of ending the conversation.
       */
      try {
      for (const call of result.toolCalls) {
        const input = call.args ?? {};

        if (call.name === "finish") {
          if (input.summary?.trim?.()) { this.memory.noteAidan(input.summary.trim()); await this.saySafely(onSay, input.summary.trim()); }
          finished = true;
          resultBlocks.push({ type: "tool_result", id: call.id, text: "done" });
          continue;
        }
        if (CAPTURE_TOOLS.has(call.name)) {
          if (call.name === "note_need") this.memory.addNeed(String(input.need ?? ""));
          else if (call.name === "record_qualification") this.memory.setQualification(String(input.field ?? ""), String(input.value ?? ""));
          else if (call.name === "note_unanswered") this.memory.addKbGap(String(input.question ?? ""));
          else if (call.name === "note_objection") this.memory.addObjection(String(input.text ?? ""));
          resultBlocks.push({ type: "tool_result", id: call.id, text: "noted" });
          continue;
        }

        // Deterministic replay of a VERIFIED journey — this is what makes the
        // mapper's verification pay off at demo time: no re-derivation, no
        // guesswork, just the path that was proven to work.
        if (call.name === "resume_flow") {
          let r: string;
          if (!this.paused) r = "There's no paused walkthrough to resume — start the relevant flow instead.";
          else {
            const { flowName, workflow, nextIndex, url } = this.paused;
            /*
             * Resuming mid-sequence is only valid if the world hasn't moved.
             * Answering an interruption often navigates away and destroys the
             * flow's preconditions (e.g. the cart gets emptied), and continuing
             * from step N then fails confusingly. If we're no longer where we
             * paused, restart the flow cleanly from the beginning instead.
             */
            const moved = this.box.currentUrl() !== url;
            if (moved) {
              console.log(`[agent] world moved since pause (${url} → ${this.box.currentUrl()}) — restarting "${flowName}" from the top`);
              r =
                `The screen moved on while we talked, so I'm running "${flowName}" again from the start rather than resuming mid-way.\n` +
                (await this.replay(workflow, flowName, onSay, 0, undefined, signal));
            } else {
              console.log(`[agent] RESUMING "${flowName}" from step ${nextIndex + 1}/${workflow.steps.length}`);
              // Rejoin the thread out loud instead of resuming mid-sentence.
              const rc = this.voice.reconnectLine?.();
              if (rc) { this.memory.noteAidan(rc); if (this.voice.speakAndWait) await this.voice.speakAndWait(rc); else onSay(rc); }
              r = await this.replay(workflow, flowName, onSay, nextIndex, undefined, signal);
            }
          }
          const s2 = await this.box.snapshot();
          resultBlocks.push({ type: "tool_result", id: call.id, text: `${r}\n${stateText(s2)}`, imageB64png: s2.screenshot });
          continue;
        }

        if (call.name === "run_verified_flow") {
          let r: string;
          if (!verifiedWorkflow && !verifiedProgram?.length) {
            console.log(`[agent] run_verified_flow requested but no verified program available`);
            r = "No verified flow is available for this request — explain the limitation and record the gap; do not improvise browser actions.";
          } else {
            r = verifiedWorkflow
              ? await this.replay(verifiedWorkflow, flowName, onSay, 0, undefined, signal)
              : await this.replay(verifiedProgram!, flowName, onSay, 0, (packet?.flow as any)?.startUrl, signal);
          }
          const s = await this.box.snapshot();
          resultBlocks.push({ type: "tool_result", id: call.id, text: `${r}\n${stateText(s)}`, imageB64png: s.screenshot });
          continue;
        }

        /*
         * Skip the action if we've been interrupted — but still emit a
         * tool_result, or the history becomes unpairable and the session dies.
         */
        if (signal?.aborted || this.voice.isInterrupted?.()) {
          resultBlocks.push({ type: "tool_result", id: call.id, text: "Skipped — the prospect started speaking." });
          continue;
        }

        // Browser actions — run under the shared lock so the Observer can't
        // sample the screen halfway through an action.
        let r = "";
        /*
         * Record every screen-changing action. Without this the recorded trail
         * showed model calls and narration but not the clicks between them, so
         * "did the screen change before or after the sentence describing it?" —
         * the exact question a mis-paced demo raises — could not be answered from
         * the log at all.
         */
        const actionStarted = Date.now();
        try {
          /*
           * Refuse destructive actions on the LIVE path, not only while mapping.
           * A demo runs against a real tenant with real records in it; "the model
           * probably will not click Delete" is not a control.
           */
          const target = this.lastScreenState?.controls.find((e) => e.id === Number(input.id)) ??
            (this.lastSnapshot?.elements ?? []).find((e: any) => e.id === Number(input.id)) as any;
          const verdict = checkAction(
            {
              action: call.name,
              name: target ? `${target.text ?? ""} ${target.value ?? ""} ${target.placeholder ?? ""}` : String(input.text ?? ""),
              url: call.name === "navigate" ? String(input.url ?? "") : undefined,
              value: String(input.text ?? ""),
            },
            { allow: this.allowActions },
          );
          if (!verdict.allowed) {
            emit("demo.action", { status: "error", ms: 0, error: verdict.reason, data: { tool: call.name, target: input.id ?? input.url, result: "blocked" } });
            resultBlocks.push({
              type: "tool_result",
              id: call.id,
              text: `Blocked for safety: ${verdict.reason}. Do not retry it — say you'll leave that alone on a live account and offer something else.`,
            });
            continue;
          }
          r = await this.box.exclusive(async () => {
            if ((call.name === "click" || call.name === "type") && this.screenObserver) {
              const expected = this.lastScreenState;
              const current = await this.screenObserver.observe(false);
              this.lastScreenState = current;
              if (expected && current.fingerprint !== expected.fingerprint) {
                return `STALE_SCREEN: the page changed from observation v${expected.version}; no action was taken.\n${screenStateText(current)}`;
              }
            }
            if (call.name === "navigate") { await this.box.goto(String(input.url)); return `Opened ${input.url}.`; }
            if (call.name === "click") { this.lastTurnUsedUiTool = true; return await this.box.clickElement(Number(input.id)); }
            if (call.name === "type") { this.lastTurnUsedUiTool = true; return await this.box.typeText(Number(input.id), String(input.text), Boolean(input.submit)); }
            if (call.name === "scroll") return await this.box.scroll(input.direction === "up" ? "up" : "down");
            if (call.name === "look") {
              const watchMs = Math.min(Math.max(Number(input.watch_ms) || 0, 0), 8000);
              if (!watchMs) return "Looked at the screen.";
              // Something is still changing: sample across the window and report
              // what APPEARED, so "did it finish?" is answered by observation
              // rather than by waiting a fixed time and hoping.
              const before = new Set((await this.box.snapshot(false)).text.split("\n"));
              const deadline = Date.now() + watchMs;
              const appeared = new Set<string>();
              while (Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 400));
                for (const line of (await this.box.snapshot(false)).text.split("\n")) {
                  if (line && !before.has(line)) appeared.add(line);
                }
              }
              return appeared.size
                ? `Watched for ${watchMs}ms. New on screen:\n${[...appeared].slice(0, 40).join("\n")}`
                : `Watched for ${watchMs}ms. Nothing on screen changed.`;
            }
            return `Unknown tool ${call.name}.`;
          });
          if (this.screenObserver && !r.startsWith("STALE_SCREEN")) {
            this.lastScreenState = await this.screenObserver.observe(false);
          }
        } catch (err) {
          r = `Action failed: ${(err as Error).message}`;
        }
        const actionFailed = /failed|no element|not_found|stale_screen/i.test(r);
        if (actionFailed) this.memory.incFailure();
        emit("demo.action", {
          status: actionFailed ? "error" : "ok",
          ms: Date.now() - actionStarted,
          error: actionFailed ? r.slice(0, 160) : undefined,
          data: { tool: call.name, target: input.url ?? input.id, result: r.slice(0, 120) },
        });
        // A snapshot failure must not escape: the tool_result still has to exist.
        const newSnap = await this.box.snapshot().catch((e) => {
          console.warn(`[agent] snapshot after ${call.name} failed: ${(e as Error).message}`);
          return null;
        });
        if (newSnap) this.lastSnapshot = newSnap;
        resultBlocks.push({
          type: "tool_result",
          id: call.id,
          text: newSnap ? `${r}\n${stateText(newSnap)}` : `${r}\n(could not read the screen)`,
          ...(newSnap ? { imageB64png: newSnap.screenshot } : {}),
        });
      }
      } finally {
        const answered = new Set(resultBlocks.map((b) => (b as any).id));
        for (const call of result.toolCalls) {
          if (!answered.has(call.id)) {
            resultBlocks.push({ type: "tool_result", id: call.id, text: "This action did not complete." });
          }
        }
        this.messages.push({ role: "user", blocks: resultBlocks });
      }
      if (finished) return;
    }
    if (!this.voice.isInterrupted?.()) onSay("Let me pause there — what would you like to see next?");
  }

  /**
   * Run a verified program, narrating each step and PACING to the audio.
   *
   * Three behaviours that make this feel like a person walking you through:
   *  - each step's line is spoken BEFORE the action, then we wait until it has
   *    actually been heard (capped) so the voice never trails the clicks;
   *  - if the prospect starts talking, we stop between steps and REMEMBER the
   *    index, so the walkthrough can be resumed rather than restarted;
   *  - the actions themselves cost zero model calls.
   */
  private async replay(input: WorkflowDefinition | any[], flowName: string, onSay: (l: string) => void, startAt: number, recordedFrom?: string, signal?: AbortSignal, skipStepNarration = false): Promise<string> {
    /*
     * Reposition first. A program is recorded from a clean start screen, so
     * replaying it from wherever the prospect happens to be is not valid — the
     * first click may not exist. Returning to the recorded screen makes replay
     * safe from ANY point in the demo (and is why the agent no longer has to
     * refuse and improvise instead).
     */
    const workflow = Array.isArray(input)
      ? legacyProgramToWorkflow({
          id: `verified-${flowName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
          name: flowName,
          startUrl: recordedFrom,
          // Expand templated values for each run so creation journeys do not
          // collide on the customer's own sandbox data.
          program: expandProgram(input as any[], newRunTag()) as any[],
        })
      : structuredClone(input);
    const executor = new WorkflowExecutor(new LiveBoxActionDriver(this.box, this.memory.id, undefined, undefined, this.screenObserver));
    const replayStarted = Date.now();
    const res = await this.box.exclusive(() => executor.execute(workflow, {
      signal,
      startAt,
      shouldStop: () => this.voice.isInterrupted?.() === true,
      onStep: async (step) => {
        if (skipStepNarration) return;
        const line = step.say?.trim();
        if (!line) return;
        this.memory.noteAidan(line);
        if (this.voice.speakAndWait) await this.voice.speakAndWait(line);
        else onSay(line);
        const delay = Number(process.env.NARRATION_STEP_DELAY_MS ?? 0);
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      },
    }));

    if (res.error === "workflow interrupted") {
      emit("demo.workflow", { status: "ok", ms: Date.now() - replayStarted,
        data: { flow: flowName, completedSteps: res.completedSteps, interrupted: true } });
      // Keep the remainder so `resume_flow` can continue from exactly here.
      const nextIndex = Math.min(workflow.steps.length, startAt + res.completedSteps);
      this.paused = { flowName, workflow, nextIndex, url: this.box.currentUrl() };
      console.log(`[agent] "${flowName}" PAUSED at step ${nextIndex + 1}/${workflow.steps.length} (prospect spoke)`);
      return `Paused the walkthrough at step ${nextIndex + 1} of ${workflow.steps.length} because the prospect started speaking. Answer them, then call resume_flow to continue.`;
    }

    if (res.ok) {
      emit("demo.workflow", { status: "ok", ms: Date.now() - replayStarted,
        data: { flow: flowName, completedSteps: res.completedSteps, totalSteps: workflow.steps.length } });
      this.paused = null;
      console.log(`[agent] DETERMINISTIC REPLAY of "${flowName}"${startAt ? ` (resumed @${startAt + 1})` : ""} → ok (${res.completedSteps} steps, 0 model calls)`);
      const log = res.events.filter((event) => event.type === "step_completed").map((event) => event.detail).filter(Boolean);
      return `Ran the verified flow (${res.completedSteps} steps):\n${log.join("\n")}`;
    }

    // A failed step is still resumable — the UI may just have moved.
    this.paused = { flowName, workflow, nextIndex: Math.min(workflow.steps.length, startAt + res.completedSteps), url: this.box.currentUrl() };
    this.memory.addJourneyFailure(flowName, res.error ?? "workflow failed");
    emit("demo.workflow", { status: "error", ms: Date.now() - replayStarted, error: res.error,
      data: { flow: flowName, completedSteps: res.completedSteps, totalSteps: workflow.steps.length } });
    console.log(`[agent] replay of "${flowName}" failed: ${res.error}`);
    return `Verified flow failed partway (${res.error}). Continue manually from the current screen.`;
  }

  private pruneOldImages(): void {
    /*
     * Bound the transcript. Previously only images were pruned, so a long demo
     * grew context (and per-turn latency and cost) without limit. Keep the most
     * recent turns; the Brain re-supplies grounding each turn, and session
     * memory carries the durable facts, so old raw turns are not load-bearing.
     */
    const MAX = Number(process.env.AGENT_MAX_MESSAGES ?? 24);
    this.messages = pruneNeutralHistory(this.messages, MAX);
    const keepFrom = this.messages.length - 2;
    this.messages.forEach((m, i) => {
      if (i >= keepFrom) return;
      m.blocks = m.blocks.map((b) => (b.type === "image" ? ({ type: "text", text: "[earlier screenshot omitted]" } as NBlock) : b));
      m.blocks.forEach((b) => { if (b.type === "tool_result") b.imageB64png = undefined; });
    });
  }
}

// tiny JSON-schema helpers
function obj(properties: Record<string, any>, required: string[]) { return { type: "object", properties, required }; }
function str() { return { type: "string" }; }
function int() { return { type: "integer" }; }
