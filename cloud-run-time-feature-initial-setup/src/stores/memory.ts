import type { ContinuityStore, HandoffStore, Installation, KnowledgeChunk, RuntimeContinuity, RuntimeEvent, RuntimeHandoff, RuntimeSession, SessionStore } from "../contracts.js";
import type { SignedCatalogEnvelope } from "@sable/sdk-contracts";
import type { RuntimeBundle, RuntimeScope } from "@sable/runtime-core";

export class MemorySessionStore implements SessionStore {
  private readonly values = new Map<string, RuntimeSession>();
  async put(session: RuntimeSession): Promise<void> { this.values.set(session.sessionId, structuredClone(session)); }
  async get(id: string): Promise<RuntimeSession | undefined> { const value = this.values.get(id); return value ? structuredClone(value) : undefined; }
  async delete(id: string): Promise<void> { this.values.delete(id); }
}

export class MemoryContinuityStore implements ContinuityStore {
  private readonly values = new Map<string, RuntimeContinuity>();
  async put(value: RuntimeContinuity, expectedRevision?: number): Promise<boolean> {
    const currentRevision = this.values.get(value.continuityId)?.revision ?? 0;
    if (expectedRevision !== undefined && currentRevision !== expectedRevision) return false;
    this.values.set(value.continuityId, structuredClone(value));
    return true;
  }
  async get(id: string): Promise<RuntimeContinuity | undefined> { const value = this.values.get(id); return value && Date.parse(value.expiresAt) > Date.now() ? structuredClone(value) : undefined; }
  async delete(id: string): Promise<void> { this.values.delete(id); }
}

export class MemoryHandoffStore implements HandoffStore {
  private readonly values = new Map<string, RuntimeHandoff>();
  async put(value: RuntimeHandoff): Promise<void> { this.values.set(value.tokenHash, structuredClone(value)); }
  async consume(tokenHash: string): Promise<RuntimeHandoff | undefined> {
    const value = this.values.get(tokenHash);
    this.values.delete(tokenHash);
    return value && Date.parse(value.expiresAt) > Date.now() ? structuredClone(value) : undefined;
  }
}

export class MemoryStores {
  readonly sessions = new MemorySessionStore();
  readonly continuities = new MemoryContinuityStore();
  readonly handoffs = new MemoryHandoffStore();
  readonly events: RuntimeEvent[] = [];
  constructor(readonly installationsData: Installation[], readonly catalogsData: SignedCatalogEnvelope[], readonly runtimeBundlesData: RuntimeBundle[], readonly knowledgeData: KnowledgeChunk[]) {}
  async get(id: string): Promise<Installation | undefined> { return this.installationsData.find((value) => value.installationId === id); }
  async list(organizationId: string): Promise<Installation[]> { return this.installationsData.filter((value) => value.organizationId === organizationId).map((value) => structuredClone(value)); }
  async put(installation: Installation): Promise<void> { const index = this.installationsData.findIndex((value) => value.installationId === installation.installationId); if (index >= 0) this.installationsData[index] = structuredClone(installation); else this.installationsData.push(structuredClone(installation)); }
  async getCatalog(version: string): Promise<SignedCatalogEnvelope | undefined> { return this.catalogsData.find((value) => value.payload.manifest.catalogVersionId === version); }
  async search(scope: RuntimeScope, input: { query: string; embedding?: number[]; limit: number }): Promise<KnowledgeChunk[]> {
    const words = input.query.toLowerCase().split(/\W+/).filter((word) => word.length > 2);
    return this.knowledgeData.filter((chunk) => chunk.tenantId === scope.organizationId && chunk.productId === scope.productId && chunk.catalogVersionId === scope.catalogVersionId)
      .map((chunk) => ({ ...chunk, score: words.reduce((score, word) => score + (`${chunk.title} ${chunk.section} ${chunk.content}`.toLowerCase().includes(word) ? 1 : 0), 0) / Math.max(1, words.length) }))
      .filter((chunk) => chunk.score > 0).sort((a, b) => b.score - a.score).slice(0, input.limit);
  }
  async append(event: RuntimeEvent): Promise<void> { this.events.push(structuredClone(event)); }
  asRuntimeStores() {
    return {
      installations: { get: (id: string) => this.get(id), list: (organizationId: string) => this.list(organizationId), put: (installation: Installation) => this.put(installation) },
      catalogs: {
        get: (version: string) => this.getCatalog(version),
        getBundle: async (scope: RuntimeScope) => this.runtimeBundlesData.find((bundle) => bundle.organizationId === scope.organizationId && bundle.productId === scope.productId && bundle.catalogVersionId === scope.catalogVersionId),
      },
      knowledge: { search: (scope: RuntimeScope, input: { query: string; embedding?: number[]; limit: number }) => this.search(scope, input) },
      sessions: this.sessions,
      continuities: this.continuities,
      handoffs: this.handoffs,
      events: { append: (event: RuntimeEvent) => this.append(event) },
      close: async () => undefined,
    };
  }
}
