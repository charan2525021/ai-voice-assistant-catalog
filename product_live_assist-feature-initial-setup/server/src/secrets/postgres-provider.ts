import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { SecretProvider, SecretValue } from "./provider.js";

/**
 * Credential storage in PostgreSQL, encrypted with AES-256-GCM.
 *
 * The shipped providers could not serve a self-hosted install: `environment` and
 * `local-file` are read-only, so POST /api/v2/credentials — the call the
 * Add-product UI makes for any product behind a login — could only ever succeed
 * against Vault. This is the writable provider that does not require running one.
 * (`local-file` additionally cannot work on Windows at all: it demands 0600
 * permissions, which the platform reports as 666 and fs.chmod cannot change.)
 *
 * GCM, not CBC, because it authenticates as well as encrypts: a tampered row
 * fails to decrypt rather than silently yielding attacker-chosen plaintext. The
 * IV is random per write and stored with the value; reusing one across writes
 * under the same key is the classic way to destroy GCM's guarantees.
 *
 * The key never lives in the database it protects — otherwise encryption would
 * add nothing over storing the password in the clear, since a dump would carry
 * both halves.
 */

const KEY_FILE = fileURLToPath(new URL("../../../data/secrets/key", import.meta.url));
const IV_BYTES = 12;   // GCM standard nonce length
const TAG_BYTES = 16;

/**
 * Resolve the 32-byte key: SECRET_ENCRYPTION_KEY if set (hex or base64),
 * otherwise a generated file. An explicit key is what lets several workers — or
 * a rebuilt container — read secrets written by another; the file fallback keeps
 * a single-node install working with no configuration.
 */
async function encryptionKey(): Promise<Buffer> {
  const configured = process.env.SECRET_ENCRYPTION_KEY?.trim();
  if (configured) {
    const buf = /^[0-9a-fA-F]{64}$/.test(configured)
      ? Buffer.from(configured, "hex")
      : Buffer.from(configured, "base64");
    if (buf.length !== 32) throw new Error("SECRET_ENCRYPTION_KEY must decode to exactly 32 bytes");
    return buf;
  }
  if (existsSync(KEY_FILE)) {
    const buf = Buffer.from((await fs.readFile(KEY_FILE, "utf8")).trim(), "hex");
    if (buf.length !== 32) throw new Error(`${KEY_FILE} is corrupt — expected 32 bytes of hex`);
    return buf;
  }
  const key = randomBytes(32);
  await fs.mkdir(path.dirname(KEY_FILE), { recursive: true });
  await fs.writeFile(KEY_FILE, key.toString("hex"), { mode: 0o600 });
  await fs.chmod(KEY_FILE, 0o600).catch(() => {}); // best-effort; a no-op on Windows
  console.log(`[secrets] generated an encryption key at ${KEY_FILE} — back it up; without it stored credentials are unrecoverable`);
  return key;
}

export class PostgresSecretProvider implements SecretProvider {
  readonly name = "postgres";
  private readonly pool: pg.Pool;
  private key: Buffer | null = null;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: Number(process.env.SECRET_POOL_MAX ?? 2) });
  }

  private async cipherKey(): Promise<Buffer> {
    return (this.key ??= await encryptionKey());
  }

  private async encrypt(value: SecretValue): Promise<string> {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", await this.cipherKey(), iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
  }

  private async decrypt(packed: string): Promise<SecretValue> {
    const raw = Buffer.from(packed, "base64");
    if (raw.length <= IV_BYTES + TAG_BYTES) throw new Error("stored secret is truncated");
    const decipher = createDecipheriv("aes-256-gcm", await this.cipherKey(), raw.subarray(0, IV_BYTES));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    const plain = Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
    return JSON.parse(plain.toString("utf8")) as SecretValue;
  }

  /** PostgreSQL secrets are always addressed inside an explicit tenant path. */
  private organizationFor(secretPath: string): string {
    const match = /^organizations\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\//i.exec(secretPath);
    if (!match) throw new Error("PostgreSQL secret paths must start with organizations/<uuid>/");
    return match[1];
  }

  private async withTenant<T>(organizationId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.organization_id',$1,true)", [organizationId]);
      const value = await fn(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async get(secretPath: string): Promise<SecretValue | null> {
    const organizationId = this.organizationFor(secretPath);
    const result = await this.withTenant(organizationId, (client) =>
      client.query("SELECT ciphertext FROM secret_values WHERE organization_id=$1 AND secret_path=$2", [organizationId, secretPath]),
    );
    if (!result.rows[0]) return null;
    try {
      return await this.decrypt(result.rows[0].ciphertext as string);
    } catch (e) {
      // Almost always a changed or lost key. Say so — "credential is missing"
      // would send someone hunting for a row that is right there.
      throw new Error(
        `stored credential at "${secretPath}" could not be decrypted (${(e as Error).message}). ` +
        "The encryption key has changed or was lost; re-enter the credential.",
      );
    }
  }

  async put(secretPath: string, value: SecretValue): Promise<void> {
    const organizationId = this.organizationFor(secretPath);
    const ciphertext = await this.encrypt(value);
    await this.withTenant(organizationId, (client) => client.query(
      `INSERT INTO secret_values(organization_id,secret_path,ciphertext) VALUES($1,$2,$3)
       ON CONFLICT(organization_id,secret_path) DO UPDATE SET ciphertext=EXCLUDED.ciphertext, updated_at=now()`,
      [organizationId, secretPath, ciphertext],
    ),
    );
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => {});
  }
}
