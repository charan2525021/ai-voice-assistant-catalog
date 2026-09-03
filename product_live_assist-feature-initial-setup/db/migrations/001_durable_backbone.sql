BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  external_subject text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organization_memberships (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_key text NOT NULL,
  name text NOT NULL,
  active_catalog_version_id uuid,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, product_key),
  UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS environments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  product_id uuid NOT NULL,
  environment_key text NOT NULL,
  name text NOT NULL,
  start_url text NOT NULL,
  product_version text,
  locale text NOT NULL DEFAULT 'en-US',
  feature_flags jsonb NOT NULL DEFAULT '{}'::jsonb,
  reset_adapter_type text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, product_id) REFERENCES products(organization_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, product_id, environment_key),
  UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS credential_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL,
  secret_path text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, provider, secret_path),
  UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS role_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  role_key text NOT NULL,
  name text NOT NULL,
  credential_ref_id uuid,
  permission_hints jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, environment_id) REFERENCES environments(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, credential_ref_id) REFERENCES credential_refs(organization_id, id) ON DELETE SET NULL,
  UNIQUE (organization_id, environment_id, role_key),
  UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS catalog_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  product_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('draft', 'mapping', 'verifying', 'review', 'published', 'retired')),
  schema_version integer NOT NULL DEFAULT 1,
  bundle_key text,
  bundle_checksum text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  FOREIGN KEY (organization_id, product_id) REFERENCES products(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, environment_id) REFERENCES environments(organization_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, product_id, environment_id, version),
  UNIQUE (organization_id, id)
);

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_active_catalog_fk;
ALTER TABLE products ADD CONSTRAINT products_active_catalog_fk
  FOREIGN KEY (organization_id, active_catalog_version_id)
  REFERENCES catalog_versions(organization_id, id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS capabilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  catalog_version_id uuid NOT NULL,
  capability_key text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  importance double precision NOT NULL DEFAULT 1 CHECK (importance >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, catalog_version_id) REFERENCES catalog_versions(organization_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, catalog_version_id, capability_key),
  UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS customer_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  catalog_version_id uuid NOT NULL,
  capability_id uuid NOT NULL,
  job_key text NOT NULL,
  goal text NOT NULL,
  outcome text NOT NULL DEFAULT '',
  importance double precision NOT NULL DEFAULT 1 CHECK (importance >= 0),
  source text NOT NULL CHECK (source IN ('documentation', 'analytics', 'sales_expert', 'mapper', 'customer_feedback', 'manual')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, catalog_version_id) REFERENCES catalog_versions(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, capability_id) REFERENCES capabilities(organization_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, catalog_version_id, job_key),
  UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS screen_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  catalog_version_id uuid NOT NULL,
  screen_key text NOT NULL,
  name text NOT NULL,
  url_template text,
  purpose text,
  fingerprint_hints jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, catalog_version_id) REFERENCES catalog_versions(organization_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, catalog_version_id, screen_key),
  UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS screen_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  catalog_version_id uuid NOT NULL,
  screen_type_id uuid NOT NULL,
  state_key text NOT NULL,
  name text NOT NULL,
  fingerprint text NOT NULL,
  conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
  artifact_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, catalog_version_id) REFERENCES catalog_versions(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, screen_type_id) REFERENCES screen_types(organization_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, catalog_version_id, screen_type_id, state_key),
  UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS controls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  catalog_version_id uuid NOT NULL,
  screen_state_id uuid NOT NULL,
  control_key text NOT NULL,
  role text,
  accessible_name text,
  locator_set jsonb NOT NULL DEFAULT '{}'::jsonb,
  risk text NOT NULL DEFAULT 'read' CHECK (risk IN ('read', 'reversible_write', 'external_side_effect', 'destructive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, catalog_version_id) REFERENCES catalog_versions(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, screen_state_id) REFERENCES screen_states(organization_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, screen_state_id, control_key),
  UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  catalog_version_id uuid NOT NULL,
  from_state_id uuid NOT NULL,
  to_state_id uuid,
  control_id uuid,
  action jsonb NOT NULL,
  verification_status text NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified', 'verified', 'broken', 'inconclusive')),
  reliability double precision NOT NULL DEFAULT 0 CHECK (reliability BETWEEN 0 AND 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, catalog_version_id) REFERENCES catalog_versions(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, from_state_id) REFERENCES screen_states(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, to_state_id) REFERENCES screen_states(organization_id, id) ON DELETE SET NULL,
  FOREIGN KEY (organization_id, control_id) REFERENCES controls(organization_id, id) ON DELETE SET NULL,
  UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS journeys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  product_id uuid NOT NULL,
  journey_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, product_id) REFERENCES products(organization_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, product_id, journey_key),
  UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS journey_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  catalog_version_id uuid NOT NULL,
  journey_id uuid NOT NULL,
  capability_id uuid NOT NULL,
  customer_job_id uuid NOT NULL,
  role_profile_ids uuid[] NOT NULL DEFAULT '{}',
  workflow jsonb NOT NULL,
  verification_status text NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified', 'verified', 'broken', 'inconclusive')),
  reliability double precision NOT NULL DEFAULT 0 CHECK (reliability BETWEEN 0 AND 1),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, catalog_version_id) REFERENCES catalog_versions(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, journey_id) REFERENCES journeys(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, capability_id) REFERENCES capabilities(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, customer_job_id) REFERENCES customer_jobs(organization_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, catalog_version_id, journey_id),
  UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS knowledge_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  product_id uuid NOT NULL,
  source_type text NOT NULL,
  uri text NOT NULL,
  trust text NOT NULL CHECK (trust IN ('official', 'marketing', 'community', 'sales_expert')),
  acl jsonb NOT NULL DEFAULT '{}'::jsonb,
  sync_cursor jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, product_id) REFERENCES products(organization_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, product_id, uri),
  UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  source_id uuid NOT NULL,
  external_key text NOT NULL,
  title text NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, source_id) REFERENCES knowledge_sources(organization_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, source_id, external_key),
  UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  document_id uuid NOT NULL,
  content_hash text NOT NULL,
  artifact_key text,
  source_modified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, document_id) REFERENCES documents(organization_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, document_id, content_hash),
  UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  product_id uuid NOT NULL,
  catalog_version_id uuid,
  document_version_id uuid NOT NULL,
  ordinal integer NOT NULL,
  title text NOT NULL,
  section text NOT NULL DEFAULT '',
  content text NOT NULL,
  embedding vector(1536),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, product_id) REFERENCES products(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, catalog_version_id) REFERENCES catalog_versions(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, document_version_id) REFERENCES document_versions(organization_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, document_version_id, ordinal),
  UNIQUE (organization_id, id)
);

