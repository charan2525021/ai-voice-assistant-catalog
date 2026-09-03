const ABBREV = /\b(mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e|approx|inc|ltd|co|no|fig)\.$/i;

function endsSentence(buf: string, i: number, atStreamEnd = true): boolean {
  const ch = buf[i];
  if (!atStreamEnd && ch === "." && i === buf.length - 1 && /\d/.test(buf[i - 1] ?? "")) return false;
  if (ch !== "." && ch !== "!" && ch !== "?" && ch !== "\n") return false;
  if (ch === "\n") return true;
  const next = buf[i + 1];
  if (next !== undefined && !/\s/.test(next)) return false;
  if (ch === "." && /\d/.test(buf[i - 1] ?? "") && /\d/.test(buf[i + 2] ?? "")) return false;
  const before = buf.slice(Math.max(0, i - 12), i + 1);
  if (ABBREV.test(before)) return false;
  return true;
}

function worthSpeaking(piece: string, minChars: number): boolean {
  if (piece.length >= minChars) return true;
  return piece.split(/\s+/).filter(Boolean).length >= 4;
}

/** Exact sentence-boundary behavior from the proven streaming model path. */
export class SentenceStream {
  private buf = "";
  constructor(private readonly minChars = 24) {}

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

  flush(): string[] {
    const rest = this.buf.trim();
    this.buf = "";
    return rest ? [rest] : [];
  }
}

export function splitSentences(text: string, minChars = 24): string[] {
  const stream = new SentenceStream(minChars);
  return [...stream.push(text), ...stream.flush()];
}
