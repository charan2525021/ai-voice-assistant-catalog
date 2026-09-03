/**
 * NirogGyan brochure (client-poc) — signed Web SDK catalog and Sable Cloud
 * Runtime bundle generator for https://www.brochure.niroggyan.com/.
 *
 * Evidence basis:
 * - live desktop exploration at 1440x900 on 2026-08-20;
 * - deployed application build static/js/main.847efae8.js and its source map;
 * - the current SDK resolver/action-driver and runtime contracts.
 *
 * Run from sable-cloud-runtime:
 *   node --import tsx client-catalogs/niroggyan-brochure/generate.ts
 */
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertValidSdkCatalog,
  assertValidSignedCatalogEnvelope,
  canonicalizeJson,
  SDK_CATALOG_SCHEMA_VERSION,
  SDK_PROTOCOL_VERSION,
  SDK_WORKFLOW_SCHEMA_VERSION,
  type CatalogControl,
  type CatalogSalesPlay,
  type CatalogScreen,
  type DemoProfile,
  type JourneyDefinition,
  type LocatorCandidate,
  type PrivacyPolicy,
  type SdkCatalog,
  type SignedCatalogEnvelope,
  type StepCompatibility,
  type StepCompatibilityClass,
  type TelemetryPolicy,
  type WorkflowAssertion,
  type WorkflowStep,
} from "@sable/sdk-contracts";
import type { KnowledgeHit, RuntimeBundle, RuntimeJourney, RuntimeScreenState } from "@sable/runtime-core";
import { hashCredential } from "../../src/security.js";
import { createFileStores } from "../../src/stores/file.js";
import {
  NIROGGYAN_CLIENT_ROUTER_TOOL_DEFINITION,
  NIROGGYAN_CLIENT_ROUTER_TOOL_NAME,
  type NirogGyanBrochureRoute,
} from "./client-router-tool.js";

// --------------------------------------------------------------------------
const GUIDED_DEMO_TEST = process.env.NIROGGYAN_GUIDED_DEMO_TEST === "1";
const CLIENT = {
  slug: GUIDED_DEMO_TEST ? "niroggyan-brochure-guided-demo" : "niroggyan-brochure",
  organizationId: "niroggyan-tenant",
  productId: "niroggyan-brochure-product",
  environmentId: GUIDED_DEMO_TEST ? "client-poc-guided-demo" : "client-poc",
  roleProfileId: "public",
  catalogId: "niroggyan-brochure-product",
  catalogVersionId: GUIDED_DEMO_TEST ? "niroggyan-brochure-v2-test" : "niroggyan-brochure-v1",
  catalogVersion: GUIDED_DEMO_TEST ? 2 : 1,
  installationId: GUIDED_DEMO_TEST ? "niroggyan-brochure-guided-demo-test-installation" : "niroggyan-brochure-poc-installation",
  origin: "https://www.brochure.niroggyan.com",
  homeUrl: "https://www.brochure.niroggyan.com/",
  issuedAt: GUIDED_DEMO_TEST ? "2026-08-25T00:00:00.000Z" : "2026-08-20T00:00:00.000Z",
  verifiedAt: GUIDED_DEMO_TEST ? "2026-08-25T00:00:00.000Z" : "2026-08-20T00:00:00.000Z",
  applicationBuild: "brochure-main-847efae8",
} as const;
const ROLES = [CLIENT.roleProfileId];

/**
 * demoSafe is deliberately narrower than "approved". An approved journey can
 * still leave a transient overlay open or represent a partial action. Guided
 * playback uses only journeys that finish in a stable state and never leave
 * the brochure origin.
 */
const GUIDED_DEMO_SAFE_JOURNEY_IDS = new Set([
  "show-brochure-overview",
  "open-viz-app-from-user-journey",
  "open-engagement-from-user-journey",
  "run-sample-roi-calculation",
  "reveal-testimonial-statistics",
  "show-smart-reporting-overview",
  "preview-whatsapp-chatbot-safely",
  "preview-demo-scheduling-safely",
]);

// --------------------------------------------------------------------------
// Builders keep compatibility entries identical to their owning steps.
// --------------------------------------------------------------------------
function compat(stepId: string, classification: StepCompatibilityClass, reason: string, verified = false): StepCompatibility {
  return {
    kind: "sable.step_compatibility",
    stepId,
    classification,
    reason,
    ...(verified ? {
      verifiedAt: CLIENT.verifiedAt,
      verifiedSdkVersion: "0.1.0",
      verifiedApplicationBuild: CLIENT.applicationBuild,
    } : {}),
  };
}

function collectCompatibility(steps: WorkflowStep[]): StepCompatibility[] {
  const entries: StepCompatibility[] = [];
  const walk = (items: WorkflowStep[]) => {
    for (const step of items) {
      entries.push(step.compatibility);
      if (step.kind === "approval") walk(step.then);
      else if (step.kind === "branch") { walk(step.then); walk(step.otherwise ?? []); }
      else if (step.kind === "loop") walk(step.steps);
    }
  };
  walk(steps);
  return entries;
}

interface JourneyInit {
  id: string;
  name: string;
  description: string;
  intents: string[];
  risk: JourneyDefinition["risk"];
  state: JourneyDefinition["state"];
  reliability: number;
  startUrl?: string;
  inputs?: JourneyDefinition["inputSchema"]["properties"];
  required?: string[];
  preconditions?: WorkflowAssertion[];
  steps: WorkflowStep[];
  postconditions?: WorkflowAssertion[];
  manualHandoff?: JourneyDefinition["manualHandoff"];
  sourceCitations?: JourneyDefinition["sourceCitations"];
}

function journey(init: JourneyInit): JourneyDefinition {
  return {
    kind: "sable.catalog.journey",
    id: init.id,
    version: 1,
    name: init.name,
    description: init.description,
    intents: init.intents,
    roles: ROLES,
    risk: init.risk,
    inputSchema: {
      kind: "sable.journey_input_schema",
      properties: init.inputs ?? {},
      required: init.required ?? [],
      additionalProperties: false,
    },
    workflow: {
      kind: "sable.workflow",
      schemaVersion: SDK_WORKFLOW_SCHEMA_VERSION,
      id: init.id,
      version: 1,
      name: init.name,
      ...(init.startUrl ? { startUrl: { kind: "literal" as const, value: init.startUrl } } : {}),
      risk: init.risk,
      preconditions: init.preconditions ?? [],
      steps: init.steps,
      postconditions: init.postconditions ?? [],
    },
    compatibility: collectCompatibility(init.steps),
    state: init.state,
    ...(GUIDED_DEMO_TEST && GUIDED_DEMO_SAFE_JOURNEY_IDS.has(init.id) ? { demoSafe: true } : {}),
    reliability: init.reliability,
    ...(init.manualHandoff ? { manualHandoff: init.manualHandoff } : {}),
    ...(init.sourceCitations ? { sourceCitations: init.sourceCitations } : {}),
  };
}

const exploration = (sourceId: string, title: string): NonNullable<JourneyDefinition["sourceCitations"]> => [
  { kind: "exploration", sourceId, title },
];
const citeLive = exploration("exploration-2026-08-20-brochure", "NirogGyan brochure live DOM and deployed source build 847efae8");

const aria = (role: string, name: string, rank = 1, confidence = 0.98): LocatorCandidate => ({
  kind: "aria_role_name",
  role,
  name,
  rank,
  exact: true,
  confidence,
});

function control(
  screenId: string,
  id: string,
  name: string,
  risk: CatalogControl["risk"],
  locators: LocatorCandidate[],
  extra: Partial<Pick<CatalogControl, "frame" | "privacyTags">> = {},
): CatalogControl {
  return { kind: "sable.catalog.control", id, screenId, name, risk, locators, ...extra };
}

function screen(id: string, name: string, routePattern: string, textAnchors: string[], purposeTag?: string): CatalogScreen {
  return {
    kind: "sable.catalog.screen",
    id,
    name,
    roles: ROLES,
    ...(purposeTag ? { privacyTags: [purposeTag] } : {}),
    variants: [{
      id: `${id}-desktop`,
      viewport: { minimumWidth: 900 },
      minimumConfidence: 0.55,
      anchors: [
        { kind: "route", pattern: routePattern, weight: 4 },
        ...textAnchors.map((text) => ({ kind: "text" as const, text, weight: 2 })),
      ],
    }, {
      id: `${id}-mobile`,
      viewport: { maximumWidth: 899 },
      minimumConfidence: 0.55,
      anchors: [
        { kind: "route", pattern: routePattern, weight: 4 },
        ...textAnchors.map((text) => ({ kind: "text" as const, text, weight: 2 })),
      ],
    }],
  };
}

// --------------------------------------------------------------------------
// All 12 routes declared by App.js in deployed build 847efae8.
// --------------------------------------------------------------------------
const screens: CatalogScreen[] = [
  screen("home", "Brochure introduction", "regex:^/$", ["The Challenges", "Why Leading Labs & Hospitals Choose Us"]),
  screen("user-journey", "Smart Health Journey", "regex:^/user-journey/?$", ["Smart Health Journey", "The NirogGyan Advantage"]),
  screen("smart-reporting", "Smart Reporting overview", "regex:^/smartReporting/?$", ["Transform Complex Reports into Clear, Actionable Health Insights", "Next-Generation Smart Reporting"]),
  screen("smart-report", "Smart Health Report", "regex:^/smartReport/?$", ["Smart Health Report", "What Makes Our Reports Different"]),
  screen("viz-app", "Viz App", "regex:^/(?:vizApp|vizapp)/?$", ["Lab Report Analysis", "AI Risk Analysis"]),
  screen("legacy-smart-reports", "Legacy Smart Reports page", "regex:^/smartReports/?$", ["Smart Report Editions", "View Demo Report"]),
  screen("legacy-vizapp-page", "Legacy Viz App page", "regex:^/vizappPage/?$", ["Viz App Features", "Complete Report"]),
  screen("legacy-analytics", "Legacy Analytics page", "regex:^/analytics/?$", ["Smart Reports", "Personal Report"]),
  screen("legacy-health-tools", "Legacy Health Tools page", "regex:^/healthTools/?$", ["Health Tools Features", "Corporate Dashboard"]),
  screen("engagement", "Patient engagement", "regex:^/engagement/?$", ["AI-Powered Engagement Tools That Patients Actually Use", "The Pillars of Modern Patient Engagement"]),
  screen("testimonials", "Customer evidence", "regex:^/testimonials/?$", ["Real Stories, Real Impact", "We believe in numbers"]),
  screen("roi-calculator", "Patient retention ROI calculator", "regex:^/roi-calculator/?$", ["Calculate Your True Patient Retention ROI", "Your Growth With Smart Reports"]),
];