CREATE INDEX IF NOT EXISTS knowledge_chunks_scope_idx
  ON knowledge_chunks (organization_id, product_id, catalog_version_id);
CREATE INDEX IF NOT EXISTS knowledge_chunks_content_fts_idx
  ON knowledge_chunks USING gin (to_tsvector('simple', content));
CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_hnsw_idx
  ON knowledge_chunks USING hnsw (embedding vector_cosine_ops) WHERE embedding IS NOT NULL;

CREATE TABLE IF NOT EXISTS sales_plays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  catalog_version_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('discovery', 'value_proposition', 'objection', 'proof_moment', 'next_best_action', 'positioning')),
  title text NOT NULL,
  content text NOT NULL,
  persona_keys text[] NOT NULL DEFAULT '{}',
  capability_ids uuid[] NOT NULL DEFAULT '{}',
  journey_keys text[] NOT NULL DEFAULT '{}',
  signal_keywords text[] NOT NULL DEFAULT '{}',
  source_document_id uuid,
  approval_status text NOT NULL DEFAULT 'draft' CHECK (approval_status IN ('draft', 'approved', 'rejected')),
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, catalog_version_id) REFERENCES catalog_versions(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, source_document_id) REFERENCES documents(organization_id, id) ON DELETE SET NULL,
  UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS coverage_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  catalog_version_id uuid NOT NULL,
  role_profile_id uuid NOT NULL,
  customer_job_id uuid NOT NULL,
  dimension_key text NOT NULL,
  depth smallint NOT NULL CHECK (depth BETWEEN 0 AND 5),
  status text NOT NULL CHECK (status IN ('unknown', 'discovered', 'verified', 'broken', 'blocked')),
  importance double precision NOT NULL DEFAULT 1 CHECK (importance >= 0),
  detail text,
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, catalog_version_id) REFERENCES catalog_versions(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, role_profile_id) REFERENCES role_profiles(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, customer_job_id) REFERENCES customer_jobs(organization_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, catalog_version_id, role_profile_id, customer_job_id, dimension_key),
  UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS customer_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  product_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  role_profile_id uuid NOT NULL,
  catalog_version_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('text', 'voice')),
  status text NOT NULL CHECK (status IN ('starting', 'active', 'ended', 'failed')),
  memory jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, product_id) REFERENCES products(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, environment_id) REFERENCES environments(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, role_profile_id) REFERENCES role_profiles(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, catalog_version_id) REFERENCES catalog_versions(organization_id, id) ON DELETE RESTRICT,
  UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS mapping_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  product_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  catalog_version_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'waiting_for_human', 'completed', 'failed')),
  stage text NOT NULL,
  cursor jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts integer NOT NULL DEFAULT 0,
  error text,
  lease_owner text,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, product_id) REFERENCES products(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, environment_id) REFERENCES environments(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, catalog_version_id) REFERENCES catalog_versions(organization_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, id)
);

