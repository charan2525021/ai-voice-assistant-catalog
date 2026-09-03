BEGIN;

-- Username + password login, stored in PostgreSQL instead of data/auth/users.json.
--
-- Deliberately a SEPARATE table from platform_users. platform_users models an
-- external identity (OIDC `external_subject`) that may belong to several
-- organizations through organization_memberships; this table is the local
-- password adapter DURABLE_BACKBONE.md describes, and it holds only what a
-- login needs. Keeping them apart means adopting SSO later is a deletion here,
-- not a migration of the identity model.
--
-- NO row-level security on purpose. Every RLS policy keys off
-- current_setting('app.organization_id'), but a login is precisely the request
-- that does not yet know its organization — the lookup has to happen before the
-- tenant is established. Because FORCE ROW LEVEL SECURITY applies even to the
-- table owner, a SECURITY DEFINER helper could not sidestep it either. The row
-- therefore carries organization_id itself, and that value is what the server
-- puts into TenantContext once the password verifies.
CREATE TABLE IF NOT EXISTS user_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE,
  -- scrypt, stored as "salt:hash" (both hex). Never a reversible encoding.
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'viewer')),
  organization_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE INDEX IF NOT EXISTS user_credentials_org_idx
  ON user_credentials (organization_id);

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aidan_runtime') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON user_credentials TO aidan_runtime';
  END IF;
END
$grants$;

COMMIT;
