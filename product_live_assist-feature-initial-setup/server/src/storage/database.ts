import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from "pg";
import type { TenantContext } from "../domain/context.js";

export type TenantClient = Pick<PoolClient, "query">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class Database {
  readonly pool: Pool;

  constructor(config: PoolConfig | string = process.env.DATABASE_URL ?? "postgres://aidan:aidan@localhost:5433/aidan") {
    this.pool = new Pool(typeof config === "string" ? { connectionString: config } : config);
    this.pool.on("error", (error) => console.error("[database] idle client error", error));
  }

  async healthcheck(): Promise<boolean> {
    return this.pool.query("SELECT 1").then(() => true).catch(() => false);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Every repository operation runs in a transaction with a transaction-local
   * tenant scope. PostgreSQL row-level security is the final enforcement layer.
   */
  async withTenant<T>(ctx: TenantContext, fn: (client: TenantClient) => Promise<T>): Promise<T> {
    if (!UUID.test(ctx.organizationId)) {
      throw new Error("durable storage requires organizationId to be a UUID");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.organization_id', $1, true)", [ctx.organizationId]);
      await client.query("SELECT set_config('app.actor_id', $1, true)", [ctx.actorId]);
      await client.query("SELECT set_config('app.request_id', $1, true)", [ctx.requestId]);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  query<Row extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]): Promise<QueryResult<Row>> {
    return this.pool.query<Row>(sql, values);
  }
}

export async function migrate(database: Database, directory = fileURLToPath(new URL("../../../db/migrations", import.meta.url))): Promise<void> {
  await database.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const files = (await fs.readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    const applied = await database.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
    if (applied.rowCount) continue;
    const sql = await fs.readFile(path.join(directory, file), "utf8");
    const client = await database.pool.connect();
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [file]);
      console.log(`[database] applied ${file}`);
    } finally {
      client.release();
    }
  }
}
