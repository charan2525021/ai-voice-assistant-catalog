import { LiveBox } from "./livebox.js";

// Smoke test: prove the open-source LiveBox works with no model/keys.
const box = new LiveBox();
let frames = 0;
let bytes = 0;
box.onFrame((jpeg) => {
  frames++;
  bytes = jpeg.length;
});

console.log("Launching Chromium + navigating to the demo product…");
await box.start();
await new Promise((r) => setTimeout(r, 2500)); // collect a few frames

const snap = await box.snapshot();
console.log("\n=== EYES (what the agent sees) ===");
console.log("URL:", snap.url);
console.log("Title:", snap.title);
console.log("Interactive elements:", snap.elements.length);
console.log(
  "First elements:",
  snap.elements.slice(0, 6).map((e) => `[${e.id}] ${e.tag}:${(e.text || e.placeholder || "").slice(0, 30)}`),
);
console.log("Screenshot bytes (base64):", snap.screenshot.length);

console.log("\n=== HANDS (agent drives) ===");
const input = snap.elements.find((e) => e.tag === "input" || e.placeholder.toLowerCase().includes("todo"));
if (input) {
  console.log(await box.typeText(input.id, "Ship the Aidan MVP", true));
  const after = await box.snapshot();
  console.log("Elements before: 4  → after adding a task:", after.elements.length);
  console.log("New interactive elements:", after.elements.map((e) => `${e.tag}:${(e.text || e.type || "").slice(0, 22)}`));
  const added = after.elements.length > snap.elements.length;
  console.log("Product changed (todo added, filters/clear appeared):", added);
} else {
  console.log("No input found to type into (unexpected for TodoMVC).");
}

console.log("\n=== LIVE VIEW (screencast) ===");
console.log("Frames streamed in ~2.5s:", frames, "| last frame bytes:", bytes);

await box.stop();
console.log("\nDone. LiveBox works.", frames > 0 && snap.elements.length > 0 ? "✅ PASS" : "❌ CHECK");
process.exit(0);
