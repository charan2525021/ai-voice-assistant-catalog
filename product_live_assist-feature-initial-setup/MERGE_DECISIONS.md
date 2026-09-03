# Sable merged implementation

This folder is a clean merge of the proven live runtime and the stronger admin,
mapping, storage, authentication, crawling and multi-tenant work from
`Sable Product_aashi`. The source folders were not changed.

## Kept from the proven runtime

- Live screen streaming and user takeover
- Streaming conversation, STT/TTS, playback acknowledgement and barge-in
- Verified action replay with post-action proof
- Current LLM API product definition and five verified journeys
- Safety interlocks for mutating actions

## Adopted and hardened

- Admin product onboarding, documentation crawl and interactive Chrome-profile sign-in
- Durable PostgreSQL repositories, catalogs, mapping jobs, Redis coordination and embed grants
- Organization-scoped users, products, live-control sessions, metrics and event access
- Encrypted PostgreSQL credentials with forced row-level security
- JavaScript-rendered documentation crawl with SSRF checks on every subrequest
- SPA mapping that merges overlays/panels but retains genuinely different views
- Recoverable product archive; irreversible purge is owner-only and not exposed in the console
- Atomic JSON writes and bounded in-memory mapping logs
- Provider-safe conversation history after interruptions or failed tool calls

## Deliberately excluded

- Salesperson transcript/training UI and any new pitch-training workflow
- `.env`, passwords, captured sessions, Chrome profiles, auth users, encryption keys and live share tokens
- `node_modules`, Python virtual environments, generated event logs and browser artifacts
- Historical session transcripts and old graph-version snapshots

The existing generic sales-play domain types remain because published catalogs already reference
them, but no salesperson-training feature was added or exposed in this merge.

## Validation

Run from `server/`:

```bash
npm install
npm run typecheck
npm test
```

The suite covers tenant isolation, generic workflows, runtime evidence routing, durable mapping,
credential RLS, rendered-crawl request safety, atomic tool history, SPA screen identity, proof
quality, sentence streaming and action safety.
