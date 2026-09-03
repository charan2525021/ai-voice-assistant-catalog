import { readFile } from "node:fs/promises";
import pg from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const filename = process.argv[2] ?? "data/sample-runtime.generated.json";
const data = JSON.parse(await readFile(filename, "utf8")) as {
  installations: Array<{ installationId: string; organizationId: string } & Record<string, unknown>>;
  catalogs: Array<{ payload: { manifest: { organizationId: string; productId: string; catalogVersionId: string } } }>;
  runtimeBundles: Array<{ organizationId: string; productId: string; catalogVersionId: string }>;
  knowledge: Array<{ id: string; tenantId: string; productId: string; catalogVersionId: string; title: string; section: string; content: string; source: string; trust: string; embedding?: number[] }>;
};
const pool = new pg.Pool({ connectionString });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  // Import is an operator action. It runs under the migration/owner role, not the restricted runtime role.
  await client.query("SET LOCAL row_security = off");
  for (const value of data.installations) await client.query("INSERT INTO runtime_installations(installation_id,organization_id,payload) VALUES($1,$2,$3) ON CONFLICT(installation_id) DO UPDATE SET organization_id=excluded.organization_id,payload=excluded.payload", [value.installationId, value.organizationId, value]);
  for (const value of data.catalogs) await client.query("INSERT INTO runtime_catalogs(organization_id,catalog_version_id,envelope) VALUES($1,$2,$3) ON CONFLICT(organization_id,catalog_version_id) DO UPDATE SET envelope=excluded.envelope", [value.payload.manifest.organizationId, value.payload.manifest.catalogVersionId, value]);
  for (const value of data.runtimeBundles) await client.query(
    "INSERT INTO runtime_evidence_bundles(organization_id,product_id,catalog_version_id,bundle) VALUES($1,$2,$3,$4) ON CONFLICT(organization_id,product_id,catalog_version_id) DO UPDATE SET bundle=excluded.bundle",
    [value.organizationId, value.productId, value.catalogVersionId, value],
  );
  for (const value of data.knowledge) await client.query(
    "INSERT INTO runtime_knowledge_chunks(organization_id,product_id,catalog_version_id,chunk_id,title,section,body,source,trust,embedding) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::vector) ON CONFLICT(organization_id,product_id,catalog_version_id,chunk_id) DO UPDATE SET title=excluded.title,section=excluded.section,body=excluded.body,source=excluded.source,trust=excluded.trust,embedding=excluded.embedding",
    [value.tenantId, value.productId, value.catalogVersionId, value.id, value.title, value.section, value.content, value.source, value.trust, value.embedding ? `[${value.embedding.join(",")}]` : null],
  );
  await client.query("COMMIT"); console.log(`Imported ${data.catalogs.length} catalog(s) into PostgreSQL.`);
} catch (error) { await client.query("ROLLBACK"); throw error; }
finally { client.release(); await pool.end(); }
