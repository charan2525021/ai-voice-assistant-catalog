import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { productDataDir } from "./knowledge/store.js";
import { atomicWrite } from "./atomic-write.js";

/**
 * Product registry — many products, added at runtime.
 *
 * Everything a product needs lives in `content/<id>/product.json`, NOT in .env.
 * The old design read PRODUCT + DEMO_* from the environment at module load,
 * which meant one product per server process and a restart to switch. Sessions
 * now name the product they want, so several can be demoed side by side.
 */

export const CONTENT_ROOT = fileURLToPath(new URL("../../content", import.meta.url));

export interface ProductAuth {
  /**
   * "none"    — public, no sign-in
   * "login"   — a simple username/password form we can fill ourselves
   * "session" — the HUMAN signed in interactively (Google SSO, 2FA, SAML…) and we
   *             captured the resulting browser session. We never see the password.
   * "profile" — the human signed in inside a REAL Google Chrome running a profile
   *             directory we own, and we drive that same profile afterwards.
   *             Required for Google SSO: Google refuses OAuth from Playwright's
   *             bundled Chromium ("this browser or app may not be secure"), so
   *             the sign-in has to happen in genuine, unautomated Chrome.
   */
  mode: "none" | "login" | "session" | "profile";
  username?: string;
  /** Stored per product. Keep the content folder out of version control if this is real. */
  password?: string;
  /**
   * Captured Playwright storageState (cookies + localStorage) from an interactive
   * sign-in. This IS a live credential — it grants access to the account — so it
   * stays in the product folder and is never returned by the API.
   */
  /**
   * Human label for WHICH account a session belongs to (e.g. an email).
   * Purely for the admin console when several accounts are linked — it is never
   * used to authenticate and is never typed into anything.
   */
  accountLabel?: string;
  sessionState?: string;
  /*
   * sessionStorage, per origin, as JSON. Playwright's storageState covers only
   * cookies and localStorage; an app that keeps its token in sessionStorage
   * (llmapi.ai does) is unrecoverable without this, because closing the browser
   * to capture the session is precisely what deletes it.
   */
  sessionStorage?: string;
  sessionCapturedAt?: string;
  sessionOrigins?: string[];
  /**
   * Chrome user-data-dir owned by this product (profile mode). The signed-in
   * state lives on disk here rather than in a copied cookie blob, so token
   * refresh and "remember this device" keep working across runs.
   */
  profileDir?: string;
  /** Optional explicit selectors when heuristic login detection isn't enough. */
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
}

/** Per-product voice, so each product's Aidan can sound distinct. */
export interface VoiceConfig {
  provider?: "sarvam" | "openai";
  speaker?: string;
  language?: string;
  pace?: number;
}

export interface ProductRecord {
  /**
   * A prospect-facing demo link. Lets a customer hand the demo to THEIR buyer
   * without creating an account for them — the PLG loop — while everything that
   * can change state stays behind a real login. Rotatable and revocable.
   */
  share?: { token: string; createdAt: string };
  id: string; // folder name, url-safe
  /** Compatibility-store tenant boundary. Production repositories enforce this with RLS. */
  organizationId: string;
  name: string; // display name
  startUrl: string;
  auth: ProductAuth;
  /** Sandbox-safe mutations this product explicitly permits, e.g. ["checkout"]. */
  allowActions?: string[];
  /** Spoken voice for this product (defaults to the global TTS settings). */
  voice?: VoiceConfig;
  createdAt: string;
  /** Recoverable operator removal. Archived products cannot start or share demos. */
  archivedAt?: string;
  /** Onboarding progress, so the UI can show state without guessing. */
  onboarding?: {
    status: "new" | "preflight_ok" | "preflight_failed" | "ingesting" | "mapping" | "awaiting_review" | "ready" | "failed";
    message?: string;
    updatedAt?: string;
    docChunks?: number;
    verifiedJourneys?: number;
  };
}

const manifestPath = (id: string) => path.join(CONTENT_ROOT, id, "product.json");
const localAuthPath = (id: string) => path.join(CONTENT_ROOT, id, ".auth.local.json");

/** Folder-name safe, stable id derived from a display name. */
export function toId(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || `product-${Date.now().toString(36)}`
  );
}

