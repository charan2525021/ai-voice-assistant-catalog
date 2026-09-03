/**
 * The live demo path must refuse destructive actions.
 *
 * These rules were enforced only while MAPPING; the live agent accepted
 * allowActions and never consulted it, so a demo against a customer's real
 * tenant could click Delete while the manifest said no actions were permitted.
 */
import { checkAction } from "./mapper/safety.js";

let pass = 0, fail = 0;
const check = (name: string, got: boolean, want: boolean) => {
  if (got === want) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.log(`  ✘ ${name} — expected allowed=${want}, got ${got}`); }
};

// Blocked with no allowlist (the default for a live tenant).
check("delete button blocked",      checkAction({ action: "click", name: "Delete customer" }, { allow: [] }).allowed, false);
check("remove blocked",             checkAction({ action: "click", name: "Remove record" }, { allow: [] }).allowed, false);
check("pay blocked",                checkAction({ action: "click", name: "Pay invoice" }, { allow: [] }).allowed, false);
check("send blocked",               checkAction({ action: "click", name: "Send email" }, { allow: [] }).allowed, false);
check("create blocked by default",  checkAction({ action: "click", name: "New Prompt" }, { allow: [] }).allowed, false);
check("save blocked by default",    checkAction({ action: "click", name: "Save Prompt" }, { allow: [] }).allowed, false);
check("run blocked by default",     checkAction({ action: "click", name: "Run evaluation" }, { allow: [] }).allowed, false);
check("log out never touched",      checkAction({ action: "click", name: "Log out" }, { allow: [] }).allowed, false);
check("billing never touched",      checkAction({ action: "click", name: "Billing settings" }, { allow: [] }).allowed, false);
// never-touch beats an explicit allow: nobody demos their way into billing.
check("allowlist cannot open billing", checkAction({ action: "click", name: "Billing" }, { allow: ["billing"] }).allowed, false);
// Ordinary navigation still works, or there is no demo.
check("normal click allowed",       checkAction({ action: "click", name: "Customers" }, { allow: [] }).allowed, true);
check("typing a name allowed",      checkAction({ action: "type", name: "Company name", value: "Acme" }, { allow: [] }).allowed, true);
// Opt-in still works for products that permit it.
check("allowlisted delete permitted", checkAction({ action: "click", name: "Delete draft" }, { allow: ["delete"] }).allowed, true);
check("sandbox creation permitted", checkAction({ action: "click", name: "New Prompt" }, { allow: ["create"] }).allowed, true);

/*
 * A bare navigate carries no accessible name.
 *
 * The keyword rules matched on name+value only, so `go_to_screen` — which
 * passes a url and nothing else — presented an EMPTY label and sailed through
 * every check. The survey, which passes the link text alongside, refused the
 * same destination. One product therefore blocked /dashboard/api-keys thirty
 * times during the survey and recorded, verified and shipped a journey that
 * navigated straight to it.
 */
const origin = { originAllowlist: ["https://app.example.com"], allow: [] };
check("never-touch area blocked by URL alone",
  checkAction({ action: "navigate", url: "https://app.example.com/dashboard/api-keys" }, origin).allowed, false);
check("nested never-touch path blocked",
  checkAction({ action: "navigate", url: "https://app.example.com/org/public-api-keys" }, origin).allowed, false);
check("security settings blocked by URL alone",
  checkAction({ action: "navigate", url: "https://app.example.com/settings/security" }, origin).allowed, false);
check("billing blocked by URL alone",
  checkAction({ action: "navigate", url: "https://app.example.com/account/billing" }, origin).allowed, false);
check("destructive route blocked by URL alone",
  checkAction({ action: "navigate", url: "https://app.example.com/cart/checkout" }, origin).allowed, false);
// ...without refusing to look at ordinary product screens.
check("ordinary route still allowed",
  checkAction({ action: "navigate", url: "https://app.example.com/dashboard/prompts" }, origin).allowed, true);
check("usage analytics still allowed",
  checkAction({ action: "navigate", url: "https://app.example.com/dashboard/usage" }, origin).allowed, true);
/*
 * Opening a create FORM is read-only navigation — the mutation happens when a
 * control on that form is pressed, and that control has its own label for the
 * MUTATING rules to catch. Folding the url into that check too would refuse
 * half the product.
 */
