import "dotenv/config";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { tenantContext } from "./domain/context.js";
import { issueEmbedToken, normalizedAllowedOrigin } from "./identity/embed-token.js";
import { DurableBackbone } from "./platform/backbone.js";
import { LocalObjectStore } from "./catalog/object-store.js";

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const databaseUrl = required("DATABASE_URL");
const organizationId = required("UAT_ORG_ID");
const productId = required("UAT_PRODUCT_ID");
const secretPath = required("UAT_SECRET_PATH");
const origin = normalizedAllowedOrigin(process.env.UAT_ORIGIN ?? "http://localhost:8787");
const ttlSeconds = Math.max(300, Math.min(30 * 24 * 60 * 60, Number(process.env.UAT_TTL_SECONDS ?? 7 * 24 * 60 * 60)));
const ctx = tenantContext({ organizationId, actorId: randomUUID(), requestId: randomUUID() });
const backend = new DurableBackbone(databaseUrl, process.env.REDIS_URL);

try {
  const aggregate = await backend.repositories.products.get(ctx, productId);
  if (!aggregate?.product.activeCatalogVersionId) throw new Error("UAT product has no published catalog");
  const active = await backend.repositories.catalogs.getActive(ctx, productId);
  if (!active) throw new Error("UAT product has no active catalog snapshot");
  const environment = aggregate.environments.find((item) => item.id === active.catalog.environmentId);
  const role = aggregate.roles.find((item) => item.id === process.env.UAT_ROLE_ID)
    ?? aggregate.roles.find((item) => item.environmentId === environment?.id);
  if (!environment || !role) throw new Error("UAT product has no role for its published environment");

  const now = new Date().toISOString();
  const credentialId = role.credentialRefId ?? randomUUID();
  await backend.repositories.access.saveCredentialRef(ctx, {
    id: credentialId,
    organizationId,
    provider: "local-file",
    secretPath,
    metadata: { purpose: "local UAT browser session" },
    createdAt: now,
    updatedAt: now,
  });
  if (role.credentialRefId !== credentialId) {
    await backend.repositories.access.saveRoleProfile(ctx, { ...role, credentialRefId: credentialId, updatedAt: now });
  }
  await backend.secrets.resolve({ provider: "local-file", secretPath });

  // Integration mapping can publish into an in-memory artifact store. Repair
  // that one-time UAT artifact through the normal immutable successor/publish
  // path so a cold worker can always load it from disk.
  const objectRoot = process.env.OBJECT_STORE_PATH
    ?? fileURLToPath(new URL("../../data/objects", import.meta.url));
  const objects = new LocalObjectStore(objectRoot);
  const artifact = active.catalog.bundleKey ? await objects.get(active.catalog.bundleKey) : null;
  let catalogVersionId = active.catalog.id;
  if (!artifact) {
    const successor = await backend.repositories.catalogs.createDraft(ctx, productId, environment.id);
    catalogVersionId = (await backend.catalogs.publish(ctx, successor.id)).catalogVersionId;
  }

  const grantId = randomUUID();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  await backend.repositories.access.saveEmbedGrant(ctx, {
    id: grantId,
    organizationId,
    productId,
    roleProfileId: role.id,
    allowedOrigins: [origin],
    expiresAt,
    createdAt: now,
    updatedAt: now,
  });
  const token = issueEmbedToken({
    v: 1,
    jti: grantId,
    organizationId,
    productId,
    roleProfileId: role.id,
    exp: Math.floor(Date.parse(expiresAt) / 1000),
  });
  const query = new URLSearchParams({ product: productId, role: role.id, embed: token });
  console.log(JSON.stringify({
    url: `${origin}/?${query}`,
    productId,
    roleProfileId: role.id,
    catalogVersionId,
    screens: active.screens.length,
    journeys: active.journeys.filter((item) => item.verificationStatus === "verified").length,
    expiresAt,
  }));
} finally {
  await backend.close();
}
