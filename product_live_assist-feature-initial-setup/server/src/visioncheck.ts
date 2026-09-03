/**
 * What does the agent actually RECEIVE about a data-heavy screen?
 *
 * Compares the interactive-element list it is given against the text a human
 * reads on the page. Any number present on screen but absent from the list is a
 * number the agent can only guess at when vision is switched off.
 */
import { getProduct } from "./products.js";
import { LiveBox } from "./livebox.js";

const rec = (await getProduct(process.argv[2] ?? "dolibarr"))!;
const box = new LiveBox({ startUrl: rec.startUrl, auth: rec.auth, allowActions: [] });
await box.start();
const snap = await box.snapshot(false);

const listed = snap.elements
  .map((e: any) => `${e.text || ""} ${e.placeholder || ""} ${e.value || ""}`)
  .join(" ") + " " + (snap.text || "");
const visible: string = await (box as any).page.evaluate(() => document.body.innerText);

const nums = (s: string) => new Set((s.match(/\b\d[\d,.]*\b/g) || []).filter((n) => n.length > 0));
const onScreen = nums(visible);
const inList = nums(listed);
const missing = [...onScreen].filter((n) => !inList.has(n));

console.log(`  numbers a human can read on screen : ${onScreen.size}`);
console.log(`  numbers in the agent's element list: ${inList.size}`);
console.log(`  INVISIBLE to the agent without vision: ${missing.length}`);
console.log(`  examples: ${missing.slice(0, 12).join(", ")}`);
await box.stop();
process.exit(0);