// --------------------------------------------------------------------------
// Controls. Empty locator lists are deliberate blocked controls: the deployed
// element has no stable marker and the production validator permits it only
// for a non-SDK_DIRECT/manual handoff.
// --------------------------------------------------------------------------
const controls: CatalogControl[] = [
  control("home", "home-talk-to-shweta", "Open the demo scheduling dialog", "read", [aria("button", "Talk to Shweta")]),
  control("home", "home-booking-close", "Close the demo scheduling dialog", "read", [aria("button", "close")]),
  control("home", "home-nav-smart-reporting", "Desktop Smart Reporting navigation item", "read", []),
  control("home", "home-panel-smart-reports", "Home Smart Reports expanding panel", "read", []),

  control("user-journey", "uj-view-smart-report-repeated", "Repeated View Smart Report buttons", "read", [aria("button", "View Smart Report", 1, 0.25)]),
  control("user-journey", "uj-view-viz-app", "View Viz App", "read", [aria("button", "View Viz App")]),
  control("user-journey", "uj-view-chat-bot", "View Chat Bot", "read", [aria("button", "View Chat Bot")]),
  control("user-journey", "uj-view-analytics", "View Analytics", "read", [aria("button", "View Analytics")]),
  control("user-journey", "uj-contact-now", "Open Contact Now booking dialog", "read", [aria("button", "Contact Now")]),

  control("smart-reporting", "sr-learn-more", "Learn More", "read", [aria("button", "Learn More")]),
  control("smart-reporting", "sr-preview-repeated", "Repeated Smart Reporting Preview buttons", "read", [aria("button", "Preview", 1, 0.25)]),
  control("smart-report", "smart-report-preview-repeated", "Repeated report Preview buttons", "read", [aria("button", "Preview", 1, 0.2)]),

  control("viz-app", "viz-try-now", "Open the external Viz App demo", "external_side_effect", [aria("button", "Try Now")]),
  control("engagement", "eng-discover-ai-tools", "Open the external consumer analyzer", "external_side_effect", [aria("button", "Discover AI Tools")]),
  control("engagement", "eng-preview-whatsapp", "Open the WhatsApp chatbot preview", "read", [aria("button", "Preview")]),
  control("engagement", "eng-preview-close", "Close the WhatsApp chatbot preview", "read", [aria("button", "✕")]),
  control("engagement", "eng-corporate-try-now", "Open the external corporate dashboard", "external_side_effect", [aria("button", "Try Now")]),

  control("testimonials", "testimonials-statistics-heading", "Animated statistics section", "read", [aria("heading", "We believe in numbers")]),

  control("roi-calculator", "roi-monthly-volume", "Monthly Patient Volume", "reversible_write", [aria("slider", "Monthly Patient Volume")], { privacyTags: ["business_input"] }),
  control("roi-calculator", "roi-average-revenue", "Average Revenue Per Patient", "reversible_write", [aria("slider", "Average Revenue Per Patient")], { privacyTags: ["business_input"] }),
  control("roi-calculator", "roi-retention-rate", "Current Patient Retention Rate", "reversible_write", [aria("slider", "Current Patient Retention Rate")], { privacyTags: ["business_input"] }),
  control("roi-calculator", "roi-book-demo", "Book a Demo", "read", [aria("button", "Book a Demo")]),
  control("roi-calculator", "roi-booking-close", "Close ROI booking dialog", "read", [aria("button", "close")]),

  // The frame is deliberately blocked. Opening the outer dialog is direct;
  // choosing and submitting a calendar slot is cross-origin and side-effecting.
  control("home", "hubspot-scheduling-frame", "HubSpot scheduling iframe", "external_side_effect", [], {
    frame: { kind: "bridge_required", name: "Schedule a meeting" },
    privacyTags: ["third_party", "scheduling"],
  }),
];

const precondition = (screenId: string): WorkflowAssertion[] => [{ kind: "screen_matches", screenId, minimumConfidence: 0.55 }];
const directAssert = (id: string, assertion: WorkflowAssertion, narration: string, reason: string): WorkflowStep => ({
  id,
  kind: "assert",
  assertion,
  narration,
  compatibility: compat(id, "SDK_DIRECT", reason, true),
});

const guidedRouteSteps = (id: string, route: NirogGyanBrochureRoute, screenId: string): WorkflowStep[] => GUIDED_DEMO_TEST ? [
  {
    id: `${id}-route`,
    kind: "action",
    action: "tool_call",
    toolName: NIROGGYAN_CLIENT_ROUTER_TOOL_NAME,
    input: { kind: "literal", value: { route } },
    compatibility: compat(`${id}-route`, "NEEDS_REGISTERED_TOOL", "The signed catalog permits only a reviewed same-origin brochure SPA route, implemented by the client host.", true),
  },
  {
    id: `${id}-ready`,
    kind: "action",
    action: "wait",
    until: { kind: "screen_matches", screenId, minimumConfidence: 0.55 },
    milliseconds: 8_000,
    compatibility: compat(`${id}-ready`, "SDK_DIRECT", "The SDK waits for the destination screen anchors before any page-specific action runs.", true),
  },
] : [];

const guidedControlReadyStep = (id: string, screenId: string, controlId: string): WorkflowStep => ({
  id,
  kind: "action",
  action: "wait",
  until: { kind: "control_visible", target: { screenId, controlId } },
  milliseconds: 8_000,
  compatibility: compat(id, "SDK_DIRECT", "The SDK waits for the signed control to finish rendering before resolving and clicking it.", true),
});

const guidedTextReadyStep = (id: string, text: string): WorkflowStep => ({
  id,
  kind: "action",
  action: "wait",
  until: { kind: "text_visible", text },
  milliseconds: 8_000,
  compatibility: compat(id, "SDK_DIRECT", "The SDK waits for the signed page text to finish rendering before evaluating the module assertions.", true),
});

