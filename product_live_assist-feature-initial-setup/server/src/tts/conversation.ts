import type { VoiceConfig } from "../products.js";

/**
 * Conversational texture — the difference between "a voice reads output" and
 * "someone is talking to me".
 *
 * Three things a person does that a naive TTS loop doesn't:
 *  1. ACKNOWLEDGE instantly. You get "sure —" in 200 ms, long before the answer.
 *     Our model takes 15–20 s to think; without a filler that's dead air.
 *  2. BREATHE. Sentences don't butt against each other, and a question is followed
 *     by a longer gap because the speaker is waiting for you.
 *  3. RECONNECT after an interruption ("right, where were we") instead of silently
 *     resuming mid-sentence.
 *
 * Nothing here is hardcoded into behaviour: every phrase set and every duration has
 * a default but can be overridden per product in `content/<id>/product.json → voice`,
 * so a different product (or language) can sound completely different without code
 * changes. Phrase sets are pre-synthesised at onboarding, so they cost nothing and
 * play instantly.
 */

export interface Phrases {
  /** Played the instant a voice turn starts, so there is no dead air while thinking. */
  acknowledge: string[];
  /** Said when picking a paused walkthrough back up. */
  reconnect: string[];
  /** Said when the user cuts in, before answering them. */
  interrupted: string[];
}

const DEFAULT_PHRASES: Phrases = {
  /*
   * Deliberately EMPTY. These were spoken before the model had seen the message,
   * so they landed on anything at all — including "that's wrong" — and sounded
   * like an agent reacting without listening. Kept as a category so a product can
   * opt back in via its own phrases file, but nothing ships by default.
   */
  acknowledge: [],
  reconnect: ["Right, where were we.", "Okay, picking up where we left off.", "So, back to it."],
  interrupted: ["Sorry, go ahead.", "Yes?"],
};

export interface Pacing {
  /** Gap between consecutive spoken chunks — stops sentences butting together. */
  betweenSentencesMs: number;
  /** Extra beat after a line that ends in a question, so the user can answer. */
  afterQuestionMs: number;
  /** Beat between finishing a line and performing the action it described. */
  beforeActionMs: number;
}

const DEFAULT_PACING: Pacing = {
  betweenSentencesMs: Number(process.env.PAUSE_BETWEEN_SENTENCES_MS ?? 280),
  afterQuestionMs: Number(process.env.PAUSE_AFTER_QUESTION_MS ?? 900),
  beforeActionMs: Number(process.env.PAUSE_BEFORE_ACTION_MS ?? 220),
};

export function phrasesFor(voice: VoiceConfig | undefined): Phrases {
  const p = (voice as any)?.phrases ?? {};
  return {
    acknowledge: p.acknowledge?.length ? p.acknowledge : DEFAULT_PHRASES.acknowledge,
    reconnect: p.reconnect?.length ? p.reconnect : DEFAULT_PHRASES.reconnect,
    interrupted: p.interrupted?.length ? p.interrupted : DEFAULT_PHRASES.interrupted,
  };
}

export function pacingFor(voice: VoiceConfig | undefined): Pacing {
  const p = (voice as any)?.pacing ?? {};
  return {
    betweenSentencesMs: p.betweenSentencesMs ?? DEFAULT_PACING.betweenSentencesMs,
    afterQuestionMs: p.afterQuestionMs ?? DEFAULT_PACING.afterQuestionMs,
    beforeActionMs: p.beforeActionMs ?? DEFAULT_PACING.beforeActionMs,
  };
}

/** Every phrase for a product — used to pre-warm the cache at onboarding. */
export function allPhrases(voice: VoiceConfig | undefined): string[] {
  const p = phrasesFor(voice);
  return [...p.acknowledge, ...p.reconnect, ...p.interrupted];
}

/**
 * Rotate rather than repeat. Hearing the same "Sure." every single turn is worse
 * than silence, so avoid the phrase used last time.
 */
export class PhrasePicker {
  private lastIndex = new Map<string, number>();
  pick(kind: keyof Phrases, phrases: Phrases): string {
    const list = phrases[kind];
    if (!list.length) return "";
    if (list.length === 1) return list[0];
    const last = this.lastIndex.get(kind);
    let i = Math.floor(Math.random() * list.length);
    if (i === last) i = (i + 1) % list.length;
    this.lastIndex.set(kind, i);
    return list[i];
  }
}

/** A line ending in a question wants a longer gap after it. */
export const isQuestion = (text: string) => /[?？]\s*$/.test(text.trim());
