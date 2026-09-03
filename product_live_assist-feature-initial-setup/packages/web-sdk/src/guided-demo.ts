import type {
  DemoAudioAsset,
  DemoControlAction,
  DemoPhase,
  DemoProfile,
  DemoUtterance,
  SdkCatalog,
  SdkServerCommand,
  WorkflowStep,
} from "@sable/sdk-contracts";

export interface GuidedDemoControls {
  canStart: boolean;
  canContinue: boolean;
  canRetry: boolean;
  canSkip: boolean;
  canStop: boolean;
}

export interface GuidedDemoJourneyCheckpoint {
  moduleId: string;
  journeyId: string;
  catalogVersionId: string;
  completedStepIds: string[];
  nextStepId: string;
  nextStepIndex: number;
}

export interface GuidedDemoSnapshot {
  enabled: boolean;
  profileId?: string;
  phase: DemoPhase;
  activeModuleId?: string;
  activeQuestionId?: string;
  pendingAction?: DemoControlAction;
  controls: GuidedDemoControls;
  checkpoint?: GuidedDemoJourneyCheckpoint;
}

/** A live guided demo owns voice turns even when no browser journey is running yet. */
export function isGuidedDemoActive(snapshot: GuidedDemoSnapshot | undefined): boolean {
  return !!snapshot?.enabled && !["idle", "completed", "stopped"].includes(snapshot.phase);
}

export type GuidedDemoCueKind = "greeting" | "question" | "module_introduction" | "module_completion" | "module_failure" | "closing";

export interface GuidedDemoPlaybackCue {
  key: string;
  kind: GuidedDemoCueKind;
  utterance: DemoUtterance;
  audioAsset?: DemoAudioAsset;
  moduleId?: string;
  questionId?: string;
}

export interface GuidedDemoPlaybackRequest extends GuidedDemoPlaybackCue {
  /** Exact signed transcript. A recording handler must never substitute different wording. */
  text: string;
}

export type GuidedDemoRecordingLoader = (asset: DemoAudioAsset, signal?: AbortSignal) => ArrayBuffer | Blob | undefined | Promise<ArrayBuffer | Blob | undefined>;

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

/** Loads host/cloud-owned bytes, verifies the signed digest, then plays them. */
export class VerifiedDemoAudioPlayer {
  constructor(private readonly loader: GuidedDemoRecordingLoader) {}

  async play(request: GuidedDemoPlaybackRequest, signal?: AbortSignal): Promise<boolean> {
    const asset = request.audioAsset;
    if (!asset || signal?.aborted) return false;
    const loaded = await this.loader(asset, signal);
    if (!loaded || signal?.aborted) return false;
    if (loaded instanceof Blob && loaded.type && loaded.type !== asset.mime) throw new Error(`Demo recording ${asset.id} has unexpected MIME type ${loaded.type}`);
    const bytes = loaded instanceof Blob ? await loaded.arrayBuffer() : loaded;
    if (signal?.aborted) return false;
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    if (signal?.aborted) return false;
    if (bytesToHex(new Uint8Array(digest)) !== asset.sha256) throw new Error(`Demo recording ${asset.id} failed signed SHA-256 verification`);
    const blob = loaded instanceof Blob ? loaded : new Blob([loaded], { type: asset.mime });
    const url = URL.createObjectURL(blob);
    const player = new Audio(url);
    player.preload = "auto";
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", abort);
          player.removeEventListener("ended", ended);
          player.removeEventListener("error", failed);
          error ? reject(error) : resolve();
        };
        const abort = () => { player.pause(); finish(new DOMException("Demo playback aborted", "AbortError")); };
        const ended = () => finish();
        const failed = () => finish(new Error(`Demo recording ${asset.id} could not be played`));
        signal?.addEventListener("abort", abort, { once: true });
        player.addEventListener("ended", ended, { once: true });
        player.addEventListener("error", failed, { once: true });
        if (signal?.aborted) { abort(); return; }
        try { void player.play().catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error)))); }
        catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      });
      return true;
    } finally {
      player.pause();
      player.removeAttribute("src");
      player.load();
      URL.revokeObjectURL(url);
    }
  }
}

export interface GuidedDemoStateUpdate {
  snapshot: GuidedDemoSnapshot;
  cues: GuidedDemoPlaybackCue[];
}

type DemoStateCommand = Extract<SdkServerCommand, { kind: "sable.sdk.server.demo_state" }>;

/** Resume indexes address top-level workflow steps, never nested branch children. */
export function isAtomicDemoBoundary(topLevelSteps: readonly WorkflowStep[], step: WorkflowStep, topLevelIndex: number): boolean {
  return topLevelSteps[topLevelIndex]?.id === step.id;
}