// --------------------------------------------------------------------------
// Journeys: approved means every action is directly executable by this SDK.
// --------------------------------------------------------------------------
const journeys: JourneyDefinition[] = [
  journey({
    id: "show-brochure-overview",
    name: "Explain the brochure overview",
    description: "A grounded, read-only introduction to the public brochure.",
    intents: ["what is this brochure", "give me an overview", "what does NirogGyan offer", "show me the main value"],
    risk: "read",
    state: "approved",
    reliability: 0.98,
    startUrl: GUIDED_DEMO_TEST ? undefined : CLIENT.homeUrl,
    preconditions: GUIDED_DEMO_TEST ? [] : precondition("home"),
    sourceCitations: citeLive,
    steps: [
      ...guidedRouteSteps("overview", "/", "home"),
      ...(GUIDED_DEMO_TEST ? [guidedTextReadyStep("overview-content-ready", "The Challenges")] : []),
      directAssert("overview-content", { kind: "text_visible", text: "The Challenges" }, "This brochure presents the reporting-understanding problem NirogGyan addresses before it explains the product's smart reporting, engagement, analytics, and lab-growth proposition.", "Live DOM verification confirmed this stable visible home-section marker; the animated hero headline remains opacity-zero after an injected SPA transition."),
      directAssert("overview-benefits", { kind: "text_visible", text: "Why Leading Labs & Hospitals Choose Us" }, "The page attributes retention, follow-up automation, revenue insight, and onboarding benefits to its platform.", "Live DOM verification confirmed the benefits section."),
    ],
    postconditions: [{ kind: "text_visible", text: "Seamless Onboarding" }],
  }),
  journey({
    id: "open-demo-scheduling-dialog",
    name: "Open the demo scheduling dialog",
    description: "Open the in-page HubSpot scheduling dialog without selecting or submitting a time.",
    intents: ["open the demo booking", "talk to Shweta", "show me the calendar", "schedule a demo"],
    risk: "read",
    state: "approved",
    reliability: 0.98,
    startUrl: CLIENT.homeUrl,
    preconditions: precondition("home"),
    sourceCitations: citeLive,
    steps: [
      { id: "booking-open", kind: "action", action: "click", target: { controlId: "home-talk-to-shweta", screenId: "home" }, narration: "I'll open the scheduling dialog; choosing a time remains with you.", compatibility: compat("booking-open", "SDK_DIRECT", "The unique Talk to Shweta button was live-tested and opens an in-page dialog without leaving the origin.", true) },
      { id: "booking-wait", kind: "action", action: "wait", until: { kind: "text_visible", text: "Schedule a Demo" }, timeoutMs: 5_000, compatibility: compat("booking-wait", "SDK_DIRECT", "The dialog title is a stable, observable completion signal.", true) },
    ],
    postconditions: [{ kind: "text_visible", text: "Book a time that works for you" }],
  }),
  journey({
    id: "close-demo-scheduling-dialog",
    name: "Close the demo scheduling dialog",
    description: "Close the local scheduling dialog without interacting with the cross-origin calendar.",
    intents: ["close the calendar", "close the demo dialog", "dismiss scheduling"],
    risk: "read",
    state: "approved",
    reliability: 0.98,
    preconditions: [...precondition("home"), { kind: "text_visible", text: "Schedule a Demo" }],
    sourceCitations: citeLive,
    steps: [
      { id: "booking-close", kind: "action", action: "click", target: { controlId: "home-booking-close", screenId: "home" }, compatibility: compat("booking-close", "SDK_DIRECT", "The dialog exposes one enabled button with aria-label close; live verification closed it.", true) },
      { id: "booking-close-wait", kind: "action", action: "wait", until: { kind: "text_absent", text: "Book a time that works for you" }, timeoutMs: 5_000, compatibility: compat("booking-close-wait", "SDK_DIRECT", "The dialog subtitle disappearing proves the dialog closed.", true) },
    ],
    postconditions: [{ kind: "text_absent", text: "Schedule a Demo" }],
  }),
  journey({
    id: "open-viz-app-from-user-journey",
    name: "Open Viz App from the user journey",
    description: "Use the unique SPA button to reach the first-party Viz App brochure page.",
    intents: ["show the viz app", "open the digital report", "view viz app"],
    risk: "read",
    state: "approved",
    reliability: 0.97,
    startUrl: GUIDED_DEMO_TEST ? undefined : `${CLIENT.origin}/user-journey`,
    preconditions: GUIDED_DEMO_TEST ? [] : precondition("user-journey"),
    sourceCitations: citeLive,
    steps: GUIDED_DEMO_TEST ? [
      ...guidedRouteSteps("uj-viz", "/vizapp", "viz-app"),
      directAssert("uj-viz-destination", { kind: "text_visible", text: "Lab Report Analysis" }, "The first-party Viz App brochure page is now open.", "The guided test uses the reviewed client router because the deployed user-journey button unloads a DevTools-injected SDK; this visible report marker remains stable when the animated hero text is opacity-zero."),
    ] : [
      { id: "uj-open-viz", kind: "action", action: "click", target: { controlId: "uj-view-viz-app", screenId: "user-journey" }, narration: "I'll open the Viz App brochure page.", compatibility: compat("uj-open-viz", "SDK_DIRECT", "The unique button reaches the first-party Viz App brochure page.", true) },
    ],
    postconditions: [{ kind: "url_matches", pattern: "^https://www\\.brochure\\.niroggyan\\.com/vizapp/?$" }],
  }),
  journey({
    id: "open-engagement-from-user-journey",
    name: "Open patient engagement from the user journey",
    description: "Use the unique View Chat Bot SPA button to reach engagement tooling.",
    intents: ["show the chatbot", "open engagement tools", "view patient engagement"],
    risk: "read",
    state: "approved",
    reliability: 0.97,
    startUrl: GUIDED_DEMO_TEST ? undefined : `${CLIENT.origin}/user-journey`,
    preconditions: GUIDED_DEMO_TEST ? [] : precondition("user-journey"),
    sourceCitations: citeLive,
    steps: GUIDED_DEMO_TEST ? [
      ...guidedRouteSteps("uj-engagement", "/engagement", "engagement"),
      directAssert("uj-engagement-destination", { kind: "text_visible", text: "The Pillars of Modern Patient Engagement" }, "The patient-engagement brochure page is now open.", "The guided test uses the reviewed client router because the deployed user-journey button unloads a DevTools-injected SDK."),
    ] : [
      { id: "uj-open-engagement", kind: "action", action: "click", target: { controlId: "uj-view-chat-bot", screenId: "user-journey" }, narration: "I'll open the patient-engagement page.", compatibility: compat("uj-open-engagement", "SDK_DIRECT", "The unique button reaches the first-party engagement page.", true) },
    ],
    postconditions: [{ kind: "url_matches", pattern: "^https://www\\.brochure\\.niroggyan\\.com/engagement/?$" }],
  }),
  journey({
    id: "open-whatsapp-chatbot-preview",
    name: "Open the WhatsApp chatbot preview",
    description: "Open the local image preview for the follow-up chatbot.",
    intents: ["preview the whatsapp chatbot", "show follow-up engines", "show the chatbot preview"],
    risk: "read",
    state: "approved",
    reliability: 0.98,
    startUrl: `${CLIENT.origin}/engagement`,
    preconditions: precondition("engagement"),
    sourceCitations: citeLive,
    steps: [{ id: "eng-preview-open", kind: "action", action: "click", target: { controlId: "eng-preview-whatsapp", screenId: "engagement" }, narration: "I'll open the WhatsApp chatbot preview.", compatibility: compat("eng-preview-open", "SDK_DIRECT", "The page has one enabled Preview button; live verification opened the Follow-up Engines Preview overlay.", true) }],
    postconditions: [{ kind: "text_visible", text: "Follow-up Engines Preview" }],
  }),
  journey({
    id: "close-whatsapp-chatbot-preview",
    name: "Close the WhatsApp chatbot preview",
    description: "Close the local chatbot preview overlay.",
    intents: ["close the chatbot preview", "dismiss follow-up preview"],
    risk: "read",
    state: "approved",
    reliability: 0.98,
    preconditions: [...precondition("engagement"), { kind: "text_visible", text: "Follow-up Engines Preview" }],
    sourceCitations: citeLive,
    steps: [{ id: "eng-preview-close", kind: "action", action: "click", target: { controlId: "eng-preview-close", screenId: "engagement" }, compatibility: compat("eng-preview-close", "SDK_DIRECT", "The open overlay exposes one button named ✕ and source/live verification confirm it closes the overlay.", true) }],
    postconditions: [{ kind: "text_absent", text: "Follow-up Engines Preview" }],
  }),
  journey({
    id: "run-sample-roi-calculation",
    name: "Run a sample patient-retention ROI calculation",
    description: "Set non-personal sample lab metrics and verify the live recomputed range.",
    intents: ["demo the roi calculator", "run a sample roi", "show how retention affects revenue", "calculate a sample"],
    risk: "reversible_write",
    state: "approved",
    reliability: 0.96,
    startUrl: GUIDED_DEMO_TEST ? undefined : `${CLIENT.origin}/roi-calculator`,
    preconditions: GUIDED_DEMO_TEST ? [] : precondition("roi-calculator"),
    sourceCitations: citeLive,
    steps: [
      ...guidedRouteSteps("roi", "/roi-calculator", "roi-calculator"),
      guidedControlReadyStep("roi-controls-ready", "roi-calculator", "roi-monthly-volume"),
      { id: "roi-volume", kind: "action", action: "fill", target: { controlId: "roi-monthly-volume", screenId: "roi-calculator" }, value: { kind: "literal", value: "12000" }, narration: "I'll use a sample monthly volume of 12,000.", compatibility: compat("roi-volume", "SDK_DIRECT", "The range input has the unique aria-label Monthly Patient Volume; the SDK's native input/change path is compatible with the MUI controlled slider.", true) },
      { id: "roi-aov", kind: "action", action: "fill", target: { controlId: "roi-average-revenue", screenId: "roi-calculator" }, value: { kind: "literal", value: "2000" }, narration: "I'll use a sample average revenue of ₹2,000.", compatibility: compat("roi-aov", "SDK_DIRECT", "The range input has the unique aria-label Average Revenue Per Patient and was verified against the live control.", true) },
      { id: "roi-retention", kind: "action", action: "fill", target: { controlId: "roi-retention-rate", screenId: "roi-calculator" }, value: { kind: "literal", value: "30" }, narration: "I'll use a sample current retention rate of 30%.", compatibility: compat("roi-retention", "SDK_DIRECT", "The range input has the unique aria-label Current Patient Retention Rate and was verified against the live control.", true) },
      directAssert("roi-result", { kind: "text_visible", text: "2,160 – 8,640 patients/year" }, "For those sample inputs, the site's calculator estimates 2,160–8,640 extra returning patients per year. This is a marketing scenario, not a guarantee.", "A native live interaction produced this exact recomputed output."),
    ],
    postconditions: [{ kind: "text_visible", text: "₹43,20,000 – ₹1,72,80,000" }],
  }),
  journey({
    id: "reveal-testimonial-statistics",
    name: "Reveal the testimonial statistics",
    description: "Scroll the public testimonials page until its count-up figures are populated.",
    intents: ["show the brochure statistics", "why do the numbers say zero", "reveal the customer numbers"],
    risk: "read",
    state: "approved",
    reliability: 0.97,
    startUrl: GUIDED_DEMO_TEST ? undefined : `${CLIENT.origin}/testimonials`,
    preconditions: GUIDED_DEMO_TEST ? [] : precondition("testimonials"),
    sourceCitations: citeLive,
    steps: [
      ...guidedRouteSteps("stats", "/testimonials", "testimonials"),
      guidedControlReadyStep("stats-control-ready", "testimonials", "testimonials-statistics-heading"),
      { id: "stats-scroll", kind: "action", action: "scroll", direction: "down", target: { controlId: "testimonials-statistics-heading", screenId: "testimonials" }, narration: "I'll scroll the statistics into view so their count-up animation runs.", compatibility: compat("stats-scroll", "SDK_DIRECT", "The exact level-two heading 'We believe in numbers' is a durable semantic anchor immediately above the animated counters. Targeted scrolling avoids viewport-dependent pixel offsets and places the counter cards inside their in-view threshold.", true) },
      { id: "stats-wait", kind: "action", action: "wait", until: { kind: "text_visible", text: "25+" }, milliseconds: 8_000, compatibility: compat("stats-wait", "SDK_DIRECT", "The deployed counter animates after entering view; the final text is observable and is given sufficient time to settle.", true) },
      directAssert("stats-accuracy", { kind: "text_visible", text: "99.9%" }, "The site presents a 99.9% accuracy claim alongside its other animated statistics.", "Live scroll verification produced the final value rather than the initial zero."),
    ],
    postconditions: [{ kind: "text_visible", text: "1M+" }],
  }),
  journey({
    id: "show-smart-reporting-overview",
    name: "Explain Smart Reporting",
    description: "Ground a Smart Reporting explanation in the current page.",
    intents: ["what is smart reporting", "compare smart report and viz app", "explain reporting options"],
    risk: "read",
    state: "approved",
    reliability: 0.96,
    startUrl: GUIDED_DEMO_TEST ? undefined : `${CLIENT.origin}/smartReporting`,
    preconditions: GUIDED_DEMO_TEST ? [] : precondition("smart-reporting"),
    sourceCitations: citeLive,
    steps: [
      ...guidedRouteSteps("smart-reporting", "/smartReporting", "smart-reporting"),
      directAssert("sr-overview", { kind: "text_visible", text: "Next-Generation Smart Reporting" }, "The brochure presents two formats: a professional Smart Report PDF and an interactive Viz App.", "The comparison section was verified in the live DOM."),
    ],
    postconditions: [{ kind: "text_visible", text: "Advanced Capabilities" }],
  }),

  // Verified but deliberately non-approved limitations and external handoffs.
  journey({
    id: "open-smart-report-from-repeated-button",
    name: "Open Smart Report from the repeated user-journey buttons",
    description: "Both buttons work for a person, but the resolver correctly refuses their tied accessible names.",
    intents: ["open smart report from user journey", "view the smart report"],
    risk: "read",
    state: "verified",
    reliability: 0.4,
    startUrl: `${CLIENT.origin}/user-journey`,
    preconditions: precondition("user-journey"),
    sourceCitations: citeLive,
    steps: [{ id: "uj-open-smart-report", kind: "action", action: "click", target: { controlId: "uj-view-smart-report-repeated", screenId: "user-journey" }, compatibility: compat("uj-open-smart-report", "NEEDS_STABLE_MARKER", "Two enabled buttons have the same role and accessible name, no IDs/test IDs, and only generated ancestors. The resolver returns CONTROL_AMBIGUOUS.", true) }],
    postconditions: [{ kind: "url_matches", pattern: "^https://www\\.brochure\\.niroggyan\\.com/smartReport/?$" }],
    manualHandoff: { reason: "The two View Smart Report controls tie at the top resolver score.", instructions: ["Ask the user to click either View Smart Report button.", "For SDK automation, give each button a distinct aria-label or data-sable-id."] },
  }),
  journey({
    id: "open-external-viz-demo",
    name: "Open the external Viz App demo",
    description: "The brochure opens a separate-origin application in a new tab.",
    intents: ["try the viz app", "open the viz app demo"],
    risk: "external_side_effect",
    state: "verified",
    reliability: 0.9,
    startUrl: `${CLIENT.origin}/vizApp`,
    preconditions: precondition("viz-app"),
    sourceCitations: citeLive,
    steps: [{ id: "viz-external", kind: "action", action: "click", target: { controlId: "viz-try-now", screenId: "viz-app" }, compatibility: compat("viz-external", "NEEDS_USER_GESTURE", "The handler calls window.open for https://www.demo-vizapp.niroggyan.com/overview. It leaves the authorized origin and opens a new tab.", true) }],
    postconditions: [],
    manualHandoff: { reason: "Opening the separate demo application requires a genuine user gesture and leaves the brochure origin.", instructions: ["Ask the user to click Try Now.", "Treat the opened application as a separate product surface and catalog scope."] },
  }),
  journey({
    id: "open-external-corporate-dashboard",
    name: "Open the external corporate dashboard",
    description: "The engagement page opens a separate dashboard login in a new tab.",
    intents: ["try the corporate dashboard", "open the analytics dashboard"],
    risk: "external_side_effect",
    state: "verified",
    reliability: 0.9,
    startUrl: `${CLIENT.origin}/engagement`,
    preconditions: precondition("engagement"),
    sourceCitations: citeLive,
    steps: [{ id: "eng-external-dashboard", kind: "action", action: "click", target: { controlId: "eng-corporate-try-now", screenId: "engagement" }, compatibility: compat("eng-external-dashboard", "NEEDS_USER_GESTURE", "The handler opens https://demo-corporate-dashboard.niroggyan.com/login in a new tab; authentication and the external origin are outside this catalog.", true) }],
    postconditions: [],
    manualHandoff: { reason: "The corporate dashboard is a separate authenticated application.", instructions: ["Ask the user to click Try Now.", "Do not enter credentials or claim dashboard coverage from this brochure catalog."] },
  }),
  journey({
    id: "open-external-consumer-analyzer",
    name: "Open the external consumer analyzer",
    description: "The engagement CTA opens niro.health in a separate tab.",
    intents: ["discover the ai tools", "open the consumer analyzer"],
    risk: "external_side_effect",
    state: "verified",
    reliability: 0.9,
    startUrl: `${CLIENT.origin}/engagement`,
    preconditions: precondition("engagement"),
    sourceCitations: citeLive,
    steps: [{ id: "eng-external-analyzer", kind: "action", action: "click", target: { controlId: "eng-discover-ai-tools", screenId: "engagement" }, compatibility: compat("eng-external-analyzer", "NEEDS_USER_GESTURE", "The handler calls window.open for https://www.niro.health/. That is another origin and another product catalog.", true) }],
    postconditions: [],
    manualHandoff: { reason: "The consumer analyzer is outside the brochure origin.", instructions: ["Ask the user to click Discover AI Tools.", "Use the separate niro catalog for that site rather than extending this brochure catalog."] },
  }),
];

if (GUIDED_DEMO_TEST) {
  // Guided-demo modules should finish in a stable UI state. These composite
  // journeys keep the preview visible while its signed narration is spoken,
  // then close it before the cloud advances to another module.
  journeys.push(
    journey({
      id: "preview-whatsapp-chatbot-safely",
      name: "Preview the WhatsApp chatbot and return to engagement",
      description: "Open the local WhatsApp preview, explain it, and close it before advancing the guided demo.",
      intents: ["show the whatsapp preview", "demonstrate the follow-up chatbot", "preview engagement automation"],
      risk: "read",
      state: "approved",
      reliability: 0.98,
      preconditions: [],
      sourceCitations: citeLive,
      steps: [
        ...guidedRouteSteps("demo-chatbot", "/engagement", "engagement"),
        { id: "demo-chatbot-scroll", kind: "action", action: "scroll", direction: "down", target: { controlId: "eng-preview-whatsapp", screenId: "engagement" }, compatibility: compat("demo-chatbot-scroll", "SDK_DIRECT", "The SDK resolves the unique signed WhatsApp Preview control without requiring it to be visible, then scrolls that exact control into view so its intersection animation can complete.", true) },
        guidedControlReadyStep("demo-chatbot-control-ready", "engagement", "eng-preview-whatsapp"),
        { id: "demo-chatbot-open", kind: "action", action: "click", target: { controlId: "eng-preview-whatsapp", screenId: "engagement" }, compatibility: compat("demo-chatbot-open", "SDK_DIRECT", "The live engagement page exposes one enabled Preview button and it opens the local overlay.", true) },
        guidedTextReadyStep("demo-chatbot-overlay-ready", "Follow-up Engines Preview"),
        directAssert("demo-chatbot-explain", { kind: "text_visible", text: "Follow-up Engines Preview" }, "This local preview illustrates automated WhatsApp follow-ups. It is brochure evidence of the proposed engagement experience, not a live patient conversation.", "The overlay title is a stable visible marker and narration completes before the next step."),
        { id: "demo-chatbot-close", kind: "action", action: "click", target: { controlId: "eng-preview-close", screenId: "engagement" }, compatibility: compat("demo-chatbot-close", "SDK_DIRECT", "The open overlay exposes one unique close button named ✕.", true) },
        { id: "demo-chatbot-closed", kind: "action", action: "wait", until: { kind: "text_absent", text: "Follow-up Engines Preview" }, timeoutMs: 5_000, compatibility: compat("demo-chatbot-closed", "SDK_DIRECT", "The missing overlay title proves the transient preview was closed before playlist advancement.", true) },
      ],
      postconditions: [{ kind: "text_absent", text: "Follow-up Engines Preview" }],
    }),
    journey({
      id: "preview-demo-scheduling-safely",
      name: "Preview demo scheduling without booking",
      description: "Open and explain the in-page scheduling dialog, then close it without entering data or selecting a slot.",
      intents: ["show how demo booking works", "show the scheduling dialog", "preview booking"],
      risk: "read",
      state: "approved",
      reliability: 0.98,
      startUrl: CLIENT.homeUrl,
      preconditions: precondition("home"),
      sourceCitations: citeLive,
      steps: [
        { id: "demo-booking-open", kind: "action", action: "click", target: { controlId: "home-talk-to-shweta", screenId: "home" }, compatibility: compat("demo-booking-open", "SDK_DIRECT", "The unique Talk to Shweta button opens an in-page dialog without leaving the brochure origin.", true) },
        { id: "demo-booking-ready", kind: "action", action: "wait", until: { kind: "text_visible", text: "Schedule a Demo" }, timeoutMs: 5_000, compatibility: compat("demo-booking-ready", "SDK_DIRECT", "The dialog title is a stable completion signal.", true) },
        directAssert("demo-booking-explain", { kind: "text_visible", text: "Book a time that works for you" }, "This is the handoff to NirogGyan's scheduling experience. I will not choose or submit a meeting time on your behalf.", "The local dialog subtitle is visible while narration is spoken; the cross-origin calendar remains untouched."),
        { id: "demo-booking-close", kind: "action", action: "click", target: { controlId: "home-booking-close", screenId: "home" }, compatibility: compat("demo-booking-close", "SDK_DIRECT", "The local dialog exposes one enabled close button with aria-label close.", true) },
        { id: "demo-booking-closed", kind: "action", action: "wait", until: { kind: "text_absent", text: "Book a time that works for you" }, timeoutMs: 5_000, compatibility: compat("demo-booking-closed", "SDK_DIRECT", "The missing subtitle proves the dialog closed without a booking action.", true) },
      ],
      postconditions: [{ kind: "text_absent", text: "Schedule a Demo" }],
    }),
  );
}

