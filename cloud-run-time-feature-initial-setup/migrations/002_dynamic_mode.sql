-- Migration 002 — dynamic-mode opt-in per installation.
-- Additive only. The existing runtime_installations.payload JSONB already
-- carries the full Installation record; the DynamicModeConfig lives at
-- payload.dynamicMode. This migration documents the new shape and adds a
-- generated column + partial index so lookups by dynamicMode.enabled stay
-- cheap even on large tenants.
--
-- Shape (see cloud-run-time/src/contracts.ts):
--
--   {
--     "dynamicMode": {
--       "enabled": true,
--       "maxIterationsPerTurn": 8,
--       "allowedTools": ["click", "fill", "select", "navigate", "wait", "read"],
--       "autoConfirmLowRisk": true
--     }
--   }
--
-- Nothing is required. Existing installations without a dynamicMode field
-- behave exactly as before (signed-catalog only).

ALTER TABLE runtime_installations
  ADD COLUMN IF NOT EXISTS dynamic_mode_enabled boolean
    GENERATED ALWAYS AS (COALESCE((payload->'dynamicMode'->>'enabled')::boolean, false)) STORED;

CREATE INDEX IF NOT EXISTS runtime_installations_dynamic_mode_idx
  ON runtime_installations (organization_id)
  WHERE dynamic_mode_enabled;
