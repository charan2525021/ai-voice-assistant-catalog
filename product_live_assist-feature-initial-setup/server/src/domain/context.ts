/**
 * Identity carried through every storage and runtime operation.
 *
 * Product ids are not an authorization boundary.  A caller must always supply
 * the organization that owns the product; repositories enforce that scope even
 * when an id from another tenant is accidentally (or maliciously) supplied.
 */
export interface TenantContext {
  organizationId: string;
  actorId: string;
  requestId: string;
}

export function tenantContext(input: Partial<TenantContext> & Pick<TenantContext, "organizationId">): TenantContext {
  const organizationId = input.organizationId.trim();
  if (!organizationId) throw new Error("organizationId is required");
  return {
    organizationId,
    actorId: input.actorId?.trim() || "system",
    requestId: input.requestId?.trim() || crypto.randomUUID(),
  };
}

export function tenantKey(ctx: Pick<TenantContext, "organizationId">, ...parts: string[]): string {
  return [ctx.organizationId, ...parts].map((part) => encodeURIComponent(part)).join(":");
}

export function assertTenantOwned(
  ctx: Pick<TenantContext, "organizationId">,
  entity: { organizationId: string },
): void {
  if (ctx.organizationId !== entity.organizationId) {
    // Return the same result as a missing row at API boundaries.  The error does
    // not disclose which organization actually owns the supplied identifier.
    throw new TenantIsolationError();
  }
}

export class TenantIsolationError extends Error {
  readonly code = "TENANT_SCOPE_VIOLATION";
  constructor() {
    super("resource not found in this organization");
  }
}