const NO_CONTROLS: GuidedDemoControls = {
  canStart: false,
  canContinue: false,
  canRetry: false,
  canSkip: false,
  canStop: false,
};

function localMaximumControls(phase: DemoPhase): GuidedDemoControls {
  return {
    canStart: phase === "idle" || phase === "completed" || phase === "stopped",
    canContinue: phase === "paused" || phase === "awaiting_resume",
    canRetry: phase === "awaiting_resume",
    canSkip: phase === "awaiting_resume",
    canStop: !["idle", "completed", "stopped"].includes(phase),
  };
}

function controlsFromCommand(command: DemoStateCommand): GuidedDemoControls {
  return {
    canStart: command.canStart,
    canContinue: command.canContinue,
    canRetry: command.canRetry,
    canSkip: command.canSkip,
    canStop: command.canStop,
  };
}

function actionAllowed(controls: GuidedDemoControls, action: DemoControlAction): boolean {
  if (action === "start") return controls.canStart;
  if (action === "continue") return controls.canContinue;
  if (action === "retry") return controls.canRetry;
  if (action === "skip") return controls.canSkip;
  return controls.canStop;
}

function copySnapshot(snapshot: GuidedDemoSnapshot): GuidedDemoSnapshot {
  return {
    ...snapshot,
    controls: { ...snapshot.controls },
    ...(snapshot.checkpoint ? { checkpoint: { ...snapshot.checkpoint, completedStepIds: [...snapshot.checkpoint.completedStepIds] } } : {}),
  };
}

/**
 * Browser-side fail-closed state machine. The cloud remains authoritative over
 * business flow, but it cannot make the SDK expose a control that is illegal
 * for the current phase or execute a journey outside the active signed module.
 */
export class GuidedDemoController {
  private readonly profile?: DemoProfile;
  private readonly audioAssets: Map<string, DemoAudioAsset>;
  private snapshotValue: GuidedDemoSnapshot;
  private cueOccurrences = new Map<string, number>();
  private greetingPlayed = false;

  constructor(private readonly catalog: SdkCatalog) {
    this.profile = catalog.demoProfile;
    this.audioAssets = new Map((catalog.demoAudioAssets ?? []).map((asset) => [asset.id, asset]));
    this.snapshotValue = this.profile
      // A profile proves capability, not installation entitlement. Phase 3's
      // server director exposes Start only after checking the opt-in flag.
      ? { enabled: true, profileId: this.profile.id, phase: "idle", controls: { ...NO_CONTROLS } }
      : { enabled: false, phase: "idle", controls: { ...NO_CONTROLS } };
  }

  snapshot(): GuidedDemoSnapshot {
    return copySnapshot(this.snapshotValue);
  }

  request(action: DemoControlAction): GuidedDemoSnapshot {
    if (!this.profile) throw new Error("Guided demo is not available in this signed catalog");
    if (this.snapshotValue.pendingAction) throw new Error(`Guided demo is already processing ${this.snapshotValue.pendingAction}`);
    if (!actionAllowed(this.snapshotValue.controls, action)) throw new Error(`${action} is not allowed while the guided demo is ${this.snapshotValue.phase}`);
    this.snapshotValue = { ...this.snapshotValue, pendingAction: action, controls: { ...NO_CONTROLS } };
    return this.snapshot();
  }

  applyServerState(command: DemoStateCommand): GuidedDemoStateUpdate {
    if (!this.profile) throw new Error("The server sent guided-demo state for a catalog without a demo profile");
    if (command.activeModuleId && !this.profile.modules.some((module) => module.id === command.activeModuleId)) {
      throw new Error(`Guided-demo state references unknown module ${command.activeModuleId}`);
    }
    if (command.activeQuestionId && !this.profile.questions.some((question) => question.id === command.activeQuestionId)) {
      throw new Error(`Guided-demo state references unknown question ${command.activeQuestionId}`);
    }
    const maximum = localMaximumControls(command.phase);
    const requested = controlsFromCommand(command);
    for (const key of Object.keys(requested) as Array<keyof GuidedDemoControls>) {
      if (requested[key] && !maximum[key]) throw new Error(`Server cannot enable ${key} while the guided demo is ${command.phase}`);
    }

    const previous = this.snapshotValue;
    this.snapshotValue = {
      enabled: true,
      profileId: this.profile.id,
      phase: command.phase,
      controls: requested,
      ...(command.activeModuleId ? { activeModuleId: command.activeModuleId } : {}),
      ...(command.activeQuestionId ? { activeQuestionId: command.activeQuestionId } : {}),
      ...(previous.checkpoint ? { checkpoint: previous.checkpoint } : {}),
    };
    const cues = this.stateCues(previous, this.snapshotValue);
    if (["idle", "completed", "stopped"].includes(command.phase)) {
      delete this.snapshotValue.checkpoint;
      this.greetingPlayed = false;
    }
    return { snapshot: this.snapshot(), cues };
  }

