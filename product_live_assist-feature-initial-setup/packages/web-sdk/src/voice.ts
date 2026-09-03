import type { SdkBootstrapResponse } from "@sable/sdk-contracts";
import { bytesToBase64Url, isRecord } from "./utils.js";

const OPEN_SOCKET_STATE = 1;

export type VoiceState = "idle" | "connecting" | "listening" | "processing" | "speaking" | "failed";
export type PlaybackOutcome = "completed" | "interrupted" | "failed";

export interface VoiceCallbacks {
  onState(state: VoiceState, detail: string | undefined, sessionActive: boolean): void;
  onTranscript(text: string, final: boolean): void;
  onPlayback(value: { utteranceId: string; turnId: string; sequence: number; state: "started" | "ended" | "cancelled" | "failed"; detail?: string }): void;
  /** Fires when the server accepts a non-echo transcript and commits the interruption. */
  onBargeIn?(): void;
}

type VoiceTransport = NonNullable<SdkBootstrapResponse["voiceTransport"]>;

function ticketProtocol(ticket: string): string {
  return `sable.ticket.${bytesToBase64Url(new TextEncoder().encode(ticket))}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

/** Convert browser-rate floating point audio to the cloud's fixed PCM16/16 kHz format. */
export function resamplePcm16(input: Float32Array, inputRate: number, outputRate = 16_000): ArrayBuffer {
  if (!input.length) return new ArrayBuffer(0);
  const ratio = inputRate / outputRate;
  const length = Math.max(1, Math.floor(input.length / ratio));
  const output = new Int16Array(length);
  for (let index = 0; index < length; index++) {
    const start = Math.floor(index * ratio);
    const end = Math.max(start + 1, Math.min(input.length, Math.floor((index + 1) * ratio)));
    let sum = 0;
    for (let cursor = start; cursor < end; cursor++) sum += input[cursor];
    const sample = clamp(sum / Math.max(1, end - start), -1, 1);
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output.buffer;
}

function pcm16Sample(sample: number): number {
  const clamped = clamp(sample, -1, 1);
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
}

/**
 * Keeps resampling state across AudioWorklet blocks and emits provider-sized
 * PCM frames instead of flooding the voice socket with tiny render quanta.
 */
export class StreamingPcm16Framer {
  private pending: number[] = [];
  private readonly ratio: number;
  private readonly outputSamplesPerFrame: number;
  private readonly sourceSamplesPerFrame: number;
  private nextSourceBoundary: number;
  private consumedSourceSamples = 0;

  constructor(inputRate: number, outputRate: number, frameMs: number) {
    if (inputRate <= 0 || outputRate <= 0 || frameMs <= 0) throw new Error("Audio frame configuration must be positive");
    this.ratio = inputRate / outputRate;
    this.outputSamplesPerFrame = Math.max(1, Math.round(outputRate * frameMs / 1_000));
    this.sourceSamplesPerFrame = inputRate * frameMs / 1_000;
    this.nextSourceBoundary = this.sourceSamplesPerFrame;
  }

  push(input: Float32Array): ArrayBuffer[] {
    for (const value of input) this.pending.push(value);
    const frames: ArrayBuffer[] = [];
    let sourceFrameLength = Math.max(1, Math.round(this.nextSourceBoundary) - this.consumedSourceSamples);
    while (this.pending.length >= sourceFrameLength) {
      const sourceFrame = this.pending.splice(0, sourceFrameLength);
      frames.push(this.resample(sourceFrame, this.outputSamplesPerFrame));
      this.consumedSourceSamples += sourceFrameLength;
      this.nextSourceBoundary += this.sourceSamplesPerFrame;
      sourceFrameLength = Math.max(1, Math.round(this.nextSourceBoundary) - this.consumedSourceSamples);
    }
    return frames;
  }

  flush(): ArrayBuffer[] {
    const frames: ArrayBuffer[] = [];
    if (this.pending.length) frames.push(this.resample(this.pending, Math.max(1, Math.round(this.pending.length / this.ratio))));
    this.pending = [];
    this.nextSourceBoundary = this.sourceSamplesPerFrame;
    this.consumedSourceSamples = 0;
    return frames;
  }

  private resample(input: number[], outputLength: number): ArrayBuffer {
    const output = new Int16Array(outputLength);
    const scale = input.length / outputLength;
    for (let index = 0; index < outputLength; index++) {
      const position = Math.min(input.length - 1, index * scale);
      const left = Math.floor(position);
      const right = Math.min(input.length - 1, left + 1);
      const fraction = position - left;
      output[index] = pcm16Sample(input[left] * (1 - fraction) + input[right] * fraction);
    }
    return output.buffer as ArrayBuffer;
  }
}

function rms(values: Float32Array): number {
  if (!values.length) return 0;
  let total = 0;
  for (const value of values) total += value * value;
  return Math.sqrt(total / values.length);
}

/** Start Web Audio while the microphone-button user gesture is still active. */
export async function ensureAudioContextRunning(context: Pick<AudioContext, "state" | "resume">): Promise<void> {
  if (context.state !== "running") await context.resume();
  if ((context.state as AudioContextState) !== "running") throw new Error("Microphone audio could not start; check this site's audio permission");
}

const WORKLET_SOURCE = `
class SableCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("sable-capture", SableCaptureProcessor);
`;

/** Browser-owned microphone and playback. Provider credentials never enter this class. */
export class CloudVoiceClient {
  private socket?: WebSocket;
  private context?: AudioContext;
  private stream?: MediaStream;
  private source?: MediaStreamAudioSourceNode;
  private worklet?: AudioWorkletNode;
  private framer?: StreamingPcm16Framer;
  private speechStartedAt?: number;
  private lastVoiceAt?: number;
  private bargeInCandidateAt?: number;
  private localBargeInTriggered = false;
  private interruptionCommitted = false;
  private sessionActive = false;
  private listening = false;
  private player?: HTMLAudioElement;
  private unlockedPlayer?: HTMLAudioElement;
  private activePlayback?: { utteranceId: string; turnId: string; sequence: number };
  private audioItems: Array<{ utteranceId: string; turnId: string; sequence: number; mime: string; base64Audio: string; gapMs: number; generation: number; serverGeneration: number }> = [];
  private nextSequence?: number;
  private playedSequence = 0;
  private playbackBlocked = false;
  private playbackWaitTimer?: number;
  private playbackWatchdog?: number;
  private utteranceEnds = new Map<string, {
    lastSequence: number | null;
    serverEnded: boolean;
    resolve: (outcome: PlaybackOutcome) => void;
    timer: number;
    timeoutMs: number;
  }>();
  private playbackGeneration = 0;
  private serverPlaybackGeneration = 0;
  /** No server audio may start between confirmed user speech and acceptance of that turn. */
  private interruptionBarrier = false;
  /**
   * A loud signal first pauses TTS. Real speech remains after the speaker falls
   * silent; acoustic echo normally does not. Only the former becomes barge-in.
   */
  private bargeInProbe?: {
    player: HTMLAudioElement;
    speechCandidateAt?: number;
    timer: number;
    authority: "browser_candidate" | "sidecar_confirmed";
  };
  private removePlaybackListeners?: () => void;

  constructor(
    private readonly transport: VoiceTransport,
    private readonly callbacks: VoiceCallbacks,
    private readonly webSocketFactory?: (url: string, protocols: string[]) => WebSocket,
  ) {}

  get active(): boolean { return this.sessionActive; }

  private state(value: VoiceState, detail?: string): void {
    this.callbacks.onState(value, detail, this.sessionActive);
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.socket?.readyState === OPEN_SOCKET_STATE) return;
    if (Date.parse(this.transport.expiresAt) <= Date.now()) throw new Error("Voice socket ticket expired before connection");
    this.state("connecting");
    const create = this.webSocketFactory ?? ((url, protocols) => new WebSocket(url, protocols));
    const socket = create(this.transport.websocketUrl, [ticketProtocol(this.transport.oneTimeTicket)]);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => reject(new Error("Voice connection timed out")), 10_000);
      const finish = (error?: Error) => {
        globalThis.clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        error ? reject(error) : resolve();
      };
      const abort = () => { socket.close(1000, "aborted"); finish(new Error("Voice connection aborted")); };
      signal?.addEventListener("abort", abort, { once: true });
      socket.addEventListener("open", () => finish(), { once: true });
      socket.addEventListener("error", () => finish(new Error("Voice connection failed")), { once: true });
    });
    socket.addEventListener("message", (event) => this.receive(event.data));
    socket.addEventListener("close", () => {
      if (this.sessionActive) void this.stop(false);
      this.state("failed", "Voice connection closed");
    });
    this.state("idle");
  }

  async start(): Promise<void> {
    if (this.sessionActive) return;
    if (this.socket?.readyState !== OPEN_SOCKET_STATE) throw new Error("Voice connection is not ready");
    this.cancelPlayback(false);
    this.interruptionBarrier = false;
    this.state("connecting", "Starting microphone…");
    const mediaDevices = globalThis.navigator?.mediaDevices;
    if (!mediaDevices?.getUserMedia) throw new Error("This browser does not support microphone capture");
    const AudioContextCtor = globalThis.AudioContext;
    if (!AudioContextCtor) throw new Error("This browser does not support Web Audio");
    this.context = new AudioContextCtor();
    try {
      // Resume before awaiting the permission prompt so Chrome still associates
      // audio startup with the user's Mic-button gesture.
      await ensureAudioContextRunning(this.context);
      this.stream = await mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
      try { await this.context.audioWorklet.addModule(workletUrl); }
      finally { URL.revokeObjectURL(workletUrl); }
      this.source = this.context.createMediaStreamSource(this.stream);
      this.worklet = new AudioWorkletNode(this.context, "sable-capture");
      this.framer = new StreamingPcm16Framer(this.context.sampleRate, this.transport.sampleRate, this.transport.audioFrameMs);
      const mute = this.context.createGain();
      mute.gain.value = 0;
      this.source.connect(this.worklet);
      this.worklet.connect(mute).connect(this.context.destination);
    } catch (error) {
      this.teardownCapture();
      await this.context.close().catch(() => undefined);
      this.context = undefined;
      throw error;
    }
    this.worklet.port.onmessage = (event: MessageEvent<Float32Array>) => this.capture(event.data);
    this.sessionActive = true;
    this.beginUtterance();
  }

  async stop(submit = true): Promise<void> {
    if (!this.sessionActive && !this.listening) return;
    this.sessionActive = false;
    if (this.listening) this.finishUtterance(submit);
    this.teardownCapture();
    await this.context?.close().catch(() => undefined);
    this.context = undefined;
    this.state("idle");
  }

  private beginUtterance(): void {
    if (!this.sessionActive || this.listening || this.socket?.readyState !== OPEN_SOCKET_STATE || !this.context) return;
    this.listening = true;
    this.framer = new StreamingPcm16Framer(this.context.sampleRate, this.transport.sampleRate, this.transport.audioFrameMs);
    this.speechStartedAt = undefined;
    this.lastVoiceAt = Date.now();
    this.bargeInCandidateAt = undefined;
    this.localBargeInTriggered = false;
    this.interruptionCommitted = false;
    this.socket.send(JSON.stringify({
      type: "voice.start", languageCode: this.transport.languageCode,
      sampleRate: this.transport.sampleRate, audioFrameMs: this.transport.audioFrameMs,
    }));
    // Listening can be active underneath assistant playback for barge-in. Keep
    // the visible state as speaking until playback drains, while audio capture
    // continues in the background.
    this.state(this.player ? "speaking" : "listening");
  }

  private finishUtterance(submit: boolean): void {
    if (!this.listening) return;
    this.listening = false;
    if (this.socket?.readyState === OPEN_SOCKET_STATE) {
      for (const finalFrame of this.framer?.flush() ?? []) if (finalFrame.byteLength) this.socket.send(finalFrame);
    }
    this.framer = undefined;
    const duration = this.speechStartedAt ? Date.now() - this.speechStartedAt : 0;
    const accepted = submit && duration >= this.transport.minimumSpeechMs;
    if (this.socket?.readyState === OPEN_SOCKET_STATE) {
      this.socket.send(JSON.stringify(accepted ? { type: "voice.flush", durationMs: duration } : { type: "voice.cancel" }));
    }
    this.state(accepted ? "processing" : "listening", accepted ? undefined : "Listening…");
    if (!accepted && this.sessionActive) globalThis.setTimeout(() => this.beginUtterance(), 0);
  }

  private teardownCapture(): void {
    this.worklet?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.worklet = undefined;
    this.framer = undefined;
    this.source = undefined;
    this.stream = undefined;
  }

  waitForUtterance(utteranceId: string, timeoutMs = this.transport.audioWaitCapMs): Promise<PlaybackOutcome> {
    return new Promise((resolve) => {
      const timer = globalThis.setTimeout(() => this.handleUtteranceInactivity(utteranceId), timeoutMs);
      this.utteranceEnds.set(utteranceId, { lastSequence: null, serverEnded: false, resolve, timer, timeoutMs });
    });
  }

  /**
   * The cap measures lack of playback progress, not total narration duration.
   * A later line may legitimately wait behind earlier audio, and an active
   * HTMLAudioElement already has its own duration-aware watchdog.
   */
  private handleUtteranceInactivity(utteranceId: string): void {
    const waiter = this.utteranceEnds.get(utteranceId);
    if (!waiter) return;
    const pipelineProgressing = !!this.player
      || this.playbackWaitTimer !== undefined
      || (!this.playbackBlocked && this.audioItems.length > 0);
    if (pipelineProgressing) {
      waiter.timer = globalThis.setTimeout(() => this.handleUtteranceInactivity(utteranceId), waiter.timeoutMs);
      return;
    }
    this.utteranceEnds.delete(utteranceId);
    waiter.resolve("failed");
  }

  private notePlaybackProgress(): void {
    for (const [id, waiter] of this.utteranceEnds) {
      // Progress by any active player keeps later queued narration healthy.
      // This includes a line that has been requested but has not received its
      // first chunk because earlier narration still owns the serialized queue.
      globalThis.clearTimeout(waiter.timer);
      waiter.timer = globalThis.setTimeout(
        () => this.handleUtteranceInactivity(id),
        waiter.timeoutMs,
      );
    }
  }

  /**
   * Called synchronously from the Start demo click. Priming one silent media
   * element while browser user activation is present makes delayed cloud TTS
   * playback reliable under autoplay policies without requesting microphone
   * permission.
   */
  unlockPlayback(): void {
    if (this.unlockedPlayer || typeof Audio === "undefined") return;
    const player = new Audio("data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=");
    player.volume = 0;
    this.unlockedPlayer = player;
    void player.play().then(() => {
      player.pause();
      player.removeAttribute("src");
      player.load();
      player.volume = 1;
    }).catch(() => { if (this.unlockedPlayer === player) this.unlockedPlayer = undefined; });
  }

  cancelPlayback(notifyState = true): void {
    if (this.bargeInProbe) globalThis.clearTimeout(this.bargeInProbe.timer);
    this.bargeInProbe = undefined;
    const player = this.player;
    const active = this.activePlayback;
    this.playbackGeneration += 1;
    this.removePlaybackListeners?.();
    this.removePlaybackListeners = undefined;
    this.player = undefined;
    this.activePlayback = undefined;
    this.audioItems = [];
    this.nextSequence = undefined;
    this.playbackBlocked = false;
    if (this.playbackWaitTimer !== undefined) globalThis.clearTimeout(this.playbackWaitTimer);
    this.playbackWaitTimer = undefined;
    if (this.playbackWatchdog !== undefined) globalThis.clearTimeout(this.playbackWatchdog);
    this.playbackWatchdog = undefined;
    if (player) {
      player.pause();
      player.removeAttribute("src");
      player.load();
    }
    if (active) this.callbacks.onPlayback({ ...active, state: "cancelled" });
    for (const [id, waiter] of this.utteranceEnds) {
      globalThis.clearTimeout(waiter.timer);
      waiter.resolve("interrupted");
      this.utteranceEnds.delete(id);
    }
    if (notifyState) this.state(this.listening ? "listening" : this.sessionActive ? "processing" : "idle");
  }

  private sidecarDecisionTimeoutMs(): number {
    // The sidecar groups PCM into ~192 ms analysis packets and requires at
    // least two voiced packets. Keep the browser's reversible pause alive long
    // enough for that authoritative signal to cross the gateway without
    // turning a timing race into audible TTS resume.
    return Math.max(750, (this.transport.minimumSpeechMs ?? 250) + 500);
  }

  private holdConfirmedSpeechProbe(): void {
    const probe = this.bargeInProbe;
    if (!probe) return;
    globalThis.clearTimeout(probe.timer);
    probe.authority = "sidecar_confirmed";
    probe.timer = globalThis.setTimeout(
      () => this.rejectBargeInProbe(),
      Math.max(5_000, (this.transport.maximumUtteranceMs ?? 30_000) + 5_000),
    );
    this.localBargeInTriggered = true;
    this.state("listening", "Listening to interruption…");
  }

  private startBargeInProbe(player: HTMLAudioElement, authority: "browser_candidate" | "sidecar_confirmed" = "browser_candidate"): void {
    if (this.bargeInProbe) {
      // A sidecar speech-start is stronger evidence than the browser's first
      // loud samples. Upgrade the existing pause instead of discarding it.
      if (authority === "sidecar_confirmed") this.holdConfirmedSpeechProbe();
      return;
    }
    if (this.localBargeInTriggered) return;
    player.pause();
    this.bargeInCandidateAt = undefined;
    const timer = globalThis.setTimeout(() => this.rejectBargeInProbe(), this.sidecarDecisionTimeoutMs());
    this.bargeInProbe = { player, timer, authority };
    if (authority === "sidecar_confirmed") {
      this.holdConfirmedSpeechProbe();
      return;
    }
    this.state("listening", "Confirming speech…");
  }

  private rejectBargeInProbe(): void {
    const probe = this.bargeInProbe;
    if (probe) globalThis.clearTimeout(probe.timer);
    this.bargeInProbe = undefined;
    this.bargeInCandidateAt = undefined;
    this.localBargeInTriggered = false;
    this.interruptionCommitted = false;
    if (!probe || this.player !== probe.player) return;
    void probe.player.play().then(() => {
      if (this.player === probe.player) this.state("speaking");
    }).catch((error) => {
      if (this.player !== probe.player) return;
      this.cancelPlayback();
      this.state("failed", `Audio could not resume: ${String(error instanceof Error ? error.message : error).slice(0, 120)}`);
    });
  }

  private confirmBargeIn(): void {
    if (this.localBargeInTriggered) return;
    // Keep the exact player paused and resumable while the sidecar finishes the
    // utterance. Acoustic energy is evidence, not authority to destroy audio.
    this.holdConfirmedSpeechProbe();
    this.socket?.send(JSON.stringify({ type: "voice.barge_in" }));
  }

  /** The accepted final transcript is the single authority for permanent cancellation. */
  private commitBargeIn(): void {
    if (this.interruptionCommitted) return;
    this.interruptionCommitted = true;
    if (this.bargeInProbe) globalThis.clearTimeout(this.bargeInProbe.timer);
    this.bargeInProbe = undefined;
    this.interruptionBarrier = true;
    this.cancelPlayback();
    this.callbacks.onBargeIn?.();
  }

  async close(): Promise<void> {
    await this.stop(false);
    this.cancelPlayback();
    this.socket?.close(1000, "SDK shutdown");
    this.socket = undefined;
  }

  private capture(input: Float32Array): void {
    if (!this.listening || this.socket?.readyState !== OPEN_SOCKET_STATE || !this.context) return;
    const level = rms(input);
    const threshold = this.transport.vadThreshold;
    const now = Date.now();
    if (level >= threshold) {
      this.speechStartedAt ??= now;
      this.lastVoiceAt = now;
    }
    // Normal endpointing belongs exclusively to the streaming STT sidecar.
    // Local VAD has one latency-sensitive job: stop assistant audio promptly.
    const bargeInThreshold = Math.max(threshold * 1.5, 0.03);
    if (this.bargeInProbe) {
      // Measure again only after pausing the speaker. Echo should collapse;
      // genuine user speech should remain continuously voiced.
      // Once the loudspeaker is paused, the normal speech threshold is enough:
      // a quieter human voice should not lose to the higher echo-defense gate.
      if (level >= threshold) {
        this.bargeInProbe.speechCandidateAt ??= now;
        if (now - this.bargeInProbe.speechCandidateAt >= 140) this.confirmBargeIn();
      } else {
        this.bargeInProbe.speechCandidateAt = undefined;
      }
    } else if (level >= bargeInThreshold) {
      this.bargeInCandidateAt ??= now;
      if (!this.localBargeInTriggered && now - this.bargeInCandidateAt >= 120) {
        // Pause first, while retaining the player and queue. This creates a
        // short echo-free window in which real speech can be distinguished
        // from the assistant's own loudspeaker output.
        if (this.player) this.startBargeInProbe(this.player);
        else this.confirmBargeIn();
      }
    } else this.bargeInCandidateAt = undefined;
    for (const pcm of this.framer?.push(input) ?? []) this.socket.send(pcm);
  }

  /** Roll directly into a fresh server utterance without closing the microphone. */
  private completeServerUtterance(): void {
    this.listening = false;
    this.framer = undefined;
    this.speechStartedAt = undefined;
    this.lastVoiceAt = undefined;
    this.bargeInCandidateAt = undefined;
    this.localBargeInTriggered = false;
    this.interruptionCommitted = false;
    if (this.sessionActive) this.beginUtterance();
  }

  private receive(raw: unknown): void {
    if (typeof raw !== "string") return;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return; }
    if (!isRecord(value)) return;
    if (value.type === "speech.candidate") {
      if (this.player) this.startBargeInProbe(this.player, "sidecar_confirmed");
    } else if (value.type === "speech.pending") {
      this.state("listening", "Listening to interruption…");
    } else if (value.type === "speech.confirmed") {
      this.commitBargeIn();
    } else if ((value.type === "transcript.partial" || value.type === "transcript.final") && typeof value.text === "string") {
      // transcript.final is also authoritative, making the SDK robust if the
      // explicit confirmation event is lost or an older gateway omits it.
      if (value.type === "transcript.final") this.commitBargeIn();
      this.callbacks.onTranscript(value.text, value.type === "transcript.final");
      if (value.type === "transcript.final") {
        this.state("processing");
        this.completeServerUtterance();
      }
    } else if (value.type === "voice.no_speech") {
      this.rejectBargeInProbe();
      this.state("processing", typeof value.reason === "string" ? value.reason : "No speech detected");
      this.completeServerUtterance();
    } else if (value.type === "voice.listen") {
      this.beginUtterance();
    } else if (value.type === "tts.cancel") {
      if (typeof value.generation === "number") this.serverPlaybackGeneration = Math.max(this.serverPlaybackGeneration, value.generation);
      if (value.reason === "barge_in") this.commitBargeIn();
      else this.cancelPlayback();
    } else if (value.type === "tts.resume" && typeof value.generation === "number") {
      // The backend sends this only after it has associated the barrier with a
      // completed user turn. Reset once more so no pre-resume queue survives.
      this.cancelPlayback(false);
      this.serverPlaybackGeneration = Math.max(this.serverPlaybackGeneration, value.generation);
      this.interruptionBarrier = false;
      this.state(this.listening ? "listening" : this.sessionActive ? "processing" : "idle");
    } else if (value.type === "tts.chunk" && typeof value.utteranceId === "string" && typeof value.turnId === "string" && typeof value.sequence === "number" && typeof value.mime === "string" && typeof value.base64Audio === "string") {
      const serverGeneration = typeof value.generation === "number" ? value.generation : this.serverPlaybackGeneration;
      if (this.interruptionBarrier || serverGeneration < this.serverPlaybackGeneration) return;
      this.serverPlaybackGeneration = Math.max(this.serverPlaybackGeneration, serverGeneration);
      this.audioItems.push({ utteranceId: value.utteranceId, turnId: value.turnId, sequence: value.sequence, mime: value.mime, base64Audio: value.base64Audio, gapMs: typeof value.gapMs === "number" ? value.gapMs : 0, generation: this.playbackGeneration, serverGeneration });
      this.notePlaybackProgress();
      void this.pumpPlayback();
    } else if (value.type === "tts.end" && typeof value.utteranceId === "string") {
      const waiter = this.utteranceEnds.get(value.utteranceId);
      if (waiter) {
        waiter.serverEnded = true;
        waiter.lastSequence = typeof value.lastSequence === "number" ? value.lastSequence : null;
        this.notePlaybackProgress();
        this.resolveUtterance(value.utteranceId);
      }
    } else if (value.type === "voice.error") {
      this.rejectBargeInProbe();
      this.state("failed", typeof value.message === "string" ? value.message : "Voice processing failed");
      this.listening = false;
      this.framer = undefined;
      if (this.sessionActive) globalThis.setTimeout(() => this.beginUtterance(), 500);
    }
  }

  private resolveUtterance(utteranceId: string): void {
    const waiter = this.utteranceEnds.get(utteranceId);
    if (!waiter || !waiter.serverEnded || (waiter.lastSequence !== null && this.playedSequence < waiter.lastSequence)) return;
    globalThis.clearTimeout(waiter.timer);
    this.utteranceEnds.delete(utteranceId);
    waiter.resolve("completed");
  }

  private failUtterance(utteranceId: string): void {
    const waiter = this.utteranceEnds.get(utteranceId);
    if (!waiter) return;
    globalThis.clearTimeout(waiter.timer);
    this.utteranceEnds.delete(utteranceId);
    waiter.resolve("failed");
  }

  private async pumpPlayback(): Promise<void> {
    if (this.player || this.playbackBlocked) return;
    if (this.playbackWaitTimer !== undefined) globalThis.clearTimeout(this.playbackWaitTimer);
    this.playbackWaitTimer = undefined;
    this.audioItems.sort((left, right) => left.sequence - right.sequence);
    const head = this.audioItems[0];
    if (!head) return;
    if (this.nextSequence === undefined) this.nextSequence = head.sequence;
    if (head.sequence > this.nextSequence) {
      this.playbackWaitTimer = globalThis.setTimeout(() => { this.nextSequence = head.sequence; void this.pumpPlayback(); }, 6_000);
      return;
    }
    const item = this.audioItems.shift()!;
    this.nextSequence = Math.max(this.nextSequence, item.sequence + 1);
    if (this.interruptionBarrier || item.generation !== this.playbackGeneration || item.serverGeneration < this.serverPlaybackGeneration) return void this.pumpPlayback();
    const generation = this.playbackGeneration;
    const player = this.unlockedPlayer ?? new Audio();
    this.unlockedPlayer = undefined;
    player.src = `data:${item.mime};base64,${item.base64Audio}`;
    player.volume = 1;
    player.preload = "auto";
    this.player = player;
    this.activePlayback = { utteranceId: item.utteranceId, turnId: item.turnId, sequence: item.sequence };
    let settled = false;
    let watchdog = globalThis.setTimeout(() => finish("ended"), 30_000);
    this.playbackWatchdog = watchdog;
    const current = () => this.player === player && generation === this.playbackGeneration;
    const finish = (state: "ended" | "failed", detail?: string) => {
      if (settled || !current()) return;
      settled = true;
      globalThis.clearTimeout(watchdog);
      this.playbackWatchdog = undefined;
      this.removePlaybackListeners?.();
      this.removePlaybackListeners = undefined;
      this.player = undefined;
      this.activePlayback = undefined;
      this.callbacks.onPlayback({ utteranceId: item.utteranceId, turnId: item.turnId, sequence: item.sequence, state, ...(detail ? { detail } : {}) });
      if (state === "ended") this.playedSequence = Math.max(this.playedSequence, item.sequence);
      this.notePlaybackProgress();
      if (state === "ended") this.resolveUtterance(item.utteranceId);
      else this.failUtterance(item.utteranceId);
      globalThis.setTimeout(() => { this.state(this.listening ? "listening" : this.sessionActive ? "processing" : "idle"); void this.pumpPlayback(); }, Math.max(0, item.gapMs));
    };
    const onPlaying = () => { if (current()) { this.playbackBlocked = false; this.notePlaybackProgress(); this.state("speaking"); this.callbacks.onPlayback({ utteranceId: item.utteranceId, turnId: item.turnId, sequence: item.sequence, state: "started" }); } };
    const onEnded = () => finish("ended");
    const onError = () => finish("failed", "Audio playback failed");
    player.addEventListener("playing", onPlaying, { once: true });
    player.addEventListener("ended", onEnded, { once: true });
    player.addEventListener("error", onError, { once: true });
    player.addEventListener("loadedmetadata", () => {
      if (settled || !Number.isFinite(player.duration)) return;
      globalThis.clearTimeout(watchdog);
      watchdog = globalThis.setTimeout(() => finish("ended"), player.duration * 1_000 + 3_000);
      this.playbackWatchdog = watchdog;
    }, { once: true });
    this.removePlaybackListeners = () => {
      player.removeEventListener("playing", onPlaying);
      player.removeEventListener("ended", onEnded);
      player.removeEventListener("error", onError);
    };
    try { await player.play(); }
    catch (error) {
      if (!current() || (error instanceof DOMException && error.name === "AbortError")) return;
      const detail = String(error instanceof Error ? error.message : error);
      if (/NotAllowedError|not allowed|user gesture|interact/i.test(detail)) {
        globalThis.clearTimeout(watchdog);
        settled = true;
        this.player = undefined;
        this.activePlayback = undefined;
        this.audioItems.unshift(item);
        this.nextSequence = Math.min(this.nextSequence, item.sequence);
        this.playbackBlocked = true;
        this.state("failed", "Sound is blocked; tap Mic once to enable it");
        return;
      }
      finish("failed", detail.slice(0, 160));
    }
  }
}
