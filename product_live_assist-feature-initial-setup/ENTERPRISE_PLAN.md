# Enterprise readiness & the PLG path

An honest gap analysis against what exists today, ordered by what actually blocks a
client handover. Nothing here is hypothetical — every gap references real code.

---

## The blockers (in order)

### P0-1 — The platform has no authentication at all
Every route is open. Anyone who can reach port 8787 can link products, read the
event log, **revoke a stored session**, or start a demo. `safeAuth()` protects
credentials in responses, but nothing protects the endpoints themselves.

This is the single thing that makes the current build undeployable beyond a laptop.
It is also the cheapest to fix: session cookie + a `requireAuth` preHandler on
everything except the prospect-facing demo routes; then org-scoped RBAC
(owner / admin / viewer), then SSO (the irony of shipping an SSO capture flow with
no SSO of its own is not lost).

### P0-2 — No tenancy boundary
Products are a flat directory (`content/<id>`), `brainFor()` is a global registry,
and `sessions` is a process-global `Map`. There is no notion of an organisation, so
two customers cannot share an install. Every path that takes a `productId` needs an
`orgId` above it, enforced in the data layer rather than at each call site.

### P0-3 — Credentials sit in plaintext on disk
Chrome profiles (`content/<id>/chrome-profile`) and captured `storageState` are live
credentials in the clear, alongside API keys in `.env`. Needed: envelope encryption
at rest (KMS/age), a real secret store, key rotation, and an expiry policy —
a captured session should not live forever. **The keys currently in `aidan/.env`
were pasted into a chat and must be rotated before any handover.**

### P0-4 — One process, in-memory everything
Sessions, jobs and the brain registry are per-process. A restart kills every live
demo; there is no horizontal scale and no failover. Needed: session state in Redis,
jobs on a real queue, brains loaded per worker.

### P0-5 — The browser is the scaling wall
Every demo session is a full Chromium (`new LiveBox(...)` per session), with no
pooling, no concurrency cap and no memory limit. A handful of concurrent demos will
exhaust a normal host. Needed: a browser pool with hard caps, queueing with an
honest wait message, per-session memory/time limits, and eviction.

> **And the Chrome-profile SSO flow does not survive hosting.** It works because
> real Chrome runs on the same machine as the server — true on a laptop, false in a
> container. For SaaS this needs either a per-tenant browser VM with a remote
> desktop for the sign-in, or a customer-side connector that captures the session
> locally and ships only the session to the platform. **This is the most important
> architectural decision to make before building the hosted version**, and it should
> be made deliberately rather than discovered during a deployment.

### P1 — Correctness and trust
- **No cost ceiling.** A looping agent can spend without bound. Per-session and
  per-org caps in `makeBrain()`.
- **No knowledge-graph versioning.** Re-mapping overwrites in place; a bad run
  destroys a good graph with no rollback. Version each mapping run, publish
  atomically, keep the previous version.
- **Journeys rot silently.** They are verified once, at mapping time. When the
  customer ships a UI change, the demo breaks in front of a prospect. Needs the
  scheduled canary from `OBSERVABILITY_PLAN.md` Phase 3.
- **Evals do not gate anything.** 25/25 passing is only checked by hand. Put them in
  CI and block on regression.
- **Single model provider.** One gateway, no fallback; a 429 or outage ends every
  demo. Needs a fallback chain and a circuit breaker.
- **`preconditions` are not re-satisfied on journey restart** (known open item).

### P2 — What procurement will ask for
Audit log of who did what (the event log is the foundation — it needs actor
identity), data residency and a retention policy, DPA/subprocessor list, PII
handling for transcripts **and screenshots** (screenshots of a customer's product
routinely contain real customer data — today they are sent to a third-party model
provider and cached with no policy), SOC 2 controls, an incident runbook, backup and
restore of `data/brain`, and an uptime SLA.

---

## Recommended sequence

**Track A — hand a demo to a client (2–3 weeks).**
Auth + org scoping (P0-1, P0-2) → cost caps → knowledge-graph versioning →
Observability Phase 1 → evals in CI. This is the minimum for someone else to run
this against their own product without you in the room.

**Track B — hosted multi-tenant (6–10 weeks).** Decide the browser/SSO architecture
first (it constrains everything else), then P0-3/4/5, then the queue, then Phase 3
monitoring.

Track A is worth doing even if Track B is deferred: it is what makes the demo
*handable*, which is the stated goal.

---

## Going PLG

PLG means the product sells itself before anyone talks to sales. Concretely, a
stranger must reach value alone, and today they cannot: there is no sign-up, the
console assumes you own the machine, and the SSO flow needs local Chrome.

**The activation moment** is *seeing your own product demo itself*. Everything
should compress the time to it. Instrument it as a funnel — link → preflight →
mapping → first verified journey → first demo — and treat first-verified-journey as
the activation metric.

1. **Self-serve entry with an instant first taste.** Sign up, paste a URL, and for a
   public product get a mapped demo with no credentials at all. Auth is the biggest
   drop-off in the funnel; do not put it before the value.
2. **Make mapping a spectacle, not a spinner.** It takes minutes and is the most
   impressive thing the product does. Stream the live browser and the journeys as
   they are verified. The Activity tab is the substrate; the demo UI already streams
   frames — connect them.
3. **Shareable prospect links.** A tokenised, no-login URL the customer sends to
   *their* buyer, with the demo branded as theirs. This is the viral loop: every
   demo introduces the product to a new company.
4. **Embeddable widget** on the customer's pricing/product page — "talk to our
   product" — which is where PLG distribution actually compounds.
5. **Usage-based free tier** with visible limits (N products, N demos/month). Cost
   caps (P1) are the enforcement mechanism, so build them once.
6. **Customer analytics as the retention hook** — Observability Phase 4. Buyers stay
   for the demand signal ("prospects keep asking about X, and our KB can't answer
   it"), which nothing else in their stack gives them.
7. **Templates and a public gallery.** Pre-mapped demos of well-known SaaS products
   as SEO surface and instant proof.

**Honest risk:** the differentiator — autonomously mapping and *verifying* journeys
on an unseen product — is also the thing most likely to fail on a stranger's app
with no one watching. PLG makes that failure self-serve too. So the mapping
experience needs to degrade gracefully and legibly: say what it could not reach and
why, let the user demonstrate a journey by hand and learn from it, and never present
an unverified journey as though it were verified. The verification gate already
enforces the last one — keep it, even when it makes the numbers look worse.
