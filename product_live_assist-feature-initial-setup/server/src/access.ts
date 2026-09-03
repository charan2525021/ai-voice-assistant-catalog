import type { PageSnapshot } from "./livebox.js";

/** Product-neutral detection of a sign-in wall. */
const AUTH_PATH = /\/(?:login|log-in|signin|sign-in|auth|authenticate|sso)(?:\/|\?|#|$)/i;
const AUTH_HOST = /(?:^|\.)(?:accounts\.google\.com|login\.microsoftonline\.com|auth0\.com|okta\.com)$/i;

export function looksLikeAuthenticationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return AUTH_HOST.test(url.hostname) || AUTH_PATH.test(`${url.pathname}${url.search}${url.hash}`);
  } catch {
    return false;
  }
}

export interface AccessAssessment {
  ok: boolean;
  reachable: boolean;
  authenticationSurface: boolean;
  passwordVisible: boolean;
  redirectedOutsideProduct: boolean;
  message: string;
}

/**
 * Decide whether a browser is inside the requested product rather than on a
 * login/identity page. This deliberately uses standards (URL, input types and
 * accessible names), never selectors belonging to one customer's UI.
 */
export function assessProductAccess(
  startUrl: string,
  snap: Pick<PageSnapshot, "url" | "title" | "elements">,
  requiresAuthentication = false,
): AccessAssessment {
  const reachable = /^https?:\/\//i.test(snap.url);
  const passwordVisible = snap.elements.some(
    (item) => (item.type || "").toLowerCase() === "password" || /password/i.test(item.name ?? ""),
  );
  const identityInput = snap.elements.some((item) =>
    (item.type || "").toLowerCase() === "email" ||
    (/\b(email|user(?:name)?)\b/i.test(item.name ?? item.placeholder ?? "") && ["input", "textbox"].includes(item.tag || item.role || "")),
  );
  const signInAction = snap.elements.some((item) =>
    /^(?:log\s*in|sign\s*in|continue with|use sso)\b/i.test((item.name || item.text || "").trim()),
  );
  const authenticationSurface = passwordVisible || looksLikeAuthenticationUrl(snap.url) || (identityInput && signInAction);

  let redirectedOutsideProduct = false;
  try {
    redirectedOutsideProduct = new URL(startUrl).origin !== new URL(snap.url).origin;
  } catch {
    redirectedOutsideProduct = false;
  }

  const ok = reachable && !authenticationSurface && !(requiresAuthentication && redirectedOutsideProduct);
  const message = !reachable
    ? `Could not load ${startUrl}.`
    : authenticationSurface
      ? `Opening ${startUrl} landed on an authentication page (${snap.url}). Re-authenticate before mapping.`
      : requiresAuthentication && redirectedOutsideProduct
        ? `Opening ${startUrl} left the product origin and landed on ${snap.url}. Re-authenticate before mapping.`
        : `Access confirmed at ${snap.url}.`;

  return { ok, reachable, authenticationSurface, passwordVisible, redirectedOutsideProduct, message };
}
