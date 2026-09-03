import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { atomicWrite } from "./atomic-write.js";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Role } from "./auth.js"; // type-only: erased, so no import cycle at runtime

/**
 * Where login credentials live.
 *
 * Two backends behind one interface. PostgreSQL is used whenever DATABASE_URL is
 * set — the same switch that turns on the rest of the durable backbone — and the
 * JSON file remains for anyone running without a database, so a laptop install
 * still works with no configuration.
 *
 * The interface is deliberately granular (find/create/remove) rather than the
 * old read-all/write-all pair. Rewriting an entire user array is fine for a file
 * and wrong for a table: two concurrent writers would silently discard each
 * other's changes.
 */

export interface StoredUser {
  id: string;
  /** The login username. An email in practice, but never required to be one. */
  email: string;
  /** scrypt "salt:hash", both hex. */
  password: string;
  role: Role;
  orgId: string;
  createdAt: string;
  lastLoginAt?: string;
}

export interface UserStore {
  readonly kind: "postgres" | "json";
  list(orgId?: string): Promise<StoredUser[]>;
  findByEmail(email: string): Promise<StoredUser | null>;
  findById(id: string): Promise<StoredUser | null>;
  create(user: StoredUser): Promise<void>;
  updatePassword(id: string, passwordHash: string): Promise<boolean>;
  remove(id: string, orgId?: string): Promise<boolean>;
  touchLogin(id: string): Promise<void>;
  /** Owners in an organization, optionally ignoring one id (the delete candidate). */
  countOwners(orgId: string, excludingId?: string): Promise<number>;
  /** Move every account from one organization id to another; returns how many moved. */
  reassignOrg(from: string, to: string): Promise<number>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------- JSON backend

const AUTH_DIR = fileURLToPath(new URL("../../data/auth", import.meta.url));
const USERS_FILE = path.join(AUTH_DIR, "users.json");

class JsonUserStore implements UserStore {
  readonly kind = "json" as const;

  private async read(): Promise<StoredUser[]> {
    if (!existsSync(USERS_FILE)) return [];
    try {
      return JSON.parse(await fs.readFile(USERS_FILE, "utf8")) as StoredUser[];
    } catch (e) {
      console.warn("[auth] users.json is unreadable:", (e as Error).message);
      return [];
    }
  }

  private async write(users: StoredUser[]): Promise<void> {
    await fs.mkdir(AUTH_DIR, { recursive: true });
    // atomic: never leave a half-written user file
    await atomicWrite(USERS_FILE, JSON.stringify(users, null, 2), { mode: 0o600 });
  }

  async list(orgId?: string) {
    return (await this.read()).filter((u) => !orgId || u.orgId === orgId);
  }
  async findByEmail(email: string) {
    return (await this.read()).find((u) => u.email === email) ?? null;
  }
  async findById(id: string) {
    return (await this.read()).find((u) => u.id === id) ?? null;
  }
  async create(user: StoredUser) {
    const users = await this.read();
    if (users.some((u) => u.email === user.email)) throw new Error("that email already exists");
    users.push(user);
    await this.write(users);
  }
  async updatePassword(id: string, passwordHash: string) {
    const users = await this.read();
    const user = users.find((item) => item.id === id);
    if (!user) return false;
    user.password = passwordHash;
    await this.write(users);
    return true;
  }
  async remove(id: string, orgId?: string) {
    const users = await this.read();
    const next = users.filter((u) => !(u.id === id && (!orgId || u.orgId === orgId)));
    if (next.length === users.length) return false;
    await this.write(next);
    return true;
  }
  async touchLogin(id: string) {
    const users = await this.read();
    const user = users.find((u) => u.id === id);
    if (!user) return;
    user.lastLoginAt = new Date().toISOString();
    await this.write(users);
  }
  async countOwners(orgId: string, excludingId?: string) {
    return (await this.read()).filter((u) => u.orgId === orgId && u.role === "owner" && u.id !== excludingId).length;
  }
  async reassignOrg(from: string, to: string) {
    const users = await this.read();
    let moved = 0;
    for (const user of users) if (user.orgId === from) { user.orgId = to; moved++; }
    if (moved) await this.write(users);
    return moved;
  }
  async close() {}
}

// ------------------------------------------------------------ Postgres backend

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const rowToUser = (r: any): StoredUser => ({
  id: r.id,
  email: r.username,
  password: r.password_hash,
  role: r.role as Role,
  orgId: r.organization_id,
  createdAt: new Date(r.created_at).toISOString(),
  lastLoginAt: r.last_login_at ? new Date(r.last_login_at).toISOString() : undefined,
});

class PostgresUserStore implements UserStore {
  readonly kind = "postgres" as const;
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    // Small pool: authentication is a short, frequent query, never a long one.
    this.pool = new pg.Pool({ connectionString, max: Number(process.env.AUTH_POOL_MAX ?? 4) });
  }

