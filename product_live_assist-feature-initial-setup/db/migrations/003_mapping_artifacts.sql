BEGIN;

CREATE TABLE IF NOT EXISTS mapping_job_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  mapping_job_id uuid NOT NULL,
  artifact_key text NOT NULL,
  payload jsonb NOT NULL,
  checksum text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, mapping_job_id) REFERENCES mapping_jobs(organization_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, mapping_job_id, artifact_key),
  UNIQUE (organization_id, id)
);

ALTER TABLE mapping_job_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mapping_job_artifacts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mapping_job_artifacts;
CREATE POLICY tenant_isolation ON mapping_job_artifacts
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

DO $runtime_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aidan_runtime') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON mapping_job_artifacts TO aidan_runtime';
  END IF;
END
$runtime_grants$;

COMMIT;