export async function listProducts(organizationId?: string, includeArchived = false): Promise<ProductRecord[]> {
  if (!existsSync(CONTENT_ROOT)) return [];
  const out: ProductRecord[] = [];
  for (const entry of await fs.readdir(CONTENT_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue; // _template is not a product
    const rec = await getProduct(entry.name);
    if (rec && (includeArchived || !rec.archivedAt) && (!organizationId || rec.organizationId === organizationId)) out.push(rec);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getProduct(id: string, organizationId?: string): Promise<ProductRecord | null> {
  const f = manifestPath(id);
  if (!existsSync(f)) return null;
  try {
    const raw = JSON.parse(await fs.readFile(f, "utf8"));
    let localAuth: Partial<ProductAuth> = {};
    if (existsSync(localAuthPath(id))) {
      try { localAuth = JSON.parse(await fs.readFile(localAuthPath(id), "utf8")); }
      catch (error) { console.warn(`[products] could not read local auth for ${id}: ${(error as Error).message}`); }
    }
    const rec: ProductRecord = {
      id,
      organizationId: raw.organizationId ?? "default",
      name: raw.name ?? id,
      startUrl: raw.startUrl ?? "",
      // Tolerate the older shape where auth lived in .env / flat fields.
      auth: {
        ...(raw.auth ?? { mode: raw.authMode ?? "none", username: raw.username, password: raw.password }),
        ...localAuth,
      },
      allowActions: raw.allowActions ?? [],
      voice: raw.voice ?? {},
      createdAt: raw.createdAt ?? new Date().toISOString(),
      onboarding: raw.onboarding ?? { status: "new" },
      share: raw.share,
      archivedAt: raw.archivedAt,
    };
    return organizationId && rec.organizationId !== organizationId ? null : rec;
  } catch (e) {
    // Swallowing this made a corrupt manifest look like "product not found",
    // which sends you looking in entirely the wrong place.
    console.warn(`[products] could not read ${id}: ${(e as Error).message}`);
    return null;
  }
}

/** Hide a product and revoke its share links while retaining data for recovery. */
export async function archiveProduct(id: string, organizationId?: string): Promise<ProductRecord | null> {
  const rec = await getProduct(id, organizationId);
  if (!rec) return null;
  rec.archivedAt = new Date().toISOString();
  rec.share = undefined;
  await saveProduct(rec);
  return rec;
}

export async function saveProduct(rec: ProductRecord): Promise<void> {
  const dir = path.join(CONTENT_ROOT, rec.id);
  await fs.mkdir(path.join(dir, "docs"), { recursive: true });
  await fs.mkdir(path.join(dir, "marketing"), { recursive: true });
  const { username, password, sessionState, sessionStorage, profileDir, ...publicAuth } = rec.auth;
  const { id, ...record } = rec;
  const body = { ...record, auth: publicAuth };
  await atomicWrite(manifestPath(rec.id), JSON.stringify(body, null, 2));

  // Compatibility mode may still use local browser credentials. Keep them out
  // of the committable product manifest; durable deployments use Vault refs.
  const localAuth = Object.fromEntries(Object.entries({
    username, password, sessionState, sessionStorage, profileDir,
  }).filter(([, value]) => value !== undefined && value !== ""));
  if (Object.keys(localAuth).length) {
    await atomicWrite(localAuthPath(rec.id), JSON.stringify(localAuth), { mode: 0o600 });
  }
}

export async function setStatus(
  id: string,
  status: NonNullable<ProductRecord["onboarding"]>["status"],
  message?: string,
  extra: Partial<NonNullable<ProductRecord["onboarding"]>> = {},
): Promise<void> {
  const rec = await getProduct(id);
  if (!rec) return;
  rec.onboarding = { ...(rec.onboarding ?? {}), ...extra, status, message, updatedAt: new Date().toISOString() };
  await saveProduct(rec);
}

/**
 * Create the content folder for a new product, with starter files so the Brain
 * has somewhere to put knowledge and the operator can see what to fill in.
 */
/**
 * Remove a product and everything it owns.
 *
 * Deletes BOTH roots, because a product is split across two of them: its
 * definition and credentials live in content/<id>/, and its learned graph,
 * documents and session history live in data/brain/<id>/. Removing only the
 * first leaves the brain behind, and a product recreated under the same id
 * would silently inherit a previous product's journeys and documents.
 *
 * This is also the revocation path: content/<id>/chrome-profile and any stored
 * session state are live credentials, so deleting the folder is what actually
 * withdraws access. Returns what was removed so the caller can report honestly
 * rather than claiming success for a product that was not there.
 */
export async function deleteProduct(id: string): Promise<{ content: boolean; brain: boolean }> {
  // Guard against "..", absolute paths and separators before building any path
  // from caller-supplied input — this function removes directories recursively.
  if (!id || id !== path.basename(id) || id === "." || id === "..") {
    throw new Error("invalid product id");
  }
  const contentDir = path.join(CONTENT_ROOT, id);
  const brainDir = productDataDir(id);
  const content = existsSync(contentDir);
  const brain = existsSync(brainDir);
  if (content) await fs.rm(contentDir, { recursive: true, force: true });
  if (brain) await fs.rm(brainDir, { recursive: true, force: true });
  return { content, brain };
}

export async function scaffoldProduct(input: {
  organizationId?: string;
  name: string;
  startUrl: string;
  auth?: ProductAuth;
  allowActions?: string[];
  voice?: VoiceConfig;
  notes?: string;
}): Promise<ProductRecord> {
  const organizationId = input.organizationId?.trim() || "default";
  let id = toId(input.name);
  // The filesystem compatibility adapter needs a globally unique folder. The
  // durable repository uses (organization_id, product_key) instead.
  const collision = await getProduct(id);
  if (collision && collision.organizationId !== organizationId) id = `${id}-${crypto.randomUUID().slice(0, 6)}`;
  const dir = path.join(CONTENT_ROOT, id);
  const rec: ProductRecord = {
    id,
    organizationId,
    name: input.name,
    startUrl: input.startUrl,
    auth: input.auth ?? { mode: "none" },
    allowActions: input.allowActions ?? [],
    voice: input.voice ?? {},
    createdAt: new Date().toISOString(),
    onboarding: { status: "new" },
  };
  await saveProduct(rec);

  // Seed the knowledge folders. Docs are what stop Aidan inventing features, so
  // make the placeholder explicit rather than leaving an empty directory.
  const docFile = path.join(dir, "docs", "overview.md");
  if (!existsSync(docFile)) {
    await fs.writeFile(
      docFile,
      `# About ${input.name}\n\n` +
        (input.notes ? `${input.notes}\n\n` : "") +
        `Replace this with real product documentation — help-centre articles, feature guides, FAQs.\n` +
        `${config.assistantName} may only state facts that appear here, so anything missing becomes "I'm not certain".\n`,
    );
  }
  for (const [file, content] of [
    ["flows.json", "[]\n"],
    ["personas.json", "[]\n"],
    ["playbook.json", "[]\n"],
  ] as const) {
    const f = path.join(dir, file);
    if (!existsSync(f)) await fs.writeFile(f, content);
  }
  return rec;
}