  /**
   * Every query goes through here so a missing table reports the fix instead of
   * a bare stack trace. Setting DATABASE_URL without running the migration is an
   * easy mistake, and it otherwise kills the server at boot inside bootstrap().
   */
  private async q(text: string, values: unknown[] = []) {
    try {
      return await this.pool.query(text, values);
    } catch (e: any) {
      if (e?.code === "42P01") {
        throw new Error(
          "user_credentials table is missing — run: npm run db:migrate (or unset DATABASE_URL to use data/auth/users.json)",
        );
      }
      throw e;
    }
  }

  async list(orgId?: string) {
    const r = orgId
      ? await this.q("SELECT * FROM user_credentials WHERE organization_id=$1 ORDER BY created_at", [orgId])
      : await this.q("SELECT * FROM user_credentials ORDER BY created_at");
    return r.rows.map(rowToUser);
  }
  async findByEmail(email: string) {
    const r = await this.q("SELECT * FROM user_credentials WHERE username=$1", [email]);
    return r.rows[0] ? rowToUser(r.rows[0]) : null;
  }
  async findById(id: string) {
    const r = await this.q("SELECT * FROM user_credentials WHERE id=$1", [id]);
    return r.rows[0] ? rowToUser(r.rows[0]) : null;
  }
  async create(user: StoredUser) {
    try {
      await this.q(
        `INSERT INTO user_credentials(id,username,password_hash,role,organization_id,created_at)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [user.id, user.email, user.password, user.role, user.orgId, user.createdAt],
      );
    } catch (e: any) {
      // 23505 = unique_violation. The UNIQUE index, not a prior SELECT, is what
      // actually prevents a duplicate under concurrency.
      if (e?.code === "23505") throw new Error("that email already exists");
      throw e;
    }
  }
  async updatePassword(id: string, passwordHash: string) {
    const r = await this.q(
      "UPDATE user_credentials SET password_hash=$2, updated_at=now() WHERE id=$1",
      [id, passwordHash],
    );
    return (r.rowCount ?? 0) > 0;
  }
  async remove(id: string, orgId?: string) {
    const r = orgId
      ? await this.q("DELETE FROM user_credentials WHERE id=$1 AND organization_id=$2", [id, orgId])
      : await this.q("DELETE FROM user_credentials WHERE id=$1", [id]);
    return (r.rowCount ?? 0) > 0;
  }
  async touchLogin(id: string) {
    await this.q("UPDATE user_credentials SET last_login_at=now(), updated_at=now() WHERE id=$1", [id]);
  }
  async countOwners(orgId: string, excludingId?: string) {
    const r = await this.q(
      "SELECT count(*)::int n FROM user_credentials WHERE organization_id=$1 AND role='owner' AND id <> COALESCE($2,'00000000-0000-0000-0000-000000000000'::uuid)",
      [orgId, excludingId ?? null],
    );
    return r.rows[0].n as number;
  }
  async reassignOrg(from: string, to: string) {
    /*
     * The JSON store used the literal string "default" as an organization id;
     * this column is a uuid. Comparing against a non-uuid does not return zero
     * rows, it aborts the statement with 22P02 — which killed db:import-legacy
     * at startup, because migrateDefaultOrganization() always passes "default".
     * No uuid can equal that string, so there is nothing to move.
     */
    if (!UUID_PATTERN.test(from) || !UUID_PATTERN.test(to)) return 0;
    const r = await this.q(
      "UPDATE user_credentials SET organization_id=$2, updated_at=now() WHERE organization_id=$1",
      [from, to],
    );
    return r.rowCount ?? 0;
  }
  async close() {
    await this.pool.end().catch(() => {});
  }
}

// ---------------------------------------------------------------- selection

let store: UserStore | null = null;

export function userStore(): UserStore {
  if (store) return store;
  store = process.env.DATABASE_URL ? new PostgresUserStore(process.env.DATABASE_URL) : new JsonUserStore();
  return store;
}

/** Test seam; also lets the CLI close its pool without exiting the process. */
export function resetUserStore(): void {
  store = null;
}

/**
 * One-time lift of file-based accounts into PostgreSQL.
 *
 * Runs only when the table is empty, so it cannot clobber credentials created
 * directly in the database. The password hashes are scrypt either way, so they
 * carry over unchanged and existing passwords keep working.
 */
export async function importJsonUsersIfEmpty(target: UserStore): Promise<number> {
  if (target.kind !== "postgres") return 0;
  if ((await target.list()).length) return 0;
  const legacy = await new JsonUserStore().list();
  if (!legacy.length) return 0;
  let moved = 0;
  for (const user of legacy) {
    try {
      // Legacy JSON installs used the literal tenant id "default". PostgreSQL
      // stores organization ids as UUIDs, so adopt the explicitly configured
      // organization during the one-time import. Preserve already-valid UUIDs.
      const orgId = UUID_PATTERN.test(user.orgId)
        ? user.orgId
        : process.env.ADMIN_ORG_ID;
      if (!orgId || !UUID_PATTERN.test(orgId)) {
        throw new Error("legacy account has no valid organization; set ADMIN_ORG_ID and retry");
      }
      await target.create({ ...user, orgId });
      moved++;
    } catch (e) {
      console.warn(`[auth] could not import ${user.email}:`, (e as Error).message);
    }
  }
  return moved;
}
