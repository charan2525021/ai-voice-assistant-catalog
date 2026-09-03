import type {
  DemoControlAction,
  DemoPhase,
  DemoProfile,
  JsonValue,
  JourneyDefinition,
  SdkServerCommand,
  SignedCatalogEnvelope,
} from "@sable/sdk-contracts";

export type DemoResumeReason = "interruption" | "failure" | "module_complete";

export interface GuidedDemoCheckpoint {
  journeyId: string;
  completedStepIds: string[];
  nextStepId: string;
}

/**
 * Durable, bounded business state for one guided-demo session. It deliberately
 * contains catalog IDs and captured answers, never selectors or executable
 * browser instructions.
 */
export interface GuidedDemoSessionState {
  profileId: string;
  profileVersion: number;
  phase: DemoPhase;
  answers: Record<string, string>;
  genericQuestionIndex: number;
  playlistModuleIds: string[];
  moduleIndex: number;
  activeQuestionId?: string;
  activeModuleId?: string;
  personaId?: string;
  personaQuestionAsked?: boolean;
  resumeReason?: DemoResumeReason;
  checkpoint?: GuidedDemoCheckpoint;
  /** The browser finished the active module before an interruption checkpoint could be emitted. */
  moduleCompletedDuringInterruption?: boolean;
  startedAt?: string;
  updatedAt: string;
}

export type DemoExecutionInstruction =
  | { kind: "run"; moduleId: string }
  | { kind: "resume"; moduleId: string; checkpoint: GuidedDemoCheckpoint }
  | { kind: "stop" }
  | { kind: "none" };

export interface DemoTransition {
  state: GuidedDemoSessionState;
  instruction: DemoExecutionInstruction;
}

type DemoStateCommand = Extract<SdkServerCommand, { kind: "sable.sdk.server.demo_state" }>;

const ANSWER_MAXIMUM_CHARACTERS = 2_000;

function now(): string {
  return new Date().toISOString();
}

function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * Intake answers become lead data, so an obvious question must never be
 * silently stored as an organisation, goal, volume, or integration answer.
 * This is a narrow shape check, not semantic qualification or sales strategy.
 */
export function isLikelyIntakeInterruption(value: string): boolean {
  const raw = value.trim();
  if (!raw) return false;
  if (raw.includes("?")) return true;
  const text = normalized(raw);
  return /^(?:what|why|who|where|when)\s+(?:is|are|was|were|do|does|did|can|could|would|will|should)\b/.test(text)
    || /^(?:can|could|would|will|should)\s+(?:you|we|i)\b/.test(text)
    || /^(?:do|does|did)\s+(?:you|this|it|niroggyan|nirog gyan)\b/.test(text);
}

function cloneState(value: GuidedDemoSessionState): GuidedDemoSessionState {
  return {
    ...value,
    answers: { ...value.answers },
    playlistModuleIds: [...value.playlistModuleIds],
    ...(value.checkpoint ? { checkpoint: { ...value.checkpoint, completedStepIds: [...value.checkpoint.completedStepIds] } } : {}),
  };
}

function result(state: GuidedDemoSessionState, instruction: DemoExecutionInstruction = { kind: "none" }): DemoTransition {
  return { state: cloneState({ ...state, updatedAt: now() }), instruction };
}

/**
 * A deterministic conductor for the signed guided-demo catalog. No model is
 * used here: identical catalog + state + user answer always produces the same
 * next state.
 */
export class DeterministicDemoDirector {
  readonly profile: DemoProfile;

  constructor(private readonly catalog: SignedCatalogEnvelope, private readonly role: string) {
    const profile = catalog.payload.demoProfile;
    if (!profile) throw new Error("The signed catalog does not contain a guided-demo profile");
    this.profile = profile;
  }

  idle(): GuidedDemoSessionState {
    return {
      profileId: this.profile.id,
      profileVersion: this.profile.version,
      phase: "idle",
      answers: {},
      genericQuestionIndex: 0,
      playlistModuleIds: [],
      moduleIndex: 0,
      updatedAt: now(),
    };
  }

  /** Fail closed when an old checkpoint no longer matches the pinned profile. */
  restore(value: GuidedDemoSessionState | undefined): GuidedDemoSessionState {
    if (!value || !this.isValid(value)) return this.idle();
    return cloneState(value);
  }

  start(): DemoTransition {
    const firstQuestionId = this.profile.intake.genericQuestionIds[0];
    const state: GuidedDemoSessionState = {
      ...this.idle(),
      phase: "intake",
      activeQuestionId: firstQuestionId,
      startedAt: now(),
    };
    return result(state);
  }

