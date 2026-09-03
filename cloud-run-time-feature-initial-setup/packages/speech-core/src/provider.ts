export interface VoiceSpec { speaker?: string; language?: string; pace?: number; }
export interface Audio { mime: string; bytes: Buffer; }
export interface TextToSpeechProvider {
  readonly id: "sarvam";
  readonly defaultSpeaker: string;
  readonly maxChars: number;
  synthesize(text: string, voice: VoiceSpec, signal?: AbortSignal): Promise<Audio>;
}

export interface SarvamTtsConfig {
  apiKey: string;
  model: string;
  defaultSpeaker: string;
  defaultLanguage: string;
  maxChars: number;
  timeoutMs: number;
  retryCount: number;
  endpoint?: string;
}

const transient = (message: string) => /429|5\d\d|temporarily|timeout|overloaded|fetch failed|network/i.test(message);

/** The proven Sarvam request and body-aware retry behavior, with injected config. */
export class SarvamTextToSpeechProvider implements TextToSpeechProvider {
  readonly id = "sarvam" as const;
  readonly defaultSpeaker: string;
  readonly maxChars: number;
  constructor(private readonly config: SarvamTtsConfig, private readonly request: typeof fetch = fetch) {
    if (!config.apiKey) throw new Error("SARVAM_API_KEY is required for voice output");
    this.defaultSpeaker = config.defaultSpeaker;
    this.maxChars = config.maxChars;
  }

  async synthesize(text: string, voice: VoiceSpec, signal?: AbortSignal): Promise<Audio> {
    let lastError = "";
    for (let attempt = 0; attempt <= this.config.retryCount; attempt++) {
      try {
        const timeout = AbortSignal.timeout(this.config.timeoutMs);
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const response = await this.request(this.config.endpoint ?? "https://api.sarvam.ai/text-to-speech", {
          method: "POST",
          headers: { "api-subscription-key": this.config.apiKey, "content-type": "application/json" },
          body: JSON.stringify({
            inputs: [text],
            target_language_code: voice.language ?? this.config.defaultLanguage,
            speaker: voice.speaker ?? this.defaultSpeaker,
            model: this.config.model,
            output_audio_codec: "wav",
            ...(voice.pace ? { pace: voice.pace } : {}),
          }),
          signal: combined,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 160)}`);
        const value = await response.json() as { audios?: string[] };
        const encoded = value.audios?.[0];
        if (!encoded) throw new Error("no audio in response");
        const bytes = Buffer.from(encoded, "base64");
        if (bytes.length < 44) throw new Error(`suspiciously small audio (${bytes.length} bytes)`);
        return { mime: "audio/wav", bytes };
      } catch (error) {
        lastError = (error as Error).message;
        if (signal?.aborted || /abort/i.test(lastError)) throw error;
        if (!transient(lastError) || attempt === this.config.retryCount) break;
        await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
      }
    }
    throw new Error(`sarvam tts: ${lastError}`);
  }
}
