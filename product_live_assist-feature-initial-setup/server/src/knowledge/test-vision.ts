import { LiveBox } from "../livebox.js";
import { makeBrain, type NMessage } from "../brain.js";
import { config } from "../config.js";

/**
 * Honest vision test: does the model actually READ THE PIXELS?
 * We deliberately send ONLY the screenshot — no DOM element list, no URL —
 * so it cannot cheat using text we hand it.
 */
const box = new LiveBox();
await box.start();

// Put the product into a distinctive state the model must SEE (not guess).
const s0 = await box.snapshot();
const input = s0.elements.find((e) => e.tag === "input");
if (input) {
  await box.typeText(input.id, "Renew the office lease", true);
  await box.typeText(input.id, "Ship Q3 report", true);
}
const snap = await box.snapshot();

const model = makeBrain();
console.log(`Model: ${model.label}`);
console.log(`Screenshot: ${Math.round((snap.screenshot.length * 3) / 4 / 1024)} KB\n`);

async function ask(label: string, question: string, withImage: boolean) {
  const blocks: any[] = [{ type: "text", text: question }];
  if (withImage) blocks.push({ type: "image", b64png: snap.screenshot });
  const messages: NMessage[] = [{ role: "user", blocks }];
  const res = await model.step(
    "You are looking at a screenshot of a web app. Answer ONLY from what is visibly in the image. If you cannot see an image, say exactly: NO IMAGE RECEIVED.",
    messages,
    [],
  );
  console.log(`── ${label}\n   ${res.texts.join(" ").slice(0, 400)}\n`);
}

// Test A: can it read text that exists ONLY in the pixels?
await ask("A. Reads pixels (no DOM given)", "List every task item you can see in this app, word for word. Then state the exact count remaining shown at the bottom.", true);

// Test B: control — same question, no image. Proves it isn't guessing from priors.
await ask("B. CONTROL — no image sent", "List every task item you can see in this app, word for word.", false);

// Test C: spatial/visual reasoning the DOM alone wouldn't give.
await ask("C. Spatial reasoning", "Describe the visual layout: where on the screen is the text input, and what is directly below it? Are any items visually struck through or greyed out?", true);

await box.stop();
process.exit(0);
