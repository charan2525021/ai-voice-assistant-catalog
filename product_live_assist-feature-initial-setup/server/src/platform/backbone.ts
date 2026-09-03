import { fileURLToPath } from "node:url";
import { Database } from "../storage/database.js";
import { postgresRepositories } from "../storage/postgres.js";
import { MemoryBundleCache, RedisBundleCache, LayeredBundleCache, type RuntimeBundleCache } from "../catalog/cache.js";
import { LocalObjectStore, S3ObjectStore } from "../catalog/object-store.js";
import { CatalogService } from "../catalog/service.js";
import { EvidenceRouter } from "../runtime/evidence-router.js";
import { embedOne } from "../knowledge/embeddings.js";
import { EnvironmentSecretProvider, LocalFileSecretProvider, SecretProviderRegistry, VaultSecretProvider } from "../secrets/provider.js";
import { PostgresSecretProvider } from "../secrets/postgres-provider.js";
import { DurableKnowledgeIngestion } from "../knowledge/durable-ingestion.js";
import { LlmSalesPlayExtractor, SalesTrainingService } from "../sales/training.js";
import { DurableMappingPipeline } from "../mapping/durable-pipeline.js";

export class DurableBackbone {
  readonly database: Database;
  readonly repositories;
  readonly cache: RuntimeBundleCache;
  readonly catalogs: CatalogService;
  readonly evidence: EvidenceRouter;
  readonly secrets: SecretProviderRegistry;
  readonly knowledgeIngestion: DurableKnowledgeIngestion;
  readonly salesTraining: SalesTrainingService;
  readonly mapping: DurableMappingPipeline;
  private readonly redis?: RedisBundleCache;

  constructor(databaseUrl: string, redisUrl?: string) {
    this.database = new Database(databaseUrl);
    this.repositories = postgresRepositories(this.database);
    const memory = new MemoryBundleCache(Number(process.env.RUNTIME_BUNDLES_PER_WORKER ?? 100));
    if (redisUrl) {
      this.redis = new RedisBundleCache(redisUrl);
      this.cache = new LayeredBundleCache(memory, this.redis);
    } else this.cache = memory;
    const objectRoot = process.env.OBJECT_STORE_PATH ?? fileURLToPath(new URL("../../../data/objects", import.meta.url));
    const objects = process.env.S3_ENDPOINT && process.env.S3_BUCKET && process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
      ? new S3ObjectStore({
          endpoint: process.env.S3_ENDPOINT, bucket: process.env.S3_BUCKET,
          region: process.env.S3_REGION ?? "us-east-1", accessKeyId: process.env.S3_ACCESS_KEY_ID,
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY, sessionToken: process.env.S3_SESSION_TOKEN,
        })
      : new LocalObjectStore(objectRoot);
    this.catalogs = new CatalogService(this.repositories.catalogs, objects, this.cache, this.repositories.products);
    this.evidence = new EvidenceRouter(this.catalogs, this.repositories.knowledge, async (text) => {
      const value = await embedOne(text);
      return value?.length === 1536 ? value : undefined;
    });
    this.secrets = new SecretProviderRegistry();
    this.knowledgeIngestion = new DurableKnowledgeIngestion(this.repositories.knowledge);
    this.salesTraining = new SalesTrainingService(this.repositories.catalogs, new LlmSalesPlayExtractor());
    this.secrets.register(new EnvironmentSecretProvider());
    // The only writable provider that needs no extra service, so /api/v2/credentials
    // works out of the box. Registered before the optional ones so a configured
    // Vault can still be selected explicitly by name.
    this.secrets.register(new PostgresSecretProvider(databaseUrl));
    if (process.env.LOCAL_SECRET_ROOT) {
      this.secrets.register(new LocalFileSecretProvider(process.env.LOCAL_SECRET_ROOT));
    }
    if (process.env.VAULT_ADDR && process.env.VAULT_TOKEN) {
      this.secrets.register(new VaultSecretProvider(
        process.env.VAULT_ADDR,
        () => process.env.VAULT_TOKEN!,
        process.env.VAULT_MOUNT ?? "secret",
      ));
    }
    this.mapping = new DurableMappingPipeline(this.repositories, this.secrets);
  }

  healthcheck(): Promise<boolean> { return this.database.healthcheck(); }
  async close(): Promise<void> {
    await this.redis?.close().catch(() => {});
    await this.database.close();
  }
}

export function createDurableBackbone(): DurableBackbone | null {
  return process.env.DATABASE_URL ? new DurableBackbone(process.env.DATABASE_URL, process.env.REDIS_URL) : null;
}
