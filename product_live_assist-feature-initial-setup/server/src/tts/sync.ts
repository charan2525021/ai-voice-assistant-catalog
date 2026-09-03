/**
 * Audio playback sync.
 *
 * The server knows when it *sent* audio; only the client knows when the audio was
 * actually *heard*. Pacing a walkthrough needs the latter: say "now I'll open the
 * cart", let that finish, then click. Without it the clicks race ahead and the
 * voice narrates a screen that changed three steps ago.
 *
 * Every wait is capped, so a dropped `audio_played` event can slow a demo but can
 * never wedge one.
 */
export class AudioSync {
  private played = 0;
  private waiters: { seq: number; resolve: () => void; timer: NodeJS.Timeout }[] = [];

  /** Client reports one chunk finished playing. */
  notePlayed(seq: number): void {
    if (seq > this.played) this.played = seq;
    for (const w of [...this.waiters]) {
      if (this.played >= w.seq) {
        clearTimeout(w.timer);
        this.waiters = this.waiters.filter((x) => x !== w);
        w.resolve();
      }
    }
  }

  /** Client's queue drained entirely — release everyone. */
  noteDrained(): void {
    for (const w of [...this.waiters]) {
      clearTimeout(w.timer);
      w.resolve();
    }
    this.waiters = [];
  }

  /** Resolve when `seq` has played, or after `capMs` — whichever comes first. */
  waitFor(seq: number | null, capMs = Number(process.env.AUDIO_WAIT_CAP_MS ?? 12_000)): Promise<void> {
    if (seq === null || this.played >= seq) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x.resolve !== resolve);
        resolve(); // never block a demo on a missing event
      }, capMs);
      this.waiters.push({ seq, resolve, timer });
    });
  }

  /** Barge-in: stop waiting on anything. */
  reset(): void {
    this.noteDrained();
    this.played = 0;
  }
}