  captureIntake(value: GuidedDemoSessionState, answer: string): DemoTransition {
    const state = this.restore(value);
    if (state.phase !== "intake" || !state.activeQuestionId) throw new Error("The guided demo is not waiting for an intake answer");
    const question = this.profile.questions.find((candidate) => candidate.id === state.activeQuestionId);
    if (!question) throw new Error("The active intake question is not in the signed profile");
    const captured = answer.trim().slice(0, ANSWER_MAXIMUM_CHARACTERS);
    if (!captured) throw new Error("An intake answer cannot be empty");
    state.answers[question.captureKey] = captured;

    const [firstGenericId, secondGenericId] = this.profile.intake.genericQuestionIds;
    if (question.id === firstGenericId) {
      state.personaId = this.classifyPersona(captured);
      state.genericQuestionIndex = 1;
      state.activeQuestionId = secondGenericId;
      return result(state);
    }

    if (question.id === secondGenericId) {
      state.genericQuestionIndex = 2;
      const personaQuestionId = state.personaId
        ? this.profile.intake.personaQuestionByPersonaId[state.personaId]
        : undefined;
      if (personaQuestionId && !state.personaQuestionAsked) {
        state.personaQuestionAsked = true;
        state.activeQuestionId = personaQuestionId;
        return result(state);
      }
      return this.beginPlaylist(state);
    }

    if (state.personaId && question.id === this.profile.intake.personaQuestionByPersonaId[state.personaId]) {
      state.personaQuestionAsked = true;
      return this.beginPlaylist(state);
    }
    throw new Error("The active intake question is outside the allowed intake sequence");
  }

  beginInterruption(value: GuidedDemoSessionState): DemoTransition {
    const state = this.restore(value);
    if (state.phase !== "playing" || !state.activeModuleId) throw new Error("Only a playing demo module can be interrupted");
    state.phase = "pausing";
    return result(state);
  }

  checkpointInterruption(value: GuidedDemoSessionState, checkpoint: GuidedDemoCheckpoint): DemoTransition {
    const state = this.restore(value);
    const module = this.activeModule(state);
    if (state.phase !== "pausing" || !module || module.journeyId !== checkpoint.journeyId) {
      throw new Error("The SDK checkpoint does not match the active signed demo module");
    }
    state.phase = "awaiting_resume";
    state.resumeReason = "interruption";
    state.checkpoint = { ...checkpoint, completedStepIds: [...checkpoint.completedStepIds] };
    delete state.moduleCompletedDuringInterruption;
    return result(state);
  }

  /** Preserve an interruption that races with successful completion of the active module. */
  completeModuleDuringInterruption(value: GuidedDemoSessionState, journeyId: string): DemoTransition {
    const state = this.restore(value);
    const module = this.activeModule(state);
    if (state.phase !== "pausing" || !module || module.journeyId !== journeyId) {
      throw new Error("The completed journey does not match the interrupted signed demo module");
    }
    state.phase = "awaiting_resume";
    state.resumeReason = "interruption";
    state.moduleCompletedDuringInterruption = true;
    delete state.checkpoint;
    return result(state);
  }

  beginInterruptionAnswer(value: GuidedDemoSessionState): DemoTransition {
    const state = this.restore(value);
    const answerablePosition = state.resumeReason === "failure"
      || state.resumeReason === "module_complete"
      || (state.resumeReason === "interruption" && (!!state.checkpoint || !!state.moduleCompletedDuringInterruption));
    if (state.phase !== "awaiting_resume" || !answerablePosition) {
      throw new Error("An interruption answer requires an authoritative journey outcome");
    }
    state.phase = "answering";
    return result(state);
  }

  finishInterruptionAnswer(value: GuidedDemoSessionState): DemoTransition {
    const state = this.restore(value);
    const answerablePosition = state.resumeReason === "failure"
      || state.resumeReason === "module_complete"
      || (state.resumeReason === "interruption" && (!!state.checkpoint || !!state.moduleCompletedDuringInterruption));
    if (state.phase !== "answering" || !answerablePosition) {
      throw new Error("No verified guided-demo interruption answer is in progress");
    }
    state.phase = "awaiting_resume";
    return result(state);
  }

