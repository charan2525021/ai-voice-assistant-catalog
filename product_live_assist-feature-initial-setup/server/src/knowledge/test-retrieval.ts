import { brain } from "./store.js";
await brain.load();
console.log(`docs=${brain.docs.length} flows=${brain.flows.length} (embedded: ${brain.docs.filter(d=>d.embedding?.length).length} docs, ${brain.flows.filter((f:any)=>f.embedding?.length).length} flows)\n`);
const queries: [string,string][] = [
  ["exact wording", "add a product to the shopping cart"],
  ["synonym: chuck it in", "how do I chuck something in my basket"],
  ["synonym: cheapest first", "can I see the cheapest items first"],
  ["paraphrase", "I want to look at what a product actually includes"],
  ["business framing", "how would my team order swag"],
];
for (const [label,q] of queries) {
  const lexFlow = brain.matchFlow(q);
  const semFlow = await brain.matchFlowSemantic(q);
  const semDocs = await brain.searchDocsSemantic(q, 2);
  console.log(`── ${label}: "${q}"`);
  console.log(`   flow  lexical:  ${lexFlow ? "✅ "+lexFlow.name : "❌ none"}`);
  console.log(`   flow  semantic: ${semFlow ? "✅ "+semFlow.name : "❌ none"}`);
  console.log(`   docs  semantic: ${semDocs.length ? semDocs.map(d=>d.chunk.title).join(", ") : "❌ none"}\n`);
}
process.exit(0);
