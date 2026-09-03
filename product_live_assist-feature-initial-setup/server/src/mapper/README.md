# Product Mapper — learn a new product into a knowledge graph

Point it at a product it has never seen; it learns the journeys, **verifies each by replaying from a
clean state**, and stores them as executable programs in a knowledge graph. Verified journeys are
published to the Brain, so the live agent can immediately run them.

Design rationale: [`../../../MAPPER_PLAN.md`](../../../MAPPER_PLAN.md).

## Use

```bash
# in aidan/server, with PRODUCT=<name> set in aidan/.env
npm run map:learn -- 5 4     # learn: [maxJobs] [maxScreens]
npm run map:show             # inspect the graph
npm run map:reverify         # re-run every journey → drift detection + reliability
```

Output: `server/data/brain/<product>/product-graph.json`, plus verified journeys exported into
`flows.json` (what the live agent and Intent Rescue consume).

## Pipeline

| Stage                | File                   | Does                                                                                                                                                           |
| ----------------------| ------------------------| ----------------------------------------------------------------------------------------------------------------------------------------------------------------|
| ① Cartographer       | `cartographer.ts`      | Breadth-first surface map from the element/a11y list. **Read-only** — follows navigation, never submits. No vision → ~free.                                    |
| ② Curriculum Planner | `planner.ts`           | Turns screens + ingested docs into a **ranked list of jobs** ("Create a task"). This is what makes exploration goal-directed instead of a combinatorial crawl. |
| ③ Explorer           | `explorer.ts`          | Attempts ONE job in a fresh browser; records each successful action with a **durable selector** (ARIA role + accessible name).                                 |
| ④ Verifier           | `verifier.ts`          | Replays the journey in a **brand-new session** and asserts the postcondition. Deterministic, no model. **Nothing enters the usable graph without passing.**    |
| ⑤ Semanticist        | `semanticist.ts`       | Writes what the capability *means*, grounded in docs.                                                                                                          |
| — Graph              | `graph.ts`, `types.ts` | Persists the graph; exports verified journeys → Brain `flows`.                                                                                                 |
| — Safety             | `safety.ts`            | Structural interlocks (below).                                                                                                                                 |

## Why journeys, not pages

A page graph ("Screen A --click--> Screen B") can't guide a user. A **journey** can:

```
Mark a task complete
  1. fill  textbox  "What needs to be done?" = "Task"     ← precondition, discovered automatically
  2. click checkbox "Toggle Todo"
  ⇒ expect: "0 items left"                                 ← asserted on every replay
  ⇒ means:  "Users can mark a task complete by clicking its checkbox…"
```

Selectors are **role + accessible name**, never per-snapshot ids or brittle CSS — so a journey
recorded in one session replays in another and survives redesigns.

## Safety (structural, not prompted)

`safety.ts` refuses at the execution layer, because an exploring agent *will* eventually try:

- **Destructive verbs** blocked unless allowlisted for that journey: delete, remove, send, pay, invite, publish, archive, cancel subscription…
- **Never-touch areas**: logout, billing, account settings, API keys, danger zones.
- **Origin allowlist**: no off-site navigation.
- **Budgets**: max steps + wall-clock per job — explorers die rather than wander.

Run against a **sandbox/demo tenant**, never production.

## Maintenance

`map:reverify` replays everything and updates a rolling `reliability` score. A journey that starts
failing means the product's UI changed — that's your **drift alarm**; re-run `map:learn` to repair.

## Known gaps

- Entity extraction is naive (it can record the typed *value* as the entity rather than the type).
- Multi-screen products need a higher `maxScreens`; auth'd apps need a logged-in `storageState`.
- Journey composition (`requiresJourney`) is modelled in the schema but not yet auto-derived.
