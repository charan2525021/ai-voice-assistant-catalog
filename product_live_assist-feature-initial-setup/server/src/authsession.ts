import { LiveBox } from "./livebox.js";
import { getProduct, saveProduct, type ProductRecord } from "./products.js";

/**
 * Interactive sign-in.
 *
 * Products behind Google SSO, SAML or 2FA cannot be automated with a username and
 * password — and we should never hold one anyway. But we already run the browser
 * and can stream it with input takeover, so the human can sign in THEMSELVES:
 *
 *   open the login page  →  stream it to the admin  →  the user clicks
 *   "Sign in with Google" and types their own credentials  →  they confirm  →
 *   we capture the resulting session (cookies + localStorage) and reuse it.
 *
 * Two properties that matter:
 *  - The password never reaches our process. The agent's hard block on typing
 *    passwords stays intact; a *person* is typing, not the agent.
 *  - What we store is a live credential (a session), so it is written only into
 *    the product folder, never returned by the API, and is revocable by clearing it.
 */

interface AuthSession {
  id: string;
  productId: string;
  organizationId: string;
  box: LiveBox;
  startedAt: number;
  lastSeenAt: number;
}

const sessions = new Map<string, AuthSession>();
const TTL_MS = Number(process.env.AUTH_SESSION_TTL_MS ?? 15 * 60_000);

/** Reap abandoned sign-in windows so we don't leak browsers. */
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastSeenAt > TTL_MS) {
      void s.box.stop().catch(() => {});
      sessions.delete(id);
      console.log(`[auth] sign-in window ${id} expired`);
    }
  }
}, 60_000).unref?.();

export function getAuthSession(id: string): AuthSession | undefined {
  const s = sessions.get(id);
  if (s) s.lastSeenAt = Date.now();
  return s;
}

/**
 * Open a browser at the product's sign-in page, ready to be streamed and driven
 * by the human. Starts SIGNED OUT even if a session exists, so re-authenticating
 * is always possible.
 */
export async function startAuthSession(rec: ProductRecord, loginUrl?: string): Promise<{ authSessionId: string; url: string }> {
  const box = new LiveBox({
    startUrl: loginUrl || rec.startUrl,
    // Deliberately ignore any stored session: this flow exists to create one.
    auth: { mode: "none" },
    allowActions: rec.allowActions,
  });
  await box.start();
  const id = `auth-${Math.random().toString(36).slice(2, 10)}`;
  sessions.set(id, { id, productId: rec.id, organizationId: rec.organizationId, box, startedAt: Date.now(), lastSeenAt: Date.now() });
  console.log(`[auth] sign-in window ${id} open for "${rec.id}" at ${box.currentUrl()}`);
  return { authSessionId: id, url: box.currentUrl() };
}

/** Where the human currently is — used to ask "grant access to this?" */
export async function authSessionStatus(id: string) {
  const s = getAuthSession(id);
  if (!s) return null;
  const snap = await s.box.snapshot();
  const signedIn = !snap.elements.some((e) => (e.type || "").toLowerCase() === "password");
  return {
    url: snap.url,
    title: snap.title,
    controls: snap.elements.length,
    /** Heuristic only: no password field on screen usually means we're through. */
    looksSignedIn: signedIn,
    origins: await s.box.sessionOrigins(),
  };
}

/**
 * Capture the session the human just created and attach it to the product.
 * `useCurrentUrlAsStart` is offered because SSO lands you on a dashboard, which is
 * usually a better demo entry point than the login page.
 */
export async function captureAuthSession(id: string, opts: { useCurrentUrlAsStart?: boolean } = {}) {
  const s = getAuthSession(id);
  if (!s) return { ok: false as const, error: "sign-in window not found or expired" };
  const rec = await getProduct(s.productId);
  if (!rec) return { ok: false as const, error: "unknown product" };

  /*
   * Verify BEFORE committing — a claim of being signed in is not evidence of it.
   *
   * This used to save whatever storage existed and report success. On HubSpot it
   * therefore captured a login page's Cloudflare cookies, set mode="session",
   * and overwrote startUrl with the login URL — corrupting the product manifest
   * while telling the user they were finished. The profile route has re-probed
   * since it was written (`finishDesktopSignIn`); session mode never grew the
   * same check, and the asymmetry stayed invisible until a product turned up
   * whose login shows an email step before any password field.
   */
  const landedOn = s.box.currentUrl();
  const snap = await s.box.snapshot().catch(() => null);
  const passwordVisible = !!snap?.elements.some(
    (e) => (e.type || "").toLowerCase() === "password" || /password/i.test(e.name ?? ""),
  );
  const looksLikeAuthPage = /\/(login|signin|sign-in|auth|sso|authenticate)(\b|\/|\?|$)/i.test(landedOn);
  if (passwordVisible || looksLikeAuthPage) {
    return {
      ok: false as const,
      error: `Still on an authentication page (${landedOn}). Finish signing in until the product's own dashboard is showing, then capture.`,
    };
  }

  const state = await s.box.saveAuthState();
  if (!state) return { ok: false as const, error: "could not read the browser session" };

  const origins = await s.box.sessionOrigins();

  rec.auth = { ...rec.auth, mode: "session", sessionState: state, sessionCapturedAt: new Date().toISOString(), sessionOrigins: origins };
  if (opts.useCurrentUrlAsStart && landedOn && !/^chrome-error:/.test(landedOn)) rec.startUrl = landedOn;
  await saveProduct(rec);

  await s.box.stop().catch(() => {});
  sessions.delete(id);
  console.log(`[auth] captured session for "${rec.id}" covering ${origins.join(", ") || "(no origins)"}`);

  return {
    ok: true as const,
    product: rec.id,
    startUrl: rec.startUrl,
    origins,
    cookieCount: (() => {
      try {
        return JSON.parse(state).cookies?.length ?? 0;
      } catch {
        return 0;
      }
    })(),
  };
}

export async function cancelAuthSession(id: string): Promise<void> {
  const s = sessions.get(id);
  if (!s) return;
  await s.box.stop().catch(() => {});
  sessions.delete(id);
}

/** Forget a stored session — the revoke path. */
export async function clearStoredSession(productId: string): Promise<boolean> {
  const rec = await getProduct(productId);
  if (!rec) return false;
  rec.auth = {
    ...rec.auth,
    mode: rec.auth.username ? "login" : "none",
    sessionState: undefined,
    sessionCapturedAt: undefined,
    sessionOrigins: undefined,
    // The caller deletes the profile directory itself; drop the pointer here so a
    // half-revoked product can never come back up in profile mode.
    profileDir: undefined,
  };
  await saveProduct(rec);
  return true;
}
