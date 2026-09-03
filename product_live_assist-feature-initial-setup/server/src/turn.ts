/**
 * Turn-taking for a spoken demo.
 *
 * Two things make a voice agent feel human, and both live here:
 *   1. BARGE-IN — it stops mid-sentence the moment you start talking.
 *   2. NOT TALKING OVER YOU — it waits, rather than replying into your speech.
 *
 * Also handles ECHO. Once Aidan speaks aloud, the microphone hears Aidan, STT
 * transcribes Aidan, and Aidan answers itself. The original live-assist code had
 * echo suppression for exactly this; it was removed when input was single-speaker
 * and text-only, and TTS makes it necessary again.
 */

export type TurnState = "idle" | "listening" | "thinking" | "speaking";

export interface TurnEvents {
  /** Tell the client to flush its audio queue immediately. */
  stopAudio: () => void;
  /** Cancel in-flight synthesis. */
  cancelSpeech: () => void;
}

const ECHO_WINDOW_MS = 12_000;

function normalise(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !["um", "uh", "er", "ah", "the", "a", "to", "i", "ll", "will", "now", "so"].includes(w))
    .join(" ");
}

/** Cheap similarity — good enough to spot our own voice coming back. */
function similar(a: string, b: string): number {
  const A = new Set(normalise(a).split(" ").filter(Boolean));
  const B = new Set(normalise(b).split(" ").filter(Boolean));
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
}

/** A second yield phrase inside this window is an echo of our own voice, not a person. */
const YIELD_COOLDOWN_MS = Number(process.env.YIELD_COOLDOWN_MS ?? 6000);

export class TurnManager {
  state: TurnState = "idle";
  /**
   * Audio chunks sent to the client but not yet reported as finished.
   *
   * Emission finishing is NOT the same as speaking finishing: cached lines are
   * emitted in milliseconds while the client may still have 40s of audio queued.
   * Treating "emitted" as "done" made barge-in a no-op, because the server
   * believed it was already silent. Playback state lives with the client, so we
   * track outstanding chunks and let it tell us when it's actually quiet.
   */
  audioOutstanding = 0;
  /** True while a verified flow is paused by an interruption. */
  flowPaused = false;
  private spoken: { text: string; at: number }[] = [];
  private lastUserVoiceAt = 0;
  /*
   * Barge-in feedback loop guards.
   *
   * The yield phrase ("Sorry, go ahead.") is itself speech, so emitting it set
   * state="speaking" — which made the very next voiced mic frame look like a
   * fresh interruption, which emitted another yield phrase, forever. Observed
   * live: dozens of "Sorry, go ahead." / "Yes?" bubbles, and because each one
   * also fired stop_audio, the real answer was cut before a word of it played.
   * That single loop produced BOTH the spam and the silence.
   */
  private speakingIsFiller = false;
  private lastYieldAt = 0;

  constructor(private events: TurnEvents) {}

  /** Record what we said, so we can recognise it if the mic hears it back. */
  noteSpoken(text: string): void {
    const now = Date.now();
    this.spoken.push({ text, at: now });
    this.spoken = this.spoken.filter((s) => now - s.at < ECHO_WINDOW_MS).slice(-12);
  }

  beginThinking(): void {
    this.state = "thinking";
  }
  beginSpeaking(): void {
    this.state = "speaking";
  }
  /**
   * One more chunk is in the client's queue.
   * `filler` marks conversational glue (acknowledgements, yields) as opposed to
   * real content — interrupting it is free and must never trigger another yield.
   */
  noteAudioSent(filler = false): void {
    this.audioOutstanding++;
    this.state = "speaking";
    // Any real content clears the filler flag; a filler alone never sets it false.
    this.speakingIsFiller = filler ? this.speakingIsFiller || true : false;
  }
  /** The client reports its queue has drained. */
  noteAudioDrained(): void {
    this.audioOutstanding = 0;
    this.speakingIsFiller = false;
    if (this.state === "speaking") this.state = "listening";
  }
  /** Are we audibly speaking right now (or about to be)? */
  get isSpeaking(): boolean {
    return this.state === "speaking" || this.audioOutstanding > 0;
  }
  finishSpeaking(): void {
    // Only safe to call when nothing is still queued on the client.
    if (this.state === "speaking" && this.audioOutstanding === 0) this.state = "listening";
  }

  /**
   * The user started making voiced sound. Fired from the STT service's FIRST
   * voiced frame — not the final transcript, which lands 1–2s later, by which
   * point a person would already have stopped talking.
   */
  onUserVoice(): { interrupted: boolean; shouldYield: boolean } {
    const now = Date.now();
    this.lastUserVoiceAt = now;
    /*
     * A speech_start is only an energy-VAD candidate. It is useful while audio
     * is actually playing because local playback must stop immediately, but it
     * is not strong enough to cancel an answer that is merely being generated.
     * Room noise repeatedly opened candidates that Whisper later classified as
     * no_speech; cancelling here made the product appear to get stuck. A real
     * final transcript still supersedes the thinking turn in server.ts.
     */
    if (this.isSpeaking) {
      const wasFiller = this.speakingIsFiller;
      this.events.stopAudio();
      this.events.cancelSpeech();
      this.flowPaused = true; // pause a running journey; don't abandon it
      this.audioOutstanding = 0;
      this.speakingIsFiller = false;
      this.state = "listening";
      /*
       * Yield ONCE per interruption episode, and never in response to cutting off
       * our own filler — otherwise the yield phrase re-arms the speaking state and
       * the next mic frame yields again, forever.
       */
      const shouldYield = !wasFiller && now - this.lastYieldAt > YIELD_COOLDOWN_MS;
      if (shouldYield) this.lastYieldAt = now;
      return { interrupted: true, shouldYield };
    }
    if (this.state !== "thinking") this.state = "listening";
    return { interrupted: false, shouldYield: false };
  }

  /**
   * Should this transcript be treated as real user input?
   * Rejects our own voice echoing back through the microphone.
   */
  acceptTranscript(text: string): { accept: boolean; reason?: string } {
    const t = (text || "").trim();
    if (!t) return { accept: false, reason: "empty" };
    if (normalise(t).length < 2) return { accept: false, reason: "too short" };

    const now = Date.now();
    for (const s of this.spoken) {
      if (now - s.at > ECHO_WINDOW_MS) continue;
      const score = similar(t, s.text);
      if (score >= 0.6) return { accept: false, reason: `echo of our own line (${score.toFixed(2)})` };
    }
    return { accept: true };
  }

  /** True if the user has been quiet long enough that it's polite to speak. */
  userQuietFor(ms: number): boolean {
    return Date.now() - this.lastUserVoiceAt >= ms;
  }
}
