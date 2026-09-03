import { randomUUID } from "node:crypto";
import type { BrainStore, SessionRecord } from "./store.js";

/**
 * B4 — per-session working memory. Accumulates what Aidan learns about the
 * prospect during a live demo, and finalizes into a logged SessionRecord that
 * feeds the aggregate learning signals.
 */
export class SessionMemory {
  id = randomUUID();
  startedAt = new Date().toISOString();
  persona?: string;
  needs: string[] = [];
  shownFeatures: string[] = [];
  qualification: Record<string, string> = {};
  objections: string[] = [];
  kbGaps: string[] = [];
  flowsSuggested: string[] = [];
  /** V1 Intent Rescue: friction points observed while the prospect drove. */
  frictionPoints: string[] = [];
  turns = 0;
  actionFailures = 0;
  journeyFailures: { journey: string; error: string }[] = [];
  transcript: { role: "user" | "assistant"; text: string }[] = [];

  noteUser(text: string) { this.transcript.push({ role: "user", text }); this.turns++; }
  noteAidan(text: string) { this.transcript.push({ role: "assistant", text }); }
  setPersona(id: string) { if (id) this.persona = id; }
  addNeed(n: string) { if (n && !this.needs.includes(n)) this.needs.push(n); }
  addShown(f: string) { if (f && !this.shownFeatures.includes(f)) this.shownFeatures.push(f); }
  setQualification(k: string, v: string) { if (k && v) this.qualification[k] = v; }
  addObjection(o: string) { if (o) this.objections.push(o); }
  addKbGap(q: string) { if (q) this.kbGaps.push(q); }
  addFlow(id: string) { if (id && !this.flowsSuggested.includes(id)) this.flowsSuggested.push(id); }
  addFriction(f: string) { if (f) this.frictionPoints.push(f); }
  incFailure() { this.actionFailures++; }
  addJourneyFailure(journey: string, error: string) {
    this.actionFailures++;
    this.journeyFailures.push({ journey, error });
  }

  /** Compact state injected into every turn's prompt so the demo stays coherent. */
  summary(): string {
    const parts: string[] = [];
    if (this.persona) parts.push(`Inferred persona: ${this.persona}`);
    if (this.needs.length) parts.push(`Stated needs: ${this.needs.join("; ")}`);
    if (this.shownFeatures.length) parts.push(`Already shown: ${this.shownFeatures.join(", ")}`);
    const q = Object.entries(this.qualification);
    if (q.length) parts.push(`Qualification captured: ${q.map(([k, v]) => `${k}=${v}`).join(", ")}`);
    return parts.length ? parts.join("\n") : "(nothing learned yet — ask a light discovery question)";
  }

  async finalize(store: BrainStore): Promise<void> {
    const outcome: SessionRecord["outcome"] =
      Object.keys(this.qualification).length >= 2 ? "qualified" : this.turns >= 2 ? "engaged" : "unknown";
    await store.logSession({
      id: this.id,
      startedAt: this.startedAt,
      endedAt: new Date().toISOString(),
      persona: this.persona,
      needs: this.needs,
      qualification: this.qualification,
      flowsSuggested: this.flowsSuggested,
      objections: this.objections,
      kbGaps: this.kbGaps,
      frictionPoints: this.frictionPoints,
      turns: this.turns,
      actionFailures: this.actionFailures,
      outcome,
      transcript: this.transcript.slice(-40),
    });
  }
}
