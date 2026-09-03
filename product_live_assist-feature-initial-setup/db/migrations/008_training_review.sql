BEGIN;

-- Human-in-the-loop journey review and durable training audit.
ALTER TABLE journey_versions ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
ALTER TABLE journey_versions ADD COLUMN IF NOT EXISTS revision_checksum text;
ALTER TABLE journey_versions ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'pending';
ALTER TABLE journey_versions ADD COLUMN IF NOT EXISTS approved_checksum text;
ALTER TABLE journey_versions ADD COLUMN IF NOT EXISTS reviewed_by text;
ALTER TABLE journey_versions ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE journey_versions ADD COLUMN IF NOT EXISTS review_comment text;
ALTER TABLE journey_versions ADD COLUMN IF NOT EXISTS supersedes_journey_version_id uuid;

UPDATE journey_versions jv
SET revision_checksum = encode(digest(jv.workflow::text || jv.evidence::text, 'sha256'), 'hex')
WHERE revision_checksum IS NULL;

UPDATE journey_versions jv
SET approval_status='approved', approved_checksum=jv.revision_checksum,
    reviewed_by='migration:previously-published', reviewed_at=COALESCE(jv.verified_at, jv.updated_at)
FROM catalog_versions cv
WHERE cv.id=jv.catalog_version_id AND cv.status IN ('published','retired') AND jv.approval_status='pending';

ALTER TABLE journey_versions ALTER COLUMN revision_checksum SET NOT NULL;
ALTER TABLE journey_versions DROP CONSTRAINT IF EXISTS journey_versions_approval_status_check;
ALTER TABLE journey_versions ADD CONSTRAINT journey_versions_approval_status_check
  CHECK (approval_status IN ('pending','approved','rejected','rework_requested'));
ALTER TABLE journey_versions DROP CONSTRAINT IF EXISTS journey_versions_supersedes_journey_version_id_fkey;
ALTER TABLE journey_versions ADD CONSTRAINT journey_versions_supersedes_journey_version_id_fkey
  FOREIGN KEY (supersedes_journey_version_id) REFERENCES journey_versions(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS journey_review_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  product_id uuid NOT NULL,
  catalog_version_id uuid NOT NULL,
  journey_version_id uuid NOT NULL,
  revision integer NOT NULL,
  revision_checksum text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved','rejected','rework_requested')),
  comment text,
  instruction text,
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, product_id) REFERENCES products(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, catalog_version_id) REFERENCES catalog_versions(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, journey_version_id) REFERENCES journey_versions(organization_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS journey_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  product_id uuid NOT NULL,
  catalog_version_id uuid NOT NULL,
  journey_version_id uuid NOT NULL,
  instruction text NOT NULL,
  constraints jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','applied','failed','cancelled')),
  requested_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, product_id) REFERENCES products(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, catalog_version_id) REFERENCES catalog_versions(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, journey_version_id) REFERENCES journey_versions(organization_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS training_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  product_id uuid NOT NULL,
  catalog_version_id uuid,
  mapping_job_id uuid,
  journey_version_id uuid,
  event_type text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('agent','human','system')),
  actor_id text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, product_id) REFERENCES products(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, catalog_version_id) REFERENCES catalog_versions(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, mapping_job_id) REFERENCES mapping_jobs(organization_id, id) ON DELETE SET NULL,
  FOREIGN KEY (organization_id, journey_version_id) REFERENCES journey_versions(organization_id, id) ON DELETE SET NULL,
  UNIQUE (organization_id, id)
);

ALTER TABLE mapping_jobs DROP CONSTRAINT IF EXISTS mapping_jobs_status_check;
ALTER TABLE mapping_jobs ADD CONSTRAINT mapping_jobs_status_check
  CHECK (status IN ('queued','running','waiting_for_human','completed','failed','cancelled'));

CREATE INDEX IF NOT EXISTS training_events_product_timeline_idx ON training_events(organization_id, product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS journey_review_decisions_journey_idx ON journey_review_decisions(organization_id, journey_version_id, created_at DESC);
CREATE INDEX IF NOT EXISTS journey_corrections_status_idx ON journey_corrections(organization_id, status, created_at);

DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['journey_review_decisions','journey_corrections','training_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid) WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END $rls$;

DO $grants$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='aidan_runtime') THEN
    FOREACH t IN ARRAY ARRAY['journey_review_decisions','journey_corrections','training_events'] LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO aidan_runtime', t);
    END LOOP;
  END IF;
END $grants$;

COMMIT;
