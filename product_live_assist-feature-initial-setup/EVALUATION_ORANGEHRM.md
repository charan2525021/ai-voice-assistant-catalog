# End-to-end evaluation on a complex product — OrangeHRM

**Target:** `opensource-demo.orangehrmlive.com` — a real HRIS with 9 modules (Admin,
PIM, Leave, Time, Recruitment, Performance, Directory, Claim, Buzz), behind a login,
built as a Vue SPA with custom widgets. Chosen because Swag Labs (6 pages, native
HTML controls) had stopped being a meaningful test.

**Date:** 2026-07-27 · **Runs:** 3 mapping runs, 1 live demo session, 12 journeys attempted.

---

## Headline

**On a complex enterprise application the system currently verifies zero journeys.**

The first run *reported* 3 verified out of 8. All three were false passes. After
fixing the verification gate (below), the honest number is **0 of 12**.

That is the finding that matters, and it was only visible because the verification
gate is the product's central claim. Swag Labs, re-checked under the corrected gate,
still passes **9 of 9** — so the fix is correct, not merely stricter, and the gap is
genuinely about application complexity.

---

## Module-by-module

| Module | Verdict | Evidence |
|---|---|---|
| **LiveBox** (browser) | ✅ Works | Loaded the SPA, real fingerprint accepted, 27 controls found on the dashboard |
| **Form login** | ✅ Works | Signed in to OrangeHRM and landed on `/dashboard/index` |
| **Preflight** | ✅ Works | Correctly reported reachable + signed in + 18 controls |
| **Cartographer** (survey) | ✅ Works | Mapped 10 distinct screens across 7 modules |
| **Planner** | ✅ Works | Proposed 8 sensible, module-spanning jobs; respected the safety constraints (no deletes, no sign-up) |
| **Explorer** | ⚠️ Partial | Produced runnable programs for 6/8 jobs; 1 "stopped without acting"; 2 blocked by widget limits |
| **Verifier** | ❌ **Was broken** — now fixed | 3/3 "verified" journeys were false passes; see below |
| **Durable selectors** | ❌ Gap | Icon-only buttons get a CSS class as their name |
| **`select` action** | ❌ Gap | Cannot drive custom (non-`<select>`) dropdowns |
| **Semanticist / narration** | ✅ Works | Wrote clear per-step narration ("I'll open the leave list so you can review pending requests") |
| **Taxonomy** | ✅ Works | Grouped journeys into coherent capability areas |
| **Graph versioning** | ✅ Works | 10 versions archived and correctly capped |
| **Knowledge / retrieval** | ✅ Works | Answered "what can this product do" accurately from an ingested page |
| **Agent (live demo)** | ✅ **Strong** | With *zero* verified journeys it still improvised correctly and told the truth about what it found |
| **Events / telemetry** | ✅ Works | Full run recorded: $0.098, 632s, 44 model calls, p95 latencies per step |
| **Budget caps** | ✅ Works | Enforced; daily counter survives restart |
| **Auth / share links** | ✅ Works | Gate closed, share link scoped to one product |
| **TTS** | ⚠️ One failure | Sarvam rejected one narration line with HTTP 400 |

---

## The critical defect: verification proved navigation, not action

`verifyJourney` took its "before" snapshot immediately after `resetState()`, which
leaves the browser on the **post-login landing page**. But nearly every journey
*begins by navigating somewhere else*. So the differential —"proof text absent
before, present after" — was satisfied by the navigation itself.

Proven directly, not inferred:

| Journey | Proof text | Present before any action? |
|---|---|---|
| Search the employee directory by department | `"Directory"` | **yes** (it is in the nav menu) |
| Search performance evaluations | `"No Records Found"` | **yes** (shown before you click Search) |
| Find an employee in the directory | `"A8Dco 4Ys 010Z"` | **yes** (the directory lists all employees already) |

The third is the most instructive: searching for an employee who is *already listed*
proves nothing whatsoever, and the system called it verified.

**Fix applied** (`mapper/verifier.ts`): split the program at the first non-`navigate`
step, run the navigation lead-in, *then* snapshot, then run the acting steps. A
journey that only navigates is now rejected outright — there is no action whose
effect could be proven.

