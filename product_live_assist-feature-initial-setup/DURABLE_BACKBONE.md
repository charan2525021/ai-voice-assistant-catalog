# Durable backend

## What is implemented

The live path is deliberately two-speed:

1. PostgreSQL + pgvector is the durable source of truth for tenants, products,
   environments, roles, credentials references, catalog versions, journeys,
   knowledge, sales plays, coverage, sessions, mapping jobs, feedback and audit.
2. A published catalog is compiled once into an immutable runtime bundle. Each
   worker reads that bundle from memory, with Redis as the shared cache and the
   object store as the durable artifact. PostgreSQL is not traversed on every
   action.
3. The browser produces a fresh versioned `ScreenState` before each action. The
   evidence router combines that state with a verified journey, an approved
   sales play, and knowledge retrieval only when the question requires it.
4. The generic workflow executor performs bounded, policy-checked actions. New
   client products add data, not branches to runtime code.

Redis also holds the active-session directory and cluster-wide browser leases.
PostgreSQL mapping jobs have worker leases and small checkpoints; large working
graphs and mapped outputs live in checksummed artifact rows, so mapping resumes
without repeatedly rewriting an ever-growing job record.
Live conversations stay pinned to the catalog version they started with. A
dropped socket gets a reconnect grace period; Redis redirects it to its owning
worker. With Steel, PostgreSQL stores the managed browser ID and an expiring
worker fence, so another worker can reattach after a hard process failure.

## Tenant boundary

Every durable entity contains `organization_id`. Composite foreign keys prevent
cross-tenant relationships. All tenant tables have row-level security enabled
and forced; repository calls set `app.organization_id` within a transaction.

Production must connect with a non-superuser, non-`BYPASSRLS` database role.
`DATABASE_ADMIN_URL` is only for migrations; the running server uses
`DATABASE_URL`. The Compose stack creates `aidan_runtime` for this purpose.
Credentials are secret-manager references only. `POST /api/v2/credentials`
writes secret material to the configured Vault adapter and links only its
provider/path reference to a role. The legacy JSON importer creates
`migration_required` references instead of copying passwords or browser state.

The bundled username/password admin login remains a single-node compatibility
adapter. Multi-replica production should terminate OIDC/SAML in a shared identity
service and map its organization/user/role claims into `TenantContext`; the
durable schema already contains platform users and organization memberships.

## Client-neutral rule

Platform code owns only universal stages and primitives: discover, observe,
classify, execute, verify, approve and publish. Product-specific URLs, labels,
roles, states, journeys, policies, pitches and exceptions live in versioned
catalog data. A catalog is published only when every included journey is
verified; only approved sales plays enter the runtime bundle.

## Start and migrate

```bash
docker compose up -d
cd server
export DATABASE_ADMIN_URL=postgres://aidan:aidan@localhost:5433/aidan
export DATABASE_URL=postgres://aidan_runtime:aidan_runtime@localhost:5433/aidan
export REDIS_URL=redis://localhost:6379
export ADMIN_ORG_ID=00000000-0000-4000-8000-000000000001
npm run db:migrate
npm run db:import-legacy   # once, if upgrading an existing JSON install
npm test
# Optional real-infrastructure checks:
DATABASE_URL=postgres://aidan_runtime:aidan_runtime@localhost:5433/aidan npm run test:postgres
```

Set a durable object-store mount with `OBJECT_STORE_PATH`. In a multi-host
deployment, mount a shared object store or replace `LocalObjectStore` with an
S3-compatible implementation behind the existing interface.

## Rollout order

1. Create organization/product/environment/role records through `/api/v2`.
2. Store login material with `/api/v2/credentials`; the API writes it to Vault
   and saves only its provider/path reference.
3. Create a draft catalog and run mapping jobs across every role and important
   customer job. Review coverage gaps, failed paths and destructive actions.
4. Approve extracted sales plays, verify journeys, then publish atomically.
5. Route customer sessions by the Redis worker directory. Track live latency,
   journey success, unanswered questions and coverage regressions.
6. Build a new draft for every remap; never mutate the published catalog.

Core v2 endpoints:

- `POST /api/v2/products` — product and environment.
- `POST /api/v2/credential-refs` and `POST /api/v2/environments/:id/roles` — secret pointer and role.
- `POST /api/v2/products/:id/mapping-jobs` / `GET /api/v2/mapping-jobs/:id` — preflight, map, verify and persist a review catalog.
- `POST /api/v2/products/:id/knowledge` — version and embed product knowledge.
- `POST /api/v2/products/:id/knowledge/sync` — crawl HTTPS pages/sitemaps through
  the private-network/redirect/size safety gate, then version and embed them.
- Salesperson transcript/pitch training is intentionally deferred in this merge;
  no training or approval endpoint is exposed.
- `POST /api/v2/catalogs/:id/publish` — immutable atomic publication.
- `POST /api/v2/session` — start the role-bound durable live employee.
- `POST /api/v2/products/:id/embed-tokens` — issue a revocable, expiring,
  origin-restricted product+role grant; `/api/v2/embed/session` consumes it.

The runtime latency path is worker memory → Redis → immutable object artifact.
PostgreSQL is reached only on a cold catalog lookup or a knowledge question;
screen questions use the fresh browser state, verified actions use the compiled
journey, and small talk performs neither catalog traversal nor vector search.

## Remaining deployment work

The code now provides the durable contracts and runtime, including S3-compatible
artifacts, Steel browsers, Vault writes, OIDC/JWKS, Redis coordination, revocable
embeds and the mapping worker. Production still needs those adapters configured,
per-worker public WebSocket URLs, browser-session failure policy, and load tests
at the expected enterprise concurrency. None requires client-specific workflow
code.
