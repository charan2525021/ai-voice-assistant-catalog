import { cacheKey, cacheStats, readCache, writeCache } from "./cache.js";
import { providerFor, synthesizeChunk, ttsEnabled, type VoiceSpec } from "./provider.js";
import { isQuestion } from "./conversation.js";

/**
 * Per-session speech engine.
 *
 * Responsibilities:
 *  - split a reply into sentences so the FIRST one can start playing while the
 *    rest is still being synthesised (time-to-first-audio is what the ear judges)
 *  - serve from the content-addressed cache whenever possible (all journey
 *    narration is pre-synthesised at onboarding, so it is free at demo time)
 *  - keep audio strictly ORDERED per session via a monotonic seq
 *  - cancel everything instantly on barge-in
 *
 * A synthesis failure is never fatal: we log it and the line still reaches the
 * user as text. Voice is an enhancement, not a dependency.
 */

export interface AudioOut {
  seq: number;
  mime: string;
  b64: string;
  text: string;
  /** Silence to leave AFTER this chunk, so speech breathes like a person. */
  gapMs?: number;
}

/** Split into speakable chunks: sentence-ish, then hard-wrapped to the provider limit. */
export function splitForSpeech(text: string, maxChars: number): string[] {
  /*
   * Make it speakable. Anything written for the eye gets read aloud literally and
   * instantly breaks the illusion — brackets, asterisks, slug-style UI ids
   * ("product-sort-container"), and symbols the engine spells out.
   */
  const clean = text
    .replace(/\[[^\]]*\]/g, " ")                      // [Docs: X] and friends
    .replace(/\*+|_{2,}|`+|#+/g, " ")                  // markdown
    .replace(/\b[a-z0-9]+(?:-[a-z0-9]+){1,}\b/gi, (m) => m.replace(/-/g, " ")) // slug ids → words
    .replace(/([a-z]):\s(?=[A-Z])/g, "$1, ")           // "Checkout: Overview" → "Checkout, Overview"
    .replace(/\s*\/\s*/g, " or ")                      // "Zip/Postal" → "Zip or Postal"
    .replace(/&/g, " and ")
    .replace(/\$\s?(\d+)\.(\d{2})\b/g, "$1 dollars $2 cents")  // "$29.99" → spoken money
    .replace(/\$\s?(\d+)\b/g, "$1 dollars")
    .replace(/["""'']/g, "")
    .replace(/\s+([.,!?;:])/g, "$1")   // no dangling punctuation after a strip
    .replace(/([.,!?;:])\1+/g, "$1")
    .replace(/^[\s.,;:—–-]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return [];

  /*
   * Split on sentence ends only. A naive /[.!?]/ split breaks "$29.99" into
   * "$29." + "99", which a TTS engine reads aloud as "twenty-nine dot".
   * Require the terminator to be followed by whitespace/end, and never split a
   * period that sits between two digits.
   */
  const sentences =
    clean
      .replace(/(?<=\d)\.(?=\d)/g, "\u0000") // protect decimals
      .match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)
      ?.map((x) => x.replace(/\u0000/g, ".").trim())
      .filter(Boolean) ?? [clean];
  const out: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if (s.length > maxChars) {
      if (buf) { out.push(buf); buf = ""; }
      for (let i = 0; i < s.length; i += maxChars) out.push(s.slice(i, i + maxChars));
      continue;
    }
    // Merge very short sentences so we don't pay a round-trip for "Sure."
    if ((buf + " " + s).trim().length <= maxChars && buf.length < 120) buf = (buf ? buf + " " : "") + s;
    else { if (buf) out.push(buf); buf = s; }
  }
  if (buf) out.push(buf);
  return out;
}

export class SpeechEngine {
  private seq = 0;
  private controller: AbortController | null = null;
  /** Bumped on every barge-in; audio from an older generation is discarded. */
  private generation = 0;

  constructor(
    private product: string,
    private voice: VoiceSpec,
    private emit: (a: AudioOut) => void,
    /** Pacing gaps; supplied per product so timing isn't baked into code. */
    private gaps: { betweenSentencesMs: number; afterQuestionMs: number } = { betweenSentencesMs: 280, afterQuestionMs: 900 },
  ) {}

  get stats() {
    return cacheStats();
  }

  /**
   * Speak one line. Resolves when all its audio has been EMITTED (not played) —
   * playback completion is reported by the client, which owns the queue.
   */
  async say(text: string, onFirstAudio?: () => void): Promise<number | null> {
    if (!ttsEnabled()) return null;
    const provider = providerFor(this.voice);
    const chunks = splitForSpeech(text, provider.maxChars);
    if (!chunks.length) return null;

    const myGen = this.generation;
    this.controller ??= new AbortController();
    const signal = this.controller.signal;

    /*
     * RESERVE the sequence numbers NOW, before synthesising.
     *
     * Assigning seq at emit time made audio play in the order synthesis
     * *finished*, not the order it was *said*: a cached step line returns in 0ms
     * while the preceding dynamic line takes ~4s, so the intro spoke AFTER the
     * steps it was introducing. The client plays strictly by seq, so reserving up
     * front keeps speech in the order a human would say it.
     */
    const seqs = chunks.map(() => ++this.seq);
    const lastSeq = seqs[seqs.length - 1];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (myGen !== this.generation || signal.aborted) return null; // interrupted
      const key = cacheKey(chunk, this.voice);
      try {
        let audio = await readCache(this.product, key);
        if (!audio) {
          audio = await synthesizeChunk(chunk, this.voice, signal);
          await writeCache(this.product, key, audio).catch(() => {});
        }
        if (myGen !== this.generation) return null; // barge-in landed while we waited
        const last = i === chunks.length - 1;
        this.emit({
          seq: seqs[i],
          mime: audio.mime,
          b64: audio.bytes.toString("base64"),
          text: chunk,
          // A question gets a longer trailing pause: the speaker is waiting for you.
          gapMs: last && isQuestion(chunk) ? this.gaps.afterQuestionMs : this.gaps.betweenSentencesMs,
        });
        if (i === 0) onFirstAudio?.(); // release the transcript alongside the audio
      } catch (e) {
        // Degrade to text-only for this line, and SAY SO — a silent catch here
        // would look like a mysteriously mute agent.
        console.warn(`[tts] could not speak "${chunk.slice(0, 40)}…": ${(e as Error).message}`);
        return null;
      }
    }
    return lastSeq;
  }

  /** Warm the cache for lines we know are coming (next journey step, etc). */
  prefetch(lines: string[]): void {
    if (!ttsEnabled()) return;
    const provider = providerFor(this.voice);
    void (async () => {
      for (const line of lines) {
        for (const chunk of splitForSpeech(line, provider.maxChars)) {
          const key = cacheKey(chunk, this.voice);
          if (await readCache(this.product, key)) continue;
          try {
            const audio = await synthesizeChunk(chunk, this.voice);
            await writeCache(this.product, key, audio);
          } catch {
            /* prefetch is best-effort */
          }
        }
      }
    })();
  }

  /** Barge-in: abandon everything in flight and ignore late arrivals. */
  interrupt(): void {
    this.generation++;
    this.controller?.abort();
    this.controller = null;
  }
}
