import { createHash } from "node:crypto";
import type { TenantContext } from "../domain/context.js";
import type { KnowledgeRepository } from "../storage/contracts.js";
import { embed } from "./embeddings.js";
import { chunkText, runCrawl, type CrawlSpec } from "./crawl.js";
import { assertSafeKnowledgeUrl } from "./source-safety.js";
import { chunkStructuredSections, documentJourneyPlanningEnabled, parseDocumentSections } from "./document-structure.js";
import { emit, trace } from "../events.js";

export interface DurableKnowledgeInput {
  productId: string;
  uri: string;
  title: string;
  content: string;
  sourceType?: string;
  externalKey?: string;
  trust?: "official" | "marketing" | "community" | "sales_expert";
  sourceModifiedAt?: string;
}

/** Versioned ingestion for pasted text and future external connectors. */
export class DurableKnowledgeIngestion {
  constructor(private readonly repository: KnowledgeRepository) {}

  private async ingestOne(ctx: TenantContext, input: DurableKnowledgeInput, audit: Record<string, unknown>) {
    const content = input.content.trim();
    if (!content) throw new Error("knowledge content is empty");
    if (Buffer.byteLength(content, "utf8") > 2 * 1024 * 1024) throw new Error("one knowledge document may not exceed 2MB");
    const structured = documentJourneyPlanningEnabled()
      ? chunkStructuredSections(parseDocumentSections(content, {
          source: input.uri, title: input.title,
          trust: input.trust === "sales_expert" ? "marketing" : input.trust ?? "official",
          freshness: input.sourceModifiedAt ?? new Date().toISOString(),
        }))
      : [];
    const texts = structured.length ? structured.map((chunk) => chunk.text) : chunkText(content);
    const vectors = await embed(texts);
    const contentHash = createHash("sha256").update(content).digest("hex");
    const stored = await this.repository.ingestDocument(ctx, {
      productId: input.productId,
      sourceType: input.sourceType ?? "manual",
      uri: input.uri,
      trust: input.trust ?? "official",
      externalKey: input.externalKey ?? createHash("sha256").update(input.uri).digest("hex"),
      title: input.title,
      contentHash,
      sourceModifiedAt: input.sourceModifiedAt,
      chunks: texts.map((text, index) => ({
        title: input.title, section: structured[index]?.section ?? input.title, content: text,
        embedding: vectors[index]?.length === 1536 ? vectors[index] : undefined,
        metadata: { contentHash, ...(structured[index]?.structure ?? {}) },
      })),
    });
    const trust = input.trust ?? "official";
    const embeddedCount = vectors.filter((vector) => vector?.length === 1536).length;
    Object.assign(audit, {
      sources: [{ source: input.uri, title: input.title, trust }],
      chunkCount: texts.length,
      embeddedCount,
      documentId: stored.documentId,
      versionId: stored.versionId,
    });
    texts.forEach((text, index) => emit("ingest.chunk", { product: input.productId, status: "ok", data: {
      chunkId: stored.chunkIds?.[index] ?? `${stored.versionId}:${index}`,
      title: input.title,
      source: input.uri,
      section: structured[index]?.section ?? input.title,
      trust,
      charCount: text.length,
      chunkText: text,
    } }));
    return stored;
  }

  async ingest(ctx: TenantContext, input: DurableKnowledgeInput) {
    const audit: Record<string, unknown> = {
      sources: [{ source: input.uri, title: input.title, trust: input.trust ?? "official" }],
    };
    return trace(input.productId, "ingestion", "ingest.run", audit, async () => this.ingestOne(ctx, input, audit));
  }

  /** Offline connector path; runtime retrieval never performs network crawling. */
  async syncWeb(ctx: TenantContext, input: { productId: string; spec: CrawlSpec }) {
    const audit: Record<string, unknown> = {
      sources: [...(input.spec.urls ?? []), ...(input.spec.sitemap ? [input.spec.sitemap] : [])]
        .map((source) => ({ source, trust: input.spec.trust ?? "official" })),
    };
    return trace(input.productId, "ingestion", "ingest.run", audit, async () => {
      for (const value of [...(input.spec.urls ?? []), ...(input.spec.sitemap ? [input.spec.sitemap] : [])]) {
        await assertSafeKnowledgeUrl(value);
      }
      const result = await runCrawl(input.spec);
      const pages = new Map<string, { title: string; chunks: string[] }>();
      for (const chunk of result.chunks) {
        const page = pages.get(chunk.source) ?? { title: chunk.title, chunks: [] };
        page.chunks.push(chunk.text); pages.set(chunk.source, page);
      }
      const documents = [];
      let embeddedCount = 0;
      for (const [uri, page] of pages) {
        const documentAudit: Record<string, unknown> = {};
        documents.push(await this.ingestOne(ctx, {
          productId: input.productId, uri, title: page.title, content: page.chunks.join("\n\n"),
          sourceType: "web", trust: input.spec.trust ?? "official",
        }, documentAudit));
        embeddedCount += Number(documentAudit.embeddedCount ?? 0);
      }
      const output = {
        pages: result.pages, documents: documents.length,
        chunks: documents.reduce((sum, item) => sum + item.chunks, 0),
        duplicates: result.duplicates,
      };
      Object.assign(audit, {
        sources: [...pages.entries()].map(([source, page]) => ({
          source, title: page.title, trust: input.spec.trust ?? "official",
        })),
        chunkCount: output.chunks,
        embeddedCount,
        pageCount: output.pages,
        duplicateCount: output.duplicates,
      });
      return output;
    });
  }
}
