CREATE TABLE IF NOT EXISTS runtime_installations (
  installation_id text PRIMARY KEY,
  organization_id text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS runtime_catalogs (
  organization_id text NOT NULL,
  catalog_version_id text NOT NULL,
  envelope jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, catalog_version_id)
);
CREATE TABLE IF NOT EXISTS runtime_evidence_bundles (
  organization_id text NOT NULL,
  product_id text NOT NULL,
  catalog_version_id text NOT NULL,
  bundle jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, product_id, catalog_version_id)
);
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS runtime_knowledge_chunks (
  organization_id text NOT NULL,
  product_id text NOT NULL,
  catalog_version_id text NOT NULL,
  chunk_id text NOT NULL,
  title text NOT NULL,
  section text NOT NULL DEFAULT '',
  body text NOT NULL,
  source text NOT NULL,
  trust text NOT NULL CHECK (trust IN ('official','marketing','community','sales_expert')),
  embedding vector,
  PRIMARY KEY (organization_id, product_id, catalog_version_id, chunk_id)
);
CREATE TABLE IF NOT EXISTS runtime_sessions (
  session_id text PRIMARY KEY,
  organization_id text NOT NULL,
  payload jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS runtime_events (
  event_id text PRIMARY KEY,
  organization_id text NOT NULL,
  installation_id text NOT NULL,
  session_id text,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS runtime_knowledge_search_idx ON runtime_knowledge_chunks USING gin (to_tsvector('simple', title || ' ' || body));
CREATE INDEX IF NOT EXISTS runtime_sessions_expiry_idx ON runtime_sessions (expires_at);

CREATE TABLE IF NOT EXISTS runtime_continuities (
  continuity_id text PRIMARY KEY,
  organization_id text NOT NULL,
  installation_id text NOT NULL,
  payload jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS runtime_continuities_expiry_idx ON runtime_continuities (expires_at);
CREATE TABLE IF NOT EXISTS runtime_handoffs (
  token_hash text PRIMARY KEY,
  organization_id text NOT NULL,
  installation_id text NOT NULL,
  payload jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS runtime_handoffs_expiry_idx ON runtime_handoffs (expires_at);

ALTER TABLE runtime_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_installations FORCE ROW LEVEL SECURITY;
ALTER TABLE runtime_catalogs ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_catalogs FORCE ROW LEVEL SECURITY;
ALTER TABLE runtime_evidence_bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_evidence_bundles FORCE ROW LEVEL SECURITY;
ALTER TABLE runtime_knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_knowledge_chunks FORCE ROW LEVEL SECURITY;
ALTER TABLE runtime_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE runtime_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_events FORCE ROW LEVEL SECURITY;
ALTER TABLE runtime_continuities ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_continuities FORCE ROW LEVEL SECURITY;
ALTER TABLE runtime_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_handoffs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS runtime_installation_scope ON runtime_installations;
CREATE POLICY runtime_installation_scope ON runtime_installations USING (
  installation_id = current_setting('app.installation_id', true)
  OR organization_id = current_setting('app.organization_id', true)
) WITH CHECK (organization_id = current_setting('app.organization_id', true));
DROP POLICY IF EXISTS runtime_catalog_scope ON runtime_catalogs;
CREATE POLICY runtime_catalog_scope ON runtime_catalogs USING (organization_id = current_setting('app.organization_id', true)) WITH CHECK (organization_id = current_setting('app.organization_id', true));
DROP POLICY IF EXISTS runtime_evidence_bundle_scope ON runtime_evidence_bundles;
CREATE POLICY runtime_evidence_bundle_scope ON runtime_evidence_bundles USING (organization_id = current_setting('app.organization_id', true)) WITH CHECK (organization_id = current_setting('app.organization_id', true));
DROP POLICY IF EXISTS runtime_knowledge_scope ON runtime_knowledge_chunks;
CREATE POLICY runtime_knowledge_scope ON runtime_knowledge_chunks USING (organization_id = current_setting('app.organization_id', true)) WITH CHECK (organization_id = current_setting('app.organization_id', true));
DROP POLICY IF EXISTS runtime_session_scope ON runtime_sessions;
CREATE POLICY runtime_session_scope ON runtime_sessions USING (
  session_id = current_setting('app.session_id', true)
  OR organization_id = current_setting('app.organization_id', true)
) WITH CHECK (organization_id = current_setting('app.organization_id', true));
DROP POLICY IF EXISTS runtime_event_scope ON runtime_events;
CREATE POLICY runtime_event_scope ON runtime_events USING (organization_id = current_setting('app.organization_id', true)) WITH CHECK (organization_id = current_setting('app.organization_id', true));
DROP POLICY IF EXISTS runtime_continuity_scope ON runtime_continuities;
CREATE POLICY runtime_continuity_scope ON runtime_continuities USING (
  continuity_id = current_setting('app.continuity_id', true)
  OR
  installation_id = current_setting('app.installation_id', true)
  OR organization_id = current_setting('app.organization_id', true)
) WITH CHECK (organization_id = current_setting('app.organization_id', true));
DROP POLICY IF EXISTS runtime_handoff_scope ON runtime_handoffs;
CREATE POLICY runtime_handoff_scope ON runtime_handoffs USING (
  token_hash = current_setting('app.handoff_hash', true)
  OR
  installation_id = current_setting('app.installation_id', true)
  OR organization_id = current_setting('app.organization_id', true)
) WITH CHECK (organization_id = current_setting('app.organization_id', true));
