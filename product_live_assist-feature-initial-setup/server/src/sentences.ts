/**
 * Cutting a token stream into speakable sentences.
 *
 * This is what turns a 5.6-second wait into a ~1-second one. The agent used to
 * await the model's ENTIRE reply, then synthesise, then play — so the listener
 * heard nothing until every token had arrived. Emitting each sentence the moment
 * it is complete lets speech start while the rest is still being written.
 *
 * Kept separate from the model adapter and the speech engine because both need
 * it and neither owns it: the streaming path splits deltas here, and the
 * non-streaming path splits finished text with the same rules, so a sentence
 * sounds identical however it arrived.
 */

/** Abbreviations that end in a period without ending a sentence. */
const ABBREV = /\b(mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e|approx|inc|ltd|co|no|fig)\.$/i;

/**
 * Is this a real sentence end?
 *
 * Deliberately conservative: splitting too eagerly makes speech choppy and
 * mispronounces decimals ("$29.99" as "twenty-nine dot"), which this codebase
 * has already been bitten by once. A terminator only counts when followed by
 * whitespace and not preceded by a known abbreviation or a digit.
 */
function endsSentence(buf: string, i: number, atStreamEnd = true): boolean {
  const ch = buf[i];
  /*
   * A trailing "." after a digit is AMBIGUOUS until more text arrives.
   *
   * Mid-stream the buffer often ends exactly at "17." because the delta boundary
   * fell there. The decimal guard below cannot fire — there is no "4" to see yet
   * — so the fragment was emitted as a whole sentence and spoken as "seventeen."
   * The rest then arrived as "4 million tokens used." Replies came out as
   * confident nonsense split across two utterances. When more is still coming,
   * wait: flush() will resolve it at the true end of the reply.
   */
  if (!atStreamEnd && ch === "." && i === buf.length - 1 && /\d/.test(buf[i - 1] ?? "")) return false;
  if (ch !== "." && ch !== "!" && ch !== "?" && ch !== "\n") return false;
  if (ch === "\n") return true;
  const next = buf[i + 1];
  // Must be followed by a space or end-of-buffer; "3.5" and "u.s.a" are not ends.
  if (next !== undefined && !/\s/.test(next)) return false;
  if (ch === "." && /\d/.test(buf[i - 1] ?? "") && /\d/.test(buf[i + 2] ?? "")) return false;
  const before = buf.slice(Math.max(0, i - 12), i + 1);
  if (ABBREV.test(before)) return false;
  return true;
}

/**
 * Is this piece worth speaking on its own?
 *
 * A pure length rule was wrong: at 24 characters it held "Want me to show you?"
 * — a complete question — and glued it to whatever came next, delaying every
 * short question in the conversation. Word count is the better signal, because
 * what makes a fragment unspeakable is having too few words, not too few
 * letters. "Hi." waits for its clause; a five-word question goes out at once.
 */
function worthSpeaking(piece: string, minChars: number): boolean {
  if (piece.length >= minChars) return true;
  return piece.split(/\s+/).filter(Boolean).length >= 4;
}

/**
 * Accumulates deltas and yields complete sentences.
 *
 * Short fragments are held back so a stray "Hi." does not become its own
 * synthesis request — each costs a round trip, and a two-word clip followed by a
 * pause sounds worse than waiting for the clause to finish.
 */
export class SentenceStream {
  private buf = "";
  private readonly minChars: number;

  constructor(minChars = 24) {
    this.minChars = minChars;
  }

  /** Feed a token delta; returns any sentences that completed. */
  push(delta: string): string[] {
    if (!delta) return [];
    this.buf += delta;
    const out: string[] = [];
    let start = 0;
    for (let i = 0; i < this.buf.length; i++) {
      if (!endsSentence(this.buf, i, false)) continue;
      const piece = this.buf.slice(start, i + 1).trim();
      if (worthSpeaking(piece, this.minChars)) {
        out.push(piece);
        start = i + 1;
      }
    }
    if (start > 0) this.buf = this.buf.slice(start);
    return out;
  }

  /** Whatever is left when the stream ends — the last sentence usually. */
  flush(): string[] {
    const rest = this.buf.trim();
    this.buf = "";
    return rest ? [rest] : [];
  }
}

/** Split finished text with the same rules, so both paths sound alike. */
export function splitSentences(text: string, minChars = 24): string[] {
  const s = new SentenceStream(minChars);
  return [...s.push(text), ...s.flush()];
}
