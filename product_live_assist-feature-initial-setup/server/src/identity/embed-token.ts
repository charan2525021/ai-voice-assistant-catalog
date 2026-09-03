import { createHmac, timingSafeEqual } from "node:crypto";

export interface EmbedTokenClaims {
  v: 1;
  jti: string;
  organizationId: string;
  productId: string;
  roleProfileId: string;
  exp: number;
}

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function secret(value = process.env.EMBED_TOKEN_SECRET): string {
  if (!value || value.length < 32) throw new Error("EMBED_TOKEN_SECRET must contain at least 32 characters");
  return value;
}

export function issueEmbedToken(claims: EmbedTokenClaims, signingSecret?: string): string {
  const payload = encode(claims);
  const signature = createHmac("sha256", secret(signingSecret)).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyEmbedToken(token: string, signingSecret?: string, now = Date.now()): EmbedTokenClaims | null {
  try {
    const [payload, supplied, extra] = token.split(".");
    if (!payload || !supplied || extra) return null;
    const expected = createHmac("sha256", secret(signingSecret)).update(payload).digest();
    const actual = Buffer.from(supplied, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as EmbedTokenClaims;
    if (claims.v !== 1 || !claims.jti || !claims.organizationId || !claims.productId || !claims.roleProfileId) return null;
    if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= now) return null;
    return claims;
  } catch {
    return null;
  }
}

export function normalizedAllowedOrigin(value: string): string {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`invalid embed origin: ${value}`);
  }
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("embed origins must use HTTPS except on localhost");
  }
  return url.origin;
}