  beginInterruption(): GuidedDemoSnapshot | undefined {
    if (!this.profile || this.snapshotValue.phase !== "playing" || !this.snapshotValue.activeModuleId) return undefined;
    this.snapshotValue = {
      ...this.snapshotValue,
      phase: "pausing",
      controls: { ...NO_CONTROLS, canStop: true },
    };
    return this.snapshot();
  }

  checkpointJourney(value: Omit<GuidedDemoJourneyCheckpoint, "moduleId">): GuidedDemoSnapshot {
    const moduleId = this.snapshotValue.activeModuleId;
    if (!this.profile || !moduleId) throw new Error("Cannot checkpoint a journey without an active guided-demo module");
    const module = this.profile.modules.find((candidate) => candidate.id === moduleId);
    if (!module || module.journeyId !== value.journeyId) throw new Error("Checkpoint journey does not match the active signed demo module");
    const checkpoint: GuidedDemoJourneyCheckpoint = {
      moduleId,
      ...value,
      completedStepIds: [...value.completedStepIds],
    };
    this.snapshotValue = {
      ...this.snapshotValue,
      phase: "paused",
      // The checkpoint exists locally, but only the cloud can decide when the
      // interruption answer is complete and expose Continue/Retry/Skip.
      controls: { ...NO_CONTROLS, canStop: true },
      checkpoint,
    };
    return this.snapshot();
  }

  canRunActiveModuleJourney(journeyId: string): boolean {
    if (!this.profile || this.snapshotValue.phase !== "playing" || !this.snapshotValue.activeModuleId) return false;
    const module = this.profile.modules.find((candidate) => candidate.id === this.snapshotValue.activeModuleId);
    const journey = this.catalog.journeys.find((candidate) => candidate.id === journeyId);
    return !!module && module.journeyId === journeyId && journey?.state === "approved" && journey.demoSafe === true;
  }

  moduleCompletion(moduleId: string): GuidedDemoPlaybackCue | undefined {
    const module = this.profile?.modules.find((candidate) => candidate.id === moduleId);
    return module ? this.cue(`module:${module.id}:completion`, "module_completion", module.completion, { moduleId }) : undefined;
  }

  moduleFailure(moduleId: string): GuidedDemoPlaybackCue | undefined {
    const module = this.profile?.modules.find((candidate) => candidate.id === moduleId);
    return module ? this.cue(`module:${module.id}:failure`, "module_failure", module.failureMessage, { moduleId }) : undefined;
  }

  private stateCues(previous: GuidedDemoSnapshot, next: GuidedDemoSnapshot): GuidedDemoPlaybackCue[] {
    if (!this.profile) return [];
    const cues: GuidedDemoPlaybackCue[] = [];
    if (next.phase === "intake" && !this.greetingPlayed) {
      const greeting = this.cue(`profile:${this.profile.id}:greeting`, "greeting", this.profile.greeting);
      if (greeting) cues.push(greeting);
      this.greetingPlayed = true;
    }
    if (next.phase === "intake" && next.activeQuestionId && next.activeQuestionId !== previous.activeQuestionId) {
      const question = this.profile.questions.find((candidate) => candidate.id === next.activeQuestionId);
      const cue = question && this.cue(`question:${question.id}`, "question", question.prompt, { questionId: question.id });
      if (cue) cues.push(cue);
    }
    if (next.phase === "playing" && next.activeModuleId && (previous.phase !== "playing" || next.activeModuleId !== previous.activeModuleId)) {
      const module = this.profile.modules.find((candidate) => candidate.id === next.activeModuleId);
      const cue = module && this.cue(`module:${module.id}:introduction`, "module_introduction", module.introduction, { moduleId: module.id });
      if (cue) cues.push(cue);
    }
    if (next.phase === "closing" && previous.phase !== "closing") {
      const closing = this.cue(`profile:${this.profile.id}:closing`, "closing", this.profile.closing);
      if (closing) cues.push(closing);
    }
    return cues;
  }

  private cue(baseKey: string, kind: GuidedDemoCueKind, utterance: DemoUtterance, references: { moduleId?: string; questionId?: string } = {}): GuidedDemoPlaybackCue {
    const occurrence = (this.cueOccurrences.get(baseKey) ?? 0) + 1;
    this.cueOccurrences.set(baseKey, occurrence);
    const key = occurrence === 1 ? baseKey : `${baseKey}:${occurrence}`;
    const audioAsset = utterance.audioAssetId ? this.audioAssets.get(utterance.audioAssetId) : undefined;
    return { key, kind, utterance, ...(audioAsset ? { audioAsset } : {}), ...references };
  }
}
