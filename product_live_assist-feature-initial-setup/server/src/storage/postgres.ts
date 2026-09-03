import { createHash, randomUUID } from "node:crypto";
import type { TenantContext } from "../domain/context.js";
import type { CatalogVersion, CoverageItem, CredentialRef, EmbedGrant, JourneyVersion, Product, ProductEnvironment, RoleProfile, SalesPlay } from "../domain/catalog.js";
import type { CustomerSession, FeedbackSignal, JourneyCorrection, MappingJob, TrainingEvent } from "../domain/runtime.js";
import { Database, type TenantClient } from "./database.js";
import type { AccessRepository, CatalogRepository, CatalogSnapshot, KnowledgeDocumentInput, KnowledgeHit, KnowledgeRepository, MappedCatalogInput, MappingJobRepository, NewProduct, PlanningKnowledgeChunk, PlatformRepositories, ProductAggregate, ProductRepository, SessionRepository, TrainingRepository } from "./contracts.js";
import { durableJourneyChecksum } from "../catalog/review-policy.js";

const iso = (value: unknown): string => value instanceof Date ? value.toISOString() : String(value);
const obj = <T>(value: unknown, fallback: T): T => (value && typeof value === "object" ? value : fallback) as T;

function productRow(row: any): Product {
  return {
    id: row.id,
    organizationId: row.organization_id,
    key: row.product_key,
    name: row.name,
    activeCatalogVersionId: row.active_catalog_version_id ?? undefined,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function environmentRow(row: any): ProductEnvironment {
  return {
    id: row.id,
    organizationId: row.organization_id,
    productId: row.product_id,
    key: row.environment_key,
    name: row.name,
    startUrl: row.start_url,
    productVersion: row.product_version ?? undefined,
    locale: row.locale,
    featureFlags: obj(row.feature_flags, {}),
    resetAdapterType: row.reset_adapter_type ?? undefined,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function roleRow(row: any): RoleProfile {
  return {
    id: row.id,
    organizationId: row.organization_id,
    environmentId: row.environment_id,
    key: row.role_key,
    name: row.name,
    credentialRefId: row.credential_ref_id ?? undefined,
    permissionHints: obj(row.permission_hints, []),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function catalogRow(row: any): CatalogVersion {
  return {
    id: row.id,
    organizationId: row.organization_id,
    productId: row.product_id,
    environmentId: row.environment_id,
    version: row.version,
    status: row.status,
    schemaVersion: row.schema_version,
    bundleKey: row.bundle_key ?? undefined,
    bundleChecksum: row.bundle_checksum ?? undefined,
    publishedAt: row.published_at ? iso(row.published_at) : undefined,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

async function aggregate(client: TenantClient, product: Product): Promise<ProductAggregate> {
  const environments = await client.query("SELECT * FROM environments WHERE product_id = $1 ORDER BY created_at", [product.id]);
  const environmentIds = environments.rows.map((row: any) => row.id);
  const roles = environmentIds.length
    ? await client.query("SELECT * FROM role_profiles WHERE environment_id = ANY($1::uuid[]) ORDER BY created_at", [environmentIds])
    : { rows: [] as any[] };
  return { product, environments: environments.rows.map(environmentRow), roles: roles.rows.map(roleRow) };
}

export class PostgresProductRepository implements ProductRepository {
  constructor(private readonly database: Database) {}

  list(ctx: TenantContext): Promise<ProductAggregate[]> {
    return this.database.withTenant(ctx, async (client) => {
      const rows = await client.query("SELECT * FROM products ORDER BY name");
      return Promise.all(rows.rows.map((row: any) => aggregate(client, productRow(row))));
    });
  }

  get(ctx: TenantContext, productId: string): Promise<ProductAggregate | null> {
    return this.database.withTenant(ctx, async (client) => {
      const rows = await client.query("SELECT * FROM products WHERE id = $1", [productId]);
      return rows.rowCount ? aggregate(client, productRow(rows.rows[0])) : null;
    });
  }

  create(ctx: TenantContext, input: NewProduct): Promise<ProductAggregate> {
    return this.database.withTenant(ctx, async (client) => {
      const product = await client.query(
        `INSERT INTO products(organization_id, product_key, name)
         VALUES ($1, $2, $3) RETURNING *`,
        [ctx.organizationId, input.key, input.name],
      );
      const environment = await client.query(
        `INSERT INTO environments(
           organization_id, product_id, environment_key, name, start_url,
           product_version, locale, feature_flags
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING *`,
        [
          ctx.organizationId,
          product.rows[0].id,
          input.environment.key,
          input.environment.name,
          input.environment.startUrl,
          input.environment.productVersion ?? null,
          input.environment.locale ?? "en-US",
          JSON.stringify(input.environment.featureFlags ?? {}),
        ],
      );
      const role = await client.query(
        `INSERT INTO role_profiles(organization_id, environment_id, role_key, name)
         VALUES ($1,$2,'default','Default role') RETURNING *`,
        [ctx.organizationId, environment.rows[0].id],
      );
      return { product: productRow(product.rows[0]), environments: [environmentRow(environment.rows[0])], roles: [roleRow(role.rows[0])] };
    });
  }

  remove(ctx: TenantContext, productId: string): Promise<boolean> {
    return this.database.withTenant(ctx, async (client) => {
      /*
       * customer_sessions references environments and catalog_versions with ON
       * DELETE RESTRICT — deliberately, so a live conversation cannot have the
       * catalog it is pinned to deleted underneath it. That also means a plain
       * DELETE on the product fails for any product that was ever demoed, so the
       * session rows must go first. This is an explicit operator action on a
       * whole product, which is precisely the case that restriction is not
       * meant to prevent.
       */
      await client.query(
        `DELETE FROM customer_sessions
          WHERE organization_id = $1
            AND environment_id IN (SELECT id FROM environments WHERE product_id = $2)`,
        [ctx.organizationId, productId],
      );
      // active_catalog_version_id points into catalog_versions, which is itself
      // about to cascade away; clearing it first avoids ordering games.
      await client.query("UPDATE products SET active_catalog_version_id = NULL WHERE id = $1", [productId]);
      const removed = await client.query("DELETE FROM products WHERE id = $1", [productId]);
      return (removed.rowCount ?? 0) > 0;
    });
  }
}

async function loadSnapshot(client: TenantClient, catalog: CatalogVersion): Promise<CatalogSnapshot> {
  // A single pg client executes one query at a time. Explicit sequencing avoids
  // pg@9's concurrent-query rejection while the transaction holds tenant scope.
  const journeys = await client.query(
    `SELECT jv.*, j.journey_key FROM journey_versions jv
     JOIN journeys j ON j.organization_id = jv.organization_id AND j.id = jv.journey_id
     WHERE jv.catalog_version_id = $1`,
    [catalog.id],
  );
  const salesPlays = await client.query("SELECT * FROM sales_plays WHERE catalog_version_id = $1", [catalog.id]);
  const coverage = await client.query("SELECT * FROM coverage_items WHERE catalog_version_id = $1", [catalog.id]);
  const screenRows = await client.query(
    `SELECT st.screen_key,st.name,st.url_template,st.purpose,ss.id AS state_id,ss.fingerprint,ss.conditions
     FROM screen_states ss JOIN screen_types st ON st.organization_id=ss.organization_id AND st.id=ss.screen_type_id
     WHERE ss.catalog_version_id=$1 ORDER BY st.screen_key,ss.state_key`,
    [catalog.id],
  );
  const controlRows = await client.query(
    `SELECT c.screen_state_id,c.control_key,c.role,c.accessible_name,c.risk
     FROM controls c WHERE c.catalog_version_id=$1 ORDER BY c.control_key`,
    [catalog.id],
  );
  const transitionRows = await client.query(
    `SELECT fst.screen_key AS from_screen_key,fs.fingerprint AS from_fingerprint,fs.conditions AS from_conditions,
       tst.screen_key AS to_screen_key,ts.fingerprint AS to_fingerprint,c.control_key,t.action,t.reliability
     FROM transitions t
     JOIN screen_states fs ON fs.organization_id=t.organization_id AND fs.id=t.from_state_id
     JOIN screen_types fst ON fst.organization_id=fs.organization_id AND fst.id=fs.screen_type_id
     LEFT JOIN screen_states ts ON ts.organization_id=t.organization_id AND ts.id=t.to_state_id
     LEFT JOIN screen_types tst ON tst.organization_id=ts.organization_id AND tst.id=ts.screen_type_id
     LEFT JOIN controls c ON c.organization_id=t.organization_id AND c.id=t.control_id
     WHERE t.catalog_version_id=$1 AND t.verification_status='verified'`,
    [catalog.id],
  );
  const controlsByState = new Map<string, any[]>();
  for (const row of controlRows.rows) {
    const controls = controlsByState.get(String(row.screen_state_id)) ?? [];
    controls.push({ key: row.control_key, role: row.role ?? undefined, accessibleName: row.accessible_name ?? undefined, risk: row.risk });
    controlsByState.set(String(row.screen_state_id), controls);
  }
  return {
    catalog,
    journeys: journeys.rows.map((row: any) => ({
      id: row.id,
      organizationId: row.organization_id,
      catalogVersionId: row.catalog_version_id,
      journeyKey: row.journey_key,
      capabilityId: row.capability_id,
      customerJobId: row.customer_job_id,
      roleProfileIds: row.role_profile_ids,
      workflow: row.workflow,
      verificationStatus: row.verification_status,
      reliability: row.reliability,
      evidence: obj(row.evidence, {}),
      revision: Number(row.revision ?? 1),
      revisionChecksum: row.revision_checksum ?? undefined,
      approvalStatus: row.approval_status ?? "pending",
      approvedChecksum: row.approved_checksum ?? undefined,
      reviewedBy: row.reviewed_by ?? undefined,
      reviewedAt: row.reviewed_at ? iso(row.reviewed_at) : undefined,
      reviewComment: row.review_comment ?? undefined,
      supersedesJourneyVersionId: row.supersedes_journey_version_id ?? undefined,
      verifiedAt: row.verified_at ? iso(row.verified_at) : undefined,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    })),
    salesPlays: salesPlays.rows.map((row: any) => ({
      id: row.id,
      organizationId: row.organization_id,
      catalogVersionId: row.catalog_version_id,
      kind: row.kind,
      title: row.title,
      content: row.content,
      personaKeys: row.persona_keys,
      capabilityIds: row.capability_ids,
      journeyKeys: row.journey_keys,
      signalKeywords: row.signal_keywords,
      sourceDocumentId: row.source_document_id ?? undefined,
      approvalStatus: row.approval_status,
      approvedBy: row.approved_by ?? undefined,
      approvedAt: row.approved_at ? iso(row.approved_at) : undefined,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    })),
    coverage: coverage.rows.map((row: any) => ({
      id: row.id,
      organizationId: row.organization_id,
      catalogVersionId: row.catalog_version_id,
      roleProfileId: row.role_profile_id,
      customerJobId: row.customer_job_id,
      dimensionKey: row.dimension_key,
      depth: row.depth,
      status: row.status,
      importance: row.importance,
      detail: row.detail ?? undefined,
      lastCheckedAt: row.last_checked_at ? iso(row.last_checked_at) : undefined,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    })),
    screens: screenRows.rows.map((row: any) => ({
      key: row.screen_key, name: row.name, url: row.url_template ?? undefined, purpose: row.purpose ?? undefined,
      fingerprint: row.fingerprint, roleProfileId: row.conditions?.roleProfileId ?? undefined,
      controls: controlsByState.get(String(row.state_id)) ?? [],
    })),
    transitions: transitionRows.rows.map((row: any) => ({
      fromScreenKey: row.from_screen_key, fromFingerprint: row.from_fingerprint,
      toScreenKey: row.to_screen_key ?? undefined, toFingerprint: row.to_fingerprint ?? undefined,
      roleProfileId: row.from_conditions?.roleProfileId ?? undefined, controlKey: row.control_key ?? undefined,
      action: obj(row.action, {}), reliability: Number(row.reliability),
    })),
  };
}

/**
 * Seed a successor catalog from the currently published version. IDs that are
 * version-owned are remapped; logical journey IDs and role IDs remain stable.
 * This makes catalog updates copy-on-write instead of forcing every role to be
 * remapped before one role can change safely.
 */
async function cloneActiveCatalog(
  client: TenantClient,
  organizationId: string,
  productId: string,
  environmentId: string,
  catalogVersionId: string,
): Promise<void> {
  const active = await client.query(
    `SELECT cv.id FROM products p
     JOIN catalog_versions cv ON cv.organization_id=p.organization_id AND cv.id=p.active_catalog_version_id
     WHERE p.id=$1 AND cv.environment_id=$2 AND cv.status='published'`,
    [productId, environmentId],
  );
  if (!active.rowCount) return;
  const source = String(active.rows[0].id);

  await client.query(`
    CREATE TEMP TABLE clone_capability_map(old_id uuid PRIMARY KEY,new_id uuid NOT NULL) ON COMMIT DROP;
    CREATE TEMP TABLE clone_job_map(old_id uuid PRIMARY KEY,new_id uuid NOT NULL) ON COMMIT DROP;
    CREATE TEMP TABLE clone_screen_type_map(old_id uuid PRIMARY KEY,new_id uuid NOT NULL) ON COMMIT DROP;
    CREATE TEMP TABLE clone_screen_state_map(old_id uuid PRIMARY KEY,new_id uuid NOT NULL) ON COMMIT DROP;
    CREATE TEMP TABLE clone_control_map(old_id uuid PRIMARY KEY,new_id uuid NOT NULL) ON COMMIT DROP;
  `);
  await client.query(
    "INSERT INTO clone_capability_map SELECT id,gen_random_uuid() FROM capabilities WHERE catalog_version_id=$1",
    [source],
  );
  await client.query(
    `INSERT INTO capabilities(id,organization_id,catalog_version_id,capability_key,name,description,importance)
     SELECT m.new_id,$1,$2,c.capability_key,c.name,c.description,c.importance
     FROM capabilities c JOIN clone_capability_map m ON m.old_id=c.id`,
    [organizationId, catalogVersionId],
  );
  await client.query(
    "INSERT INTO clone_job_map SELECT id,gen_random_uuid() FROM customer_jobs WHERE catalog_version_id=$1",
    [source],
  );
  await client.query(
    `INSERT INTO customer_jobs(id,organization_id,catalog_version_id,capability_id,job_key,goal,outcome,importance,source)
     SELECT jm.new_id,$1,$2,cm.new_id,j.job_key,j.goal,j.outcome,j.importance,j.source
     FROM customer_jobs j JOIN clone_job_map jm ON jm.old_id=j.id
     JOIN clone_capability_map cm ON cm.old_id=j.capability_id`,
    [organizationId, catalogVersionId],
  );
  await client.query(
    "INSERT INTO clone_screen_type_map SELECT id,gen_random_uuid() FROM screen_types WHERE catalog_version_id=$1",
    [source],
  );
  await client.query(
    `INSERT INTO screen_types(id,organization_id,catalog_version_id,screen_key,name,url_template,purpose,fingerprint_hints)
     SELECT m.new_id,$1,$2,s.screen_key,s.name,s.url_template,s.purpose,s.fingerprint_hints
     FROM screen_types s JOIN clone_screen_type_map m ON m.old_id=s.id`,
    [organizationId, catalogVersionId],
  );
  await client.query(
    "INSERT INTO clone_screen_state_map SELECT id,gen_random_uuid() FROM screen_states WHERE catalog_version_id=$1",
    [source],
  );
  await client.query(
    `INSERT INTO screen_states(id,organization_id,catalog_version_id,screen_type_id,state_key,name,fingerprint,conditions,artifact_key)
     SELECT sm.new_id,$1,$2,tm.new_id,s.state_key,s.name,s.fingerprint,s.conditions,s.artifact_key
     FROM screen_states s JOIN clone_screen_state_map sm ON sm.old_id=s.id
     JOIN clone_screen_type_map tm ON tm.old_id=s.screen_type_id`,
    [organizationId, catalogVersionId],
  );
  await client.query(
    "INSERT INTO clone_control_map SELECT id,gen_random_uuid() FROM controls WHERE catalog_version_id=$1",
    [source],
  );
  await client.query(
    `INSERT INTO controls(id,organization_id,catalog_version_id,screen_state_id,control_key,role,accessible_name,locator_set,risk)
     SELECT cm.new_id,$1,$2,sm.new_id,c.control_key,c.role,c.accessible_name,c.locator_set,c.risk
     FROM controls c JOIN clone_control_map cm ON cm.old_id=c.id
     JOIN clone_screen_state_map sm ON sm.old_id=c.screen_state_id`,
    [organizationId, catalogVersionId],
  );
  await client.query(
    `INSERT INTO transitions(id,organization_id,catalog_version_id,from_state_id,to_state_id,control_id,action,verification_status,reliability)
     SELECT gen_random_uuid(),$1,$2,fm.new_id,tm.new_id,cm.new_id,t.action,t.verification_status,t.reliability
     FROM transitions t JOIN clone_screen_state_map fm ON fm.old_id=t.from_state_id
     LEFT JOIN clone_screen_state_map tm ON tm.old_id=t.to_state_id
     LEFT JOIN clone_control_map cm ON cm.old_id=t.control_id
     WHERE t.catalog_version_id=$3`,
    [organizationId, catalogVersionId, source],
  );
  await client.query(
    `INSERT INTO journey_versions(id,organization_id,catalog_version_id,journey_id,capability_id,customer_job_id,
       role_profile_ids,workflow,verification_status,reliability,evidence,verified_at,revision,revision_checksum,
       approval_status,approved_checksum,reviewed_by,reviewed_at,review_comment,supersedes_journey_version_id)
     SELECT gen_random_uuid(),$1,$2,jv.journey_id,cm.new_id,jm.new_id,jv.role_profile_ids,jv.workflow,
       jv.verification_status,jv.reliability,jv.evidence,jv.verified_at,jv.revision,jv.revision_checksum,
       jv.approval_status,jv.approved_checksum,jv.reviewed_by,jv.reviewed_at,jv.review_comment,jv.id
     FROM journey_versions jv JOIN clone_capability_map cm ON cm.old_id=jv.capability_id
     JOIN clone_job_map jm ON jm.old_id=jv.customer_job_id
     WHERE jv.catalog_version_id=$3`,
    [organizationId, catalogVersionId, source],
  );
  await client.query(
    `INSERT INTO coverage_items(id,organization_id,catalog_version_id,role_profile_id,customer_job_id,
       dimension_key,depth,status,importance,detail,last_checked_at)
     SELECT gen_random_uuid(),$1,$2,c.role_profile_id,jm.new_id,c.dimension_key,c.depth,c.status,
       c.importance,c.detail,c.last_checked_at
     FROM coverage_items c JOIN clone_job_map jm ON jm.old_id=c.customer_job_id
     WHERE c.catalog_version_id=$3`,
    [organizationId, catalogVersionId, source],
  );
  await client.query(
    `INSERT INTO sales_plays(id,organization_id,catalog_version_id,kind,title,content,persona_keys,
       capability_ids,journey_keys,signal_keywords,source_document_id,approval_status,approved_by,approved_at)
     SELECT gen_random_uuid(),$1,$2,s.kind,s.title,s.content,s.persona_keys,
       ARRAY(SELECT COALESCE(cm.new_id,ids.old_id) FROM unnest(s.capability_ids) AS ids(old_id)
             LEFT JOIN clone_capability_map cm ON cm.old_id=ids.old_id),
       s.journey_keys,s.signal_keywords,s.source_document_id,s.approval_status,s.approved_by,s.approved_at
     FROM sales_plays s WHERE s.catalog_version_id=$3 AND s.approval_status='approved'`,
    [organizationId, catalogVersionId, source],
  );
}

export class PostgresCatalogRepository implements CatalogRepository {
  constructor(private readonly database: Database) {}

  createDraft(ctx: TenantContext, productId: string, environmentId: string): Promise<CatalogVersion> {
    return this.database.withTenant(ctx, async (client) => {
      // Serialize version allocation for this product/environment. The unique
      // index remains the final guard, while this avoids normal concurrent
      // mapper jobs racing on MAX(version) + 1.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${ctx.organizationId}:${productId}:${environmentId}`]);
      const result = await client.query(
        `INSERT INTO catalog_versions(organization_id, product_id, environment_id, version, status, created_by)
         SELECT $1, $2, $3, COALESCE(MAX(version), 0) + 1, 'draft', nullif($4, '')::uuid
         FROM catalog_versions WHERE product_id = $2 AND environment_id = $3 RETURNING *`,
        [ctx.organizationId, productId, environmentId, /^[0-9a-f-]{36}$/i.test(ctx.actorId) ? ctx.actorId : ""],
      );
      await cloneActiveCatalog(client, ctx.organizationId, productId, environmentId, String(result.rows[0].id));
      return catalogRow(result.rows[0]);
    });
  }

  getOpenDraft(ctx: TenantContext, productId: string, environmentId: string): Promise<CatalogVersion | null> {
    return this.database.withTenant(ctx, async (client) => {
      const result = await client.query(
        `SELECT * FROM catalog_versions
         WHERE product_id=$1 AND environment_id=$2 AND status IN ('draft','mapping','verifying','review')
         ORDER BY version DESC LIMIT 1`,
        [productId, environmentId],
      );
      return result.rowCount ? catalogRow(result.rows[0]) : null;
    });
  }

  get(ctx: TenantContext, catalogVersionId: string): Promise<CatalogSnapshot | null> {
    return this.database.withTenant(ctx, async (client) => {
      const result = await client.query("SELECT * FROM catalog_versions WHERE id = $1", [catalogVersionId]);
      return result.rowCount ? loadSnapshot(client, catalogRow(result.rows[0])) : null;
    });
  }

  getActive(ctx: TenantContext, productId: string): Promise<CatalogSnapshot | null> {
    return this.database.withTenant(ctx, async (client) => {
      const result = await client.query(
        `SELECT cv.* FROM products p JOIN catalog_versions cv
         ON cv.organization_id = p.organization_id AND cv.id = p.active_catalog_version_id
         WHERE p.id = $1 AND cv.status = 'published'`,
        [productId],
      );
      return result.rowCount ? loadSnapshot(client, catalogRow(result.rows[0])) : null;
    });
  }

  publish(ctx: TenantContext, catalogVersionId: string, bundle: { key: string; checksum: string }): Promise<CatalogVersion> {
    return this.database.withTenant(ctx, async (client) => {
      const found = await client.query("SELECT * FROM catalog_versions WHERE id = $1 FOR UPDATE", [catalogVersionId]);
      if (!found.rowCount) throw new Error("catalog not found");
      const current = catalogRow(found.rows[0]);
      if (!['draft', 'mapping', 'verifying', 'review'].includes(current.status)) throw new Error(`cannot publish a ${current.status} catalog`);
      const invalid = await client.query(
        `SELECT count(*)::int AS total,
           count(*) FILTER (WHERE verification_status <> 'verified')::int AS invalid,
           count(*) FILTER (WHERE approval_status <> 'approved' OR approved_checksum IS DISTINCT FROM revision_checksum)::int AS unapproved
         FROM journey_versions WHERE catalog_version_id = $1`,
        [catalogVersionId],
      );
      if (invalid.rows[0].total === 0) throw new Error("catalog has no verified journeys");
      if (invalid.rows[0].invalid > 0) throw new Error("catalog contains journeys that are not verified");
      if (invalid.rows[0].unapproved > 0) throw new Error("catalog contains journeys awaiting human approval or changed after approval");
      await client.query(
        "UPDATE catalog_versions SET status = 'retired', updated_at = now() WHERE product_id = $1 AND status = 'published' AND id <> $2",
        [current.productId, catalogVersionId],
      );
      const updated = await client.query(
        `UPDATE catalog_versions SET status = 'published', bundle_key = $2,
         bundle_checksum = $3, published_at = now(), updated_at = now()
         WHERE id = $1 RETURNING *`,
        [catalogVersionId, bundle.key, bundle.checksum],
      );
      await client.query("UPDATE products SET active_catalog_version_id = $2, updated_at = now() WHERE id = $1", [current.productId, catalogVersionId]);
      await client.query(
        `INSERT INTO audit_events(organization_id, actor_id, request_id, action, resource_type, resource_id, payload)
         VALUES ($1,$2,$3,'catalog.publish','catalog_version',$4,$5::jsonb)`,
        [ctx.organizationId, ctx.actorId, ctx.requestId, catalogVersionId, JSON.stringify(bundle)],
      );
      return catalogRow(updated.rows[0]);
    });
  }

  getSalesPlay(ctx: TenantContext, id: string): Promise<SalesPlay | null> {
    return this.database.withTenant(ctx, async (client) => {
      const result = await client.query("SELECT * FROM sales_plays WHERE id=$1", [id]);
      if (!result.rowCount) return null;
      const row = result.rows[0];
      return {
        id: row.id, organizationId: row.organization_id, catalogVersionId: row.catalog_version_id,
        kind: row.kind, title: row.title, content: row.content, personaKeys: row.persona_keys,
        capabilityIds: row.capability_ids, journeyKeys: row.journey_keys, signalKeywords: row.signal_keywords,
        sourceDocumentId: row.source_document_id ?? undefined, approvalStatus: row.approval_status,
        approvedBy: row.approved_by ?? undefined, approvedAt: row.approved_at ? iso(row.approved_at) : undefined,
        createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
      };
    });
  }

  saveJourney(ctx: TenantContext, value: JourneyVersion): Promise<void> {
    return this.database.withTenant(ctx, async (client) => {
      const mutable = await client.query("SELECT product_id FROM catalog_versions WHERE id=$1 AND status NOT IN ('published','retired')", [value.catalogVersionId]);
      if (!mutable.rowCount) throw new Error("catalog not found or immutable");
      let journeyId = value.id;
      const existing = await client.query("SELECT journey_id FROM journey_versions WHERE id = $1", [value.id]);
      if (existing.rowCount) journeyId = existing.rows[0].journey_id;
      else {
        const journey = await client.query(
          `INSERT INTO journeys(id, organization_id, product_id, journey_key) VALUES ($1,$2,$3,$4)
           ON CONFLICT (organization_id, product_id, journey_key) DO UPDATE SET updated_at = now() RETURNING id`,
          [randomUUID(), ctx.organizationId, mutable.rows[0].product_id, value.journeyKey],
        );
        journeyId = journey.rows[0].id;
      }
      await client.query(
        `INSERT INTO journey_versions(
          id, organization_id, catalog_version_id, journey_id, capability_id, customer_job_id,
          role_profile_ids, workflow, verification_status, reliability, evidence, verified_at,
          revision,revision_checksum,approval_status,approved_checksum,reviewed_by,reviewed_at,review_comment,supersedes_journey_version_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19,$20)
        ON CONFLICT (organization_id, catalog_version_id, journey_id) DO UPDATE SET
          workflow=EXCLUDED.workflow, role_profile_ids=EXCLUDED.role_profile_ids,
          verification_status=EXCLUDED.verification_status, reliability=EXCLUDED.reliability,
          evidence=EXCLUDED.evidence, verified_at=EXCLUDED.verified_at,
          revision=EXCLUDED.revision,revision_checksum=EXCLUDED.revision_checksum,
          approval_status=EXCLUDED.approval_status,approved_checksum=EXCLUDED.approved_checksum,
          reviewed_by=EXCLUDED.reviewed_by,reviewed_at=EXCLUDED.reviewed_at,
          review_comment=EXCLUDED.review_comment,supersedes_journey_version_id=EXCLUDED.supersedes_journey_version_id,updated_at=now()`,
        [value.id, ctx.organizationId, value.catalogVersionId, journeyId, value.capabilityId, value.customerJobId,
          value.roleProfileIds, JSON.stringify(value.workflow), value.verificationStatus, value.reliability,
          JSON.stringify(value.evidence), value.verifiedAt ?? null,value.revision ?? 1,
          value.revisionChecksum ?? durableJourneyChecksum(value),value.approvalStatus ?? "pending",value.approvedChecksum ?? null,
          value.reviewedBy ?? null,value.reviewedAt ?? null,value.reviewComment ?? null,value.supersedesJourneyVersionId ?? null],
      );
    });
  }

  reviewJourney(ctx: TenantContext, journeyVersionId: string, input: { decision: "approved" | "rejected" | "rework_requested"; comment?: string; instruction?: string }): Promise<JourneyVersion> {
    return this.database.withTenant(ctx, async (client) => {
      const found = await client.query(
        `SELECT jv.*,j.journey_key,cv.product_id,cv.status AS catalog_status
         FROM journey_versions jv
         JOIN journeys j ON j.organization_id=jv.organization_id AND j.id=jv.journey_id
         JOIN catalog_versions cv ON cv.organization_id=jv.organization_id AND cv.id=jv.catalog_version_id
         WHERE jv.id=$1 FOR UPDATE`,
        [journeyVersionId],
      );
      if (!found.rowCount || ["published", "retired"].includes(found.rows[0].catalog_status)) throw new Error("journey not found or immutable");
      const row = found.rows[0];
      if (input.decision === "approved" && row.verification_status !== "verified") throw new Error("journey must be machine-verified before approval");
      const checksum = row.revision_checksum ?? durableJourneyChecksum({ workflow: row.workflow, evidence: obj(row.evidence, {}) });
      const updated = await client.query(
        `UPDATE journey_versions SET approval_status=$2,approved_checksum=$3,reviewed_by=$4,
         reviewed_at=now(),review_comment=$5,revision_checksum=$6,updated_at=now()
         WHERE id=$1 RETURNING *`,
        [journeyVersionId,input.decision,input.decision === "approved" ? checksum : null,ctx.actorId,input.comment ?? null,checksum],
      );
      await client.query(
        `INSERT INTO journey_review_decisions(organization_id,product_id,catalog_version_id,journey_version_id,
         revision,revision_checksum,decision,comment,instruction,actor_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [ctx.organizationId,row.product_id,row.catalog_version_id,journeyVersionId,row.revision ?? 1,checksum,
          input.decision,input.comment ?? null,input.instruction ?? null,ctx.actorId],
      );
      if (input.decision === "rework_requested") {
        if (!input.instruction?.trim()) throw new Error("a rework instruction is required");
        await client.query(
          `INSERT INTO journey_corrections(organization_id,product_id,catalog_version_id,journey_version_id,
           instruction,constraints,status,requested_by) VALUES($1,$2,$3,$4,$5,'{}'::jsonb,'pending',$6)`,
          [ctx.organizationId,row.product_id,row.catalog_version_id,journeyVersionId,input.instruction.trim(),ctx.actorId],
        );
      }
      await client.query(
        `INSERT INTO audit_events(organization_id,actor_id,request_id,action,resource_type,resource_id,payload)
         VALUES($1,$2,$3,$4,'journey_version',$5,$6::jsonb)`,
        [ctx.organizationId,ctx.actorId,ctx.requestId,`journey.review.${input.decision}`,journeyVersionId,
          JSON.stringify({ revision: row.revision ?? 1, checksum, comment: input.comment, instruction: input.instruction })],
      );
      const value = updated.rows[0];
      return {
        id: value.id, organizationId: value.organization_id, catalogVersionId: value.catalog_version_id,
        journeyKey: row.journey_key, capabilityId: value.capability_id, customerJobId: value.customer_job_id,
        roleProfileIds: value.role_profile_ids, workflow: value.workflow, verificationStatus: value.verification_status,
        reliability: value.reliability, evidence: obj(value.evidence, {}), verifiedAt: value.verified_at ? iso(value.verified_at) : undefined,
        revision: value.revision, revisionChecksum: value.revision_checksum, approvalStatus: value.approval_status,
        approvedChecksum: value.approved_checksum ?? undefined, reviewedBy: value.reviewed_by ?? undefined,
        reviewedAt: value.reviewed_at ? iso(value.reviewed_at) : undefined, reviewComment: value.review_comment ?? undefined,
        supersedesJourneyVersionId: value.supersedes_journey_version_id ?? undefined,
        createdAt: iso(value.created_at), updatedAt: iso(value.updated_at),
      };
    });
  }

  saveSalesPlay(ctx: TenantContext, value: SalesPlay): Promise<void> {
    return this.database.withTenant(ctx, async (client) => {
      const mutable = await client.query("SELECT 1 FROM catalog_versions WHERE id=$1 AND status NOT IN ('published','retired')", [value.catalogVersionId]);
      if (!mutable.rowCount) throw new Error("catalog not found or immutable");
      await client.query(
        `INSERT INTO sales_plays(
          id, organization_id, catalog_version_id, kind, title, content, persona_keys,
          capability_ids, journey_keys, signal_keywords, source_document_id,
          approval_status, approved_by, approved_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (organization_id, id) DO UPDATE SET kind=EXCLUDED.kind, title=EXCLUDED.title,
          content=EXCLUDED.content, persona_keys=EXCLUDED.persona_keys,
          capability_ids=EXCLUDED.capability_ids, journey_keys=EXCLUDED.journey_keys,
          signal_keywords=EXCLUDED.signal_keywords, approval_status=EXCLUDED.approval_status,
          approved_by=EXCLUDED.approved_by, approved_at=EXCLUDED.approved_at, updated_at=now()`,
        [value.id, ctx.organizationId, value.catalogVersionId, value.kind, value.title, value.content,
          value.personaKeys, value.capabilityIds, value.journeyKeys, value.signalKeywords,
          value.sourceDocumentId ?? null, value.approvalStatus, value.approvedBy ?? null, value.approvedAt ?? null],
      );
    });
  }

  replaceCoverage(ctx: TenantContext, catalogVersionId: string, values: CoverageItem[]): Promise<void> {
    return this.database.withTenant(ctx, async (client) => {
      const mutable = await client.query("SELECT 1 FROM catalog_versions WHERE id=$1 AND status NOT IN ('published','retired')", [catalogVersionId]);
      if (!mutable.rowCount) throw new Error("catalog not found or immutable");
      await client.query("DELETE FROM coverage_items WHERE catalog_version_id = $1", [catalogVersionId]);
      for (const value of values) {
        await client.query(
          `INSERT INTO coverage_items(id, organization_id, catalog_version_id, role_profile_id,
           customer_job_id, dimension_key, depth, status, importance, detail, last_checked_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [value.id, ctx.organizationId, catalogVersionId, value.roleProfileId, value.customerJobId,
            value.dimensionKey, value.depth, value.status, value.importance, value.detail ?? null, value.lastCheckedAt ?? null],
        );
      }
    });
  }

  replaceMappedCatalog(ctx: TenantContext, catalogVersionId: string, roleProfileId: string, value: MappedCatalogInput): Promise<void> {
    return this.database.withTenant(ctx, async (client) => {
      const catalog = await client.query(
        "SELECT product_id,environment_id FROM catalog_versions WHERE id=$1 AND status NOT IN ('published','retired') FOR UPDATE",
        [catalogVersionId],
      );
      if (!catalog.rowCount) throw new Error("catalog not found or immutable");
      const role = await client.query("SELECT 1 FROM role_profiles WHERE id=$1 AND environment_id=$2", [roleProfileId, catalog.rows[0].environment_id]);
      if (!role.rowCount) throw new Error("role profile not found");

      const prior = await client.query(
        `SELECT j.journey_key,jv.* FROM journey_versions jv
         JOIN journeys j ON j.organization_id=jv.organization_id AND j.id=jv.journey_id
         WHERE jv.catalog_version_id=$1 AND $2::uuid=ANY(jv.role_profile_ids)`,
        [catalogVersionId,roleProfileId],
      );
      const previousForRole = new Map(prior.rows.map((row: any) => [String(row.journey_key), row]));

      // Replace only this role's evidence. Other roles are part of the same
      // catalog build and must survive independent/retried mapper jobs.
      await client.query("DELETE FROM coverage_items WHERE catalog_version_id=$1 AND role_profile_id=$2", [catalogVersionId, roleProfileId]);
      await client.query(
        "DELETE FROM journey_versions WHERE catalog_version_id=$1 AND $2::uuid = ANY(role_profile_ids)",
        [catalogVersionId, roleProfileId],
      );
      await client.query(
        "DELETE FROM screen_states WHERE catalog_version_id=$1 AND conditions->>'roleProfileId'=$2",
        [catalogVersionId, roleProfileId],
      );
      await client.query(
        "DELETE FROM customer_jobs cj WHERE catalog_version_id=$1 AND NOT EXISTS (SELECT 1 FROM journey_versions jv WHERE jv.customer_job_id=cj.id)",
        [catalogVersionId],
      );
      await client.query(
        `DELETE FROM capabilities c WHERE catalog_version_id=$1
         AND NOT EXISTS (SELECT 1 FROM customer_jobs cj WHERE cj.capability_id=c.id)
         AND NOT EXISTS (SELECT 1 FROM sales_plays sp WHERE sp.catalog_version_id=$1 AND c.id=ANY(sp.capability_ids))`,
        [catalogVersionId],
      );

      const states = new Map<string, string>();
      const controls = new Map<string, string>();
      for (const screen of value.screens) {
        const type = await client.query(
          `INSERT INTO screen_types(organization_id,catalog_version_id,screen_key,name,url_template,purpose,fingerprint_hints)
           VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
           ON CONFLICT(organization_id,catalog_version_id,screen_key) DO UPDATE SET
             name=EXCLUDED.name,url_template=EXCLUDED.url_template,purpose=EXCLUDED.purpose,
             fingerprint_hints=EXCLUDED.fingerprint_hints,updated_at=now() RETURNING id`,
          [ctx.organizationId,catalogVersionId,screen.key,screen.name,screen.url,screen.purpose,JSON.stringify({ fingerprint: screen.fingerprint })],
        );
        const state = await client.query(
          `INSERT INTO screen_states(organization_id,catalog_version_id,screen_type_id,state_key,name,fingerprint,conditions)
           VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
           ON CONFLICT(organization_id,catalog_version_id,screen_type_id,state_key) DO UPDATE SET
             name=EXCLUDED.name,fingerprint=EXCLUDED.fingerprint,conditions=EXCLUDED.conditions,updated_at=now() RETURNING id`,
          [ctx.organizationId,catalogVersionId,type.rows[0].id,`role:${roleProfileId}`,screen.name,screen.fingerprint,
            JSON.stringify({ roleProfileId })],
        );
        states.set(screen.key, String(state.rows[0].id));
        for (const control of screen.controls) {
          const inserted = await client.query(
            `INSERT INTO controls(organization_id,catalog_version_id,screen_state_id,control_key,role,accessible_name,locator_set)
             VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING id`,
            [ctx.organizationId,catalogVersionId,state.rows[0].id,control.key,control.role ?? null,control.accessibleName ?? null,
              JSON.stringify({ role: control.role, accessibleName: control.accessibleName })],
          );
          controls.set(`${screen.key}:${control.key}`, String(inserted.rows[0].id));
        }
      }

      for (const transition of value.transitions ?? []) {
        const from = states.get(transition.fromScreenKey);
        if (!from) continue;
        await client.query(
          `INSERT INTO transitions(organization_id,catalog_version_id,from_state_id,to_state_id,control_id,action,verification_status,reliability)
           VALUES($1,$2,$3,$4,$5,$6::jsonb,'verified',$7)`,
          [ctx.organizationId,catalogVersionId,from,transition.toScreenKey ? states.get(transition.toScreenKey) ?? null : null,
            transition.controlKey ? controls.get(`${transition.fromScreenKey}:${transition.controlKey}`) ?? null : null,
            JSON.stringify(transition.action),transition.reliability],
        );
      }

      const capabilities = new Map<string, string>();
      for (const journey of value.journeys) {
        let capabilityId = capabilities.get(journey.capabilityKey);
        if (!capabilityId) {
          const capability = await client.query(
            `INSERT INTO capabilities(organization_id,catalog_version_id,capability_key,name,description,importance)
             VALUES($1,$2,$3,$4,'',1)
             ON CONFLICT(organization_id,catalog_version_id,capability_key) DO UPDATE SET
               name=EXCLUDED.name,updated_at=now() RETURNING id`,
            [ctx.organizationId,catalogVersionId,journey.capabilityKey,journey.capabilityName],
          );
          capabilityId = String(capability.rows[0].id);
          capabilities.set(journey.capabilityKey, capabilityId);
        }
        const customerJob = await client.query(
          `INSERT INTO customer_jobs(organization_id,catalog_version_id,capability_id,job_key,goal,outcome,importance,source)
           VALUES($1,$2,$3,$4,$5,$6,1,'mapper')
           ON CONFLICT(organization_id,catalog_version_id,job_key) DO UPDATE SET
             capability_id=EXCLUDED.capability_id,goal=EXCLUDED.goal,outcome=EXCLUDED.outcome,updated_at=now() RETURNING id`,
          [ctx.organizationId,catalogVersionId,capabilityId,journey.key,journey.goal,
            journey.workflow.postconditions.map((item) => item.kind).join(", ")],
        );
        const logical = await client.query(
          `INSERT INTO journeys(organization_id,product_id,journey_key) VALUES($1,$2,$3)
           ON CONFLICT(organization_id,product_id,journey_key) DO UPDATE SET updated_at=now() RETURNING id`,
          [ctx.organizationId,catalog.rows[0].product_id,journey.key],
        );
        const checksum = durableJourneyChecksum({ workflow: journey.workflow, evidence: journey.evidence });
        const previous = previousForRole.get(journey.key) as any;
        const approvalCurrent = previous?.approval_status === "approved" && previous?.approved_checksum === checksum;
        const revision = previous ? Number(previous.revision ?? 1) + (previous.revision_checksum === checksum ? 0 : 1) : 1;
        await client.query(
          `INSERT INTO journey_versions(id,organization_id,catalog_version_id,journey_id,capability_id,customer_job_id,
           role_profile_ids,workflow,verification_status,reliability,evidence,verified_at,
           revision,revision_checksum,approval_status,approved_checksum,reviewed_by,reviewed_at,review_comment,supersedes_journey_version_id)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'verified',$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
          [randomUUID(),ctx.organizationId,catalogVersionId,logical.rows[0].id,capabilityId,customerJob.rows[0].id,
            [roleProfileId],JSON.stringify(journey.workflow),journey.reliability,JSON.stringify(journey.evidence),journey.verifiedAt ?? new Date().toISOString(),
            revision,checksum,approvalCurrent ? "approved" : "pending",approvalCurrent ? checksum : null,
            approvalCurrent ? previous.reviewed_by : null,approvalCurrent ? previous.reviewed_at : null,
            approvalCurrent ? previous.review_comment : null,null],
        );
        const branches = ["happy_path", "validation", "permission", "empty_state", "error"] as const;
        for (const branch of branches) {
          const happy = branch === "happy_path";
          const observed = happy ? undefined : journey.coverage?.[branch];
          await client.query(
            `INSERT INTO coverage_items(organization_id,catalog_version_id,role_profile_id,customer_job_id,
             dimension_key,depth,status,importance,detail,last_checked_at)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [ctx.organizationId,catalogVersionId,roleProfileId,customerJob.rows[0].id,
              JSON.stringify({ state: "default", branch, locale: "default" }),happy ? journey.depth : (observed?.depth ?? 0),
              happy ? "verified" : (observed?.status ?? "blocked"),happy ? 5 : 1,
              happy ? "replayed successfully" : (observed?.detail ?? "mapper did not return branch evidence"),
              happy ? (journey.verifiedAt ?? new Date().toISOString()) : (observed?.checkedAt ?? null)],
          );
        }
      }
      await client.query("UPDATE catalog_versions SET status='review',updated_at=now() WHERE id=$1", [catalogVersionId]);
    });
  }
}

function feedbackRow(row: any): FeedbackSignal {
  return {
    id: row.id, organizationId: row.organization_id, productId: row.product_id,
    catalogVersionId: row.catalog_version_id, sessionId: row.session_id ?? undefined,
    kind: row.kind, content: row.content, metadata: obj(row.metadata, {}),
    createdAt: iso(row.created_at), updatedAt: iso(row.created_at),
  };
}

export class PostgresFeedbackRepository {
  constructor(private readonly database: Database) {}
  save(ctx: TenantContext, value: FeedbackSignal): Promise<void> {
    return this.database.withTenant(ctx, async (client) => {
      await client.query(
        `INSERT INTO feedback_signals(id,organization_id,product_id,catalog_version_id,session_id,kind,content,metadata)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
         ON CONFLICT(organization_id,id) DO NOTHING`,
        [value.id,ctx.organizationId,value.productId,value.catalogVersionId,value.sessionId ?? null,
          value.kind,value.content,JSON.stringify(value.metadata)],
      );
    });
  }
  listForProduct(ctx: TenantContext, productId: string, limit = 100): Promise<FeedbackSignal[]> {
    return this.database.withTenant(ctx, async (client) => {
      const result = await client.query(
        "SELECT * FROM feedback_signals WHERE product_id=$1 ORDER BY created_at DESC LIMIT $2",
        [productId, Math.max(1, Math.min(1000, limit))],
      );
      return result.rows.map(feedbackRow);
    });
  }
}

function sessionRow(row: any): CustomerSession {
  return {
    id: row.id, organizationId: row.organization_id, productId: row.product_id,
    environmentId: row.environment_id, roleProfileId: row.role_profile_id,
    catalogVersionId: row.catalog_version_id, mode: row.mode, status: row.status,
    memory: obj(row.memory, {}), lastSeenAt: iso(row.last_seen_at),
    browserSessionId: row.browser_session_id ?? undefined, workerId: row.worker_id ?? undefined,
    recoveryLeaseExpiresAt: row.recovery_lease_expires_at ? iso(row.recovery_lease_expires_at) : undefined,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

export class PostgresSessionRepository implements SessionRepository {
  constructor(private readonly database: Database) {}
  create(ctx: TenantContext, value: CustomerSession): Promise<void> {
    return this.database.withTenant(ctx, async (client) => {
      await client.query(
        `INSERT INTO customer_sessions(id,organization_id,product_id,environment_id,role_profile_id,
         catalog_version_id,mode,status,memory,last_seen_at,browser_session_id,worker_id,recovery_lease_expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13)`,
        [value.id,ctx.organizationId,value.productId,value.environmentId,value.roleProfileId,value.catalogVersionId,
          value.mode,value.status,JSON.stringify(value.memory),value.lastSeenAt,value.browserSessionId ?? null,
          value.workerId ?? null,value.recoveryLeaseExpiresAt ?? null],
      );
    });
  }
  get(ctx: TenantContext, id: string): Promise<CustomerSession | null> {
    return this.database.withTenant(ctx, async (client) => {
      const result = await client.query("SELECT * FROM customer_sessions WHERE id=$1", [id]);
      return result.rowCount ? sessionRow(result.rows[0]) : null;
    });
  }
  update(ctx: TenantContext, value: CustomerSession): Promise<void> {
    return this.database.withTenant(ctx, async (client) => {
      await client.query(
        `UPDATE customer_sessions SET status=$2,memory=$3::jsonb,last_seen_at=$4,browser_session_id=$5,
           worker_id=$6,recovery_lease_expires_at=$7,mode=$8,updated_at=now() WHERE id=$1`,
        [value.id,value.status,JSON.stringify(value.memory),value.lastSeenAt,value.browserSessionId ?? null,
          value.workerId ?? null,value.recoveryLeaseExpiresAt ?? null,value.mode],
      );
    });
  }
  claimRecovery(ctx: TenantContext, id: string, workerId: string, leaseSeconds: number): Promise<CustomerSession | null> {
    return this.database.withTenant(ctx, async (client) => {
      const result = await client.query(
        `UPDATE customer_sessions SET worker_id=$2,
           recovery_lease_expires_at=now() + make_interval(secs => $3),updated_at=now()
         WHERE id=$1 AND status='active'
           AND (worker_id=$2 OR recovery_lease_expires_at IS NULL OR recovery_lease_expires_at <= now())
         RETURNING *`,
        [id,workerId,Math.max(10, leaseSeconds)],
      );
      return result.rowCount ? sessionRow(result.rows[0]) : null;
    });
  }
}

function jobRow(row: any): MappingJob {
  return {
    id: row.id, organizationId: row.organization_id, productId: row.product_id,
    environmentId: row.environment_id, catalogVersionId: row.catalog_version_id,
    status: row.status, stage: row.stage, cursor: obj(row.cursor, {}), attempts: row.attempts,
    error: row.error ?? undefined, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

export class PostgresMappingJobRepository implements MappingJobRepository {
  constructor(private readonly database: Database) {}
  enqueue(ctx: TenantContext, value: MappingJob): Promise<void> {
    return this.database.withTenant(ctx, async (client) => {
      await client.query(
        `INSERT INTO mapping_jobs(id,organization_id,product_id,environment_id,catalog_version_id,status,stage,cursor,attempts,error)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
        [value.id,ctx.organizationId,value.productId,value.environmentId,value.catalogVersionId,value.status,
          value.stage,JSON.stringify(value.cursor),value.attempts,value.error ?? null],
      );
    });
  }
  get(ctx: TenantContext, id: string): Promise<MappingJob | null> {
    return this.database.withTenant(ctx, async (client) => {
      const result = await client.query("SELECT * FROM mapping_jobs WHERE id=$1", [id]);
      return result.rowCount ? jobRow(result.rows[0]) : null;
    });
  }
  claim(ctx: TenantContext, id: string, workerId: string, leaseSeconds: number): Promise<MappingJob | null> {
    return this.database.withTenant(ctx, async (client) => {
      const result = await client.query(
        `UPDATE mapping_jobs SET status='running', attempts=attempts+1, lease_owner=$2,
           lease_expires_at=now()+make_interval(secs => $3::int), updated_at=now()
         WHERE id=$1 AND (
           status='queued' OR lease_owner=$2 OR
           (status='running' AND (lease_expires_at IS NULL OR lease_expires_at < now()))
         ) RETURNING *`,
        [id, workerId, Math.max(30, leaseSeconds)],
      );
      return result.rowCount ? jobRow(result.rows[0]) : null;
    });
  }
  checkpoint(ctx: TenantContext, value: MappingJob, lease?: { owner: string; seconds: number }): Promise<void> {
    return this.database.withTenant(ctx, async (client) => {
      const result = await client.query(
        `UPDATE mapping_jobs SET status=$2,stage=$3,cursor=$4::jsonb,attempts=$5,error=$6,
           lease_owner=CASE WHEN $2='running' THEN $7 ELSE NULL END,
           lease_expires_at=CASE WHEN $2='running' THEN now()+make_interval(secs => $8::int) ELSE NULL END,
           updated_at=now()
         WHERE id=$1 AND ($7::text IS NULL OR lease_owner=$7)`,
        [value.id,value.status,value.stage,JSON.stringify(value.cursor),value.attempts,value.error ?? null,
          lease?.owner ?? null,Math.max(30,lease?.seconds ?? 30)],
      );
      if (!result.rowCount) throw new Error("mapping job lease was lost");
    });
  }
  control(ctx: TenantContext, id: string, action: "pause" | "resume" | "cancel"): Promise<MappingJob> {
    return this.database.withTenant(ctx, async (client) => {
      const desired = action === "pause" ? "waiting_for_human" : action === "resume" ? "queued" : "cancelled";
      const allowed = action === "pause" ? ["queued", "running"] : action === "resume" ? ["waiting_for_human"] : ["queued", "running", "waiting_for_human"];
      const result = await client.query(
        `UPDATE mapping_jobs SET status=$2,lease_owner=NULL,lease_expires_at=NULL,
           cursor=jsonb_set(cursor,'{control}',$3::jsonb,true),updated_at=now()
         WHERE id=$1 AND status=ANY($4::text[]) RETURNING *`,
        [id,desired,JSON.stringify({ action, actorId: ctx.actorId, at: new Date().toISOString() }),allowed],
      );
      if (!result.rowCount) {
        const current = await client.query("SELECT status FROM mapping_jobs WHERE id=$1", [id]);
        if (!current.rowCount) throw new Error("mapping job not found");
        throw new Error(`cannot ${action} a ${current.rows[0].status} job`);
      }
      await client.query(
        `INSERT INTO audit_events(organization_id,actor_id,request_id,action,resource_type,resource_id,payload)
         VALUES($1,$2,$3,$4,'mapping_job',$5,$6::jsonb)`,
        [ctx.organizationId,ctx.actorId,ctx.requestId,`mapping.${action}`,id,JSON.stringify({ status: desired })],
      );
      return jobRow(result.rows[0]);
    });
  }
  saveArtifact(ctx: TenantContext, jobId: string, key: string, value: unknown): Promise<{ checksum: string }> {
    return this.database.withTenant(ctx, async (client) => {
      const json = JSON.stringify(value);
      const checksum = createHash("sha256").update(json).digest("hex");
      const result = await client.query(
        `INSERT INTO mapping_job_artifacts(organization_id,mapping_job_id,artifact_key,payload,checksum)
         SELECT $1,id,$3,$4::jsonb,$5 FROM mapping_jobs WHERE id=$2
         ON CONFLICT(organization_id,mapping_job_id,artifact_key) DO UPDATE SET
           payload=EXCLUDED.payload,checksum=EXCLUDED.checksum,updated_at=now() RETURNING checksum`,
        [ctx.organizationId,jobId,key,json,checksum],
      );
      if (!result.rowCount) throw new Error("mapping job not found");
      return { checksum };
    });
  }
  getArtifact<T>(ctx: TenantContext, jobId: string, key: string): Promise<T | null> {
    return this.database.withTenant(ctx, async (client) => {
      const result = await client.query(
        "SELECT payload FROM mapping_job_artifacts WHERE mapping_job_id=$1 AND artifact_key=$2",
        [jobId,key],
      );
      return result.rowCount ? result.rows[0].payload as T : null;
    });
  }
}

function trainingRow(row: any): TrainingEvent {
  return {
    id: row.id, organizationId: row.organization_id, productId: row.product_id,
    catalogVersionId: row.catalog_version_id ?? undefined, mappingJobId: row.mapping_job_id ?? undefined,
    journeyVersionId: row.journey_version_id ?? undefined, eventType: row.event_type,
    actorType: row.actor_type, actorId: row.actor_id, payload: obj(row.payload, {}),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

function correctionRow(row: any): JourneyCorrection {
  return {
    id: row.id, organizationId: row.organization_id, productId: row.product_id,
    catalogVersionId: row.catalog_version_id, journeyVersionId: row.journey_version_id,
    instruction: row.instruction, constraints: obj(row.constraints, {}), status: row.status,
    requestedBy: row.requested_by, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

export class PostgresTrainingRepository implements TrainingRepository {
  constructor(private readonly database: Database) {}
  append(ctx: TenantContext, value: TrainingEvent): Promise<void> {
    return this.database.withTenant(ctx, async (client) => {
      await client.query(
        `INSERT INTO training_events(id,organization_id,product_id,catalog_version_id,mapping_job_id,
          journey_version_id,event_type,actor_type,actor_id,payload,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`,
        [value.id,ctx.organizationId,value.productId,value.catalogVersionId ?? null,value.mappingJobId ?? null,
          value.journeyVersionId ?? null,value.eventType,value.actorType,value.actorId,JSON.stringify(value.payload),value.createdAt,value.updatedAt],
      );
    });
  }
  list(ctx: TenantContext, productId: string, limit = 500): Promise<TrainingEvent[]> {
    return this.database.withTenant(ctx, async (client) => {
      const result = await client.query(
        "SELECT * FROM training_events WHERE product_id=$1 ORDER BY created_at DESC LIMIT $2",
        [productId,Math.max(1,Math.min(2000,limit))],
      );
      return result.rows.map(trainingRow);
    });
  }
  saveCorrection(ctx: TenantContext, value: JourneyCorrection): Promise<void> {
    return this.database.withTenant(ctx, async (client) => {
      await client.query(
        `INSERT INTO journey_corrections(id,organization_id,product_id,catalog_version_id,journey_version_id,
          instruction,constraints,status,requested_by,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)
         ON CONFLICT(organization_id,id) DO UPDATE SET instruction=EXCLUDED.instruction,
          constraints=EXCLUDED.constraints,status=EXCLUDED.status,updated_at=now()`,
        [value.id,ctx.organizationId,value.productId,value.catalogVersionId,value.journeyVersionId,
          value.instruction,JSON.stringify(value.constraints),value.status,value.requestedBy,value.createdAt,value.updatedAt],
      );
    });
  }
  listCorrections(ctx: TenantContext, productId: string): Promise<JourneyCorrection[]> {
    return this.database.withTenant(ctx, async (client) => {
      const result = await client.query("SELECT * FROM journey_corrections WHERE product_id=$1 ORDER BY created_at DESC", [productId]);
      return result.rows.map(correctionRow);
    });
  }
}

export class PostgresKnowledgeRepository implements KnowledgeRepository {
  constructor(private readonly database: Database) {}
  ingestDocument(ctx: TenantContext, input: KnowledgeDocumentInput): Promise<{ documentId: string; versionId: string; chunks: number; chunkIds?: string[] }> {
    return this.database.withTenant(ctx, async (client) => {
      const product = await client.query("SELECT 1 FROM products WHERE id=$1", [input.productId]);
      if (!product.rowCount) throw new Error("product not found");
      const source = await client.query(
        `INSERT INTO knowledge_sources(organization_id,product_id,source_type,uri,trust)
         VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(organization_id,product_id,uri) DO UPDATE SET source_type=EXCLUDED.source_type,
           trust=EXCLUDED.trust,enabled=true,updated_at=now() RETURNING id`,
        [ctx.organizationId,input.productId,input.sourceType,input.uri,input.trust],
      );
      const document = await client.query(
        `INSERT INTO documents(organization_id,source_id,external_key,title)
         VALUES($1,$2,$3,$4)
         ON CONFLICT(organization_id,source_id,external_key) DO UPDATE SET title=EXCLUDED.title,
           deleted_at=NULL,updated_at=now() RETURNING id`,
        [ctx.organizationId,source.rows[0].id,input.externalKey,input.title],
      );
      const version = await client.query(
        `INSERT INTO document_versions(organization_id,document_id,content_hash,source_modified_at)
         VALUES($1,$2,$3,$4)
         ON CONFLICT(organization_id,document_id,content_hash) DO UPDATE SET
           source_modified_at=EXCLUDED.source_modified_at RETURNING id`,
        [ctx.organizationId,document.rows[0].id,input.contentHash,input.sourceModifiedAt ?? null],
      );
      await client.query("DELETE FROM knowledge_chunks WHERE document_version_id=$1", [version.rows[0].id]);
      const chunkIds: string[] = [];
      for (const [ordinal, chunk] of input.chunks.entries()) {
        if (chunk.embedding && chunk.embedding.length !== 1536) throw new Error("knowledge embeddings must have 1536 dimensions");
        const vector = chunk.embedding ? `[${chunk.embedding.join(",")}]` : null;
        const inserted = await client.query(
          `INSERT INTO knowledge_chunks(organization_id,product_id,document_version_id,ordinal,title,section,content,embedding,metadata)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8::vector,$9::jsonb) RETURNING id`,
          [ctx.organizationId,input.productId,version.rows[0].id,ordinal,chunk.title,chunk.section,chunk.content,vector,
            JSON.stringify({ source: input.uri, trust: input.trust, ...(chunk.metadata ?? {}) })],
        );
        chunkIds.push(inserted.rows[0].id);
      }
      return { documentId: document.rows[0].id, versionId: version.rows[0].id, chunks: input.chunks.length, chunkIds };
    });
  }
  search(ctx: TenantContext, input: { productId: string; catalogVersionId: string; query: string; embedding?: number[]; limit?: number }): Promise<KnowledgeHit[]> {
    if (input.embedding && input.embedding.length !== 1536) throw new Error("knowledge query embedding must have 1536 dimensions");
    return this.database.withTenant(ctx, async (client) => {
      const vector = input.embedding ? `[${input.embedding.join(",")}]` : null;
      const result = await client.query(
        `WITH candidates AS (
           SELECT kc.id,kc.title,kc.section,kc.content,kc.metadata,
             ts_rank_cd(to_tsvector('simple', kc.content), plainto_tsquery('simple', $3)) AS lexical,
             CASE WHEN $4::vector IS NOT NULL AND kc.embedding IS NOT NULL
               THEN 1 - (kc.embedding <=> $4::vector) ELSE 0 END AS semantic
           FROM knowledge_chunks kc
           JOIN document_versions current ON current.organization_id=kc.organization_id AND current.id=kc.document_version_id
           WHERE kc.product_id=$1 AND (kc.catalog_version_id=$2 OR kc.catalog_version_id IS NULL)
             AND NOT EXISTS (
               SELECT 1 FROM document_versions newer
               WHERE newer.document_id=current.document_id
                 AND (newer.created_at,newer.id) > (current.created_at,current.id)
             )
             AND ($4::vector IS NOT NULL OR to_tsvector('simple', kc.content) @@ plainto_tsquery('simple', $3))
         )
         SELECT *, (lexical * 0.4 + semantic * 0.6) AS score
         FROM candidates ORDER BY score DESC LIMIT $5`,
        [input.productId, input.catalogVersionId, input.query, vector, Math.max(1, Math.min(20, input.limit ?? 4))],
      );
      return result.rows.map((row: any) => ({
        id: row.id, title: row.title, section: row.section, content: row.content,
        source: row.metadata?.source ?? "", trust: row.metadata?.trust ?? "official", score: Number(row.score ?? 0),
      }));
    });
  }
  listForPlanning(ctx: TenantContext, productId: string, limit = 10000): Promise<PlanningKnowledgeChunk[]> {
    return this.database.withTenant(ctx, async (client) => {
      const result = await client.query(
        `SELECT kc.id,kc.title,kc.section,kc.content,kc.metadata
         FROM knowledge_chunks kc
         JOIN document_versions current
           ON current.organization_id=kc.organization_id AND current.id=kc.document_version_id
         WHERE kc.product_id=$1
           AND NOT EXISTS (
             SELECT 1 FROM document_versions newer
             WHERE newer.organization_id=current.organization_id AND newer.document_id=current.document_id
               AND (newer.created_at,newer.id) > (current.created_at,current.id)
           )
         ORDER BY current.created_at,kc.document_version_id,kc.ordinal
         LIMIT $2`,
        [productId, Math.max(1, Math.min(50000, limit))],
      );
      return result.rows.map((row: any) => ({
        id: row.id, title: row.title, section: row.section, content: row.content,
        source: row.metadata?.source ?? "", trust: row.metadata?.trust ?? "official",
        metadata: row.metadata ?? {},
      }));
    });
  }
}

export class PostgresAccessRepository implements AccessRepository {
  constructor(private readonly database: Database) {}
  saveCredentialRef(ctx: TenantContext, value: CredentialRef): Promise<void> {
    return this.database.withTenant(ctx, async (client) => {
      await client.query(
        `INSERT INTO credential_refs(id,organization_id,provider,secret_path,metadata,expires_at)
         VALUES($1,$2,$3,$4,$5::jsonb,$6)
         ON CONFLICT(organization_id,id) DO UPDATE SET provider=EXCLUDED.provider,secret_path=EXCLUDED.secret_path,
           metadata=EXCLUDED.metadata,expires_at=EXCLUDED.expires_at,updated_at=now()`,
        [value.id,ctx.organizationId,value.provider,value.secretPath,JSON.stringify(value.metadata),value.expiresAt ?? null],
      );
    });
  }
  getCredentialRef(ctx: TenantContext, id: string): Promise<CredentialRef | null> {
    return this.database.withTenant(ctx, async (client) => {
      const result = await client.query("SELECT * FROM credential_refs WHERE id=$1", [id]);
      if (!result.rowCount) return null;
      const row = result.rows[0];
      return {
        id: row.id, organizationId: row.organization_id, provider: row.provider, secretPath: row.secret_path,
        metadata: obj(row.metadata, {}), expiresAt: row.expires_at ? iso(row.expires_at) : undefined,
        createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
      };
    });
  }
  saveRoleProfile(ctx: TenantContext, value: RoleProfile): Promise<void> {
    return this.database.withTenant(ctx, async (client) => {
      await client.query(
        `INSERT INTO role_profiles(id,organization_id,environment_id,role_key,name,credential_ref_id,permission_hints)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
         ON CONFLICT(organization_id,environment_id,role_key) DO UPDATE SET name=EXCLUDED.name,
           credential_ref_id=EXCLUDED.credential_ref_id,permission_hints=EXCLUDED.permission_hints,updated_at=now()`,
        [value.id,ctx.organizationId,value.environmentId,value.key,value.name,value.credentialRefId ?? null,JSON.stringify(value.permissionHints)],
      );
    });
  }
  listRoleProfiles(ctx: TenantContext, environmentId: string): Promise<RoleProfile[]> {
    return this.database.withTenant(ctx, async (client) => {
      const result = await client.query("SELECT * FROM role_profiles WHERE environment_id=$1 ORDER BY name", [environmentId]);
      return result.rows.map(roleRow);
    });
  }
  saveEmbedGrant(ctx: TenantContext, value: EmbedGrant): Promise<void> {
    return this.database.withTenant(ctx, async (client) => {
      await client.query(
        `INSERT INTO embed_grants(id,organization_id,product_id,role_profile_id,allowed_origins,expires_at,revoked_at)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(organization_id,id) DO UPDATE SET allowed_origins=EXCLUDED.allowed_origins,
           expires_at=EXCLUDED.expires_at,revoked_at=EXCLUDED.revoked_at,updated_at=now()`,
        [value.id,ctx.organizationId,value.productId,value.roleProfileId,value.allowedOrigins,value.expiresAt,value.revokedAt ?? null],
      );
    });
  }
  getEmbedGrant(ctx: TenantContext, id: string): Promise<EmbedGrant | null> {
    return this.database.withTenant(ctx, async (client) => {
      const result = await client.query("SELECT * FROM embed_grants WHERE id=$1", [id]);
      if (!result.rowCount) return null;
      const row = result.rows[0];
      return {
        id: row.id, organizationId: row.organization_id, productId: row.product_id,
        roleProfileId: row.role_profile_id, allowedOrigins: row.allowed_origins,
        expiresAt: iso(row.expires_at), revokedAt: row.revoked_at ? iso(row.revoked_at) : undefined,
        createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
      };
    });
  }
  revokeEmbedGrant(ctx: TenantContext, id: string): Promise<void> {
    return this.database.withTenant(ctx, async (client) => {
      const result = await client.query("UPDATE embed_grants SET revoked_at=now(),updated_at=now() WHERE id=$1 AND revoked_at IS NULL", [id]);
      if (!result.rowCount) throw new Error("embed grant not found or already revoked");
    });
  }
}

export function postgresRepositories(database: Database): PlatformRepositories {
  return {
    products: new PostgresProductRepository(database),
    catalogs: new PostgresCatalogRepository(database),
    sessions: new PostgresSessionRepository(database),
    mappingJobs: new PostgresMappingJobRepository(database),
    training: new PostgresTrainingRepository(database),
    feedback: new PostgresFeedbackRepository(database),
    knowledge: new PostgresKnowledgeRepository(database),
    access: new PostgresAccessRepository(database),
  };
}
