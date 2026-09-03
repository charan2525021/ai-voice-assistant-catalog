import { createHash } from "node:crypto";
import type { TenantContext } from "../domain/context.js";
import { loadGraph } from "../mapper/graph.js";
import { brainFor } from "../knowledge/store.js";
import { legacyProgramToWorkflow } from "../workflow/schema.js";
import { coverageDimensionKey } from "../mapping/coverage.js";
import type { SecretProviderRegistry, SecretValue } from "../secrets/provider.js";
import { profileDirFor } from "../chromeprofile.js";
import type { CatalogService } from "../catalog/service.js";
import type { ProductRecord } from "../products.js";
import type { Database } from "./database.js";
import { approvalIsCurrent } from "../mapper/journey-review.js";
import { durableJourneyChecksum } from "../catalog/review-policy.js";

/**
 * Copy ONE file-backed product into PostgreSQL and publish its catalog.
 *
 * The admin console creates products through the legacy path, which writes
 * content/<id>/ and data/brain/<id>/. The demo page lists /api/v2/products,
 * which reads PostgreSQL. Nothing joined the two, so a product mapped from the
 * console was invisible to the demo picker and could never be run — it existed,
 * it had verified journeys, and there was no way to reach it.
 *
 * Extracted from import-legacy.ts so the same code serves three callers: the
 * bulk importer, a single-product re-sync, and the onboarding path that calls it
 * automatically once mapping finishes.
 */