**Result after the fix:** OrangeHRM 0/12 (6 rejected as "proof already on screen",
3 as "only navigates"); Swag Labs unchanged at 9/9.

### Second defect: verified status never expired
The three false passes survived a full re-map, because "verified" was permanent once
earned. That means a badge outlives both UI drift in the customer's product *and* any
bug fix in the gate itself. **Fixed**: onboarding now re-verifies existing journeys
first and demotes failures. Confirmed working — the run log shows all three demoted.

---

## Capability gaps that blocked real journeys

These are not bugs; they are the honest reason the system cannot yet demo an
enterprise app.

1. **Custom dropdowns (highest impact).** OrangeHRM uses `<div>`-based comboboxes,
   not `<select>`. Errors: `option "Pending Approval" not in div "-- Select --"`,
   `option "Online" not in div "-- Select --"`. This killed the Leave and Recruitment
   journeys — two of the most demo-worthy workflows in an HRIS. Nearly every modern
   enterprise UI (Ant, MUI, Radix, PrimeVue) does the same. **This is the single
   highest-value fix available.**

2. **Icon-only buttons have no durable name.** `no button named
   "oxd-icon-button oxd-table-cell-action-"` — the accessible-name extraction fell
   back to the CSS class. Row actions in tables are almost always icon buttons, so
   "open this record" journeys break.

3. **Proof selection is naive.** The explorer picks any text that appears; it needs
   to prefer text *causally produced by the action* (a new row, a toast, a changed
   count) and to reject page furniture and empty-state strings.

4. **Empty demo data.** "No Records Found" is a legitimate outcome that makes a
   terrible demo. Journeys should be scored on whether they *show something*.

---

## Cost and performance (measured, not estimated)

| | |
|---|---|
| Full mapping run (8 jobs) | **$0.098**, 10m 32s, 44 model calls |
| Tokens | 45,918 in / 1,535 out |
| Verification | p50 **17.6s**, p95 **25.6s** per journey — the dominant cost in time |
| Live demo turn | ~$0.003, 2–4s to first token |
| Screens surveyed | 10, in ~60s |

Cost is not a problem. **Verification time is** — at ~20s per attempt, a 50-journey
catalogue is ~20 minutes of pure replay, and every re-map now pays it twice.

---

## Against the original product promise

| Promise | Verdict |
|---|---|
| Point it at any product and it learns the workflows | **Partial.** Survey, plan and narrate work on an unseen enterprise app. Execution stalls on non-native widgets. |
| Nothing is demoed unless verified from a clean state | **Now true.** It was not true before this test — the gate passed navigation as proof. |
| Deterministic replay, no model in the loop | **True**, where a journey verifies. |
| Works on any product, nothing hardcoded | **True.** OrangeHRM needed no product-specific code; openers, narration and capabilities were all derived. |
| Handles SSO / real logins | **True** for form login here; Chrome-profile path covers SSO. |
| Graceful under failure | **True, and a genuine strength.** With zero journeys it still ran a useful demo and admitted what was missing rather than inventing it. |

## Industry readiness

**Not ready to hand to an enterprise client for their own product.** One blocker:
it cannot yet complete journeys in a standard enterprise UI toolkit, so the
catalogue comes back empty — and an empty catalogue reduces the product to an
improvising chat agent, which is not what is being sold.

**Ready as a controlled demo** on a product with native HTML controls (Swag Labs:
9/9 verified, narrated, deterministic replay, ~$0.10 to map).

The platform around the capability is in good shape: auth, spend caps, event log,
versioning, health checks, share links and graceful degradation all held up under a
real workload. The gap is narrow and specific — **widget interaction and proof
selection** — not architectural.

### Ordered next steps
1. **Custom-dropdown support** — detect a combobox by role/aria, click to open, click
   the option. Unblocks the majority of enterprise journeys.
2. **Accessible names for icon buttons** — use `aria-label`, `title`, nearest header
   cell, or row context; never a class attribute.
3. **Proof-quality scoring** — reject page furniture, empty-state text, and anything
   already visible at the point of action; prefer counts and new rows.
4. **Verification speed** — reuse one browser across journeys instead of a cold
   LiveBox per attempt (this alone should cut the 20s p50 substantially).
