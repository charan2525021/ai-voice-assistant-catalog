import type { NarrationAudioCache } from "./cache.js";
import { narrationCacheKey } from "./cache.js";
import type { TextToSpeechProvider, VoiceSpec } from "./provider.js";

export type SpeechPurpose = "answer" | "acknowledgement" | "journey_step" | "result" | "demo";
export interface SpeechContext { utteranceId: string; turnId: string; purpose: SpeechPurpose; journeyId?: string; stepId?: string; }
export interface AudioOut extends SpeechContext { sequence: number; mime: string; base64Audio: string; text: string; gapMs: number; }

export function splitForSpeech(text: string, maxChars: number): string[] {
  const clean = text
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\*+|_{2,}|`+|#+/g, " ")
    .replace(/\b[a-z0-9]+(?:-[a-z0-9]+){1,}\b/gi, (match) => match.replace(/-/g, " "))
    .replace(/([a-z]):\s(?=[A-Z])/g, "$1, ")
    .replace(/\s*\/\s*/g, " or ")
    .replace(/&/g, " and ")
    .replace(/\$\s?(\d+)\.(\d{2})\b/g, "$1 dollars $2 cents")
    .replace(/\$\s?(\d+)\b/g, "$1 dollars")
    .replace(/[\"“”'’]/g, "")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/([.,!?;:])\1+/g, "$1")
    .replace(/^[\s.,;:—–-]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return [];
  const sentences = clean.replace(/(?<=\d)\.(?=\d)/g, "\u0000").match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)?.map((value) => value.replace(/\u0000/g, ".").trim()).filter(Boolean) ?? [clean];
  const output: string[] = [];
  let buffer = "";
  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      if (buffer) { output.push(buffer); buffer = ""; }
      for (let i = 0; i < sentence.length; i += maxChars) output.push(sentence.slice(i, i + maxChars));
      continue;
    }
    if ((`${buffer} ${sentence}`).trim().length <= maxChars && buffer.length < 120) buffer = buffer ? `${buffer} ${sentence}` : sentence;
    else { if (buffer) output.push(buffer); buffer = sentence; }
  }
  if (buffer) output.push(buffer);
  return output;
}

const isQuestion = (text: string) => /[?？]\s*$/.test(text.trim());

export interface SpeechEngineConfig { betweenSentencesMs: number; afterQuestionMs: number; }

export class SpeechEngine {
  private sequence = 0;
  private controller: AbortController | undefined;
  private generation = 0;
  private synthesisQueue: Promise<void> = Promise.resolve();
  constructor(
    private readonly productId: string,
    private readonly voice: VoiceSpec,
    private readonly provider: TextToSpeechProvider,
    private readonly emit: (audio: AudioOut) => void,
    private readonly config: SpeechEngineConfig,
    private readonly narrationCache?: NarrationAudioCache,
  ) {}

  say(text: string, context: SpeechContext, options: { cache?: "catalog"; onFirstAudio?: () => void } = {}): Promise<number | null> {
    const chunks = splitForSpeech(text, this.provider.maxChars);
    if (!chunks.length) return Promise.resolve(null);
    const generation = this.generation;
    this.controller ??= new AbortController();
    const signal = this.controller.signal;
    const sequences = chunks.map(() => ++this.sequence);
    const run = async (): Promise<number | null> => {
      for (let index = 0; index < chunks.length; index++) {
        const chunk = chunks[index];
        if (generation !== this.generation || signal.aborted) return null;
        try {
          let audio;
          const key = narrationCacheKey(chunk, this.voice, this.provider);
          if (options.cache === "catalog") audio = await this.narrationCache?.get(this.productId, key);
          if (!audio) {
            audio = await this.provider.synthesize(chunk, this.voice, signal);
            if (options.cache === "catalog") await this.narrationCache?.put(this.productId, key, audio).catch(() => undefined);
          }
          if (generation !== this.generation || signal.aborted) return null;
          const last = index === chunks.length - 1;
          this.emit({ ...context, sequence: sequences[index], mime: audio.mime, base64Audio: audio.bytes.toString("base64"), text: chunk, gapMs: last && isQuestion(chunk) ? this.config.afterQuestionMs : this.config.betweenSentencesMs });
          if (index === 0) options.onFirstAudio?.();
        } catch (error) {
          if (signal.aborted) return null;
          throw error;
        }
      }
      return sequences[sequences.length - 1];
    };
    const scheduled = this.synthesisQueue.catch(() => undefined).then(run);
    this.synthesisQueue = scheduled.then(() => undefined, () => undefined);
    return scheduled;
  }

  prefetch(lines: string[]): void {
    const cache = this.narrationCache;
    if (!cache) return;
    void (async () => {
      for (const line of lines) for (const chunk of splitForSpeech(line, this.provider.maxChars)) {
        const key = narrationCacheKey(chunk, this.voice, this.provider);
        if (await cache.get(this.productId, key)) continue;
        try { await cache.put(this.productId, key, await this.provider.synthesize(chunk, this.voice)); }
        catch { /* best-effort prefetch; live narration can retry later */ }
      }
    })();
  }

  interrupt(): void {
    this.generation++;
    this.controller?.abort();
    this.controller = undefined;
    // New speech after a barge-in must not wait behind the cancelled provider
    // call. The generation guard prevents the abandoned queue from emitting.
    this.synthesisQueue = Promise.resolve();
  }
}