  /** Replace the active slot and remove a later duplicate of that module. */
  replaceAfterInterruption(value: GuidedDemoSessionState, moduleId: string): DemoTransition {
    const state = this.restore(value);
    const replaceablePosition = state.resumeReason === "failure"
      || state.resumeReason === "module_complete"
      || (state.resumeReason === "interruption" && (!!state.checkpoint || !!state.moduleCompletedDuringInterruption));
    if (state.phase !== "awaiting_resume" || !replaceablePosition || !state.activeModuleId) {
      throw new Error("A module replacement requires an authoritative paused, completed, or failed module position");
    }
    const module = this.profile.modules.find((candidate) => candidate.id === moduleId);
    if (!module) throw new Error(`Replacement module ${moduleId} is not in the signed demo profile`);
    // A replacement is a jump, not a temporary detour. Put the requested
    // module in the current playlist position and remove any later occurrence
    // so it cannot run twice when it was already the next planned module.
    const currentIndex = state.moduleIndex;
    state.playlistModuleIds = state.playlistModuleIds
      .filter((candidate, index) => index <= currentIndex || candidate !== module.id);
    state.playlistModuleIds[currentIndex] = module.id;
    state.phase = "playing";
    state.activeModuleId = module.id;
    delete state.resumeReason;
    delete state.checkpoint;
    delete state.moduleCompletedDuringInterruption;
    return result(state, { kind: "run", moduleId: module.id });
  }

  journeyResult(value: GuidedDemoSessionState, ok: boolean): DemoTransition {
    const state = this.restore(value);
    if (state.phase !== "playing" || !state.activeModuleId) throw new Error("No guided-demo module is currently playing");
    if (!ok) {
      state.phase = "awaiting_resume";
      state.resumeReason = "failure";
      delete state.checkpoint;
      return result(state);
    }
    if (!state.playlistModuleIds[state.moduleIndex + 1]) return this.advanceModule(state);
    state.phase = "awaiting_resume";
    state.resumeReason = "module_complete";
    delete state.checkpoint;
    delete state.moduleCompletedDuringInterruption;
    return result(state);
  }

  control(value: GuidedDemoSessionState, action: DemoControlAction): DemoTransition {
    const state = this.restore(value);
    if (action === "start") {
      if (!["idle", "completed", "stopped"].includes(state.phase)) throw new Error(`Start is not allowed while the demo is ${state.phase}`);
      return this.start();
    }
    if (action === "stop") {
      if (["idle", "completed", "stopped"].includes(state.phase)) throw new Error(`Stop is not allowed while the demo is ${state.phase}`);
      state.phase = "stopped";
      delete state.activeQuestionId;
      delete state.activeModuleId;
      delete state.checkpoint;
      delete state.resumeReason;
      delete state.moduleCompletedDuringInterruption;
      return result(state, { kind: "stop" });
    }
    if (state.phase !== "awaiting_resume" || !state.activeModuleId) throw new Error(`${action} is not allowed while the demo is ${state.phase}`);
    if (action === "retry") {
      state.phase = "playing";
      delete state.checkpoint;
      delete state.resumeReason;
      delete state.moduleCompletedDuringInterruption;
      return result(state, { kind: "run", moduleId: state.activeModuleId });
    }
    if (action === "skip") return this.advanceModule(state);
    if (action === "continue") {
      if (state.resumeReason === "module_complete") return this.advanceModule(state);
      if (state.resumeReason !== "interruption") throw new Error("Continue requires a verified interruption position");
      if (state.moduleCompletedDuringInterruption) return this.advanceModule(state);
      if (!state.checkpoint) throw new Error("Continue requires a verified interruption checkpoint");
      const checkpoint = { ...state.checkpoint, completedStepIds: [...state.checkpoint.completedStepIds] };
      state.phase = "playing";
      delete state.resumeReason;
      return result(state, { kind: "resume", moduleId: state.activeModuleId, checkpoint });
    }
    throw new Error(`Unsupported guided-demo control: ${action}`);
  }

  completeClosing(value: GuidedDemoSessionState): DemoTransition {
    const state = this.restore(value);
    if (state.phase !== "closing") throw new Error("Only a closing demo can be completed");
    state.phase = "completed";
    delete state.activeModuleId;
    delete state.activeQuestionId;
    return result(state);
  }

  activeJourney(value: GuidedDemoSessionState): { moduleId: string; journey: JourneyDefinition; inputs: Record<string, JsonValue> } | undefined {
    const state = this.restore(value);
    const module = this.activeModule(state);
    if (!module || state.phase !== "playing") return undefined;
    const journey = this.catalog.payload.journeys.find((candidate) => candidate.id === module.journeyId);
    if (!journey || journey.state !== "approved" || journey.demoSafe !== true) return undefined;
    if (journey.roles.length && !journey.roles.includes(this.role)) return undefined;
    if (journey.compatibility.some((step) => ["EXTENSION_ONLY", "HUMAN_ONLY", "UNSUPPORTED"].includes(step.classification))) return undefined;
    const inputs: Record<string, JsonValue> = {};
    for (const required of journey.inputSchema.required) {
      const fallback = journey.inputSchema.properties[required]?.default;
      if (fallback === undefined) return undefined;
      inputs[required] = fallback;
    }
    return { moduleId: module.id, journey, inputs };
  }