5. Re-run this evaluation on OrangeHRM as the regression test for 1–3.

---

# Round 2 — fixes applied and re-tested

Everything below was implemented after the first evaluation and re-run against the
same target.

## Fixed and verified working

| Fix | Evidence |
|---|---|
| **Custom comboboxes** (`openCustomCombobox`) | `selected "Pending Approval" in div "-- Select --"`, confirmed on the page. Clicks the trigger, waits for `[role="option"]`, matches exactly before falling back to partial — so "Pending" cannot beat "Pending Approval". Generalises to Ant/MUI/Radix/PrimeVue, which all emit the same ARIA. |
| **Icon-only button names** | Derived from the icon glyph, not the button's class: `bi-pencil-fill` → `"pencil"`, `bi-trash` → `"trash"`, `bi-chevron-left` → `"chevron left"`. Verified by running the shipped script against the live PIM table. |
| **Explorer proof guard** | It already rejected proofs "already visible", but compared against the **start URL** — the same flaw the verifier had, so it never saw the destination page. Now captures the baseline immediately before the first real interaction. The whole "already on screen" failure class disappeared from run 3. |
| **Empty-state proofs rejected** | `"No Records Found"` and similar are refused before a 20s replay is spent on them. |
| **Creation-preferring planner** | Nothing blocked `add`/`create`; the prohibition list simply dominated the prompt, so all 8 jobs were read-only — and a search on sparse demo data can never prove anything. The planner now proposes "Add a new employee record", "Create and submit a leave request", capped at two read-only jobs. |
| **Verification speed** | One signed-in browser shared across every verification in a run, released in a `finally`. **10m 32s → ~6m** for the same 8 jobs. |
| **Capacity limits** (`capacity.ts`) | Concurrent demos and mappings are capped and abandoned leases reclaimed. Verified: with a limit of 2, the third session got `503` and an honest message; releasing one freed a slot. |

### A false negative I introduced and caught
The first empty-state pattern was `/^(no|0)\s/`, which rejected **`"0 items left"`** on
the to-do app — a perfectly good proof that the last task was completed. A count
reaching zero is a *result*; "no results found" is the *absence* of one. Narrowed to
phrase matching and unit-tested against nine cases. Without the regression run this
would have silently cost a working journey.

## Regression status (all re-verified under the corrected gate)

| Product | Result |
|---|---|
| Swag Labs | **9/9** verified |
| Tasks (example) | **2/2** verified |
| Acme Swag Store | **3/3** verified |
| Conduit Blog | 0/1 — legitimately demoted: the journey only navigated, proving nothing |
| Eval suite | **25/25** |

## OrangeHRM after all fixes: still 0 verified — and now for defensible reasons

Run 3 failure reasons, which are diagnostic rather than false:

- *"No Leave Types with Leave Balance, so no leave request can be created"* — **correct refusal**; genuinely impossible on this instance.
- *"The Save action did not produce a visible confirmation, changed page, or new candidate row"* — **correct refusal**; OrangeHRM saves without a toast, so there is nothing to prove success with.
- *"Login requires entering a password, but password controls are blocked"* — **the safety interlock working as designed.**
- `postcondition NOT met: expected "Aarav Sharma"` — the closest miss: it created an employee, but the replay could not reproduce it.
- `no button named "Edit"` — a remaining selector gap.

**The honest conclusion:** this public demo instance is a hostile target — sparse
data, no leave balances, and saves with no success indicator. Several "failures" are
the system correctly refusing to certify something it could not prove. That is the
gate behaving exactly as promised, and it is a better outcome than the three false
passes it started with.

**What would move OrangeHRM off zero:** a demo instance with real data and normal
save confirmations, plus one more capability — recognising a saved record by the row
appearing in the list it returns to, rather than needing a confirmation message.

## Revised readiness

Unchanged in verdict, better in substance. The platform (auth, capacity, budgets,
events, versioning, health) is sound. The mapper is now **honest** — its central
claim survives adversarial testing on a complex app — and materially more capable
(comboboxes, icon buttons, creation journeys, 2× faster verification). It still
cannot produce a catalogue on a sparse enterprise demo instance, which remains the
gap between "works" and "sellable".
