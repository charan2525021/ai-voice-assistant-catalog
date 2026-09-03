#!/bin/sh
set -eu

# The application must never connect as POSTGRES_USER: PostgreSQL superusers
# bypass RLS. Create a login-only runtime role before SQL migrations grant DML.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=runtime_password="${AIDAN_RUNTIME_PASSWORD:-aidan_runtime}" <<'SQL'
SELECT format(
  'CREATE ROLE aidan_runtime LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',
  :'runtime_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aidan_runtime')
\gexec
SQL
