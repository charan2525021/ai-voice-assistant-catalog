export class AudioSync {
  private played = 0;
  private waiters: { sequence: number; resolve: () => void; timer: NodeJS.Timeout }[] = [];
  constructor(private readonly waitCapMs: number) {}
  notePlayed(sequence: number): void {
    if (sequence > this.played) this.played = sequence;
    for (const waiter of [...this.waiters]) if (this.played >= waiter.sequence) {
      clearTimeout(waiter.timer);
      this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
      waiter.resolve();
    }
  }
  noteDrained(): void {
    for (const waiter of [...this.waiters]) { clearTimeout(waiter.timer); waiter.resolve(); }
    this.waiters = [];
  }
  waitFor(sequence: number | null): Promise<void> {
    if (sequence === null || this.played >= sequence) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((candidate) => candidate.resolve !== resolve);
        resolve();
      }, this.waitCapMs);
      this.waiters.push({ sequence, resolve, timer });
    });
  }
  reset(): void { this.noteDrained(); this.played = 0; }
}
