import { surveyProduct } from "./cartographer.js";
import type { LiveBox } from "../livebox.js";

/**
 * Survey identity tests.
 *
 * The scenario is draw.io, reproduced from a real mapping run: one canvas page
 * at one URL whose menu bar opens File / Edit / View / Arrange / Extras. Every
 * one of those produced its own "screen", so all six screen slots were spent on
 * a single page and nothing else in the product was ever reached.
 */

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ✔ ${name}`);
  } else {
    failed++;
    console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

type El = { id: number; tag: string; type: string; text: string; placeholder: string; value: string; href: string; role?: string; name?: string; discloses?: boolean; overlay?: boolean };

const el = (role: string, name: string, extra: Partial<El> = {}): El => ({
  id: 0, tag: role === "link" ? "a" : "button", type: "", text: name, placeholder: "", value: "",
  href: "", role, name, ...extra,
});

/** The canvas page's permanent menu bar. Present on every state. */
const MENU_BAR = ["File", "Edit", "View", "Arrange", "Extras"].map((n) => el("button", n, { discloses: true }));

/** Items revealed inside the open menu — transient, and flagged as overlay. */
const MENU_ITEMS: Record<string, string[]> = {
  File: ["New", "Open Recent", "Export as"],
  Edit: ["Undo", "Redo", "Find/Replace"],
  View: ["Format Panel", "Outline", "Layers"],
  Arrange: ["To Front", "To Back", "Rotate"],
  Extras: ["Edit Diagram", "Edit Style", "Plugins"],
};

/**
 * A stub browser: one URL, one title, and whichever menu was last clicked.
 * Text changes when a menu opens, exactly as the real page does.
 */
function makeBox() {
  let open: string | null = null;
  const box = {
    startUrl: "https://app.diagrams.net/",
    async goto() { open = null; },
    async gotoStart() { open = null; },
    async loginIfNeeded() { return false; },
    async clickByRole(_role: string, name: string) {
      open = MENU_ITEMS[name] ? name : open;
      return "ok";
    },
    async snapshot() {
      const overlay = open ? MENU_ITEMS[open].map((n) => el("menuitem", n, { overlay: true })) : [];
      return {
        url: "https://app.diagrams.net/",
        title: "Untitled Diagram - draw.io",
        elements: [...MENU_BAR, ...overlay],
        text: `File Edit View Arrange Extras${open ? " " + MENU_ITEMS[open].join(" ") : ""}`,
        screenshot: "",
      };
    },
  };
  return box as unknown as LiveBox;
}

console.log("survey — one canvas page with five dropdown menus");
const screens = await surveyProduct(makeBox(), "https://app.diagrams.net/", 6);

check("records ONE screen, not one per open menu", screens.length === 1, `got ${screens.length}: ${screens.map((s) => s.title).join(", ")}`);

const controls = screens[0]?.controls ?? [];
check(
  "keeps the permanent menu bar",
  MENU_BAR.every((m) => controls.some((c) => c.includes(`"${m.name}"`))),
  controls.join(" | "),
);
check(
  "merges revealed menu items into the parent screen",
  Object.values(MENU_ITEMS).flat().every((item) => controls.some((c) => c.includes(`"${item}"`))),
  `missing from: ${controls.join(" | ")}`,
);
check("records a runtime fingerprint", !!screens[0]?.runtimeFingerprint);

/*
 * The case ARIA missed, taken from the real draw.io run.
 *
 * The shape sidebar is plain <a> elements in <div>s — no role="menu", no
 * aria-expanded — and clicking a section SWAPS the palette rather than layering
 * on top. So nothing is flagged `overlay`, the base control set genuinely
 * changes, and identity-by-hash minted a new screen every time. Six screens,
 * one editor. Overlap is what catches it.
 */
const SIDEBAR = ["General", "Misc", "Advanced", "Basic", "Arrows"].map((n) => el("link", n));
const CHROME = ["File", "Edit", "View", "Help", "Share", "Scratchpad", "Grid", "Zoom"].map((n) => el("link", n));
const PALETTE: Record<string, string[]> = {
  General: ["Rectangle", "Ellipse", "Diamond"],
  Misc: ["Cube", "Cylinder", "Cloud"],
  Advanced: ["Swimlane", "Table", "Tree"],
  Basic: ["Square", "Circle", "Triangle"],
  Arrows: ["Arrow Left", "Arrow Right", "Bidirectional"],
};

function makeAccordionBox() {
  let section = "General";
  return {
    startUrl: "https://app.diagrams.net/",
    async goto() {}, async gotoStart() { section = "General"; }, async loginIfNeeded() { return false; },
    async clickByRole(_r: string, name: string) { if (PALETTE[name]) section = name; return "ok"; },
    async snapshot() {
      // NOTE: no `overlay` flag anywhere — that is the point of this case.
      return {
        url: "https://app.diagrams.net/", title: "Untitled Diagram - draw.io",
        elements: [...CHROME, ...SIDEBAR, ...PALETTE[section].map((n) => el("link", n))],
        text: `draw.io ${section} ${PALETTE[section].join(" ")}`, screenshot: "",
      };
    },
  } as unknown as LiveBox;
}

console.log("\nsurvey — one editor whose sidebar swaps the shape palette (no ARIA overlay markers)");
const accordion = await surveyProduct(makeAccordionBox(), "https://app.diagrams.net/", 6);
check(
  "swapping a side panel does not mint a new screen",
  accordion.length === 1,
  `got ${accordion.length} screens, reachedBy: ${accordion.map((s) => JSON.stringify(s.reachedBy)).join(" ")}`,
);
check(
  "absorbs shapes revealed by other sections",
  ["Cube", "Swimlane", "Square"].some((shape) => (accordion[0]?.controls ?? []).some((c) => c.includes(`"${shape}"`))),
  (accordion[0]?.controls ?? []).join(" | "),
);

/* Same URL/title is not enough: two substantive views with only shared chrome
 * must remain separate. This protects the overlap fix from over-collapsing SPAs. */
function makeDistinctStateBox() {
  let state: "overview" | "audit" = "overview";
  const common = ["Switch view", "Home", "Help", "Account"].map((n) => el("link", n));
  const unique = {
    overview: ["Revenue", "Pipeline", "Forecast", "Targets", "Leads", "Deals"],
    audit: ["Events", "Actors", "IP Address", "Exports", "Retention", "Alerts"],
  };
  return {
    startUrl: "https://app.example.test/workspace",
    async goto() { state = "overview"; }, async gotoStart() { state = "overview"; }, async loginIfNeeded() { return false; },
    async clickByRole(_r: string, name: string) { if (name === "Switch view") state = "audit"; return "ok"; },
    async snapshot() {
      return {
        url: "https://app.example.test/workspace", title: "Workspace",
        elements: [...common, ...unique[state].map((n) => el("button", n))],
        text: `${state} ${unique[state].join(" ")}`, screenshot: "",
      };
    },
  } as unknown as LiveBox;
}

console.log("\nsurvey — distinct views sharing only global chrome");
const distinct = await surveyProduct(makeDistinctStateBox(), "https://app.example.test/workspace", 4);
check("does not merge genuinely different same-address views", distinct.length === 2, `got ${distinct.length}`);

console.log(`\n${failed ? "❌" : "✅"} ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
