BEGIN;

-- Docker creates this role in db/init/000_runtime_role.sh. Managed databases
-- may provision it separately; skip grants until that role exists.
DO $runtime_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aidan_runtime') THEN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO aidan_runtime', current_database());
    EXECUTE 'GRANT USAGE ON SCHEMA public TO aidan_runtime';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO aidan_runtime';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO aidan_runtime';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aidan_runtime';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO aidan_runtime';
  END IF;
END
$runtime_grants$;

COMMIT;
