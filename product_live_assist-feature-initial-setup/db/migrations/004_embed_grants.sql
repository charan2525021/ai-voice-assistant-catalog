BEGIN;

CREATE TABLE IF NOT EXISTS embed_grants (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  product_id uuid NOT NULL,
  role_profile_id uuid NOT NULL,
  allowed_origins text[] NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, product_id) REFERENCES products(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, role_profile_id) REFERENCES role_profiles(organization_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, id)
);

CREATE INDEX IF NOT EXISTS embed_grants_active_idx
  ON embed_grants (organization_id, product_id, expires_at) WHERE revoked_at IS NULL;

ALTER TABLE embed_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE embed_grants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON embed_grants;
CREATE POLICY tenant_isolation ON embed_grants
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

DO $runtime_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aidan_runtime') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON embed_grants TO aidan_runtime';
  END IF;
END
$runtime_grants$;

COMMIT;
