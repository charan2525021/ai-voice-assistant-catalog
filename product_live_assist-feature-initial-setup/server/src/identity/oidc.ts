import { createPublicKey, verify } from "node:crypto";
import type { AuthedUser, Role } from "../auth.js";

interface JwtHeader { alg: string; kid?: string }
interface Claims { sub?: string; email?: string; exp?: number; nbf?: number; iss?: string; aud?: string | string[]; [key: string]: unknown }
interface Jwk { kid?: string; kty: string; alg?: string; use?: string; [key: string]: unknown }

const decode = <T>(value: string): T => JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;

/** Minimal RS256 OIDC verifier. It trusts claims only after JWKS signature and issuer/audience checks. */
export class OidcIdentityProvider {
  private keys = new Map<string, Jwk>();
  private refreshedAt = 0;
  constructor(private readonly options: {
    jwksUri: string;
    issuer: string;
    audience: string;
    organizationClaim: string;
    roleClaim: string;
  }) {}

  private async refresh(force = false): Promise<void> {
    if (!force && Date.now() - this.refreshedAt < 60 * 60_000 && this.keys.size) return;
    const response = await fetch(this.options.jwksUri, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) throw new Error(`OIDC JWKS request failed: HTTP ${response.status}`);
    const body = await response.json() as { keys?: Jwk[] };
    this.keys = new Map((body.keys ?? []).filter((key) => key.kid).map((key) => [key.kid!, key]));
    this.refreshedAt = Date.now();
  }

  async authenticate(authorization: string | undefined): Promise<AuthedUser | null> {
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    try {
      const header = decode<JwtHeader>(parts[0]);
      if (header.alg !== "RS256" || !header.kid) return null;
      await this.refresh();
      let jwk = this.keys.get(header.kid);
      if (!jwk) { await this.refresh(true); jwk = this.keys.get(header.kid); }
      if (!jwk) return null;
      const valid = verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk as any, format: "jwk" }), Buffer.from(parts[2], "base64url"));
      if (!valid) return null;
      const claims = decode<Claims>(parts[1]);
      const now = Math.floor(Date.now() / 1000);
      const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!claims.sub || !claims.exp || claims.exp <= now || (claims.nbf && claims.nbf > now) ||
          claims.iss !== this.options.issuer || !audience.includes(this.options.audience)) return null;
      const organizationId = String(claims[this.options.organizationClaim] ?? "");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(organizationId)) return null;
      const rawRole = claims[this.options.roleClaim];
      const values = (Array.isArray(rawRole) ? rawRole : [rawRole]).map(String).map((value) => value.toLowerCase());
      const role: Role = values.includes("owner") ? "owner" : values.includes("admin") ? "admin" : "viewer";
      return { id: claims.sub, email: String(claims.email ?? claims.sub), role, orgId: organizationId };
    } catch {
      return null;
    }
  }
}

export function createOidcIdentityProvider(): OidcIdentityProvider | null {
  if (!process.env.OIDC_JWKS_URI || !process.env.OIDC_ISSUER || !process.env.OIDC_AUDIENCE) return null;
  return new OidcIdentityProvider({
    jwksUri: process.env.OIDC_JWKS_URI,
    issuer: process.env.OIDC_ISSUER,
    audience: process.env.OIDC_AUDIENCE,
    organizationClaim: process.env.OIDC_ORGANIZATION_CLAIM ?? "organization_id",
    roleClaim: process.env.OIDC_ROLE_CLAIM ?? "roles",
  });
}