// --------------------------------------------------------------------------
// Conservative policy: third-party widgets and credential-shaped inputs are
// excluded before observation and before resolution.
// --------------------------------------------------------------------------
const privacyPolicy: PrivacyPolicy = {
  kind: "sable.catalog.privacy_policy",
  schemaVersion: SDK_CATALOG_SCHEMA_VERSION,
  defaultTextTreatment: "allow",
  screenshots: "disabled",
  excludedRoutes: [],
  rules: [
    { kind: "input_type", inputType: "password", action: "exclude" },
    { kind: "input_type", inputType: "hidden", action: "exclude" },
    { kind: "input_type", inputType: "email", action: "redact", replacement: "[email]" },
    { kind: "input_type", inputType: "tel", action: "redact", replacement: "[phone]" },
    { kind: "selector", selector: "input[autocomplete='username'], input[autocomplete='current-password'], input[autocomplete='new-password'], input[autocomplete='one-time-code'], input[name*='password' i], input[name*='token' i], input[name*='secret' i]", action: "exclude" },
    { kind: "selector", selector: "iframe[title='Language Translate Widget'], iframe[name='votingFrame'], form[action^='https://translate.googleapis.com/'], [id^='goog-gt-'], [class^='VIpgJd-'], [class*=' VIpgJd-'], .goog-te-gadget, .goog-te-combo, .skiptranslate", action: "exclude" },
    { kind: "selector", selector: "iframe[src*='meetings.hubspot.com']", action: "exclude" },
    { kind: "attribute", attribute: "autocomplete", value: "cc-number", action: "exclude" },
    { kind: "attribute", attribute: "data-private", action: "redact", replacement: "[private]" },
    { kind: "text_pattern", pattern: "\\b(?!sales@niroggyan\\.com)[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b", flags: "g", action: "redact", replacement: "[email]" },
  ],
  maximumVisibleTextChars: 25_000,
  allowElementValues: false,
};

const telemetryPolicy: TelemetryPolicy = {
  kind: "sable.catalog.telemetry_policy",
  schemaVersion: SDK_CATALOG_SCHEMA_VERSION,
  enabled: true,
  sampleRate: 1,
  allowedEvents: ["session.started", "session.stopped", "catalog.loaded", "screen.matched", "element.resolved", "action.completed", "journey.started", "journey.completed", "journey.failed", "approval.requested", "approval.resolved", "privacy.redacted", "transport.state", "sdk.error"],
  batchMaximumEvents: 50,
  flushIntervalMs: 5_000,
  includeVisibleText: false,
  includeElementValues: false,
};

const demoProfile: DemoProfile | undefined = GUIDED_DEMO_TEST ? {
  id: "niroggyan-brochure-guided-demo",
  version: 1,
  greeting: { text: "Welcome to the NirogGyan guided demo. I will first understand your context, then walk you through the relevant parts of our public brochure." },
  questions: [
    { id: "visitor-organisation", captureKey: "lead.organisationType", prompt: { text: "Before we begin, what kind of organisation are you joining from?" } },
    { id: "visitor-goal", captureKey: "lead.demoGoal", prompt: { text: "What would you most like to understand or see today?" } },
    { id: "lab-volume", captureKey: "lead.labMonthlyVolume", prompt: { text: "Approximately how many patient reports does your laboratory process in a month?" } },
    { id: "hospital-integration", captureKey: "lead.hospitalIntegrationContext", prompt: { text: "Which reporting or integration environment matters most to you, such as LIS, HIS, or EHR?" } },
  ],
  intake: {
    genericQuestionIds: ["visitor-organisation", "visitor-goal"],
    personaQuestionByPersonaId: {
      diagnostic_lab: "lab-volume",
      hospital: "hospital-integration",
    },
  },
  personas: [
    {
      id: "diagnostic_lab",
      name: "Diagnostic laboratory",
      description: "A diagnostic laboratory, pathology laboratory, diagnostic centre, or lab network.",
      classifierSignals: ["diagnostic laboratory", "pathology laboratory", "diagnostic centre", "diagnostic center", "lab network", "laboratory", "lab"],
    },
    {
      id: "hospital",
      name: "Hospital or health system",
      description: "A hospital, clinic group, healthcare provider, or health system.",
      classifierSignals: ["hospital", "health system", "clinic group", "healthcare provider", "clinic"],
    },
  ],
  modules: [
    { id: "overview", name: "NirogGyan overview", journeyId: "show-brochure-overview", introduction: { text: "I will begin with the problem NirogGyan addresses and the main value presented on the brochure." }, completion: { text: "That completes the NirogGyan overview. I will move naturally to the next relevant part." }, failureMessage: { text: "The overview could not be verified on the current page. I have paused so we do not continue from an uncertain state." } },
    { id: "smart-reporting", name: "Smart Reporting", journeyId: "show-smart-reporting-overview", introduction: { text: "Next, I will explain the two Smart Reporting formats shown on the brochure." }, completion: { text: "That covers the Smart Report and Viz App formats. Let us continue." }, failureMessage: { text: "The Smart Reporting section could not be verified. I have paused the demo." } },
    { id: "viz-app", name: "Viz App brochure", journeyId: "open-viz-app-from-user-journey", introduction: { text: "I will now open the first-party Viz App brochure page using the verified user-journey control." }, completion: { text: "The Viz App brochure page is now open and verified." }, failureMessage: { text: "I could not safely reach the Viz App brochure page, so I have paused." } },
    { id: "engagement", name: "Patient engagement", journeyId: "open-engagement-from-user-journey", introduction: { text: "Now I will move to the patient-engagement part of the brochure." }, completion: { text: "The engagement page is open. It presents follow-ups, communication, and related engagement tools." }, failureMessage: { text: "I could not safely reach the engagement page, so I have paused." } },
    { id: "whatsapp-preview", name: "WhatsApp follow-up preview", journeyId: "preview-whatsapp-chatbot-safely", introduction: { text: "I will briefly open the local WhatsApp follow-up preview, explain it, and close it before continuing." }, completion: { text: "The WhatsApp preview is now closed and the engagement page is ready for the next step." }, failureMessage: { text: "The WhatsApp preview did not return to a verified closed state, so I have paused." } },
    { id: "roi-scenario", name: "Patient-retention ROI scenario", journeyId: "run-sample-roi-calculation", introduction: { text: "I will now run the brochure's ROI calculator with non-personal sample values. This is a marketing scenario, not a forecast." }, completion: { text: "That completes the sample ROI scenario. Actual results can vary by laboratory." }, failureMessage: { text: "The sample ROI result could not be verified, so I have paused instead of quoting an uncertain number." } },
    { id: "customer-proof", name: "Customer evidence", journeyId: "reveal-testimonial-statistics", introduction: { text: "I will finish the main walkthrough with the testimonials and attributed statistics presented on the brochure." }, completion: { text: "That completes the brochure's customer-evidence section. These figures remain attributed website claims." }, failureMessage: { text: "The testimonial figures did not reach their verified final state, so I have paused." } },
    { id: "booking-preview", name: "Demo scheduling preview", journeyId: "preview-demo-scheduling-safely", introduction: { text: "I will show the scheduling handoff without choosing a time or submitting a booking." }, completion: { text: "The scheduling preview is closed. No meeting was selected or submitted." }, failureMessage: { text: "The scheduling dialog did not return to a verified closed state, so I have paused." } },
  ],
  defaultPlaylistModuleIds: ["overview", "smart-reporting", "engagement", "customer-proof"],
  playlistModuleIdsByPersonaId: {
    diagnostic_lab: ["overview", "smart-reporting", "engagement", "whatsapp-preview", "roi-scenario", "customer-proof"],
    hospital: ["overview", "smart-reporting", "viz-app", "engagement", "customer-proof"],
  },
  closing: { text: "Thank you for exploring NirogGyan. I have kept your answers as lead context for human follow-up; this demo has not decided whether the lead is qualified." },
} : undefined;

