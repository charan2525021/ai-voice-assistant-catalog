BEGIN;

-- Encrypted secret material for the PostgresSecretProvider.
--
-- Until now the only writable provider was Vault, so POST /api/v2/credentials
-- failed with "not configured for secure writes" on every install without one —
-- which made the Add-product flow unusable for any product behind a login.
--
-- Values are AES-256-GCM ciphertext, never plaintext, so a database dump or
-- backup does not disclose customer credentials. The key lives outside the
-- database (SECRET_ENCRYPTION_KEY, or data/secrets/key) precisely so that
-- holding the dump is not enough to read it.
--
-- Defense in depth: the organization is both an explicit column protected by
-- forced RLS and the first component of the validated secret path. The provider
-- sets app.organization_id inside the same transaction as every read/write.
CREATE TABLE IF NOT EXISTS secret_values (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  secret_path text NOT NULL,
  -- base64 of iv(12) || auth_tag(16) || ciphertext
  ciphertext text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, secret_path)
);

ALTER TABLE secret_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE secret_values FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS secret_values_tenant ON secret_values;
CREATE POLICY secret_values_tenant ON secret_values
  USING (organization_id = current_setting('app.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.organization_id', true)::uuid);

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aidan_runtime') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON secret_values TO aidan_runtime';
  END IF;
END
$grants$;

COMMIT;
