export type RuntimeStoreKind = "file" | "postgres";
export type SpeakMode = "voice_turns" | "all" | "off";
export type ReasoningProviderKind = "anthropic" | "openai_compatible";

const firstNonEmpty = (...values: Array<string | undefined>): string | undefined => values.find((value) => value?.trim())?.trim();

const numberValue = (env: NodeJS.ProcessEnv, key: string, fallback: number, minimum: number, maximum: number): number => {
  const raw = env[key];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${key} must be a number`);
  return Math.max(minimum, Math.min(maximum, value));
};

const booleanValue = (env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean => {
  const raw = env[key];
  if (raw === undefined) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${key} must be true or false`);
};

const enumValue = <T extends string>(env: NodeJS.ProcessEnv, key: string, values: readonly T[], fallback: T): T => {
  const value = (env[key] ?? fallback) as T;
  if (!values.includes(value)) throw new Error(`${key} must be one of: ${values.join(", ")}`);
  return value;
};

export interface RuntimeConfig {
  port: number;
  publicApiUrl: string;
  runtimeStore: RuntimeStoreKind;
  runtimeFile: string;
  databaseUrl?: string;
  tokenSigningSecret: string;
  providers: { reasoning: ReasoningProviderKind; stt: "sarvam"; tts: "sarvam" };
  reasoning: { model: string; maxTokens: number; timeoutMs: number; retries: number; maxHistory: number; maxUserMessage: number; maxConcurrentTurns: number; reasoningEffort?: string };
  retrieval: { chunks: number; deadlineMs: number; observationTimeoutMs: number; maximumVisibleTextChars: number; maximumControls: number };
  session: { identityTtlMs: number; sessionTtlMs: number; ticketTtlMs: number; idleTimeoutMs: number; reconnectGraceMs: number; turnRatePerMinute: number; maximumAudioBytes: number };
  voice: {
    languageCode: string;
    speaker: string;
    sttModel: string;
    ttsModel: string;
    sttSidecarUrl: string;
    silenceTimeoutMs: number;
    minimumSpeechMs: number;
    maximumUtteranceMs: number;
    audioFrameMs: number;
    vadThreshold: number;
    asrGraceMs: number;
    ttsTimeoutMs: number;
    audioWaitCapMs: number;
    betweenSentencesMs: number;
    afterQuestionMs: number;
    ttsRetryCount: number;
    speakMode: SpeakMode;
    bargeIn: boolean;
    stepNarration: boolean;
    autoStop: boolean;
  };
  anthropicApiKey?: string;
  openAiCompatibleApiKey?: string;
  openAiCompatibleBaseUrl: string;
  sarvamApiKey?: string;
  adminApiKey?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const reasoningProvider = enumValue(env, "REASONING_PROVIDER", ["anthropic", "openai_compatible"] as const, "anthropic");
  const sttProvider = enumValue(env, "STT_PROVIDER", ["sarvam"] as const, "sarvam");
  const ttsProvider = enumValue(env, "TTS_PROVIDER", ["sarvam"] as const, "sarvam");
  const runtimeStore = enumValue(env, "RUNTIME_STORE", ["file", "postgres"] as const, "file");
  const secret = env.TOKEN_SIGNING_SECRET ?? "development-only-change-this-secret-now";
  if (secret.length < 32) throw new Error("TOKEN_SIGNING_SECRET must be at least 32 characters");
  if (runtimeStore === "postgres" && !env.DATABASE_URL) throw new Error("DATABASE_URL is required when RUNTIME_STORE=postgres");
  return {
    port: numberValue(env, "PORT", 8787, 1, 65_535),
    publicApiUrl: (env.PUBLIC_API_URL ?? "http://localhost:8787").replace(/\/$/, ""),
    runtimeStore,
    runtimeFile: env.RUNTIME_FILE ?? "./data/sample-runtime.json",
    databaseUrl: env.DATABASE_URL,
    tokenSigningSecret: secret,
    providers: { reasoning: reasoningProvider, stt: sttProvider, tts: ttsProvider },
    reasoning: {
      model: firstNonEmpty(env.REASONING_MODEL, reasoningProvider === "anthropic" ? env.ANTHROPIC_MODEL : env.OPENAI_COMPATIBLE_MODEL) ?? (reasoningProvider === "anthropic" ? "claude-sonnet-4-5" : "gpt-4o"),
      maxTokens: numberValue(env, "REASONING_MAX_TOKENS", 1200, 128, 8192),
      timeoutMs: numberValue(env, "REASONING_TIMEOUT_MS", 20_000, 1_000, 60_000),
      retries: numberValue(env, "REASONING_RETRIES", 1, 0, 3),
      maxHistory: numberValue(env, "REASONING_MAX_HISTORY", 12, 0, 40),
      maxUserMessage: numberValue(env, "REASONING_MAX_USER_MESSAGE_CHARS", 4_000, 100, 20_000),
      maxConcurrentTurns: numberValue(env, "REASONING_MAX_CONCURRENT_TURNS", 1, 1, 4),
      reasoningEffort: firstNonEmpty(env.MODEL_REASONING_EFFORT),
    },
    retrieval: {
      chunks: numberValue(env, "RETRIEVAL_CHUNKS", 6, 1, 20),
      deadlineMs: numberValue(env, "RETRIEVAL_DEADLINE_MS", 1_500, 100, 10_000),
      observationTimeoutMs: numberValue(env, "OBSERVATION_TIMEOUT_MS", 5_000, 1_000, 15_000),
      maximumVisibleTextChars: numberValue(env, "OBSERVATION_MAX_TEXT_CHARS", 25_000, 1_000, 25_000),
      maximumControls: numberValue(env, "OBSERVATION_MAX_CONTROLS", 5_000, 100, 5_000),
    },
    session: {
      identityTtlMs: numberValue(env, "IDENTITY_TOKEN_TTL_MS", 60_000, 30_000, 300_000),
      sessionTtlMs: numberValue(env, "SDK_SESSION_TTL_MS", 3_600_000, 300_000, 28_800_000),
      ticketTtlMs: numberValue(env, "SOCKET_TICKET_TTL_MS", 30_000, 5_000, 120_000),
      idleTimeoutMs: numberValue(env, "IDLE_SESSION_TIMEOUT_MS", 900_000, 60_000, 3_600_000),
      reconnectGraceMs: numberValue(env, "RECONNECT_GRACE_MS", 15_000, 0, 120_000),
      turnRatePerMinute: numberValue(env, "TURN_RATE_PER_MINUTE", 20, 1, 120),
      maximumAudioBytes: numberValue(env, "VOICE_MAX_AUDIO_BYTES", 3_840_000, 160_000, 15_360_000),
    },
    voice: {
      languageCode: env.VOICE_LANGUAGE_CODE ?? "en-IN",
      speaker: env.VOICE_SPEAKER ?? "shubh",
      sttModel: env.SARVAM_STT_MODEL ?? "saaras:v3",
      ttsModel: env.SARVAM_TTS_MODEL ?? "bulbul:v3",
      sttSidecarUrl: env.VOICE_STT_SIDECAR_URL ?? "ws://127.0.0.1:8089",
      silenceTimeoutMs: numberValue(env, "VOICE_SILENCE_TIMEOUT_MS", 800, 300, 3_000),
      minimumSpeechMs: numberValue(env, "VOICE_MIN_SPEECH_MS", 250, 100, 2_000),
      maximumUtteranceMs: numberValue(env, "VOICE_MAX_UTTERANCE_MS", 20_000, 5_000, 120_000),
      audioFrameMs: numberValue(env, "VOICE_AUDIO_FRAME_MS", 40, 20, 100),
      vadThreshold: numberValue(env, "VOICE_VAD_THRESHOLD", 0.02, 0.001, 0.5),
      asrGraceMs: numberValue(env, "VOICE_ASR_GRACE_MS", 2_500, 500, 10_000),
      ttsTimeoutMs: numberValue(env, "VOICE_TTS_TIMEOUT_MS", 8_000, 2_000, 20_000),
      audioWaitCapMs: numberValue(env, "VOICE_AUDIO_WAIT_CAP_MS", 12_000, 1_000, 30_000),
      betweenSentencesMs: numberValue(env, "VOICE_BETWEEN_SENTENCES_MS", 280, 0, 2_000),
      afterQuestionMs: numberValue(env, "VOICE_AFTER_QUESTION_MS", 900, 0, 4_000),
      ttsRetryCount: numberValue(env, "TTS_RETRY_COUNT", 2, 0, 5),
      speakMode: enumValue(env, "VOICE_SPEAK_MODE", ["voice_turns", "all", "off"] as const, "voice_turns"),
      bargeIn: booleanValue(env, "VOICE_BARGE_IN", true),
      stepNarration: booleanValue(env, "VOICE_STEP_NARRATION", true),
      autoStop: booleanValue(env, "VOICE_AUTO_STOP", true),
    },
    anthropicApiKey: firstNonEmpty(env.ANTHROPIC_API_KEY),
    openAiCompatibleApiKey: firstNonEmpty(env.OPENAI_COMPATIBLE_API_KEY),
    openAiCompatibleBaseUrl: (firstNonEmpty(env.OPENAI_COMPATIBLE_BASE_URL) ?? "https://api.openai.com/v1").replace(/\/$/, ""),
    sarvamApiKey: firstNonEmpty(env.SARVAM_API_KEY),
    adminApiKey: firstNonEmpty(env.ADMIN_API_KEY),
  };
}