export async function syncLegacyProduct(
  database: Database,
  ctx: TenantContext,
  catalogService: CatalogService,
  legacy: ProductRecord,
  /** Optional: when supplied, real credential material is migrated instead of a placeholder. */
  secrets?: SecretProviderRegistry,
): Promise<{
  productId: string; catalogVersionId: string; verified: number; approved: number; docs: number; plays: number;
  screens: number; transitions: number; published: boolean;
}> {
  const graph = await loadGraph(legacy.id, legacy.startUrl);
  const brain = await brainFor(legacy.id);

  const imported = await database.withTenant(ctx, async (client) => {
    const productResult = await client.query(
      `INSERT INTO products(organization_id, product_key, name, settings)
       VALUES($1,$2,$3,$4::jsonb)
       ON CONFLICT(organization_id, product_key) DO UPDATE SET name=EXCLUDED.name, settings=EXCLUDED.settings, updated_at=now()
       RETURNING id`,
      [ctx.organizationId, legacy.id, legacy.name, JSON.stringify({ voice: legacy.voice ?? {}, allowActions: legacy.allowActions ?? [] })],
    );
    const productId = productResult.rows[0].id as string;
    const environmentResult = await client.query(
      `INSERT INTO environments(organization_id,product_id,environment_key,name,start_url,locale)
       VALUES($1,$2,'default','Default',$3,$4)
       ON CONFLICT(organization_id,product_id,environment_key) DO UPDATE SET start_url=EXCLUDED.start_url,updated_at=now()
       RETURNING id`,
      [ctx.organizationId, productId, legacy.startUrl, process.env.BROWSER_LOCALE ?? "en-US"],
    );
    const environmentId = environmentResult.rows[0].id as string;

    /*
     * Carry the ACTUAL credential across, not a placeholder.
     *
     * This always wrote provider='migration_required' with no stored value, for
     * every product whose auth.mode was not "none". That is a deliberate loud
     * placeholder for a `login` product whose password we cannot recover — but
     * it was applied to `profile` and `session` products too, where nothing
     * needs migrating: the material is already on disk (a captured storageState
     * or a Chrome profile directory), and SecretValue/session start both support
     * exactly those fields. The result was a product that mapped, verified and
     * published, and then refused to demo with
     *   secret provider "migration_required" is not configured
     * — with no way forward from the console.
     */
    const secretPath = `organizations/${ctx.organizationId}/products/${legacy.id}/default`;
    const material: SecretValue = {};
    // Portable captured state beats a profile directory: Chromium takes a
    // singleton lock on a profile, so only one session could ever run.
    if (legacy.auth.sessionState) material.sessionState = legacy.auth.sessionState;
    if (legacy.auth.sessionStorage) material.sessionStorage = legacy.auth.sessionStorage;
    if (!material.sessionState && !material.sessionStorage && legacy.auth.mode === "profile") {
      material.profileDir = legacy.auth.profileDir ?? profileDirFor(legacy.id);
    }
    if (legacy.auth.username) {
      material.username = legacy.auth.username;
      material.password = legacy.auth.password;
    }
    const hasMaterial = !!(material.username || material.sessionState || material.sessionStorage || material.profileDir);

    let credentialRefId: string | null = null;
    if (legacy.auth.mode !== "none") {
      let provider = "migration_required";
      if (secrets && hasMaterial) {
        const target = process.env.SECRET_PROVIDER ?? "postgres";
        try {
          await secrets.store(target, secretPath, material);
          provider = target;
        } catch (e) {
          // A failed write must leave the loud placeholder rather than a ref
          // that points at a provider holding nothing.
          console.warn(`[sync] ${legacy.id}: could not store credential (${(e as Error).message}) — leaving migration_required`);
        }
      }
      const metadata = JSON.stringify({ legacyMode: legacy.auth.mode, accountLabel: legacy.auth.accountLabel });
      /*
       * Move an existing ref to the new provider IN PLACE. Deleting it and
       * inserting a replacement is not an option: role_profiles references
       * credential_refs through the COMPOSITE key (organization_id,
       * credential_ref_id) with ON DELETE SET NULL, and Postgres sets every
       * column of that key to NULL — including organization_id, which is NOT
       * NULL. So the delete always fails with a not-null violation on
       * role_profiles rather than orphaning the role.
       */
      const moved = await client.query(
        `UPDATE credential_refs SET provider=$3, metadata=$4::jsonb, updated_at=now()
          WHERE organization_id=$1 AND secret_path=$2 RETURNING id`,
        [ctx.organizationId, secretPath, provider, metadata],
      );
      const credential = moved.rowCount
        ? moved
        : await client.query(
            `INSERT INTO credential_refs(organization_id,provider,secret_path,metadata)
             VALUES($1,$2,$3,$4::jsonb)
             ON CONFLICT(organization_id,provider,secret_path) DO UPDATE SET metadata=EXCLUDED.metadata,updated_at=now()
             RETURNING id`,
            [ctx.organizationId, provider, secretPath, metadata],
          );
      credentialRefId = credential.rows[0].id;
    }
    const roleResult = await client.query(
      `INSERT INTO role_profiles(organization_id,environment_id,role_key,name,credential_ref_id)
       VALUES($1,$2,'default','Default role',$3)
       ON CONFLICT(organization_id,environment_id,role_key) DO UPDATE SET credential_ref_id=EXCLUDED.credential_ref_id,updated_at=now()
       RETURNING id`,
      [ctx.organizationId, environmentId, credentialRefId],
    );
    const roleProfileId = roleResult.rows[0].id as string;

    /*
     * Re-syncing must not stack a new catalog version every run — that is how a
     * product ends up with a dozen review drafts nobody asked for. Reuse an open
     * one and replace its contents; only allocate a version when none is open.
     */
    const openDraft = await client.query(
      `SELECT id FROM catalog_versions
        WHERE organization_id=$1 AND product_id=$2 AND environment_id=$3
          AND status IN ('draft','mapping','verifying','review')
        ORDER BY version DESC LIMIT 1`,
      [ctx.organizationId, productId, environmentId],
    );
    let catalogVersionId: string;
    if (openDraft.rows[0]) {
      catalogVersionId = openDraft.rows[0].id as string;
      // Foreign keys dictate the order: transitions reference controls and
      // screen_states, controls reference screen_states, states reference types.
      for (const table of [
        "transitions", "controls", "screen_states", "screen_types",
        "coverage_items", "journey_versions", "customer_jobs", "capabilities", "sales_plays",
      ]) {
        await client.query(`DELETE FROM ${table} WHERE catalog_version_id=$1`, [catalogVersionId]);
      }
    } else {
      const created = await client.query(
        `INSERT INTO catalog_versions(organization_id,product_id,environment_id,version,status)
         SELECT $1,$2,$3,COALESCE(MAX(version),0)+1,'review' FROM catalog_versions WHERE product_id=$2 AND environment_id=$3
         RETURNING id`,
        [ctx.organizationId, productId, environmentId],
      );
      catalogVersionId = created.rows[0].id as string;
    }

    /*
     * Screens, their controls, and the moves between them.
     *
     * These were the one part of the graph nothing ever mirrored — every install
     * had zero rows in screen_types/controls/transitions. compileRuntimeBundle()
     * builds bundle.screens and bundle.transitions from them, so the evidence
     * router could never match the live page to a known screen: selectScreen()
     * scored against an empty list and nextTransitions was always empty. Journeys
     * still ran (they carry their own workflow), so this failed quietly — the
     * agent simply had no durable idea which screen it was looking at.
     */
    const stateByFingerprint = new Map<string, string>();
    for (const [index, screen] of graph.screens.entries()) {
      const screenKey = screen.id || `screen-${index}`;
      const type = await client.query(
        `INSERT INTO screen_types(organization_id,catalog_version_id,screen_key,name,url_template,purpose,fingerprint_hints)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING id`,
        [ctx.organizationId, catalogVersionId, screenKey, screen.title || screenKey, screen.url ?? null,
          screen.purpose ?? "", JSON.stringify({ reachedBy: screen.reachedBy ?? [] })],
      );
      // The legacy survey records one observed state per screen; role- and
      // condition-specific variants only exist on the durable mapping path.
      const state = await client.query(
        `INSERT INTO screen_states(organization_id,catalog_version_id,screen_type_id,state_key,name,fingerprint,conditions)
         VALUES($1,$2,$3,'default',$4,$5,$6::jsonb) RETURNING id`,
        // The RUNTIME fingerprint, not the survey's: this column is compared
        // against what the live browser reports, and the survey's hash is
        // computed from different inputs so it could never match.
        [ctx.organizationId, catalogVersionId, type.rows[0].id, screen.title || screenKey,
          screen.runtimeFingerprint || screen.fingerprint || `legacy:${screenKey}`,
          JSON.stringify({ source: "legacy-survey", surveyFingerprint: screen.fingerprint ?? null })],
      );
      const stateId = state.rows[0].id as string;
      // Journey steps record runtime fingerprints, so that is the key that can
      // actually resolve a transition's endpoints.
      if (screen.runtimeFingerprint) stateByFingerprint.set(screen.runtimeFingerprint, stateId);
      if (screen.fingerprint) stateByFingerprint.set(screen.fingerprint, stateId);

      for (const [position, control] of (screen.controls ?? []).entries()) {
        // Recorded as `role "accessible name"`, which is the durable addressing
        // pair the whole mapper is built on — keep both halves separate here.
        const parsed = /^(\S+)\s+"([\s\S]*)"$/.exec(control);
        const role = parsed?.[1] ?? "element";
        const name = parsed?.[2] ?? control;
        await client.query(
          `INSERT INTO controls(organization_id,catalog_version_id,screen_state_id,control_key,role,accessible_name,locator_set,risk)
           VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,'read')`,
          // Position keeps the key unique when a screen legitimately repeats a
          // role+name pair (paginated rows, repeated "Edit" links).
          [ctx.organizationId, catalogVersionId, stateId, `${screenKey}:${position}`, role, name,
            JSON.stringify({ role, accessibleName: name })],
        );
      }
    }

    const capabilityIds = new Map<string, string>();
    for (const [index, capability] of graph.capabilities.entries()) {
      const result = await client.query(
        `INSERT INTO capabilities(organization_id,catalog_version_id,capability_key,name,description,importance)
         VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
        [ctx.organizationId, catalogVersionId, capability.id || `capability-${index + 1}`, capability.name, capability.description ?? "", 1],
      );
      capabilityIds.set(capability.name.toLowerCase(), result.rows[0].id);
    }

    let verified = 0;
    let approved = 0;
    const coverage: { customerJobId: string; status: string; depth: number; detail?: string }[] = [];
    /*
     * Transitions are DERIVED from verified journey steps rather than guessed
     * from the survey: the explorer records the fingerprint before and after
     * every action, so a step whose two fingerprints are both known screens is
     * direct evidence that this action moves between them. A step that stays on
     * one screen, or lands somewhere the survey never saw, yields no edge —
     * inventing one would put unverified moves in front of the agent.
     */
    const edges: { from: string; to: string; action: unknown; status: string; reliability: number }[] = [];
    for (const [index, journey] of graph.journeys.entries()) {
      let capabilityId = capabilityIds.get(journey.capability.toLowerCase());
      if (!capabilityId) {
        const result = await client.query(
          `INSERT INTO capabilities(organization_id,catalog_version_id,capability_key,name,description,importance)
           VALUES($1,$2,$3,$4,'',1) RETURNING id`,
          [ctx.organizationId, catalogVersionId, `derived-${index + 1}`, journey.capability || "Other"],
        );
        capabilityId = String(result.rows[0].id);
        capabilityIds.set(journey.capability.toLowerCase(), capabilityId);
      }
      const job = await client.query(
        `INSERT INTO customer_jobs(organization_id,catalog_version_id,capability_id,job_key,goal,outcome,importance,source)
         VALUES($1,$2,$3,$4,$5,$6,1,'mapper') RETURNING id`,
        [ctx.organizationId, catalogVersionId, capabilityId, journey.id || `journey-${index + 1}`, journey.goal, journey.postcondition],
      );
      const customerJobId = job.rows[0].id as string;
      coverage.push({
        customerJobId,
        status: journey.status === "verified" ? "verified" : journey.status === "broken" ? "broken" : "discovered",
        depth: journey.status === "verified" ? (journey.meaning ? 4 : 2) : 1,
        detail: journey.status === "verified" ? undefined : "Imported from the legacy repair backlog",
      });
      if (journey.status !== "verified") continue;
      for (const step of journey.steps) {
        const from = step.fromFingerprint && stateByFingerprint.get(step.fromFingerprint);
        const to = step.toFingerprint && stateByFingerprint.get(step.toFingerprint);
        if (!from || !to || from === to) continue;
        edges.push({
          from, to,
          action: { action: step.action, role: step.role, name: step.name, url: step.url },
          status: "verified",
          reliability: journey.reliability,
        });
      }
      const logicalJourney = await client.query(
        `INSERT INTO journeys(organization_id,product_id,journey_key) VALUES($1,$2,$3)
         ON CONFLICT(organization_id,product_id,journey_key) DO UPDATE SET updated_at=now() RETURNING id`,
        [ctx.organizationId, productId, journey.id || `journey-${index + 1}`],
      );
      const workflow = legacyProgramToWorkflow({
        id: journey.id || `journey-${index + 1}`, name: journey.goal, startUrl: journey.startUrl ?? graph.startUrl,
        postcondition: journey.postcondition, program: journey.steps,
      });
      const evidence = { attempts: journey.attempts, imported: true, verificationRuns: journey.verificationRuns,
        proof: journey.proof, contract: journey.evidence, meaning: journey.meaning };
      const checksum = durableJourneyChecksum({ workflow, evidence });
      const humanApproved = approvalIsCurrent(journey);
      await client.query(
        `INSERT INTO journey_versions(organization_id,catalog_version_id,journey_id,capability_id,customer_job_id,
         role_profile_ids,workflow,verification_status,reliability,evidence,verified_at,
         revision,revision_checksum,approval_status,approved_checksum,reviewed_by,reviewed_at,review_comment)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,'verified',$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [ctx.organizationId, catalogVersionId, logicalJourney.rows[0].id, capabilityId, customerJobId, [roleProfileId],
          JSON.stringify(workflow), journey.reliability, JSON.stringify(evidence),journey.verifiedAt ?? new Date().toISOString(),
          journey.revision ?? 1,checksum,humanApproved ? "approved" : "pending",humanApproved ? checksum : null,
          humanApproved ? journey.approval?.reviewedBy : null,humanApproved ? journey.approval?.reviewedAt : null,
          humanApproved ? journey.approval?.comment : null],
      );
      verified++;
      if (humanApproved) approved++;
    }

    // Deduplicate: several journeys legitimately share a move (every checkout
    // journey walks cart → checkout), and one edge per screen pair is what the
    // router wants to offer as "you can go here next".
    const seenEdges = new Set<string>();
    for (const edge of edges) {
      const key = `${edge.from}->${edge.to}:${JSON.stringify(edge.action)}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      await client.query(
        `INSERT INTO transitions(organization_id,catalog_version_id,from_state_id,to_state_id,action,verification_status,reliability)
         VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)`,
        [ctx.organizationId, catalogVersionId, edge.from, edge.to, JSON.stringify(edge.action), edge.status, edge.reliability],
      );
    }

    /*
     * dimension_key MUST be the canonical JSON produced by coverageDimensionKey().
     *
     * This wrote the plain string 'default/happy_path', which reads fine and is
     * silently unusable: CatalogService.publish() decides which roles have a
     * verified happy path with `JSON.parse(item.dimensionKey).branch`, so a
     * non-JSON key throws, is swallowed by the surrounding catch, and counts as
     * "not verified". Every legacy-imported product therefore failed the
     * role-coverage gate with "catalog is missing verified journeys for
     * role(s): Default role" — a product with verified journeys that could never
     * be published, and the reason a mapped product showed "not published" in
     * the demo picker. The durable path (storage/memory.ts) already writes JSON.
     */
    for (const item of coverage) {
      const dimensionKey = coverageDimensionKey({
        roleProfileId, customerJobId: item.customerJobId,
        state: "default", branch: "happy_path", locale: "default",
      });
      await client.query(
        `INSERT INTO coverage_items(organization_id,catalog_version_id,role_profile_id,customer_job_id,
         dimension_key,depth,status,importance,detail,last_checked_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,now())`,
        [ctx.organizationId, catalogVersionId, roleProfileId, item.customerJobId, dimensionKey, item.depth, item.status, item.detail ?? null],
      );
    }

    const kind = (value: string) => (value === "value_prop" ? "value_proposition" : value);
    for (const play of brain.playbook) {
      await client.query(
        `INSERT INTO sales_plays(organization_id,catalog_version_id,kind,title,content,persona_keys,
         signal_keywords,approval_status,approved_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,'approved',now())`,
        [ctx.organizationId, catalogVersionId, kind(play.kind), play.prompt ?? play.kind, play.content, play.personas, play.keywords],
      );
    }

    const source = await client.query(
      `INSERT INTO knowledge_sources(organization_id,product_id,source_type,uri,trust)
       VALUES($1,$2,'legacy_import',$3,'official')
       ON CONFLICT(organization_id,product_id,uri) DO UPDATE SET updated_at=now() RETURNING id`,
      [ctx.organizationId, productId, `legacy://${legacy.id}`],
    );
    const grouped = new Map<string, typeof brain.docs>();
    for (const chunk of brain.docs) {
      const key = `${chunk.source}\n${chunk.title}`;
      grouped.set(key, [...(grouped.get(key) ?? []), chunk]);
    }
    for (const [key, chunks] of grouped) {
      const title = chunks[0]?.title ?? "Imported document";
      const externalKey = createHash("sha256").update(key).digest("hex");
      const document = await client.query(
        `INSERT INTO documents(organization_id,source_id,external_key,title) VALUES($1,$2,$3,$4)
         ON CONFLICT(organization_id,source_id,external_key) DO UPDATE SET title=EXCLUDED.title,updated_at=now() RETURNING id`,
        [ctx.organizationId, source.rows[0].id, externalKey, title],
      );
      const contentHash = createHash("sha256").update(chunks.map((chunk) => chunk.text).join("\n")).digest("hex");
      const version = await client.query(
        `INSERT INTO document_versions(organization_id,document_id,content_hash) VALUES($1,$2,$3)
         ON CONFLICT(organization_id,document_id,content_hash) DO UPDATE SET content_hash=EXCLUDED.content_hash RETURNING id`,
        [ctx.organizationId, document.rows[0].id, contentHash],
      );
      for (const [ordinal, chunk] of chunks.entries()) {
        const embedding = chunk.embedding?.length === 1536 ? `[${chunk.embedding.join(",")}]` : null;
        await client.query(
          `INSERT INTO knowledge_chunks(organization_id,product_id,catalog_version_id,document_version_id,
           ordinal,title,section,content,embedding,metadata)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::vector,$10::jsonb)
           ON CONFLICT(organization_id,document_version_id,ordinal) DO UPDATE SET
             content=EXCLUDED.content,embedding=EXCLUDED.embedding,metadata=EXCLUDED.metadata`,
          [ctx.organizationId, productId, catalogVersionId, version.rows[0].id, ordinal, chunk.title, chunk.section, chunk.text,
            embedding, JSON.stringify({ source: chunk.source, trust: chunk.trust, freshness: chunk.freshness })],
        );
      }
    }
    return {
      productId, catalogVersionId, verified, approved, docs: brain.docs.length, plays: brain.playbook.length,
      screens: graph.screens.length, transitions: seenEdges.size,
    };
  });

  /*
   * Publishing REQUIRES at least one verified journey — that gate is the whole
   * point of publishing, and a catalog with nothing proven cannot be demoed. A
   * product that was never successfully mapped therefore stays a review draft
   * rather than failing the whole sync.
   */
  let published = false;
  if (imported.verified > 0 && imported.approved === imported.verified) {
    await catalogService.publish(ctx, imported.catalogVersionId);
    published = true;
  }
  return { ...imported, published };
}