  view(value: GuidedDemoSessionState): Omit<DemoStateCommand, "schemaVersion" | "commandId" | "sessionId" | "sentAt" | "kind"> {
    const state = this.restore(value);
    const terminal = ["idle", "completed", "stopped"].includes(state.phase);
    const awaiting = state.phase === "awaiting_resume";
    return {
      phase: state.phase,
      ...(state.activeModuleId ? { activeModuleId: state.activeModuleId } : {}),
      ...(state.activeQuestionId ? { activeQuestionId: state.activeQuestionId } : {}),
      canStart: terminal,
      canContinue: awaiting && (state.resumeReason === "module_complete"
        || (state.resumeReason === "interruption" && (!!state.checkpoint || !!state.moduleCompletedDuringInterruption))),
      canRetry: awaiting && state.resumeReason === "failure",
      canSkip: awaiting && state.resumeReason === "failure",
      canStop: !terminal,
    };
  }

  private classifyPersona(answer: string): string | undefined {
    const haystack = ` ${normalized(answer)} `;
    const ranked = this.profile.personas.map((persona, index) => {
      const matches = (persona.classifierSignals ?? []).map(normalized).filter((signal) => signal && haystack.includes(` ${signal} `));
      return { id: persona.id, index, matches: matches.length, specificity: matches.reduce((total, signal) => total + signal.length, 0) };
    }).filter((candidate) => candidate.matches > 0)
      .sort((left, right) => right.matches - left.matches || right.specificity - left.specificity || left.index - right.index);
    return ranked[0]?.id;
  }

  private beginPlaylist(state: GuidedDemoSessionState): DemoTransition {
    const personaPlaylist = state.personaId ? this.profile.playlistModuleIdsByPersonaId[state.personaId] : undefined;
    state.playlistModuleIds = [...(personaPlaylist?.length ? personaPlaylist : this.profile.defaultPlaylistModuleIds)];
    state.moduleIndex = 0;
    delete state.activeQuestionId;
    delete state.resumeReason;
    delete state.checkpoint;
    delete state.moduleCompletedDuringInterruption;
    const activeModuleId = state.playlistModuleIds[0];
    if (!activeModuleId) {
      state.phase = "closing";
      delete state.activeModuleId;
      return result(state);
    }
    state.phase = "playing";
    state.activeModuleId = activeModuleId;
    return result(state, { kind: "run", moduleId: activeModuleId });
  }

  private advanceModule(state: GuidedDemoSessionState): DemoTransition {
    state.moduleIndex += 1;
    delete state.resumeReason;
    delete state.checkpoint;
    delete state.moduleCompletedDuringInterruption;
    const nextModuleId = state.playlistModuleIds[state.moduleIndex];
    if (!nextModuleId) {
      state.phase = "closing";
      delete state.activeModuleId;
      return result(state);
    }
    state.phase = "playing";
    state.activeModuleId = nextModuleId;
    return result(state, { kind: "run", moduleId: nextModuleId });
  }

  private activeModule(state: GuidedDemoSessionState) {
    return state.activeModuleId ? this.profile.modules.find((candidate) => candidate.id === state.activeModuleId) : undefined;
  }

  private isValid(value: GuidedDemoSessionState): boolean {
    if (value.profileId !== this.profile.id || value.profileVersion !== this.profile.version) return false;
    if (!Number.isInteger(value.genericQuestionIndex) || value.genericQuestionIndex < 0 || value.genericQuestionIndex > 2) return false;
    if (!Number.isInteger(value.moduleIndex) || value.moduleIndex < 0) return false;
    if (!value.answers || typeof value.answers !== "object" || Object.values(value.answers).some((answer) => typeof answer !== "string" || answer.length > ANSWER_MAXIMUM_CHARACTERS)) return false;
    const questionIds = new Set(this.profile.questions.map((question) => question.id));
    const moduleIds = new Set(this.profile.modules.map((module) => module.id));
    if (value.activeQuestionId && !questionIds.has(value.activeQuestionId)) return false;
    if (value.activeModuleId && !moduleIds.has(value.activeModuleId)) return false;
    if (value.playlistModuleIds.some((id) => !moduleIds.has(id))) return false;
    if (value.personaId && !this.profile.personas.some((persona) => persona.id === value.personaId)) return false;
    if (value.checkpoint) {
      const module = this.activeModule(value);
      if (!module || module.journeyId !== value.checkpoint.journeyId || !value.checkpoint.nextStepId) return false;
    }
    if (value.moduleCompletedDuringInterruption
      && (value.resumeReason !== "interruption" || !!value.checkpoint || !value.activeModuleId
        || !["awaiting_resume", "answering"].includes(value.phase))) return false;
    return true;
  }
}
