export type TurnState = "idle" | "listening" | "thinking" | "speaking";
export interface TurnEvents { stopAudio(): void; cancelSpeech(): void; }

const normalise = (value: string) => (value || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((word) => word && !["um", "uh", "er", "ah", "the", "a", "to", "i", "ll", "will", "now", "so"].includes(word)).join(" ");
const similar = (left: string, right: string) => {
  const a = new Set(normalise(left).split(" ").filter(Boolean));
  const b = new Set(normalise(right).split(" ").filter(Boolean));
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / Math.min(a.size, b.size);
};

export interface TurnManagerConfig { echoWindowMs: number; yieldCooldownMs: number; }

export class TurnManager {
  state: TurnState = "idle";
  audioOutstanding = 0;
  flowPaused = false;
  private spoken: { text: string; at: number }[] = [];
  private lastUserVoiceAt = 0;
  private speakingIsFiller = false;
  private lastYieldAt = 0;
  constructor(private readonly events: TurnEvents, private readonly config: TurnManagerConfig) {}
  noteSpoken(text: string): void {
    const now = Date.now();
    this.spoken.push({ text, at: now });
    this.spoken = this.spoken.filter((item) => now - item.at < this.config.echoWindowMs).slice(-12);
  }
  beginThinking(): void { this.state = "thinking"; }
  beginSpeaking(): void { this.state = "speaking"; }
  noteAudioSent(filler = false): void { this.audioOutstanding++; this.state = "speaking"; this.speakingIsFiller = filler ? this.speakingIsFiller || true : false; }
  noteAudioDrained(): void { this.audioOutstanding = 0; this.speakingIsFiller = false; if (this.state === "speaking") this.state = "listening"; }
  get isSpeaking(): boolean { return this.state === "speaking" || this.audioOutstanding > 0; }
  finishSpeaking(): void { if (this.state === "speaking" && this.audioOutstanding === 0) this.state = "listening"; }
  onUserVoice(): { interrupted: boolean; shouldYield: boolean } {
    const now = Date.now();
    this.lastUserVoiceAt = now;
    if (this.isSpeaking) {
      const wasFiller = this.speakingIsFiller;
      this.events.stopAudio();
      this.events.cancelSpeech();
      this.flowPaused = true;
      this.audioOutstanding = 0;
      this.speakingIsFiller = false;
      this.state = "listening";
      const shouldYield = !wasFiller && now - this.lastYieldAt > this.config.yieldCooldownMs;
      if (shouldYield) this.lastYieldAt = now;
      return { interrupted: true, shouldYield };
    }
    if (this.state !== "thinking") this.state = "listening";
    return { interrupted: false, shouldYield: false };
  }
  acceptTranscript(text: string): { accept: boolean; reason?: string } {
    const transcript = (text || "").trim();
    if (!transcript) return { accept: false, reason: "empty" };
    if (normalise(transcript).length < 2) return { accept: false, reason: "too short" };
    const now = Date.now();
    for (const spoken of this.spoken) if (now - spoken.at <= this.config.echoWindowMs) {
      const score = similar(transcript, spoken.text);
      if (score >= 0.6) return { accept: false, reason: `echo of our own line (${score.toFixed(2)})` };
    }
    return { accept: true };
  }
  userQuietFor(milliseconds: number): boolean { return Date.now() - this.lastUserVoiceAt >= milliseconds; }
}
