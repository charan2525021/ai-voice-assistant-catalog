import { config } from "../config.js";
import { record } from "../telemetry.js";
import { emit } from "../events.js";

/**
 * Text-to-speech providers.
 *
 * Same shape as the model adapter in brain.ts: one interface, swappable
 * implementations, and a hard rule that **a TTS failure must never break the
 * demo** — we degrade to text-only and say so loudly rather than throwing.
 *
 * Verified working with the keys already in aidan/.env:
 *   sarvam  → POST https://api.sarvam.ai/text-to-speech  → base64 WAV
 *   openai  → POST <gateway>/v1/audio/speech             → audio/mpeg
 */

export interface VoiceSpec {
  /** Which engine to use; falls back to the configured default. */
  provider?: "sarvam" | "openai";
  /** Sarvam speaker name (e.g. "anushka") or OpenAI voice (e.g. "alloy"). */
  speaker?: string;
  /** BCP-47-ish code Sarvam expects, e.g. "en-IN". */
  language?: string;
  /** Playback rate hint passed through where supported. */
  pace?: number;
}

export interface Audio {
  mime: string;
  bytes: Buffer;
}

export interface TTSProvider {
  readonly id: string;
  readonly defaultSpeaker: string;
  /** Max characters per request; the engine splits above this. */
  readonly maxChars: number;
  synthesize(text: string, voice: VoiceSpec, signal?: AbortSignal): Promise<Audio>;
}

/** Retry transient failures only — the same body-aware rule as the model adapter. */
async function withRetries<T>(label: string, fn: (attempt: number) => Promise<T>): Promise<T> {
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = (e as Error).message;
      if (/abort/i.test(lastErr)) throw e; // a barge-in cancellation is not a failure
      const transient = /429|5\d\d|temporarily|timeout|overloaded|fetch failed|network/i.test(lastErr);
      if (!transient || attempt === 2) break;
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    }
  }
  throw new Error(`${label}: ${lastErr}`);
}

class SarvamTTS implements TTSProvider {
  readonly id = "sarvam";
  readonly defaultSpeaker = process.env.SARVAM_TTS_SPEAKER ?? "anushka";
  /** Sarvam rejects long inputs; keep requests comfortably short. */
  readonly maxChars = Number(process.env.SARVAM_TTS_MAX_CHARS ?? 450);

  async synthesize(text: string, voice: VoiceSpec, signal?: AbortSignal): Promise<Audio> {
    const key = process.env.SARVAM_API_KEY ?? "";
    if (!key) throw new Error("SARVAM_API_KEY missing");
    return withRetries("sarvam tts", async () => {
      const res = await fetch("https://api.sarvam.ai/text-to-speech", {
        method: "POST",
        headers: { "api-subscription-key": key, "content-type": "application/json" },
        body: JSON.stringify({
          inputs: [text],
          target_language_code: voice.language ?? process.env.SARVAM_TTS_LANGUAGE ?? "en-IN",
          speaker: voice.speaker ?? this.defaultSpeaker,
          ...(voice.pace ? { pace: voice.pace } : {}),
        }),
        signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
      const data: any = await res.json();
      const b64 = data?.audios?.[0];
      if (!b64) throw new Error("no audio in response");
      return { mime: "audio/wav", bytes: Buffer.from(b64, "base64") };
    });
  }
}

class OpenAICompatTTS implements TTSProvider {
  readonly id = "openai";
  readonly defaultSpeaker = process.env.OPENAI_TTS_VOICE ?? "alloy";
  readonly maxChars = Number(process.env.OPENAI_TTS_MAX_CHARS ?? 1500);

  async synthesize(text: string, voice: VoiceSpec, signal?: AbortSignal): Promise<Audio> {
    return withRetries("openai tts", async () => {
      const res = await fetch(`${config.openai.baseUrl.replace(/\/$/, "")}/audio/speech`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.openai.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: process.env.OPENAI_TTS_MODEL ?? "gpt-4o-mini-tts",
          input: text,
          voice: voice.speaker ?? this.defaultSpeaker,
          response_format: "mp3",
        }),
        signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 200) throw new Error(`suspiciously small audio (${buf.length} bytes)`);
      return { mime: "audio/mpeg", bytes: buf };
    });
  }
}

/**
 * Local Kokoro, over the little Python service in `voice/tts_server.py`.
 *
 * This is the default because it is roughly eight times faster than the hosted
 * providers for the same job — measured warm on an M1 Pro: ~520ms for a 3s line
 * against ~4000ms from Sarvam. In a spoken conversation that difference is the
 * gap between answering and appearing to freeze. It also costs nothing per call
 * and needs no API key, which is what makes a self-hosted deployment sane.
 */
class KokoroTTS implements TTSProvider {
  readonly id = "kokoro";
  readonly defaultSpeaker = process.env.KOKORO_VOICE ?? "af_heart";
  // Kokoro handles long inputs, but shorter requests return sooner, and the
  // engine already splits on sentences for streaming.
  readonly maxChars = 400;

  async synthesize(text: string, voice: VoiceSpec, signal?: AbortSignal): Promise<Audio> {
    const url = process.env.TTS_URL ?? "http://127.0.0.1:8091";
    return withRetries("kokoro", async () => {
      const res = await fetch(`${url}/speak`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text,
          voice: voice.speaker ?? this.defaultSpeaker,
          speed: Number(voice.pace ?? 1) || 1,
        }),
        signal,
      });
      if (!res.ok) throw new Error(`kokoro ${res.status}: ${(await res.text()).slice(0, 160)}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error("kokoro returned empty audio");
      return { bytes: buf, mime: "audio/wav" };
    });
  }
}

const providers: Record<string, TTSProvider> = {
  kokoro: new KokoroTTS(),
  sarvam: new SarvamTTS(),
  openai: new OpenAICompatTTS(),
};

export const ttsEnabled = () => (process.env.TTS ?? "on") !== "off";

export function providerFor(voice: VoiceSpec = {}): TTSProvider {
  // Local-first: fastest, free, and no key required. A product can still pin a
  // hosted voice in its manifest.
  const want = voice.provider ?? process.env.TTS_PROVIDER ?? "kokoro";
  return providers[want] ?? providers.kokoro;
}

/** Synthesize one chunk, recording cost/latency like every other model call. */
export async function synthesizeChunk(text: string, voice: VoiceSpec, signal?: AbortSignal): Promise<Audio> {
  const p = providerFor(voice);
  const started = Date.now();
  /*
   * Record failures too. The success-only version reported "16 syntheses, 0
   * errors" for a run whose log clearly showed a provider 400 — so voice
   * reliability was unmeasurable, which is the same blind spot model calls had.
   */
  try {
    const audio = await p.synthesize(text, voice, signal);
    const ttsMs = Date.now() - started;
    record({ purpose: "tts", ms: ttsMs, inTokens: text.length, outTokens: 0, images: 0 });
    emit("tts.synth", { status: "ok", ms: ttsMs, data: { chars: text.length, provider: p.id } });
    return audio;
  } catch (e) {
    const ttsMs = Date.now() - started;
    record({ purpose: "tts", ms: ttsMs, inTokens: text.length, outTokens: 0, images: 0 });
    emit("tts.synth", {
      status: "error",
      ms: ttsMs,
      error: (e as Error).message,
      // The text itself is the usual culprit (a line of only digits or symbols
      // trips Sarvam's language validation), so keep a short sample.
      data: { chars: text.length, provider: p.id, sample: text.slice(0, 80) },
    });
    throw e;
  }
}
