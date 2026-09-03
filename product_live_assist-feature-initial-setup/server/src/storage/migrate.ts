import "../load-env.js";
import { randomUUID } from "node:crypto";
import { Database, migrate } from "./database.js";
import { tenantContext } from "../domain/context.js";

const database = new Database(process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL);
try {
  await migrate(database);
  const organizationId = process.env.ADMIN_ORG_ID;
  if (organizationId) {
    const ctx = tenantContext({ organizationId, actorId: "database-migration", requestId: randomUUID() });
    await database.withTenant(ctx, async (client) => {
      await client.query(
        `INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)
         ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,updated_at=now()`,
        [organizationId, process.env.ADMIN_ORG_SLUG ?? `org-${organizationId.slice(0, 8)}`, process.env.ADMIN_ORG_NAME ?? "Aidan organization"],
      );
    });
    console.log(`[database] organization ready: ${organizationId}`);
  } else {
    console.warn("[database] ADMIN_ORG_ID is not set; create an organization before using /api/v2");
  }
} finally {
  await database.close();
}