check("create-form route is navigable",
  checkAction({ action: "navigate", url: "https://app.example.com/projects/new" }, origin).allowed, true);
// A malformed url must not silently become an empty, unmatched label.
check("malformed URL blocked",
  checkAction({ action: "navigate", url: "not-a-url" }, origin).allowed, false);

/*
 * Record TITLES are user content, not action labels.
 *
 * On Jira every work item is a link named after its summary, and summaries are
 * written by people: "Start here: Add your team's work". Matching mutation
 * verbs against that refused to OPEN the ticket — 29 refusals in one run, all
 * of them plain GETs that would have changed nothing, leaving the agent unable
 * to read the product's primary record type.
 */
const jira = { originAllowlist: ["https://x.atlassian.net"], allow: [] as string[] };
check("opening a ticket titled 'Add ...' is allowed",
  checkAction({ action: "navigate", role: "link", name: "Start here: Add your team's work", url: "https://x.atlassian.net/browse/KAN-1" }, jira).allowed, true);
check("opening a ticket titled 'Create ...' is allowed",
  checkAction({ action: "navigate", role: "link", name: "Create Wallet Integration", url: "https://x.atlassian.net/browse/SAM1-7" }, jira).allowed, true);
check("opening a ticket titled 'Delete ...' is allowed",
  checkAction({ action: "navigate", role: "link", name: "Delete old records", url: "https://x.atlassian.net/browse/KAN-9" }, jira).allowed, true);
// ...but the BUTTON that performs it is still refused.
check("clicking a Create button still blocked",
  checkAction({ action: "click", role: "button", name: "Create Wallet Integration" }, jira).allowed, false);
check("clicking an Add button still blocked",
  checkAction({ action: "click", role: "button", name: "Add your team's work" }, jira).allowed, false);
// ...and a destructive DESTINATION is still refused, judged on the path.
check("navigating to a delete route still blocked",
  checkAction({ action: "navigate", role: "link", name: "Old records", url: "https://x.atlassian.net/issues/3/delete" }, jira).allowed, false);
// never-touch still applies to a navigation by name as well as by path.
check("never-touch by link name still blocked",
  checkAction({ action: "navigate", role: "link", name: "Billing", url: "https://x.atlassian.net/admin" }, jira).allowed, false);

/*
 * The term lists are policy and must be settable per environment.
 *
 * Resolved once at module load, so this re-imports with a cache-busting query
 * after setting the vars — which is also a faithful test of the real contract:
 * a run is governed by the values present when it started.
 */
process.env.SAFETY_MUTATING = "create,add ";
process.env.SAFETY_NEVER_TOUCH = "billing";
process.env.SAFETY_DESTRUCTIVE_EXTRA = "escalate";
// Held in a variable so TypeScript does not try to resolve the cache-busting
// query as a real module path; Node reloads it because the specifier differs.
const reloadSpecifier = "./mapper/safety.js?env=1";
const fresh = (await import(reloadSpecifier)) as typeof import("./mapper/safety.js");

check("SAFETY_MUTATING replaces the default list",
  fresh.checkAction({ action: "click", name: "Create board" }, { allow: [] }).allowed, false);
check("a default term dropped by the override is now allowed",
  fresh.checkAction({ action: "click", name: "Save draft" }, { allow: [] }).allowed, true);
check("SAFETY_NEVER_TOUCH replaces the default list",
  fresh.checkAction({ action: "click", name: "Billing settings" }, { allow: [] }).allowed, false);
check("a never-touch term dropped by the override is now allowed",
  fresh.checkAction({ action: "click", name: "Open security page" }, { allow: [] }).allowed, true);
check("SAFETY_DESTRUCTIVE_EXTRA appends to the defaults",
  fresh.checkAction({ action: "click", name: "Escalate ticket" }, { allow: [] }).allowed, false);
check("appended list keeps the built-in destructive terms",
  fresh.checkAction({ action: "click", name: "Delete customer" }, { allow: [] }).allowed, false);
check("allowlist opt-in still works against a configured list",
  fresh.checkAction({ action: "click", name: "Create board" }, { allow: ["create"] }).allowed, true);

const policy = fresh.safetyPolicy();
check("policy reports itself customised", policy.customised, true);
check("policy reports the configured mutating list", policy.mutating.join(",") === "create,add ", true);

console.log(`\n${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