const salesPlays: CatalogSalesPlay[] = GUIDED_DEMO_TEST ? [
  { id: "play-product-overview", kind: "product_answer", title: "What NirogGyan presents", content: "The public brochure presents AI-assisted smart lab reports, patient engagement tools, analytics, onboarding, and demo booking for diagnostic laboratories and hospitals. Treat this as the brochure's product description, not proof that every linked external surface is deployed for the prospect.", personaIds: [], capabilityIds: [], journeyIds: ["show-brochure-overview"], signalPhrases: ["what is niroggyan", "what do you offer", "product overview", "service"] },
  { id: "play-report-formats", kind: "product_answer", title: "Smart Report and Viz App formats", content: "The brochure presents Smart Report as a professional PDF with visual explanations and Viz App as an interactive, mobile-friendly web report. It also describes templates, trends, body summaries, recommendations, customization, and multilingual output.", personaIds: [], capabilityIds: [], journeyIds: ["show-smart-reporting-overview", "open-viz-app-from-user-journey"], signalPhrases: ["smart report", "viz app", "pdf report", "report formats", "interactive report"] },
  { id: "play-engagement-tools", kind: "product_answer", title: "Patient engagement tools", content: "The engagement page presents a local WhatsApp follow-up preview, omnichannel communication, lab integrations, video-based reporting, and links to separate external tools. The preview is covered by this brochure catalog; external tools are not.", personaIds: [], capabilityIds: [], journeyIds: ["open-engagement-from-user-journey", "preview-whatsapp-chatbot-safely"], signalPhrases: ["whatsapp", "follow up", "patient engagement", "chatbot", "communication"] },
  { id: "play-onboarding-integration", kind: "product_answer", title: "Onboarding and LIS HIS EHR integration", content: "The brochure describes five onboarding stages: parameter mapping and configuration, API integration with LIS, HIS, or EHR, live processing, report delivery through preferred media, and ongoing follow-up and engagement. It also claims continuing support; implementation details still require human confirmation for the prospect's environment.", personaIds: ["diagnostic_lab", "hospital"], capabilityIds: [], journeyIds: ["show-brochure-overview"], signalPhrases: ["integration", "lis", "his", "ehr", "onboarding", "implementation"] },
  { id: "play-roi-model", kind: "product_answer", title: "How the brochure ROI calculator works", content: "The live brochure calculator uses monthly patient volume, twelve months, current retention, a claimed additional-retention range of five to twenty percent, and average revenue per patient. Its output is a marketing scenario and must never be stated as a guarantee or observed customer result.", personaIds: ["diagnostic_lab"], capabilityIds: [], journeyIds: ["run-sample-roi-calculation"], signalPhrases: ["roi", "revenue", "retention calculation", "business case", "return on investment"] },
  { id: "play-coverage-boundary", kind: "product_answer", title: "Brochure coverage boundary", content: "This signed catalog covers only brochure.niroggyan.com. The external Viz App demo, corporate dashboard login, niro.health consumer analyzer, configuration portal, authenticated dashboards, pricing, and HubSpot scheduling internals are separate surfaces. Explain the boundary instead of implying that the current page can operate them.", personaIds: [], capabilityIds: [], journeyIds: ["open-external-viz-demo", "open-external-corporate-dashboard", "open-external-consumer-analyzer"], signalPhrases: ["dashboard", "portal", "pricing", "consumer analyzer", "external demo", "configuration"] },
  { id: "play-patient-understanding-value", kind: "value_proposition", title: "Patient-friendly understanding", content: "The brochure's central value proposition is to turn raw laboratory numbers into visual, plain-language, actionable explanations that patients can understand more quickly. Present this as NirogGyan's stated value proposition.", personaIds: [], capabilityIds: [], journeyIds: ["show-brochure-overview", "show-smart-reporting-overview"], signalPhrases: ["patient understanding", "plain language", "why it matters", "patient friendly", "report clarity"] },
  { id: "play-lab-retention-value", kind: "value_proposition", title: "Retention and engagement value for laboratories", content: "For laboratories, the brochure connects understandable reports and automated follow-ups with stronger patient engagement, retention, and revenue opportunities. These outcomes are marketing claims; use the ROI calculator only to illustrate assumptions transparently.", personaIds: ["diagnostic_lab"], capabilityIds: [], journeyIds: ["show-brochure-overview", "preview-whatsapp-chatbot-safely", "run-sample-roi-calculation"], signalPhrases: ["lab growth", "patient retention", "repeat patients", "engagement value", "revenue growth"] },
  { id: "play-brochure-statistics-proof", kind: "proof", title: "Attributed brochure statistics", content: "After the count-up animation completes, the testimonials page presents claims of 25-plus countries, 99.9 percent accuracy, more than one million smart reports, and 15 languages. Attribute them to the NirogGyan brochure and do not describe them as independently verified.", personaIds: [], capabilityIds: [], journeyIds: ["reveal-testimonial-statistics"], signalPhrases: ["statistics", "accuracy", "countries", "one million reports", "languages", "proof"] },
  { id: "play-named-testimonials-proof", kind: "proof", title: "Named customer testimonials", content: "The brochure attributes testimonials to Dr. Arjun Dang of Dr. Dangs, Dr. Danish of Zaincare, and Ashwani of PharmEasy. Their presence and attribution are verified on the page; their praise remains testimonial content.", personaIds: [], capabilityIds: [], journeyIds: ["reveal-testimonial-statistics"], signalPhrases: ["customers", "testimonials", "dr dangs", "zaincare", "pharmeasy", "who uses it"] },
  { id: "play-traditional-versus-smart", kind: "positioning", title: "Traditional reports versus Smart Reporting", content: "Position Smart Reporting against a raw results table: the brochure emphasizes visual ranges, status cues, plain language, and next-step context. Avoid claiming that it replaces a doctor or provides a diagnosis.", personaIds: [], capabilityIds: [], journeyIds: ["show-brochure-overview", "show-smart-reporting-overview"], signalPhrases: ["different from normal report", "traditional report", "why smart", "comparison", "replace doctor"] },
  { id: "play-objection-implementation", kind: "objection_response", title: "Implementation and integration concern", content: "Acknowledge that integration effort depends on the prospect's systems and workflow. The brochure describes mapping, configuration, API integration, go-live processing, delivery, and ongoing support, but exact timelines and technical commitments require human validation.", personaIds: ["diagnostic_lab", "hospital"], capabilityIds: [], journeyIds: ["show-brochure-overview"], signalPhrases: ["hard to integrate", "implementation effort", "takes too long", "lis integration", "technical work"] },
  { id: "play-objection-claims", kind: "objection_response", title: "Concern about accuracy or guaranteed results", content: "Separate the brochure's attributed claims from guarantees. Explain the published statistic or calculator assumption, state that it is not independently verified in this demo, and recommend human follow-up for evidence, methodology, contractual commitments, or a customer-specific forecast.", personaIds: [], capabilityIds: [], journeyIds: ["reveal-testimonial-statistics", "run-sample-roi-calculation"], signalPhrases: ["can you guarantee", "is this accurate", "prove it", "results guaranteed", "roi guarantee", "credible"] },
  { id: "play-next-roi-scenario", kind: "next_best_action", title: "Offer the approved ROI scenario", content: "If a diagnostic-laboratory prospect explicitly asks to see how the retention assumptions change the output, offer the approved non-personal ROI scenario. This chunk is only a suggestion; deterministic policy must still validate the exact module request.", personaIds: ["diagnostic_lab"], capabilityIds: [], journeyIds: ["run-sample-roi-calculation"], signalPhrases: ["show me the roi", "run the calculator", "calculate sample", "see the numbers"], suggestedJourneyId: "run-sample-roi-calculation", requiresConfirmation: true },
] : [];

const catalog: SdkCatalog = {
  kind: "sable.sdk_catalog",
  schemaVersion: SDK_CATALOG_SCHEMA_VERSION,
  manifest: {
    kind: "sable.catalog.manifest",
    schemaVersion: SDK_CATALOG_SCHEMA_VERSION,
    protocolVersion: SDK_PROTOCOL_VERSION,
    catalogId: CLIENT.catalogId,
    catalogVersionId: CLIENT.catalogVersionId,
    version: CLIENT.catalogVersion,
    organizationId: CLIENT.organizationId,
    productId: CLIENT.productId,
    environmentId: CLIENT.environmentId,
    roleProfileId: CLIENT.roleProfileId,
    channel: GUIDED_DEMO_TEST ? "staging" : "production",
    issuedAt: CLIENT.issuedAt,
    supportedSdk: { minimum: "0.1.0", maximum: "1.0.0" },
    applicationBuildHints: [CLIENT.applicationBuild],
    publishedBy: GUIDED_DEMO_TEST ? "guided-demo test catalog — verified brochure build 847efae8" : "second analyst — live verification and deployed-source inspection",
  },
  screens,
  controls,
  journeys,
  ...(demoProfile ? { demoProfile, salesPlays } : {}),
  tools: GUIDED_DEMO_TEST ? [NIROGGYAN_CLIENT_ROUTER_TOOL_DEFINITION] : [],
  privacyPolicy,
  telemetryPolicy,
};

