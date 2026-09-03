import WebSocket from "ws";
import type { RuntimeConfig } from "../config.js";
import type { SpeechToTextProvider, SpeechToTextSession } from "../contracts.js";

interface SidecarEvent {
  type?: "ready" | "speech_start" | "partial" | "transcript" | "no_speech" | "error";
  text?: string;
  reason?: string;
  timing?: Record<string, number | null>;
}

/**
 * Thin private gateway to the proven Python Sarvam service. Audio processing,
 * VAD, pre-roll, transcript merging and finalization stay in the Python code.
 */
export class SarvamSidecarSpeechToTextProvider implements SpeechToTextProvider {
  private readonly url: URL;
  constructor(private readonly config: RuntimeConfig) {
    this.url = new URL(config.voice.sttSidecarUrl);
    if (this.url.protocol !== "ws:") throw new Error("VOICE_STT_SIDECAR_URL must use private ws:// transport");
    if (!["127.0.0.1", "localhost", "::1", "sable-stt"].includes(this.url.hostname)) {
      throw new Error("VOICE_STT_SIDECAR_URL must point to the private local STT service");
    }
  }

  async open(options: Parameters<SpeechToTextProvider["open"]>[0]): Promise<SpeechToTextSession> {
    const socket = new WebSocket(this.url);
    let ready = false;
    let closed = false;
    let settleReady: (() => void) | undefined;
    let rejectReady: ((error: Error) => void) | undefined;
    const readyPromise = new Promise<void>((resolve, reject) => { settleReady = resolve; rejectReady = reject; });
    const timer = setTimeout(() => rejectReady?.(new Error("Sarvam STT sidecar did not become ready")), Math.max(3_000, this.config.voice.asrGraceMs + 2_000));
    socket.on("open", () => {
      if (options.vocabulary) socket.send(JSON.stringify({ type: "vocabulary", terms: options.vocabulary.slice(0, 400) }));
    });
    socket.on("message", (raw) => {
      let event: SidecarEvent;
      try { event = JSON.parse(raw.toString()) as SidecarEvent; }
      catch { return; }
      if (event.type === "ready") { ready = true; clearTimeout(timer); settleReady?.(); }
      else if (event.type === "speech_start") options.onSpeechStart();
      else if (event.type === "partial" && event.text) options.onPartial(event.text);
      else if (event.type === "transcript" && event.text) options.onFinal(event.text, event.timing);
      else if (event.type === "no_speech") options.onNoSpeech(event.reason);
      else if (event.type === "error") options.onError(new Error(event.text || "Sarvam STT sidecar failed"));
    });
    socket.on("error", (error) => {
      if (!ready) { clearTimeout(timer); rejectReady?.(error); }
      else options.onError(error);
    });
    socket.on("close", () => {
      closed = true;
      if (!ready) { clearTimeout(timer); rejectReady?.(new Error("Sarvam STT sidecar closed before it was ready")); }
    });
    await readyPromise;
    return {
      push(pcm16) { if (!closed && socket.readyState === WebSocket.OPEN) socket.send(pcm16, { binary: true }); },
      finish() { if (!closed && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "flush" })); },
      cancel() { if (!closed) socket.close(1000, "voice cancelled"); closed = true; },
    };
  }
}
