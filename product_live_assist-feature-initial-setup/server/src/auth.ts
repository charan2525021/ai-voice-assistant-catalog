import { createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { emit } from "./events.js";
import { importJsonUsersIfEmpty, userStore, type StoredUser } from "./auth-store.js";

/**
 * Who is allowed to use this platform.
 *
 * Until now every route was open: anyone who could reach the port could link a
 * product, read the event log, or revoke a stored session. `safeAuth()` kept
 * credentials out of responses, but nothing kept strangers out of the endpoints.
 * That is the single thing that made this undeployable past a laptop.
 *
 * Deliberately small: users in a JSON file, scrypt password hashes, signed cookie
 * sessions. No dependency, no database, no third-party identity provider. It is
 * the floor, not the ceiling — `ENTERPRISE_PLAN.md` P0-1/P0-2 describe the SSO and
 * org-scoping this is designed to grow into, and `Role` and `orgId` exist here so
 * that growth does not require touching every call site again.
 */

// Accounts live in auth-store.ts; only the session signing secret is still a file.
const AUTH_DIR = fileURLToPath(new URL("../../data/auth", import.meta.url));
const SECRET_FILE = path.join(AUTH_DIR, "secret");
const scryptAsync = promisify(scrypt);

/** owner: everything incl. user management · admin: products + demos · viewer: read-only */
export type Role = "owner" | "admin" | "viewer";

/** The persisted account record. Shape is owned by the store layer. */
export type User = StoredUser;

export interface AuthedUser {
  id: string;
  email: string;
  role: Role;
  orgId: string;
}

const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS ?? 12 * 60 * 60 * 1000);
export const SESSION_COOKIE = "aidan_session";

/*
 * Sessions are a SIGNED, STATELESS cookie rather than a server-side map.
 *
 * The map version threw everyone out on every restart — which, during a demo you
 * are actively iterating on, is constant — and made the persisted signing secret
 * pointless. A token carries the user id and expiry, signed with that secret, so
 * a restart no longer invalidates it.
 *
 * Trade-off, stated plainly: a stateless token cannot be revoked by forgetting it.
 * Explicit logouts go in `revoked` below, which is in-memory and therefore
 * best-effort across a restart. Deleting a user IS fully effective immediately,
 * because `userForToken` re-reads the user file and fails closed if the account
 * is gone. A shared revocation store is the fix when this runs on more than one
 * process (ENTERPRISE_PLAN.md P0-4).
 */
const revoked = new Set<string>();

// ---------------------------------------------------------------- password hashing

async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const key = (await scryptAsync(plain, salt, 64)) as Buffer;
  return `${salt.toString("hex")}:${key.toString("hex")}`;
}

async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const [saltHex, keyHex] = stored.split(":");
  if (!saltHex || !keyHex) return false;
  const key = (await scryptAsync(plain, Buffer.from(saltHex, "hex"), 64)) as Buffer;
  const expected = Buffer.from(keyHex, "hex");
  // Constant-time: a length mismatch must not short-circuit either.
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// ---------------------------------------------------------------- user store

/*
 * Storage lives in auth-store.ts and is chosen by DATABASE_URL: a
 * user_credentials table when the durable backbone is on, users.json otherwise.
 * Everything below is backend-agnostic, so the rules enforced here — password
 * length, duplicate detection, last-owner protection — hold either way.
 */

export async function listUsers(orgId?: string): Promise<AuthedUser[]> {
  return (await userStore().list(orgId)).map((u) => ({ id: u.id, email: u.email, role: u.role, orgId: u.orgId }));
}