// Signing order is intentionally explicit and matches the handoff contract.
assertValidSdkCatalog(catalog);
const canonical = canonicalizeJson(catalog);
const digest = createHash("sha256").update(canonical).digest("base64url");
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const publicKey = createPublicKey(privateKey);
const publicJwk = publicKey.export({ format: "jwk" });
const keyId = `niroggyan-brochure-${createHash("sha256").update(JSON.stringify(publicJwk)).digest("hex").slice(0, 12)}`;
const signature = sign("sha256", Buffer.from(canonical), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
const envelope: SignedCatalogEnvelope = {
  kind: "sable.signed_catalog",
  schemaVersion: SDK_CATALOG_SCHEMA_VERSION,
  payload: catalog,
  digest: { algorithm: "SHA-256", encoding: "base64url", value: digest },
  signature: { kind: "sable.catalog_signature", algorithm: "ES256", keyId, encoding: "base64url", value: signature, signedAt: CLIENT.issuedAt },
};
assertValidSignedCatalogEnvelope(envelope);

// --------------------------------------------------------------------------
// Runtime bundle
// --------------------------------------------------------------------------
function accessibilityFingerprint(key: string, list: { role: string; name: string }[]): string {
  return `a11y-sha256:${createHash("sha256").update(`${key}|${list.map((item) => `${item.role}:${item.name}`).join("|")}`).digest("hex").slice(0, 32)}`;
}

const routeMeta: Array<{ key: string; name: string; url: string; purpose: string; controls: RuntimeScreenState["controls"] }> = [
  { key: "home", name: "Brochure introduction", url: CLIENT.homeUrl, purpose: "Public overview of smart reports, engagement, benefits, onboarding, founders, and demo booking.", controls: [{ key: "home-talk-to-shweta", role: "button", accessibleName: "Talk to Shweta", risk: "read" }] },
  { key: "user-journey", name: "Smart Health Journey", url: `${CLIENT.origin}/user-journey`, purpose: "Five-step reporting, retention, digital, counselling, and marketing journey.", controls: [{ key: "uj-view-viz-app", role: "button", accessibleName: "View Viz App", risk: "read" }, { key: "uj-view-chat-bot", role: "button", accessibleName: "View Chat Bot", risk: "read" }] },
  { key: "smart-reporting", name: "Smart Reporting overview", url: `${CLIENT.origin}/smartReporting`, purpose: "Comparison of Smart Report PDF and Viz App formats.", controls: [{ key: "sr-learn-more", role: "button", accessibleName: "Learn More", risk: "read" }] },
  { key: "smart-report", name: "Smart Health Report", url: `${CLIENT.origin}/smartReport`, purpose: "New smart-report templates, add-ons, and preview galleries.", controls: [] },
  { key: "viz-app", name: "Viz App", url: `${CLIENT.origin}/vizApp`, purpose: "Interactive web-report brochure and external Viz App demo handoff.", controls: [{ key: "viz-try-now", role: "button", accessibleName: "Try Now", risk: "external_side_effect" }] },
  { key: "legacy-smart-reports", name: "Legacy Smart Reports page", url: `${CLIENT.origin}/smartReports`, purpose: "Older Smart Report marketing page retained as a directly loadable route.", controls: [] },
  { key: "legacy-vizapp-page", name: "Legacy Viz App page", url: `${CLIENT.origin}/vizappPage`, purpose: "Older Viz App marketing page retained as a directly loadable route.", controls: [] },
  { key: "legacy-analytics", name: "Legacy Analytics page", url: `${CLIENT.origin}/analytics`, purpose: "Older report-template selector retained as a directly loadable route.", controls: [] },
  { key: "legacy-health-tools", name: "Legacy Health Tools page", url: `${CLIENT.origin}/healthTools`, purpose: "Older health-tools page retained as a directly loadable route.", controls: [] },
  { key: "engagement", name: "Patient engagement", url: `${CLIENT.origin}/engagement`, purpose: "Follow-up chatbot preview, corporate dashboard handoff, and engagement capabilities.", controls: [{ key: "eng-preview-whatsapp", role: "button", accessibleName: "Preview", risk: "read" }, { key: "eng-corporate-try-now", role: "button", accessibleName: "Try Now", risk: "external_side_effect" }] },
  { key: "testimonials", name: "Customer evidence", url: `${CLIENT.origin}/testimonials`, purpose: "Named testimonials, marketing statistics, customer logos, and outcomes.", controls: [] },
  { key: "roi-calculator", name: "Patient retention ROI calculator", url: `${CLIENT.origin}/roi-calculator`, purpose: "Interactive marketing scenario using patient volume, revenue, and retention inputs.", controls: [{ key: "roi-monthly-volume", role: "slider", accessibleName: "Monthly Patient Volume", risk: "reversible_write" }, { key: "roi-average-revenue", role: "slider", accessibleName: "Average Revenue Per Patient", risk: "reversible_write" }, { key: "roi-retention-rate", role: "slider", accessibleName: "Current Patient Retention Rate", risk: "reversible_write" }] },
];

const bundleScreens: RuntimeScreenState[] = routeMeta.map((item) => ({
  key: item.key,
  name: item.name,
  url: item.url,
  purpose: item.purpose,
  fingerprint: accessibilityFingerprint(item.key, item.controls.map((controlState) => ({ role: controlState.role ?? "", name: controlState.accessibleName ?? "" }))),
  roleProfileId: CLIENT.roleProfileId,
  controls: item.controls,
}));

const screenKeyForJourney = (definition: JourneyDefinition): string[] => {
  const match = definition.workflow.preconditions.find((assertion) => assertion.kind === "screen_matches");
  return match?.kind === "screen_matches" ? [match.screenId] : [];
};
const bundleJourneys: RuntimeJourney[] = catalog.journeys.map((definition) => {
  const screenKeys = screenKeyForJourney(definition);
  const fingerprints = screenKeys.map((key) => bundleScreens.find((candidate) => candidate.key === key)?.fingerprint).filter((value): value is string => !!value);
  return {
    key: definition.id,
    name: definition.name,
    roleProfileIds: definition.roles,
    intentPhrases: definition.intents,
    reliability: definition.reliability ?? 1,
    screenKeys,
    screenFingerprints: fingerprints,
    workflow: {
      schemaVersion: 1,
      id: definition.id,
      version: definition.version,
      name: definition.name,
      ...(definition.workflow.startUrl?.kind === "literal" && typeof definition.workflow.startUrl.value === "string" ? { startUrl: definition.workflow.startUrl.value } : {}),
      risk: definition.risk,
      preconditions: definition.workflow.preconditions,
      steps: definition.workflow.steps.map((step) => ({ id: step.id, action: step.kind === "action" ? step.action : step.kind, ...(step.narration ? { say: step.narration } : {}) })),
      postconditions: definition.workflow.postconditions,
    },
  };
});

const approvedCount = catalog.journeys.filter((definition) => definition.state === "approved").length;
const runtimeBundle: RuntimeBundle = {
  schemaVersion: 1,
  organizationId: CLIENT.organizationId,
  productId: CLIENT.productId,
  environmentId: CLIENT.environmentId,
  catalogVersionId: CLIENT.catalogVersionId,
  catalogVersion: CLIENT.catalogVersion,
  generatedAt: CLIENT.issuedAt,
  journeys: bundleJourneys,
  salesPlays: [{
    id: "play-smart-reporting-value",
    kind: "value_prop",
    content: "Use the brochure to explain the claimed value of patient-friendly smart reporting, but call every statistic or outcome a site claim. Use the live ROI calculator as a scenario model, never as a guaranteed forecast.",
    personaKeys: ROLES,
    capabilityIds: [],
    journeyKeys: ["show-brochure-overview", "show-smart-reporting-overview", "run-sample-roi-calculation"],
    signalKeywords: ["patient engagement", "retention", "smart report", "roi", "revenue", "lab report"],
  }, {
    id: "play-coverage-boundary",
    kind: "guardrail",
    content: "This catalog covers the public brochure only. The Viz App demo, corporate dashboard, consumer analyzer, configuration portal, authenticated dashboards, and pricing are separate surfaces and must not be implied as live brochure capabilities.",
    personaKeys: ROLES,
    capabilityIds: [],
    journeyKeys: ["open-external-viz-demo", "open-external-corporate-dashboard", "open-external-consumer-analyzer"],
    signalKeywords: ["dashboard", "portal", "pricing", "demo app", "consumer", "configuration"],
  }],
  screens: bundleScreens,
  transitions: [
    { fromScreenKey: "user-journey", fromFingerprint: bundleScreens.find((item) => item.key === "user-journey")!.fingerprint, toScreenKey: "viz-app", toFingerprint: bundleScreens.find((item) => item.key === "viz-app")!.fingerprint, roleProfileId: CLIENT.roleProfileId, controlKey: "uj-view-viz-app", action: { kind: "click" }, reliability: 0.97 },
    { fromScreenKey: "user-journey", fromFingerprint: bundleScreens.find((item) => item.key === "user-journey")!.fingerprint, toScreenKey: "engagement", toFingerprint: bundleScreens.find((item) => item.key === "engagement")!.fingerprint, roleProfileId: CLIENT.roleProfileId, controlKey: "uj-view-chat-bot", action: { kind: "click" }, reliability: 0.97 },
    { fromScreenKey: "engagement", fromFingerprint: bundleScreens.find((item) => item.key === "engagement")!.fingerprint, toScreenKey: "engagement", toFingerprint: bundleScreens.find((item) => item.key === "engagement")!.fingerprint, roleProfileId: CLIENT.roleProfileId, controlKey: "eng-preview-whatsapp", action: { kind: "click" }, reliability: 0.98 },
  ],
  coverage: {
    weighted: Number((approvedCount / catalog.journeys.length).toFixed(3)),
    verified: catalog.journeys.length,
    total: catalog.journeys.length,
    unknown: 0,
  },
};

// --------------------------------------------------------------------------
// Knowledge: every product/outcome statement is explicitly attributed.
// --------------------------------------------------------------------------
interface Chunk extends KnowledgeHit { tenantId: string; productId: string; catalogVersionId: string; }
const k = (id: string, title: string, section: string, content: string, source: string, trust: KnowledgeHit["trust"]): Chunk => ({
  id,
  title,
  section,
  content,
  source,
  trust,
  score: 0,
  tenantId: CLIENT.organizationId,
  productId: CLIENT.productId,
  catalogVersionId: CLIENT.catalogVersionId,
});

const knowledge: Chunk[] = [
  k("kb-overview", "What the brochure presents", "Overview", "The public NirogGyan brochure presents AI-assisted smart lab reports, patient engagement tools, analytics, onboarding, and demo booking for diagnostic labs and hospitals. These are brochure claims and examples, not proof of deployed customer functionality.", CLIENT.homeUrl, "marketing"),
  k("kb-smart-reporting", "Smart Reporting formats", "Smart Reporting", "The site presents two reporting formats: Smart Report, a professional PDF with visual explanations, and Viz App, an interactive mobile-friendly web report. The Smart Report pages also describe templates, trend reports, body summaries, cover customization, test recommendations, diet pages, doctor pages, and multilingual output.", `${CLIENT.origin}/smartReporting`, "marketing"),
  k("kb-engagement", "Engagement tools", "Patient engagement", "The engagement page presents a WhatsApp follow-up chatbot preview, omnichannel communication, lab integrations, video-based reporting, and a corporate health dashboard link. The chatbot preview is local; the corporate dashboard is a separate-origin login application.", `${CLIENT.origin}/engagement`, "marketing"),
  k("kb-roi-calculator", "ROI calculator model", "ROI calculator", "The live calculator uses monthly patient volume × 12 × current retention rate, then applies the site's claimed additional retention range of 5%–20%. It multiplies those extra patients by average revenue per patient. The page explicitly says actual results vary by lab; treat all output as a marketing scenario, not a forecast or guarantee.", `${CLIENT.origin}/roi-calculator`, "marketing"),
  k("kb-sample-roi", "Verified sample ROI", "ROI sample", "With non-personal sample inputs of 12,000 monthly patients, ₹2,000 average revenue, and 30% current retention, the live page recomputed 2,160–8,640 extra patients/year and ₹43,20,000–₹1,72,80,000 extra annual revenue. These are outputs of the site's marketing formula, not observed business results.", `${CLIENT.origin}/roi-calculator`, "marketing"),
  k("kb-statistics", "Animated brochure statistics", "Testimonials", "After scrolling into view, the testimonial page displays site claims of 25+ countries, 99.9% accuracy, 1M+ smart reports, and 15 languages. Before intersection, the count-up controls intentionally render zero. Do not quote the initial zeros and do not present the final figures as independently verified facts.", `${CLIENT.origin}/testimonials`, "marketing"),
  k("kb-testimonials", "Named testimonials", "Testimonials", "The page attributes testimonials to Dr. Arjun Dang (Dr. Dangs), Dr. Danish (Paediatrician in Oman and CEO of Zaincare), and Ashwani (PharmEasy). Their presence and attribution are verified; their praise remains customer testimonial content.", `${CLIENT.origin}/testimonials`, "marketing"),
  k("kb-onboarding", "Onboarding and support claims", "Onboarding", "The home page describes five onboarding steps: parameter mapping and product configuration, API integration with LIS/HIS/EHR, live processing, delivery through preferred media, and follow-up/engagement tools. It also claims 24/7 support, a dedicated success manager, and ongoing optimization.", CLIENT.homeUrl, "marketing"),
  k("kb-routes", "Brochure route inventory", "Coverage", "Deployed build 847efae8 declares 12 first-party routes. Eight are reachable from current navigation or page buttons; /smartReports, /vizappPage, /analytics, and /healthTools are legacy routes that load directly but are not referenced by a current UI navigation handler.", "catalog://niroggyan-brochure/mapping-report", "official"),
  k("kb-coverage-gap", "Catalog coverage boundary", "Limitations", "This catalog covers only brochure.niroggyan.com. The external Viz App demo, corporate dashboard login, niro.health consumer analyzer, configuration portal, authenticated dashboards, and pricing surfaces are not covered. The brochure can demonstrate marketing narratives, local previews, route transitions, animated statistics, booking-dialog opening, and the ROI calculator—not the full founder sales demo.", "catalog://niroggyan-brochure/mapping-report", "sales_expert"),
  k("kb-auth", "Authentication coverage", "Authentication", "No authentication is required for any of the 12 brochure routes. The HubSpot scheduling iframe and external corporate dashboard are separate origins; the dashboard presents a login and is outside this catalog.", "catalog://niroggyan-brochure/mapping-report", "official"),
  k("kb-contact", "Public contact", "Contact", "The brochure publishes sales@niroggyan.com and a New Delhi office address. Opening a mail client or sending a message is a user action outside direct SDK execution.", CLIENT.homeUrl, "official"),
];

// --------------------------------------------------------------------------
// Installation, public trust config, findings, and coverage.
// --------------------------------------------------------------------------
const installationCredential = `sable_installation_${randomBytes(32).toString("base64url")}`;
const installation = {
  installationId: CLIENT.installationId,
  organizationId: CLIENT.organizationId,
  productId: CLIENT.productId,
  environmentId: CLIENT.environmentId,
  credentialHash: hashCredential(installationCredential),
  allowedOrigins: [CLIENT.origin],
  allowedRoles: ROLES,
  activeCatalogVersionId: CLIENT.catalogVersionId,
  ...(GUIDED_DEMO_TEST ? { guidedDemo: { enabled: true } } : {}),
  voice: { languageCode: "en-IN", speaker: "shubh", speakMode: "voice_turns" as const, stepNarration: true },
};
const database = { installations: [installation], catalogs: [envelope], runtimeBundles: [runtimeBundle], knowledge };
const secrets = { installationId: CLIENT.installationId, installationCredential, note: "Cleartext installation credential. Gitignored. Do not commit or share." };
const runtimeConfig = {
  apiBaseUrl: process.env.PUBLIC_API_URL ?? "http://localhost:8787",
  installationId: CLIENT.installationId,
  origin: CLIENT.origin,
  catalogTrustKeys: [{ keyId, algorithm: "ES256", jwk: publicJwk }],
};

const recordingManifest = demoProfile ? {
  schemaVersion: 1,
  catalogVersionId: CLIENT.catalogVersionId,
  profileId: demoProfile.id,
  status: "signed_text_fallback_ready",
  note: "The correct brochure catalog contains no approved recording bytes with verifiable transcript-to-file mapping. Runtime TTS uses these exact signed texts until approved audio files and SHA-256 metadata are supplied; unrelated niro.health audio cache files are not reused.",
  utterances: [
    { key: "greeting", text: demoProfile.greeting.text, audioAssetId: null },
    ...demoProfile.questions.map((question) => ({ key: `question:${question.id}`, text: question.prompt.text, audioAssetId: null })),
    ...demoProfile.modules.flatMap((module) => [
      { key: `module:${module.id}:introduction`, text: module.introduction.text, audioAssetId: null },
      { key: `module:${module.id}:completion`, text: module.completion.text, audioAssetId: null },
      { key: `module:${module.id}:failure`, text: module.failureMessage.text, audioAssetId: null },
    ]),
    { key: "closing", text: demoProfile.closing.text, audioAssetId: null },
  ],
} : undefined;

const linkChecks = [
  "/", "/user-journey", "/smartReporting", "/smartReport", "/vizApp", "/smartReports", "/vizappPage", "/analytics", "/healthTools", "/engagement", "/testimonials", "/roi-calculator",
].map((path) => ({ url: `${CLIENT.origin}${path === "/" ? "/" : path}`, status: 200, checkedAt: CLIENT.verifiedAt }));
linkChecks.push(
  { url: "https://www.demo-vizapp.niroggyan.com/overview", status: 200, checkedAt: CLIENT.verifiedAt },
  { url: "https://demo-corporate-dashboard.niroggyan.com/login", status: 200, checkedAt: CLIENT.verifiedAt },
  { url: "https://www.niro.health/", status: 200, checkedAt: CLIENT.verifiedAt },
  { url: "https://meetings.hubspot.com/shweta26", status: 200, checkedAt: CLIENT.verifiedAt },
);

const brokenLinks = {
  generatedAt: CLIENT.verifiedAt,
  sourcePage: CLIENT.homeUrl,
  applicationBuild: CLIENT.applicationBuild,
  method: "Correct 1440x900 viewport DOM/accessibility exploration, deployed source-map inspection, native interaction replay, and HTTP GET reachability.",
  brokenLinks: [] as Array<Record<string, unknown>>,
  brokenControls: [] as Array<Record<string, unknown>>,
  linkChecks,
  resolvedSuspicions: [
    { item: "testimonial statistics initially read zero", verdict: "not broken", evidence: "The source uses useInView(amount 0.5) and a 2.5-second AnimatedCounter. Native scroll produced 25+, 99.9%, 1M+, and 15." },
    { item: "home expanding panels", verdict: "not broken", evidence: "Each outer Box handles both onMouseEnter and onClick. Native pointer interaction expanded every panel from 60px to 400px." },
    { item: "repeated Preview buttons", verdict: "not broken", evidence: "They open local preview modals for a user; the SDK limitation is locator ambiguity, not application failure." },
  ],
  unsupportedActions: [
    { controlId: "home-nav-smart-reporting", classification: "NEEDS_STABLE_MARKER", reason: "Desktop navigation uses plain MUI Box/Typography nodes with no role, tabindex, id, test id, or data-sable-id. Only generated classes distinguish items." },
    { controlId: "home-panel-smart-reports", classification: "NEEDS_STABLE_MARKER", reason: "The event-owning panel is a plain Box with no stable semantic marker. Add data-sable-id or render an accessible button." },
    { controlId: "uj-view-smart-report-repeated", classification: "NEEDS_STABLE_MARKER", reason: "Two buttons tie on role+name; every semantic tier remains ambiguous and generated/positional CSS is rejected." },
    { controlId: "smart-report-preview-repeated", classification: "NEEDS_STABLE_MARKER", reason: "Seven enabled buttons share Preview and have no distinct accessible labels or stable markers." },
    { controlId: "hubspot-scheduling-frame", classification: "NEEDS_FRAME_BRIDGE", reason: "The in-page calendar is a cross-origin HubSpot iframe; choosing/submitting a slot is also an external side effect." },
    { controlId: "viz-try-now", classification: "NEEDS_USER_GESTURE", reason: "window.open leaves the brochure origin for the Viz App demo." },
    { controlId: "eng-corporate-try-now", classification: "NEEDS_USER_GESTURE", reason: "window.open leaves the brochure origin for an authenticated corporate dashboard." },
    { controlId: "eng-discover-ai-tools", classification: "NEEDS_USER_GESTURE", reason: "window.open leaves the brochure origin for niro.health." },
  ],
};

const coverageReport = {
  generatedAt: CLIENT.verifiedAt,
  client: CLIENT.slug,
  origin: CLIENT.origin,
  catalogVersionId: CLIENT.catalogVersionId,
  applicationBuild: CLIENT.applicationBuild,
  routes: {
    totalDefined: 12,
    uiReachable: ["/", "/user-journey", "/smartReporting", "/smartReport", "/vizApp", "/engagement", "/testimonials", "/roi-calculator"],
    directOnlyLegacy: ["/smartReports", "/vizappPage", "/analytics", "/healthTools"],
    acceptedCaseAlias: "/vizapp resolves to the /vizApp route in the current React Router configuration",
  },
  screens: { total: screens.length },
  controls: { total: controls.length, direct: controls.filter((item) => item.locators.length > 0).length, blockedWithoutStableLocator: controls.filter((item) => item.locators.length === 0).map((item) => item.id) },
  journeys: {
    total: catalog.journeys.length,
    approved: catalog.journeys.filter((definition) => definition.state === "approved").map((definition) => definition.id),
    verifiedNonApproved: catalog.journeys.filter((definition) => definition.state === "verified").map((definition) => definition.id),
  },
  authentication: { requiredForBrochure: false, note: "All 12 brochure routes loaded publicly. External dashboard authentication is outside this origin and catalog." },
  externalSurfacesNotCataloged: ["demo-vizapp.niroggyan.com", "demo-corporate-dashboard.niroggyan.com", "niro.health", "HubSpot scheduling internals", "configuration portal", "pricing surface"],
  coverageHonesty: "The brochure is strong for product narrative, static report previews, a WhatsApp preview, and ROI scenario demonstration. It cannot demonstrate the founder's full authenticated dashboards, configuration workflow, consumer analysis, or pricing journey.",
  brokenLinks: 0,
  brokenControls: 0,
  knowledgeChunks: knowledge.length,
  privacyRules: privacyPolicy.rules.length,
};

const mappingReport = `# NirogGyan brochure mapping report

Verified: 2026-08-20 at a forced 1440×900 desktop viewport  
Application build: \`${CLIENT.applicationBuild}\`  
Origin: ${CLIENT.origin}

## Executive result

The brochure is public and needs no authentication. The current build defines 12 first-party routes. Eight are connected to the current navigation or page buttons; four older pages load directly but are orphaned from the current UI.

The strongest SDK-direct interactions are the ROI sliders, the local WhatsApp preview, the local booking-dialog open/close boundary, two unique React SPA route buttons, and testimonial scrolling. Main navigation, home expansion panels, and repeated Preview/View Smart Report buttons need stable markers before they can be approved.

## Capability boundary derived from code

- \`dom.ts\` reaches buttons, anchors, inputs, textareas, selects, summaries, roles, contenteditable nodes, non-negative tabindex nodes, and \`data-sable-id\` nodes.
- Semantic resolver tiers inspect only those meaningful elements. CSS fallback can technically query any element, but the brochure supplies only generated MUI/Emotion classes for the problematic nodes; those are intentionally rejected as unstable.
- The resolver refuses a tie when the two top candidates have the same score (\`CONTROL_AMBIGUOUS\`).
- The action driver allows local button clicks, fills, scrolling, and assertions. It refuses cross-origin anchors, target-blank/download links, full-page navigation, and native form submission. New-window button handlers still require compatibility classification and must never be called SDK-direct.
- Policy allows only \`SDK_DIRECT\` and reviewed registered tools. The guided-demo test catalog declares one read-only, route-allow-listed client router so an injected SDK can move between React pages without a document reload; the production v1 catalog declares no tools.

## Route inventory

| Route | Surface | Reachability |
|---|---|---|
| \`/\` | Intro/home | Desktop nav Intro |
| \`/user-journey\` | Five-step user journey | Desktop nav |
| \`/smartReporting\` | Smart Reporting overview | Smart Reporting nav label |
| \`/smartReport\` | New Smart Report page | Dropdown and repeated user-journey buttons |
| \`/vizApp\` | New Viz App page | Dropdown; \`/vizapp\` case alias from a page button |
| \`/engagement\` | Patient engagement | Desktop nav and two user-journey buttons |
| \`/testimonials\` | Customer evidence | Desktop nav |
| \`/roi-calculator\` | Live ROI calculator | Desktop nav |
| \`/smartReports\` | Legacy Smart Report page | Direct URL only; route literal appears only in App.js |
| \`/vizappPage\` | Legacy Viz App page | Direct URL only; route literal appears only in App.js |
| \`/analytics\` | Legacy report selector | Direct URL only; route literal appears only in App.js |
| \`/healthTools\` | Legacy health-tools page | Direct URL only; route literal appears only in App.js |

This corrects the earlier “at least eight / two button-only hidden routes” lead. In build 847efae8 there are 12 declarations, and the four extra legacy routes are not button-reachable at all.

## Open-question verdicts

### 1. Navigation

The previous negative finding is correct for the current markup, but the mechanism matters. Desktop nav items are plain \`Box\`/\`Typography\` nodes. They have click handlers but no role, tabindex, id, test ID, or Sable marker. Semantic locator kinds cannot see them. Generated CSS classes are the only unique selectors.

Smallest robust fix: add \`data-sable-id\` to the event-owning Box. Better accessibility fix: render an anchor/button with a distinct accessible name and keyboard behavior. A registered client-router tool is the alternative when markup cannot change.

### 2. Four home panels

They are working. Deployed source attaches the same state setter to \`onMouseEnter\` and \`onClick\` on the outer Box. A native pointer changed each selected panel from 60px to 400px. The SDK problem is targeting: the handler-owning Box is outside the semantic selector and has no stable marker. Add \`data-sable-id\` (or make it a real button) and the SDK click path becomes legitimate.

### 3. Smart Reporting dropdown

Native hover opens two items: Smart Report and Viz App. Both items are plain Boxes with generated classes and no role/marker, so they are not safely resolvable. They route to \`/smartReport\` and \`/vizApp\`.

### 4. Repeated labels

The user-journey page has two \`View Smart Report\` buttons; Smart Reporting has two \`Preview\` buttons; Smart Report has seven \`Preview\` buttons. Agent ID is absent, role/name and text tie, label ties, test ID is absent, relationship has no stable ancestor, and CSS would require generated or positional selectors. The resolver therefore refuses the top-score tie. Give each control a distinct \`aria-label\` or \`data-sable-id\`.

### 5. Zero statistics

Not a defect. \`AnimatedCounter\` uses \`useInView({ once: true, amount: 0.5 })\` and runs for 2.5 seconds. A clean load showed zeros; a native scroll produced 25+, 99.9%, 1M+, and 15. Store/quote them only as attributed site claims.

### 6. Scrolling

The page scrolls on \`window\`; all main pages have document heights above the 900px viewport. The SDK scroll action calls smooth \`window.scrollBy\`, defaulting to 80% of viewport height. A 950px testimonial scroll triggered the count-up successfully.

### 7. Coverage honesty

This brochure supports narrative walkthroughs, report-preview explanations, a local WhatsApp preview, booking-dialog opening, and ROI scenarios. It does not contain the full authenticated dashboards, configuration portal, consumer analysis workflow, or pricing shown in the founder's broader sales demo. The linked Viz App, corporate dashboard, and niro.health surfaces are separate origins and separate catalog scopes.

## Per-route control summary

- Home: Talk to Shweta; Personal/Total/Compact comparison buttons; two distinctly labelled founder LinkedIn buttons; Book Demo; unnamed social links.
- User journey: View Smart Report ×2; View Viz App; View Chat Bot; View Analytics; Contact Now; Book Demo.
- Smart Reporting: Learn More; Preview ×2; Book Demo.
- Smart Report: Preview ×7; Book Demo.
- Viz App: Try Now (external new tab); Book Demo.
- Engagement: Discover AI Tools (external); Preview (local WhatsApp overlay); Try Now (external corporate dashboard); Book Demo.
- Testimonials: unnamed carousel arrows; Book Demo.
- ROI: three uniquely aria-labelled range inputs; Book a Demo; footer Book Demo.
- Legacy Smart Reports: View Demo Report; Preview ×7; Book Demo.
- Legacy Viz App: Try Now; Book Demo.
- Legacy Analytics: Book Demo ×2 and four report-selector buttons.
- Legacy Health Tools: Book Now; Preview; Try Now; Book Demo.

## Third-party and privacy boundaries

The Google Translate widget injects a voting form, inputs, IDs, classes, and iframes on every route. The catalog excludes its forms, frames, IDs/classes, and gadget nodes from both observation and resolution. Screenshots are disabled, element values are disabled, visible text is capped at 25,000 characters, credential-shaped inputs are excluded, and the HubSpot iframe is excluded.

Opening the local booking dialog is SDK-direct. Selecting or submitting a time occurs inside a cross-origin HubSpot iframe and needs a frame bridge plus explicit external-side-effect handling; it is not approved here.

## Link and defect result

HTTP GET returned 200 for all 12 brochure routes and the Viz App demo, corporate dashboard login, niro.health, and HubSpot meeting destination. No broken link or broken control was found. The zero counters, home panels, and preview overlays were all resolved as working mechanisms rather than defects.
`;

// --------------------------------------------------------------------------
// Emit artifacts.
// --------------------------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url));
const artifactDir = GUIDED_DEMO_TEST ? resolve(here, "guided-demo-test") : here;
const dataDir = resolve(here, "../../data");
const runtimeDbPath = resolve(dataDir, `${CLIENT.slug}-runtime.generated.json`);
const secretsPath = resolve(dataDir, `${CLIENT.slug}-secrets.generated.json`);
const writeJson = (path: string, value: unknown, secret = false) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, secret ? { encoding: "utf8", mode: 0o600 } : { encoding: "utf8" });

