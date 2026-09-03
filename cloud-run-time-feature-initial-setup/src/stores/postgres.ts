import pg from "pg";
import type { RuntimeContinuity, RuntimeEvent, RuntimeHandoff, RuntimeSession, RuntimeStores } from "../contracts.js";

export function createPostgresStores(connectionString: string): RuntimeStores {
  const pool = new pg.Pool({ connectionString, max: 10 });
  const scoped = async <T>(scope: { organizationId?: string; installationId?: string; sessionId?: string; continuityId?: string; handoffHash?: string }, operation: (client: pg.PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.organization_id',$1,true), set_config('app.installation_id',$2,true), set_config('app.session_id',$3,true), set_config('app.continuity_id',$4,true), set_config('app.handoff_hash',$5,true)", [scope.organizationId ?? "", scope.installationId ?? "", scope.sessionId ?? "", scope.continuityId ?? "", scope.handoffHash ?? ""]);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  };
  return {
    installations: {
      get: async (id) => {
        return scoped({ installationId: id }, async (client) => (await client.query("SELECT payload FROM runtime_installations WHERE installation_id=$1", [id])).rows[0]?.payload);
      },
      list: async (organizationId) => scoped({ organizationId }, async (client) => (await client.query("SELECT payload FROM runtime_installations WHERE organization_id=$1 ORDER BY installation_id", [organizationId])).rows.map((row) => row.payload)),
      put: async (installation) => scoped({ organizationId: installation.organizationId, installationId: installation.installationId }, async (client) => { await client.query("INSERT INTO runtime_installations(installation_id,organization_id,payload) VALUES($1,$2,$3) ON CONFLICT(installation_id) DO UPDATE SET organization_id=excluded.organization_id,payload=excluded.payload", [installation.installationId, installation.organizationId, installation]); }),
    },
    catalogs: {
      get: async (version, installation) => {
        return scoped({ organizationId: installation.organizationId }, async (client) => (await client.query("SELECT envelope FROM runtime_catalogs WHERE organization_id=$1 AND catalog_version_id=$2", [installation.organizationId, version])).rows[0]?.envelope);
      },
      getBundle: async (scope) => scoped({ organizationId: scope.organizationId }, async (client) => (await client.query(
        "SELECT bundle FROM runtime_evidence_bundles WHERE organization_id=$1 AND product_id=$2 AND catalog_version_id=$3",
        [scope.organizationId, scope.productId, scope.catalogVersionId],
      )).rows[0]?.bundle),
    },
    knowledge: {
      search: async (scope, input) => {
        return scoped({ organizationId: scope.organizationId }, async (client) => {
        const result = input.embedding ? await client.query(
          `SELECT chunk_id AS id, organization_id AS "tenantId", product_id AS "productId",
                  catalog_version_id AS "catalogVersionId", title, section, body AS content, source, trust,
                  1 - (embedding <=> $4::vector) AS score
             FROM runtime_knowledge_chunks
            WHERE organization_id=$1 AND product_id=$2 AND catalog_version_id=$3 AND embedding IS NOT NULL
            ORDER BY embedding <=> $4::vector
            LIMIT $5`,
          [scope.organizationId, scope.productId, scope.catalogVersionId, `[${input.embedding.join(",")}]`, input.limit],
        ) : await client.query(
          `SELECT chunk_id AS id, organization_id AS "tenantId", product_id AS "productId",
                  catalog_version_id AS "catalogVersionId", title, section, body AS content, source, trust,
                  ts_rank(to_tsvector('simple', title || ' ' || section || ' ' || body), plainto_tsquery('simple', $4)) AS score
             FROM runtime_knowledge_chunks
            WHERE organization_id=$1 AND product_id=$2 AND catalog_version_id=$3
            ORDER BY to_tsvector('simple', title || ' ' || section || ' ' || body) @@ plainto_tsquery('simple', $4) DESC,
                     score DESC
            LIMIT $5`,
          [scope.organizationId, scope.productId, scope.catalogVersionId, input.query, input.limit],
        );
        return result.rows;
        });
      },
    },
    sessions: {
      put: async (session: RuntimeSession) => scoped({ organizationId: session.installation.organizationId, sessionId: session.sessionId }, async (client) => { await client.query("INSERT INTO runtime_sessions(session_id, organization_id, payload, expires_at) VALUES ($1,$2,$3,$4) ON CONFLICT(session_id) DO UPDATE SET payload=excluded.payload, expires_at=excluded.expires_at", [session.sessionId, session.installation.organizationId, session, session.expiresAt]); }),
      get: async (id) => scoped({ sessionId: id }, async (client) => (await client.query("SELECT payload FROM runtime_sessions WHERE session_id=$1 AND expires_at>now()", [id])).rows[0]?.payload),
      delete: async (id) => scoped({ sessionId: id }, async (client) => { await client.query("DELETE FROM runtime_sessions WHERE session_id=$1", [id]); }),
    },
    continuities: {
      put: async (value: RuntimeContinuity, expectedRevision?: number) => scoped({ organizationId: value.organizationId, installationId: value.installationId, continuityId: value.continuityId }, async (client) => {
        if (expectedRevision !== undefined) {
          const current = await client.query("SELECT payload FROM runtime_continuities WHERE continuity_id=$1 FOR UPDATE", [value.continuityId]);
          const currentRevision = Number(current.rows[0]?.payload?.revision ?? 0);
          if (currentRevision !== expectedRevision) return false;
        }
        await client.query("INSERT INTO runtime_continuities(continuity_id,organization_id,installation_id,payload,expires_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(continuity_id) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at", [value.continuityId, value.organizationId, value.installationId, value, value.expiresAt]);
        return true;
      }),
      get: async (id: string) => scoped({ continuityId: id }, async (client) => (await client.query("SELECT payload FROM runtime_continuities WHERE continuity_id=$1 AND expires_at>now()", [id])).rows[0]?.payload),
      delete: async (id: string) => scoped({ continuityId: id }, async (client) => { await client.query("DELETE FROM runtime_continuities WHERE continuity_id=$1", [id]); }),
    },
    handoffs: {
      put: async (value: RuntimeHandoff) => scoped({ organizationId: value.organizationId, installationId: value.installationId }, async (client) => { await client.query("INSERT INTO runtime_handoffs(token_hash,organization_id,installation_id,payload,expires_at) VALUES($1,$2,$3,$4,$5)", [value.tokenHash, value.organizationId, value.installationId, value, value.expiresAt]); }),
      consume: async (tokenHash: string) => scoped({ handoffHash: tokenHash }, async (client) => (await client.query("DELETE FROM runtime_handoffs WHERE token_hash=$1 AND expires_at>now() RETURNING payload", [tokenHash])).rows[0]?.payload),
    },
    events: {
      append: async (event: RuntimeEvent) => scoped({ organizationId: event.tenantId, sessionId: event.sessionId }, async (client) => { await client.query("INSERT INTO runtime_events(event_id, organization_id, installation_id, session_id, event_type, occurred_at, detail) VALUES($1,$2,$3,$4,$5,$6,$7)", [event.id, event.tenantId, event.installationId, event.sessionId ?? null, event.type, event.occurredAt, event.detail ?? {}]); }),
    },
    close: () => pool.end(),
  };
}
