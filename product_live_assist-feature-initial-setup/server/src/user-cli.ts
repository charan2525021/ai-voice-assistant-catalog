import "./load-env.js";
import { randomBytes } from "node:crypto";
import { createUser, deleteUser, listUsers, login, resetUserPassword, type Role } from "./auth.js";
import { userStore } from "./auth-store.js";
import { flushEvents } from "./events.js";

/**
 * Manage login credentials from the command line.
 *
 * This exists because the HTTP user API requires an owner session, which is
 * useless when nobody can log in yet — a lost password would otherwise mean
 * hand-editing storage. It writes through the same createUser() the API uses,
 * so validation and hashing cannot drift between the two paths.
 *
 *   npm run user:create -- --email you@example.com [--password ...] [--role owner]
 *   npm run user:list
 *   npm run user:reset  -- --email you@example.com [--password ...]
 *   npm run user:delete -- --id <uuid>
 *   npm run user:check  -- --email you@example.com --password ...
 */

const argv = process.argv.slice(2);
const command = argv[0];
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const ROLES: Role[] = ["owner", "admin", "viewer"];
const usage = () => {
  console.log(`
Manage Aidan login credentials.

  npm run user:create -- --email <email> [--password <pw>] [--role owner|admin|viewer] [--org <uuid>]
  npm run user:list
  npm run user:reset  -- --email <email> [--password <pw>]
  npm run user:delete -- --id <uuid>
  npm run user:check  -- --email <email> --password <pw>

--password may be omitted on create; a strong one is generated and printed once.
Storage: PostgreSQL user_credentials when DATABASE_URL is set, else data/auth/users.json.
`.trim());
};

let exitCode = 0;
try {
  const store = userStore();

  if (command === "create") {
    const email = flag("email");
    if (!email) throw new Error("--email is required");
    const role = (flag("role") ?? "owner") as Role;
    if (!ROLES.includes(role)) throw new Error(`--role must be one of ${ROLES.join(", ")}`);
    // Default to the organization the durable data was imported under, so a new
    // account can actually see the products rather than landing in an empty tenant.
    const orgId = flag("org") ?? process.env.ADMIN_ORG_ID ?? "default";

    const generated = !flag("password");
    const password = flag("password") ?? randomBytes(12).toString("base64url");
    const user = await createUser(email, password, role, orgId);

    console.log(`\n  created ${user.email}  role=${user.role}`);
    console.log(`  id:    ${user.id}`);
    console.log(`  org:   ${user.orgId}`);
    if (generated) console.log(`  password: ${password}   <- shown once, save it now`);
    console.log(`  stored in: ${store.kind === "postgres" ? "PostgreSQL user_credentials" : "data/auth/users.json"}\n`);
  } else if (command === "reset") {
    const email = flag("email");
    if (!email) throw new Error("--email is required");
    const generated = !flag("password");
    const password = flag("password") ?? randomBytes(15).toString("base64url");
    const user = await resetUserPassword(email, password);
    const verified = await login(email, password);
    if (!verified) throw new Error("password was updated but verification failed");
    console.log(`\n  reset and verified ${user.email}  role=${user.role}`);
    if (generated) console.log(`  password: ${password}   <- shown once, save it now`);
    console.log();
  } else if (command === "list") {
    const users = await listUsers();
    if (!users.length) console.log("no accounts yet — create one with: npm run user:create -- --email you@example.com");
    for (const u of users) console.log(`  ${u.email.padEnd(30)} ${u.role.padEnd(7)} org=${u.orgId}  id=${u.id}`);
    console.log(`\n  backend: ${store.kind}`);
  } else if (command === "delete") {
    const id = flag("id");
    if (!id) throw new Error("--id is required (see: npm run user:list)");
    console.log(await deleteUser(id) ? `deleted ${id}` : `no such account: ${id}`);
  } else if (command === "check") {
    // Verifies a credential without going through HTTP — separates "bad password"
    // from "server or cookie problem" when a login fails.
    const email = flag("email");
    const password = flag("password");
    if (!email || !password) throw new Error("--email and --password are required");
    const result = await login(email, password);
    if (result) console.log(`OK — ${result.user.email} role=${result.user.role} org=${result.user.orgId}`);
    else { console.log("REJECTED — no such account, or wrong password"); exitCode = 1; }
  } else {
    usage();
    exitCode = command ? 1 : 0;
  }
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  exitCode = 1;
} finally {
  // emit() is fire-and-forget; flush before exit or the audit event is lost.
  await flushEvents().catch(() => {});
  await userStore().close().catch(() => {});
}
process.exit(exitCode);