CREATE INDEX IF NOT EXISTS mapping_jobs_claim_idx
  ON mapping_jobs (status, lease_expires_at, created_at) WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS workflow_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  session_id uuid,
  mapping_job_id uuid,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, session_id) REFERENCES customer_sessions(organization_id, id) ON DELETE SET NULL,
  FOREIGN KEY (organization_id, mapping_job_id) REFERENCES mapping_jobs(organization_id, id) ON DELETE SET NULL,
  UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS feedback_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  product_id uuid NOT NULL,
  catalog_version_id uuid NOT NULL,
  session_id uuid,
  kind text NOT NULL CHECK (kind IN ('unanswered_question', 'journey_failure', 'correction', 'friction', 'positive_engagement')),
  content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, product_id) REFERENCES products(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, catalog_version_id) REFERENCES catalog_versions(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, session_id) REFERENCES customer_sessions(organization_id, id) ON DELETE SET NULL,
  UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  request_id text NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workflow_events_timeline_idx ON workflow_events (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS feedback_signals_product_idx ON feedback_signals (organization_id, product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_timeline_idx ON audit_events (organization_id, created_at DESC);

-- Tenant scope is mandatory at the database layer. Application code sets these
-- transaction-local values before calling a repository.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON organizations;
CREATE POLICY tenant_isolation ON organizations
  USING (id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.organization_id', true), '')::uuid);

DO $tenant_rls$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'organization_memberships', 'products', 'environments', 'credential_refs',
    'role_profiles', 'catalog_versions', 'capabilities', 'customer_jobs',
    'screen_types', 'screen_states', 'controls', 'transitions', 'journeys',
    'journey_versions', 'knowledge_sources', 'documents', 'document_versions',
    'knowledge_chunks', 'sales_plays', 'coverage_items', 'customer_sessions',
    'mapping_jobs', 'workflow_events', 'feedback_signals', 'audit_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid) WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid)',
      table_name
    );
  END LOOP;
END
$tenant_rls$;

COMMIT;
