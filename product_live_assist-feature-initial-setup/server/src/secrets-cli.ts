import "./load-env.js";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { listProducts } from "./products.js";
import { tenantContext } from "./domain/context.js";
import { Database } from "./storage/database.js";

/**
 * Finish the credential half of the legacy import.
 *
 * db:import-legacy deliberately does NOT copy passwords or captured browser
 * sessions into PostgreSQL — it writes a credential_refs row whose provider is
 * the literal marker "migration_required", so the material has to be re-entered
 * against a real secret provider. Until that happens, starting a demo fails with
 *   secret provider "migration_required" is not configured
 *
 * This moves username/password pairs from content/<id>/product.json into the
 * EnvironmentSecretProvider (which backbone.ts always registers) and repoints
 * the credential_refs row at it.
 *
 * Session- and profile-based products are reported, not migrated: a captured
 * storageState is a live, expiring credential that belongs in Vault or in a
 * fresh interactive sign-in, and hubspot's is 112KB — beyond the practical size
 * of a Windows environment variable anyway.
 *
 *   npm run secrets:migrate            # show what would change
 *   npm run secrets:migrate -- --apply # write .env and update credential_refs
 */

const ENV_FILE = fileURLToPath(new URL("../../.env", import.meta.url));
const apply = process.argv.includes("--apply");
const organizationId = process.env.ADMIN_ORG_ID;

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set — nothing to migrate");
if (!organizationId) throw new Error("ADMIN_ORG_ID is not set — needed to read credential_refs under row-level security");

/** Must match EnvironmentSecretProvider.get() exactly, or the lookup misses. */
const envKeyFor = (secretPath: string) => `AIDAN_SECRET_${secretPath.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`;

const database = new Database(process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL);
const ctx = tenantContext({ organizationId, actorId: "secrets-migrate", requestId: randomUUID() });

interface Planned { product: string; secretPath: string; envKey: string; value: string }
const planned: Planned[] = [];
const skipped: { product: string; why: string }[] = [];

try {
  const legacyById = new Map((await listProducts()).map((p) => [p.id, p]));

  const rows = await database.withTenant(ctx, async (client) => {
    const r = await client.query(
      `SELECT cr.id, cr.secret_path, p.product_key
         FROM credential_refs cr
         JOIN role_profiles rp ON rp.credential_ref_id = cr.id
         JOIN environments e   ON e.id = rp.environment_id
         JOIN products p       ON p.id = e.product_id
        WHERE cr.provider = 'migration_required'
        ORDER BY p.product_key`,
    );
    return r.rows as { id: string; secret_path: string; product_key: string }[];
  });

  if (!rows.length) {
    console.log("no credential references are waiting on migration");
  }

  for (const row of rows) {
    const legacy = legacyById.get(row.product_key);
    const auth = legacy?.auth;
    if (!auth || auth.mode === "none") {
      skipped.push({ product: row.product_key, why: "no legacy credential on disk" });
      continue;
    }
    if (auth.mode !== "login" || !auth.username || !auth.password) {
      // session / profile mode: a live browser credential, not a password.
      skipped.push({
        product: row.product_key,
        why: `mode="${auth.mode}" — re-authenticate interactively in the admin console (🔐 Sign in), or store it in Vault`,
      });
      continue;
    }
    planned.push({
      product: row.product_key,
      secretPath: row.secret_path,
      envKey: envKeyFor(row.secret_path),
      value: JSON.stringify({ username: auth.username, password: auth.password }),
    });
  }

  console.log(`\n${apply ? "migrating" : "would migrate"} ${planned.length} credential(s):`);
  for (const p of planned) console.log(`  ${p.product.padEnd(20)} -> ${p.envKey}`);
  if (skipped.length) {
    console.log(`\nskipped ${skipped.length}:`);
    for (const s of skipped) console.log(`  ${s.product.padEnd(20)} ${s.why}`);
  }

  if (!apply) {
    console.log("\nre-run with --apply to write .env and repoint credential_refs\n");
  } else if (planned.length) {
    // Append to .env, replacing any line for the same key so re-runs stay idempotent.
    const existing = await fs.readFile(ENV_FILE, "utf8").catch(() => "");
    await fs.writeFile(`${ENV_FILE}.bak-secrets`, existing).catch(() => {});
    const keep = existing
      .split(/\r?\n/)
      .filter((line) => !planned.some((p) => line.startsWith(`${p.envKey}=`)))
      .join("\n")
      .replace(/\n+$/, "");
    const block = [
      "",
      "# --- Demo-account credentials for the durable stack (secrets-cli) ---",
      "# Read by EnvironmentSecretProvider. Single-quoted so the JSON survives dotenv.",
      ...planned.map((p) => `${p.envKey}='${p.value}'`),
      "",
    ].join("\n");
    await fs.writeFile(ENV_FILE, `${keep}\n${block}`);

    await database.withTenant(ctx, async (client) => {
      for (const p of planned) {
        await client.query(
          "UPDATE credential_refs SET provider='environment', updated_at=now() WHERE secret_path=$1 AND provider='migration_required'",
          [p.secretPath],
        );
      }
    });

    console.log(`\nwrote ${planned.length} secret(s) to aidan/.env (backup: .env.bak-secrets)`);
    console.log("repointed credential_refs to provider=environment");
    console.log("RESTART the server so it picks up the new environment variables\n");
  }
} finally {
  await database.close();
}
