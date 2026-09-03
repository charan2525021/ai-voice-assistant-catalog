BEGIN;

ALTER TABLE customer_sessions ADD COLUMN IF NOT EXISTS browser_session_id text;
ALTER TABLE customer_sessions ADD COLUMN IF NOT EXISTS worker_id text;
ALTER TABLE customer_sessions ADD COLUMN IF NOT EXISTS recovery_lease_expires_at timestamptz;
CREATE INDEX IF NOT EXISTS customer_sessions_recovery_idx
  ON customer_sessions (organization_id, status, recovery_lease_expires_at);

COMMIT;
