import { randomUUID } from "node:crypto";
import type { SalesPlay, SalesPlayKind } from "../domain/catalog.js";
import type { TenantContext } from "../domain/context.js";
import type { CatalogRepository } from "../storage/contracts.js";
import { makeBrain, type Brain, type NMessage } from "../brain.js";

export interface TrainingMoment {
  transcript: string;
  journeyKey?: string;
  capabilityId?: string;
  personaKeys: string[];
  screenEvidence?: string;
}

export interface ExtractedPlay {
  kind: SalesPlayKind;
  title: string;
  content: string;
  journeyKeys: string[];
  capabilityIds: string[];
  personaKeys: string[];
  signalKeywords: string[];
}

export interface SalesPlayExtractor {
  extract(moments: TrainingMoment[], signal?: AbortSignal): Promise<ExtractedPlay[]>;
}

const KINDS = new Set<SalesPlayKind>(["discovery", "value_proposition", "objection", "proof_moment", "next_best_action", "positioning"]);

/** Provider-neutral extractor. Its output is deliberately draft-only. */
export class LlmSalesPlayExtractor implements SalesPlayExtractor {
  constructor(private readonly model: Brain = makeBrain("planner")) {}
  async extract(moments: TrainingMoment[], signal?: AbortSignal): Promise<ExtractedPlay[]> {
    if (signal?.aborted) throw new Error("sales training interrupted");
    const system = `Extract reusable sales guidance from an expert's product demonstration.
Use ONLY statements present in the supplied moments. Do not add capabilities, promises, numbers or claims.
Separate discovery questions, value propositions, objection responses, proof moments, positioning and next-best actions.
Return a JSON array. Each item must have: kind, title, content, journeyKeys, capabilityIds, personaKeys, signalKeywords.
kind must be one of discovery, value_proposition, objection, proof_moment, next_best_action, positioning.`;
    const user = moments.map((moment, index) => ({
      index: index + 1,
      transcript: moment.transcript,
      journeyKey: moment.journeyKey,
      capabilityId: moment.capabilityId,
      personaKeys: moment.personaKeys,
      screenEvidence: moment.screenEvidence,
    }));
    const result = await this.model.step(system, [{ role: "user", blocks: [{ type: "text", text: JSON.stringify(user) }] }] as NMessage[], []);
    const raw = result.texts.join("\n").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("sales extractor did not return an array");
    return parsed.flatMap((value: any): ExtractedPlay[] => {
      if (!KINDS.has(value?.kind) || typeof value?.content !== "string" || !value.content.trim()) return [];
      const strings = (candidate: unknown) => Array.isArray(candidate) ? candidate.filter((item): item is string => typeof item === "string") : [];
      return [{
        kind: value.kind,
        title: typeof value.title === "string" ? value.title.slice(0, 160) : value.kind,
        content: value.content.trim(),
        journeyKeys: strings(value.journeyKeys), capabilityIds: strings(value.capabilityIds),
        personaKeys: strings(value.personaKeys), signalKeywords: strings(value.signalKeywords),
      }];
    });
  }
}

/** Captured expertise remains draft until a human approves the exact claim. */
export class SalesTrainingService {
  constructor(private readonly catalogs: CatalogRepository, private readonly extractor: SalesPlayExtractor) {}

  async ingest(ctx: TenantContext, catalogVersionId: string, moments: TrainingMoment[], signal?: AbortSignal): Promise<SalesPlay[]> {
    if (!moments.length) return [];
    const snapshot = await this.catalogs.get(ctx, catalogVersionId);
    if (!snapshot) throw new Error("catalog not found");
    if (["published", "retired"].includes(snapshot.catalog.status)) throw new Error("published catalogs are immutable; train a new draft");
    const extracted = await this.extractor.extract(moments, signal);
    const timestamp = new Date().toISOString();
    const plays = extracted.map((play): SalesPlay => ({
      id: randomUUID(), organizationId: ctx.organizationId, catalogVersionId,
      ...play, approvalStatus: "draft", createdAt: timestamp, updatedAt: timestamp,
    }));
    for (const play of plays) await this.catalogs.saveSalesPlay(ctx, play);
    return plays;
  }

  async approve(ctx: TenantContext, play: SalesPlay): Promise<SalesPlay> {
    const snapshot = await this.catalogs.get(ctx, play.catalogVersionId);
    if (!snapshot) throw new Error("catalog not found");
    if (["published", "retired"].includes(snapshot.catalog.status)) throw new Error("published catalogs are immutable; approve in a new draft");
    const approved = { ...play, approvalStatus: "approved" as const, approvedBy: ctx.actorId, approvedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await this.catalogs.saveSalesPlay(ctx, approved);
    return approved;
  }
}
