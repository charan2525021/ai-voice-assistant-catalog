import { brain } from "./store.js";
import { retrieveContext } from "./retrieve.js";
import { SessionMemory } from "./memory.js";
import { config } from "../config.js";

// Proves the Brain retrieves product-correct grounding for whatever PRODUCT is set.
await brain.load();
console.log(`PRODUCT=${config.product} | docs=${brain.docs.length} flows=${brain.flows.length} playbook=${brain.playbook.length} personas=${brain.personas.length}\n`);

const turns = process.argv.slice(2);
const memory = new SessionMemory();

for (const turn of turns) {
  const { packet, system } = await retrieveContext(turn, memory, brain);
  console.log(`──── "${turn}"`);
  console.log(`  intent:    ${packet.intent}`);
  console.log(`  persona:   ${packet.persona?.name ?? "(none yet)"}`);
  console.log(`  flow:      ${packet.flow ? `${packet.flow.name} → [${packet.flow.steps.length} steps]` : "(none)"}`);
  console.log(`  facts:     ${packet.facts.length ? packet.facts.map((f: any) => `"${f.chunk.text.slice(0, 60)}…"`).join(" | ") : "(none — will refuse to invent)"}`);
  console.log(`  valueProps:${packet.valueProps.length ? " " + packet.valueProps.map((v: any) => v.content.slice(0, 50) + "…").join(" | ") : " (none)"}`);
  if (packet.objection) console.log(`  objection: ${packet.objection.content.slice(0, 70)}…`);
  if (packet.discovery) console.log(`  discovery: ${packet.discovery.content.slice(0, 70)}…`);
  console.log(`  grounded prompt: ${system.length} chars\n`);
}
process.exit(0);