await mkdir(dataDir, { recursive: true });
await mkdir(artifactDir, { recursive: true });
await writeJson(resolve(artifactDir, "catalog.source.json"), catalog);
await writeJson(resolve(artifactDir, "signed-catalog.generated.json"), envelope);
await writeJson(resolve(artifactDir, "runtime-bundle.source.json"), runtimeBundle);
await writeJson(resolve(artifactDir, "knowledge.source.json"), knowledge);
await writeJson(resolve(artifactDir, "broken-links.json"), brokenLinks);
await writeJson(resolve(artifactDir, "coverage-report.json"), coverageReport);
await writeFile(resolve(artifactDir, "mapping-report.md"), mappingReport, "utf8");
await writeJson(resolve(artifactDir, "runtime-config.generated.json"), runtimeConfig);
if (recordingManifest) await writeJson(resolve(artifactDir, "recording-manifest.source.json"), recordingManifest);
await writeJson(runtimeDbPath, database, true);
await writeJson(secretsPath, secrets, true);

// --------------------------------------------------------------------------
// Self-verification.
// --------------------------------------------------------------------------
const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
const record = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, ...(detail ? { detail } : {}) });

try { assertValidSdkCatalog(envelope.payload); record("catalog schema valid", true); }
catch (error) { record("catalog schema valid", false, String(error)); }
try { assertValidSignedCatalogEnvelope(envelope); record("signed envelope valid", true); }
catch (error) { record("signed envelope valid", false, String(error)); }