export async function createUser(email: string, password: string, role: Role, orgId = "default"): Promise<AuthedUser> {
  const clean = email.trim().toLowerCase();
  if (!clean || !/^[^@\s]+@[^@\s]+$/.test(clean)) throw new Error("a valid email is required");
  if (password.length < 10) throw new Error("password must be at least 10 characters");
  const user: StoredUser = {
    id: randomUUID(),
    email: clean,
    password: await hashPassword(password),
    role,
    orgId,
    createdAt: new Date().toISOString(),
  };
  // create() rejects duplicates itself — in PostgreSQL via the UNIQUE index, so
  // two simultaneous signups cannot both pass a check-then-insert race.
  await userStore().create(user);
  emit("auth.user_created", { product: "_system", status: "ok", data: { email: clean, role, orgId } });
  return { id: user.id, email: user.email, role: user.role, orgId: user.orgId };
}

/** Administrative recovery path for a lost local password. */
export async function resetUserPassword(email: string, password: string): Promise<AuthedUser> {
  const clean = email.trim().toLowerCase();
  if (password.length < 10) throw new Error("password must be at least 10 characters");
  const store = userStore();
  const user = await store.findByEmail(clean);
  if (!user) throw new Error("no such account");
  if (!await store.updatePassword(user.id, await hashPassword(password))) throw new Error("password reset did not update the account");
  emit("auth.password_reset", { product: "_system", status: "ok", data: { userId: user.id, email: clean } });
  return { id: user.id, email: user.email, role: user.role, orgId: user.orgId };
}

export async function deleteUser(id: string, orgId?: string): Promise<boolean> {
  const store = userStore();
  const target = await store.findById(id);
  if (!target || (orgId && target.orgId !== orgId)) return false;
  if (target.role === "owner" && (await store.countOwners(target.orgId, target.id)) === 0) {
    throw new Error("cannot remove the last owner");
  }
  const removed = await store.remove(id, orgId);
  if (!removed) return false;
  // No session sweep needed: userForToken re-reads the user, so a deleted
  // account stops authenticating on its very next request.
  emit("auth.user_deleted", { product: "_system", status: "ok", data: { userId: id } });
  return true;
}

/**
 * Ensure someone can log in on a fresh install.
 *
 * Uses ADMIN_EMAIL/ADMIN_PASSWORD when provided, otherwise generates a strong
 * password and prints it once. It is never defaulted to something guessable —
 * a well-known default credential on an internet-reachable box is the same as
 * having no authentication, which is the problem this file exists to fix.
 */
export async function bootstrap(): Promise<void> {
  const store = userStore();
  // Lift any file-based accounts into PostgreSQL the first time the durable
  // backbone is switched on. Hashes are scrypt in both, so passwords still work.
  const imported = await importJsonUsersIfEmpty(store).catch((e) => {
    console.warn("[auth] could not import users.json:", (e as Error).message);
    return 0;
  });
  if (imported) console.log(`[auth] imported ${imported} account(s) from users.json into PostgreSQL`);

  const users = await store.list();
  const configuredOrg = process.env.ADMIN_ORG_ID;
  if (users.length) {
    // One-time compatibility bridge: an explicit durable organization adopts
    // only users from the old unscoped "default" tenant. Named tenant users are
    // never moved implicitly.
    if (configuredOrg && users.some((user) => user.orgId === "default")) {
      const moved = await store.reassignOrg("default", configuredOrg);
      if (moved) console.log(`[auth] migrated ${moved} legacy default user(s) to organization ${configuredOrg}`);
    }
    return;
  }
  const email = (process.env.ADMIN_EMAIL ?? "admin@localhost").trim().toLowerCase();
  const generated = !process.env.ADMIN_PASSWORD;
  const password = process.env.ADMIN_PASSWORD ?? randomBytes(12).toString("base64url");
  await createUser(email, password, "owner", process.env.ADMIN_ORG_ID ?? "default");
  if (generated) {
    console.log(
      [
        "",
        "  ┌───────────────────────────────────────────────────────────────┐",
        "  │  First run — an owner account was created.                    │",
        "  ├───────────────────────────────────────────────────────────────┤",
        `  │  email:    ${email.padEnd(50)}│`,
        `  │  password: ${password.padEnd(50)}│`,
        "  │                                                               │",
        "  │  This is shown ONCE. Save it now.                             │",
        "  │  Set ADMIN_EMAIL / ADMIN_PASSWORD to choose your own.         │",
        "  └───────────────────────────────────────────────────────────────┘",
        "",
      ].join("\n"),
    );
  } else {
    console.log(`[auth] created owner account ${email} from ADMIN_EMAIL/ADMIN_PASSWORD`);
  }
}

