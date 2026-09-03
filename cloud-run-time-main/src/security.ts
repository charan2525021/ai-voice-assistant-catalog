import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const encode = (value: Buffer | string) => Buffer.from(value).toString("base64url");
const decode = (value: string) => Buffer.from(value, "base64url");

export function hashCredential(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function credentialMatches(value: string, expectedHex: string): boolean {
  const actual = Buffer.from(hashCredential(value), "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export interface SignedClaims { purpose: "identity" | "session" | "control_ticket" | "voice_ticket" | "audio_ticket"; sub: string; exp: number; [key: string]: unknown; }

export class TokenSigner {
  constructor(private readonly secret: string) {}
  sign(claims: SignedClaims): string {
    const body = encode(JSON.stringify(claims));
    const signature = createHmac("sha256", this.secret).update(body).digest("base64url");
    return `${body}.${signature}`;
  }
  verify<T extends SignedClaims>(token: string, purpose: T["purpose"]): T {
    const [body, signature, extra] = token.split(".");
    if (!body || !signature || extra) throw new Error("Malformed token");
    const expected = createHmac("sha256", this.secret).update(body).digest();
    const actual = decode(signature);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Invalid token signature");
    const claims = JSON.parse(decode(body).toString("utf8")) as T;
    if (claims.purpose !== purpose) throw new Error("Token purpose mismatch");
    if (!Number.isFinite(claims.exp) || claims.exp <= Date.now()) throw new Error("Token expired");
    return claims;
  }

  /** Stable but non-reversible identifier for a server-owned scope. */
  opaqueId(prefix: string, ...scope: string[]): string {
    const digest = createHmac("sha256", this.secret).update(scope.join("\u001f")).digest("base64url").slice(0, 32);
    return `${prefix}_${digest}`;
  }
}

export const createId = (prefix: string): string => `${prefix}_${randomBytes(12).toString("base64url")}`;
export const createCredential = (): string => `sable_installation_${randomBytes(32).toString("base64url")}`;