const recomputedDigest = createHash("sha256").update(canonicalizeJson(envelope.payload)).digest("base64url");
record("digest matches RFC 8785 canonical payload", recomputedDigest === envelope.digest.value);
record("ES256 signature verifies with public key", verify("sha256", Buffer.from(canonicalizeJson(envelope.payload)), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(envelope.signature.value, "base64url")));

function allSteps(items: WorkflowStep[]): WorkflowStep[] {
  const output: WorkflowStep[] = [];
  for (const step of items) {
    output.push(step);
    if (step.kind === "approval") output.push(...allSteps(step.then));
    else if (step.kind === "branch") output.push(...allSteps(step.then), ...allSteps(step.otherwise ?? []));
    else if (step.kind === "loop") output.push(...allSteps(step.steps));
  }
  return output;
}

{
  const controlIds = new Set(controls.map((item) => item.id));
  const screenIds = new Set(screens.map((item) => item.id));
  const missing: string[] = [];
  const visit = (value: unknown, journeyId: string) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach((item) => visit(item, journeyId)); return; }
    const recordValue = value as Record<string, unknown>;
    if (typeof recordValue.controlId === "string" && !controlIds.has(recordValue.controlId)) missing.push(`${journeyId}:control:${recordValue.controlId}`);
    if (typeof recordValue.screenId === "string" && !screenIds.has(recordValue.screenId)) missing.push(`${journeyId}:screen:${recordValue.screenId}`);
    Object.values(recordValue).forEach((item) => visit(item, journeyId));
  };
  catalog.journeys.forEach((definition) => visit(definition.workflow, definition.id));
  record("every journey control and screen reference exists", missing.length === 0, missing.join(", ") || undefined);
}

{
  const failures: string[] = [];
  for (const definition of catalog.journeys) {
    const steps = allSteps(definition.workflow.steps);
    const stepIds = steps.map((step) => step.id).sort();
    const compatibilityIds = definition.compatibility.map((entry) => entry.stepId).sort();
    if (JSON.stringify(stepIds) !== JSON.stringify(compatibilityIds)) failures.push(definition.id);
  }
  record("every compatibility entry maps exactly to a real step", failures.length === 0, failures.join(", ") || undefined);
}

{
  const failures: string[] = [];
  for (const definition of catalog.journeys) {
    const inputs = new Set(Object.keys(definition.inputSchema.properties));
    const visit = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(visit); return; }
      const recordValue = value as Record<string, unknown>;
      if (recordValue.kind === "input_ref" && typeof recordValue.name === "string" && !inputs.has(recordValue.name)) failures.push(`${definition.id}:${recordValue.name}`);
      Object.values(recordValue).forEach(visit);
    };
    visit(definition.workflow);
  }
  record("every workflow input reference exists in its schema", failures.length === 0, failures.join(", ") || undefined);
}

{
  const declaredTools = new Set(catalog.tools.map((tool) => tool.name));
  const failures: string[] = [];
  for (const definition of catalog.journeys.filter((candidate) => candidate.state === "approved")) {
    const steps = new Map<string, WorkflowStep>();
    const visit = (items: WorkflowStep[]) => {
      for (const step of items) {
        steps.set(step.id, step);
        if (step.kind === "approval") visit(step.then);
        else if (step.kind === "branch") { visit(step.then); visit(step.otherwise ?? []); }
        else if (step.kind === "loop") visit(step.steps);
      }
    };
    visit(definition.workflow.steps);
    const invalid = definition.compatibility.some((entry) => {
      if (entry.classification === "SDK_DIRECT") return false;
      const step = steps.get(entry.stepId);
      return entry.classification !== "NEEDS_REGISTERED_TOOL"
        || step?.kind !== "action"
        || step.action !== "tool_call"
        || !declaredTools.has(step.toolName);
    });
    if (invalid) failures.push(definition.id);
  }
  record("approved journeys use only SDK_DIRECT steps or declared client tools", failures.length === 0, failures.join(", ") || undefined);
}

{
  const failures: string[] = [];
  for (const definition of catalog.journeys.filter((candidate) => candidate.state === "approved")) {
    if (!definition.workflow.postconditions.length) failures.push(`${definition.id}:missing`);
    const pre = new Set(definition.workflow.preconditions.map((item) => JSON.stringify(item)));
    if (definition.workflow.postconditions.every((item) => pre.has(JSON.stringify(item)))) failures.push(`${definition.id}:duplicates-precondition`);
  }
  record("approved postconditions are present and can fail independently", failures.length === 0, failures.join(", ") || undefined);
}

{
  const approvedTargets = new Set<string>();
  for (const definition of catalog.journeys.filter((candidate) => candidate.state === "approved")) {
    const visit = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(visit); return; }
      const recordValue = value as Record<string, unknown>;
      if (typeof recordValue.controlId === "string") approvedTargets.add(recordValue.controlId);
      Object.values(recordValue).forEach(visit);
    };
    visit(definition.workflow);
  }
  const brokenControlIds = brokenLinks.brokenLinks.map((item) => item.controlId).filter((value): value is string => typeof value === "string");
  const failures = brokenControlIds.filter((id) => approvedTargets.has(id));
  record("broken items are not approved executable journeys", failures.length === 0, failures.join(", ") || undefined);
}

record("privacy policy disables screenshots and element values", privacyPolicy.screenshots === "disabled" && !privacyPolicy.allowElementValues && privacyPolicy.maximumVisibleTextChars === 25_000);
record("Google Translate DOM has a site-specific exclusion", privacyPolicy.rules.some((rule) => rule.kind === "selector" && rule.action === "exclude" && rule.selector.includes("translate.googleapis.com")));
record("runtime DB stores only credential hash", /^[a-f0-9]{64}$/.test(installation.credentialHash) && !JSON.stringify(database).includes(installationCredential));
record("public JWK contains no private key material", !("d" in publicJwk));
if (GUIDED_DEMO_TEST) {
  const moduleJourneyIds = new Set(demoProfile?.modules.map((module) => module.journeyId) ?? []);
  const demoSafeJourneyIds = new Set(catalog.journeys.filter((definition) => definition.demoSafe === true).map((definition) => definition.id));
  record("guided-demo installation is explicitly enabled", installation.guidedDemo?.enabled === true);
  record("guided-demo profile contains exactly two generic intake questions", demoProfile?.intake.genericQuestionIds.length === 2);
  record("every configured module maps to an approved demo-safe journey", [...moduleJourneyIds].every((id) => {
    const definition = catalog.journeys.find((candidate) => candidate.id === id);
    return definition?.state === "approved" && definition.demoSafe === true;
  }));
  record("only the reviewed stable-state journey set is demo-safe", demoSafeJourneyIds.size === GUIDED_DEMO_SAFE_JOURNEY_IDS.size && [...demoSafeJourneyIds].every((id) => GUIDED_DEMO_SAFE_JOURNEY_IDS.has(id)));
  record("external and ambiguous journeys remain outside guided playback", catalog.journeys.filter((definition) => definition.state !== "approved").every((definition) => definition.demoSafe !== true && !moduleJourneyIds.has(definition.id)));
  record("signed catalog contains bounded sales-call grounding", salesPlays.length >= 10 && salesPlays.length <= 20);
  record("recording manifest never invents an unverified audio reference", recordingManifest?.utterances.every((utterance) => utterance.audioAssetId === null) === true);
}
{
  const publicText = JSON.stringify({ catalog, runtimeBundle, knowledge, brokenLinks, coverageReport, runtimeConfig });
  record("public artifacts contain no installation credential or private PEM", !publicText.includes(installationCredential) && !/BEGIN (?:EC )?PRIVATE KEY/.test(publicText));
}

try {
  const stores = await createFileStores(runtimeDbPath);
  const scope = { organizationId: CLIENT.organizationId, productId: CLIENT.productId, roleProfileId: CLIENT.roleProfileId, catalogVersionId: CLIENT.catalogVersionId };
  const loadedInstallation = await stores.installations.get(CLIENT.installationId);
  record("file store: installation loads", !!loadedInstallation);
  const loadedCatalog = loadedInstallation ? await stores.catalogs.get(CLIENT.catalogVersionId, loadedInstallation) : undefined;
  record("file store: signed catalog loads", !!loadedCatalog);
  record("file store: runtime bundle loads", !!(await stores.catalogs.getBundle(scope)));
  const roiHits = await stores.knowledge.search(scope, { query: "retention roi revenue calculator", limit: 4 });
  record("file store: ROI knowledge is searchable", roiHits.some((hit) => hit.id === "kb-roi-calculator"), roiHits.map((hit) => hit.id).join(", "));
  const coverageHits = await stores.knowledge.search(scope, { query: "dashboard portal pricing coverage limitation", limit: 4 });
  record("file store: coverage boundary is searchable", coverageHits.some((hit) => hit.id === "kb-coverage-gap"), coverageHits.map((hit) => hit.id).join(", "));
  await stores.close();
} catch (error) {
  record("file store load", false, String(error));
}

const validationReport = {
  generatedAt: CLIENT.verifiedAt,
  client: CLIENT.slug,
  catalogVersionId: CLIENT.catalogVersionId,
  digest: envelope.digest,
  signature: { algorithm: envelope.signature.algorithm, keyId: envelope.signature.keyId },
  counts: { screens: screens.length, controls: controls.length, journeys: catalog.journeys.length, approvedJourneys: approvedCount, demoSafeJourneys: catalog.journeys.filter((definition) => definition.demoSafe === true).length, demoModules: demoProfile?.modules.length ?? 0, salesPlays: salesPlays.length, knowledgeChunks: knowledge.length },
  checks,
  allPassed: checks.every((check) => check.ok),
};
await writeJson(resolve(artifactDir, "validation-report.json"), validationReport);

const failed = checks.filter((check) => !check.ok);
console.log(`NirogGyan brochure catalog generated (${CLIENT.catalogVersionId}).`);
console.log(`  screens=${screens.length} controls=${controls.length} journeys=${catalog.journeys.length} approved=${approvedCount} knowledge=${knowledge.length}`);
console.log(`  digest=${envelope.digest.value}`);
console.log(`  keyId=${keyId}`);
console.log(`  runtime db  -> ${runtimeDbPath}`);
console.log(`  artifacts   -> ${artifactDir}`);
console.log(`  secrets     -> ${secretsPath} (gitignored)`);
console.log(`  self-checks: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) {
  for (const check of failed) console.error(`  FAILED: ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);
  process.exitCode = 1;
}
