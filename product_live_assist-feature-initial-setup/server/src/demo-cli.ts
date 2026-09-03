import { config } from "./config.js";
import { getProduct } from "./products.js";
import {
  startDemonstration, recordClick, recordKey, recordNavigate, demonstrationStatus,
  demonstrationProofOptions, finishDemonstration, cancelDemonstration,
} from "./demonstrate.js";
import { flushEvents } from "./events.js";

/**
 * Drive a demonstration headlessly, so M2 is testable without a human at a
 * browser. A script here plays the part of the person: it clicks by ROLE+NAME
 * (resolved to coordinates) rather than by guessed pixels — guessing coordinates
 * silently hits <body> and invalidates the whole test.
 *
 *   npm run demo:record -- --id <product> --goal "..." --steps 'click:button:Add,fill:textbox:First Name=Ava'
 */
const arg = (k: string, d = "") => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const id = arg("id", config.product);
const rec = await getProduct(id);
if (!rec) { console.error(`no such product: ${id}`); await flushEvents(); process.exit(1); }

const { demoId, url } = await startDemonstration(rec);
console.log(`recording ${demoId} — opened ${url}`);

const s = (await import("./demonstrate.js")).getDemoSession(demoId)!;

/**
 * Click a control by role+name, using its MEASURED box centre.
 *
 * Polls for the control instead of assuming it is already there. A real person
 * waits for the screen before clicking; a script does not, and clicking into an
 * unrendered SPA silently hits nothing. That is not a hypothetical: the first
 * run of this harness missed "First Name" on a freshly navigated OrangeHRM form,
 * left the field empty, and produced a demonstration that failed validation —
 * which the proof gate then correctly refused to certify.
 */
async function clickByName(role: string, name: string, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snap = await s.box.snapshot();
    const el = snap.elements.find(
      (e) => (e.role === role || e.tag === role) && (e.name === name || e.placeholder === name || e.text === name),
    );
    if (el) {
      const box = await s.box.boxOfElement(el.id);
      if (box) {
        const r = await recordClick(demoId, box.cx, box.cy);
        console.log(`   click ${role} "${name}" → ${r.label}`);
        return true;
      }
    }
    if (Date.now() > deadline) {
      console.log(`   ! no measurable ${role} "${name}" after ${timeoutMs}ms`);
      return false;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

for (const raw of arg("steps").split(",").map((x) => x.trim()).filter(Boolean)) {
  const kind = raw.split(":")[0];
  const [, role, rest] = raw.split(":");
  if (kind === "click") {
    await clickByName(role, rest);
  } else if (kind === "fill") {
    const [name, value] = (rest ?? "").split("=");
    if (await clickByName(role, name)) {
      for (const ch of value ?? "") await recordKey(demoId, ch, ch);
      console.log(`   typed "${value}" into ${role} "${name}"`);
    }
  } else if (kind === "enter") {
    await recordKey(demoId, "Enter", "");
    console.log("   pressed Enter");
  } else if (kind === "nav") {
    const url = raw.slice(4); // the URL contains ":" so take the remainder whole
    await recordNavigate(demoId, url);
    console.log(`   navigated to ${url}`);
  }
}

console.log("\ncaptured:", JSON.stringify(await demonstrationStatus(demoId), null, 2));
console.log("\nproof options:", await demonstrationProofOptions(demoId));

const goal = arg("goal", "Demonstrated journey");
console.log(`\nfinishing as "${goal}" (verifying from a clean state)…`);
const out = await finishDemonstration(demoId, { goal, publish: arg("publish", "yes") !== "no" });
console.log(`${out.ok ? "✓" : "✗"} ${out.detail}`);
if (out.proof) console.log(`  proof: "${out.proof}"`);
if (!out.ok && out.candidates?.length) console.log(`  candidates: ${out.candidates.slice(0, 5).join(" | ")}`);
await cancelDemonstration(demoId);
await flushEvents();
process.exit(out.ok ? 0 : 1);
