import type { RuntimeConfig } from "../config.js";
import type { SpeechToTextProvider } from "../contracts.js";
import { makeModelClient, type ModelClient } from "@sable/model-client";
import { SarvamTextToSpeechProvider, type TextToSpeechProvider } from "@sable/speech-core";
import { SarvamSidecarSpeechToTextProvider } from "./sarvam-stt-sidecar.js";

export interface Providers { model: ModelClient; stt: SpeechToTextProvider; tts: TextToSpeechProvider; embedQuery?: (text: string) => Promise<number[] | undefined>; }

export function createProviders(config: RuntimeConfig): Providers {
  if (config.providers.reasoning === "anthropic" && !config.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is required when REASONING_PROVIDER=anthropic");
  if (config.providers.reasoning === "openai_compatible" && !config.openAiCompatibleApiKey) throw new Error("OPENAI_COMPATIBLE_API_KEY is required when REASONING_PROVIDER=openai_compatible");
  if (!config.sarvamApiKey) throw new Error("SARVAM_API_KEY is required for Sarvam STT and TTS");
  const model = makeModelClient(config.providers.reasoning === "anthropic" ? {
    provider: "anthropic",
    apiKey: config.anthropicApiKey ?? "",
    model: config.reasoning.model,
    maxTokens: config.reasoning.maxTokens,
    timeoutMs: config.reasoning.timeoutMs,
    retries: config.reasoning.retries,
  } : {
    provider: "openai_compatible",
    apiKey: config.openAiCompatibleApiKey ?? "",
    baseUrl: config.openAiCompatibleBaseUrl,
    model: config.reasoning.model,
    maxTokens: config.reasoning.maxTokens,
    timeoutMs: config.reasoning.timeoutMs,
    retries: config.reasoning.retries,
    reasoningEffort: config.reasoning.reasoningEffort,
  });
  const tts = new SarvamTextToSpeechProvider({
    apiKey: config.sarvamApiKey ?? "",
    model: config.voice.ttsModel,
    defaultSpeaker: config.voice.speaker,
    defaultLanguage: config.voice.languageCode,
    maxChars: 450,
    timeoutMs: config.voice.ttsTimeoutMs,
    retryCount: config.voice.ttsRetryCount,
  });
  return { model, stt: new SarvamSidecarSpeechToTextProvider(config), tts };
}
