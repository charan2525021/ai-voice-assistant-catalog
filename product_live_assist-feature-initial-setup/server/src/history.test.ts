import { normalizeToolHistory, pruneNeutralHistory, toOpenAIMessages, type NMessage } from "./brain.js";

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail = "") {
  if (condition) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const malformed: NMessage[] = [
  { role: "assistant", blocks: [{ type: "text", text: "I'll open it." }, { type: "tool_call", id: "call-1", name: "click", args: { id: 4 } }] },
  { role: "user", blocks: [
    { type: "text", text: "Actually, stop." },
    { type: "tool_result", id: "call-1", text: "clicked" },
    { type: "tool_result", id: "orphan", text: "must disappear" },
  ] },
];

console.log("history — interrupted/mixed tool exchange");
const repaired = normalizeToolHistory(malformed);
check("splits a mixed tool result and prospect turn", repaired.length === 3, JSON.stringify(repaired));
check("keeps assistant call first", repaired[0]?.role === "assistant" && repaired[0].blocks.some((b) => b.type === "tool_call"));
check("puts only the matching result second", repaired[1]?.blocks.length === 1 && repaired[1].blocks[0]?.type === "tool_result" && repaired[1].blocks[0].id === "call-1");
check("keeps prospect text after the result", repaired[2]?.blocks[0]?.type === "text" && repaired[2].blocks[0].text === "Actually, stop.");
check("drops orphan results", !JSON.stringify(repaired).includes("orphan"));

const missing = normalizeToolHistory([
  { role: "assistant", blocks: [{ type: "tool_call", id: "lost", name: "navigate", args: {} }] },
  { role: "user", blocks: [{ type: "text", text: "hello?" }] },
]);
check("synthesizes interrupted tool results", missing[1]?.blocks[0]?.type === "tool_result" && missing[1].blocks[0].text.includes("did not complete"));

const wire = toOpenAIMessages(malformed);
check("OpenAI order is assistant, tool, user", wire.map((m) => m.role).join(",") === "assistant,tool,user", JSON.stringify(wire));
check("tool reply references the preceding call", wire[1]?.tool_call_id === "call-1");

const long: NMessage[] = [
  { role: "user", blocks: [{ type: "text", text: "old" }] },
  { role: "assistant", blocks: [{ type: "tool_call", id: "paired", name: "click", args: {} }] },
  { role: "user", blocks: [{ type: "tool_result", id: "paired", text: "ok" }] },
  { role: "assistant", blocks: [{ type: "text", text: "done" }] },
];
const pruned = pruneNeutralHistory(long, 3);
check("pruning preserves an atomic call/result pair", pruned.length === 3 && pruned[0]?.role === "assistant" && pruned[1]?.blocks[0]?.type === "tool_result");

console.log(`\n${failed ? "❌" : "✅"} ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