/** Used by the one-time legacy data importer when PostgreSQL allocates the org id. */
export async function migrateDefaultOrganization(organizationId: string): Promise<number> {
  return userStore().reassignOrg("default", organizationId);
}

// ---------------------------------------------------------------- sessions

/** Signing secret, persisted so sessions survive a restart. */
async function secret(): Promise<Buffer> {
  await fs.mkdir(AUTH_DIR, { recursive: true });
  if (existsSync(SECRET_FILE)) return Buffer.from(await fs.readFile(SECRET_FILE, "utf8"), "hex");
  const s = randomBytes(32);
  await fs.writeFile(SECRET_FILE, s.toString("hex"));
  await fs.chmod(SECRET_FILE, 0o600).catch(() => {});
  return s;
}
let secretCache: Buffer | null = null;
const getSecret = async () => (secretCache ??= await secret());

function sign(payload: string, key: Buffer): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

async function makeToken(userId: string): Promise<string> {
  const key = await getSecret();
  const body = Buffer.from(JSON.stringify({ uid: userId, exp: Date.now() + SESSION_TTL_MS })).toString("base64url");
  return `${body}.${sign(body, key)}`;
}

async function readToken(token: string): Promise<{ uid: string; exp: number } | null> {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const key = await getSecret();
  const expected = sign(body, key);
  // Constant-time compare; a length mismatch must not short-circuit.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString());
    if (typeof parsed?.uid !== "string" || typeof parsed?.exp !== "number") return null;
    if (parsed.exp < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function login(email: string, password: string): Promise<{ token: string; user: AuthedUser } | null> {
  const clean = email.trim().toLowerCase();
  const user = await userStore().findByEmail(clean);
  /*
   * Hash even when the user does not exist. Skipping it makes "no such user"
   * measurably faster than "wrong password", which leaks whether an address is
   * registered.
   */
  const stored = user?.password ?? (await hashPassword("dummy-for-timing"));
  const ok = await verifyPassword(password, stored);
  if (!user || !ok) {
    emit("auth.login_failed", { product: "_system", status: "error", data: { email: clean } });
    return null;
  }

  const token = await makeToken(user.id);
  await userStore().touchLogin(user.id);
  emit("auth.login", { product: "_system", status: "ok", data: { email: user.email, role: user.role } });
  return { token, user: { id: user.id, email: user.email, role: user.role, orgId: user.orgId } };
}

export function logout(token: string): void {
  revoked.add(token);
}

export async function userForToken(token: string | undefined): Promise<AuthedUser | null> {
  if (!token || revoked.has(token)) return null;
  const claims = await readToken(token);
  if (!claims) return null;
  // Re-read every time: a deleted or demoted account must lose access at once,
  // without waiting for the token to expire.
  const user = await userStore().findById(claims.uid);
  if (!user) return null;
  return { id: user.id, email: user.email, role: user.role, orgId: user.orgId };
}

/** Drop revoked tokens once they would have expired anyway. */
setInterval(async () => {
  for (const t of revoked) if (!(await readToken(t))) revoked.delete(t);
}, 60_000).unref?.();

export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export function sessionCookie(token: string, secureRequested: boolean): string {
  const bits = [
    `${SESSION_COOKIE}=${token}`,
    "HttpOnly", // not readable from JS, so an XSS cannot lift the session
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secureRequested) bits.push("Secure");
  return bits.join("; ");
}

export const clearCookie = () => `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;

/** Role ranking for permission checks. */
const RANK: Record<Role, number> = { viewer: 1, admin: 2, owner: 3 };
export const atLeast = (user: AuthedUser | null, role: Role): boolean => !!user && RANK[user.role] >= RANK[role];
