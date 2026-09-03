import "../load-env.js";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { tenantContext } from "../domain/context.js";
import { listProducts, saveProduct } from "../products.js";
import { CatalogService } from "../catalog/service.js";
import { syncLegacyProduct } from "./import-product.js";
import { MemoryBundleCache } from "../catalog/cache.js";
import { LocalObjectStore } from "../catalog/object-store.js";
import { Database, migrate } from "./database.js";
import { postgresRepositories } from "./postgres.js";
import { EnvironmentSecretProvider, SecretProviderRegistry } from "../secrets/provider.js";
import { PostgresSecretProvider } from "../secrets/postgres-provider.js";
import { migrateDefaultOrganization } from "../auth.js";

const slug = (process.env.MIGRATION_ORG_SLUG ?? "default").toLowerCase().replace(/[^a-z0-9-]+/g, "-");
const organizationName = process.env.MIGRATION_ORG_NAME ?? "Imported organization";
const stableOrganizationId = () => {
  if (process.env.MIGRATION_ORG_ID) return process.env.MIGRATION_ORG_ID;
  /*
   * Fall back to the organization the SERVER runs as before inventing one.
   *
   * The hash below derives an id from the slug, which is fine on a first import
   * and wrong afterwards: an install whose org was created with a different id
   * already owns slug "default", so re-importing failed on
   * organizations_slug_key — and had that constraint not existed, the products
   * would have landed in a second organization that no logged-in user belongs
   * to, i.e. imported successfully and visible to nobody.
   */
  if (process.env.ADMIN_ORG_ID) return process.env.ADMIN_ORG_ID;
  const hex = createHash("sha256").update(`aidan-organization:${slug}`).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ["8", "9", "a", "b"][parseInt(hex[16], 16) % 4];
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
};
const database = new Database(process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL);

try {
  await migrate(database);
  const organizationId = stableOrganizationId();
  const bootstrapCtx = tenantContext({ organizationId, actorId: "legacy-import", requestId: randomUUID() });
  await database.withTenant(bootstrapCtx, async (client) => {
    await client.query(
      `INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)
       ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,updated_at=now()`,
      [organizationId, slug, organizationName],
    );
  });
  const movedUsers = await migrateDefaultOrganization(organizationId);
  if (movedUsers) console.log(`[import] moved ${movedUsers} legacy user(s) into organization ${organizationId}`);
  const ctx = tenantContext({ organizationId, actorId: "legacy-import", requestId: randomUUID() });
  const repositories = postgresRepositories(database);
  // Import is an offline command. Runtime workers warm their shared Redis cache
  // from the newly published immutable catalog on first use.
  const cache = new MemoryBundleCache();
  const objects = new LocalObjectStore(fileURLToPath(new URL("../../../data/objects", import.meta.url)));
  const catalogService = new CatalogService(repositories.catalogs, objects, cache);
  /*
   * Same secret providers the server registers, so a CLI import migrates real
   * credentials rather than leaving every authenticated product pinned to the
   * migration_required placeholder — which publishes fine and then cannot demo.
   */
  const secrets = new SecretProviderRegistry();
  secrets.register(new EnvironmentSecretProvider());
  secrets.register(new PostgresSecretProvider(process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL ?? ""));

  /*
   * `--product <id>` (or MIGRATION_PRODUCT) syncs ONE product. Re-running the
   * whole import just to publish a newly mapped product would rewrite every
   * other product's catalog as a side effect.
   */
  const onlyIndex = process.argv.indexOf("--product");
  const only = (onlyIndex >= 0 ? process.argv[onlyIndex + 1] : process.env.MIGRATION_PRODUCT)?.trim();
  const all = await listProducts();
  const selected = only ? all.filter((p) => p.id === only) : all;
  if (only && !selected.length) throw new Error(`no product with id "${only}" in content/`);

  for (const legacy of selected) {
    // The file-backed console historically used the literal organization id
    // "default". Once the durable tenant is created, keep the compatibility
    // manifest aligned with it; /api/products is tenant-scoped and would
    // otherwise hide a product that was successfully imported and published.
    if (legacy.organizationId === "default" && organizationId !== "default") {
      legacy.organizationId = organizationId;
      await saveProduct(legacy);
      console.log(`[import] ${legacy.id}: adopted organization ${organizationId}`);
    }
    const imported = await syncLegacyProduct(database, ctx, catalogService, legacy, secrets);
    const state = imported.published ? "published" : "left as review draft (no verified journeys)";
    console.log(`[import] ${legacy.id}: ${imported.verified} verified journeys, ${imported.docs} chunks, ${imported.plays} sales plays, ${imported.screens} screen(s), ${imported.transitions} transition(s) — ${state}`);
  }
} finally {
  await database.close();
}
