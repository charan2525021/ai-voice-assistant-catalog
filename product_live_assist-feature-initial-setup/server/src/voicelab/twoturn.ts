import { WebSocket } from "ws";
/** Does the AGENT answer a second question on the same session? */
const SHARE = process.argv[2];
const PRODUCT = process.env.PRODUCT ?? "llm-api";
const res = await fetch(`http://localhost:8787/api/session?share=${SHARE}`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ product: PRODUCT, mode: "voice" }),
});
const s: any = await res.json();
if (!res.ok || !s.sessionId) { console.log(`❌ session refused: ${res.status}`); process.exit(2); }
const ws = new WebSocket(`ws://localhost:8787/ws?sessionId=${s.sessionId}&share=${SHARE}`);
const said: string[] = [];
let audio = 0;
ws.on("message", (r) => {
  try {
    const m = JSON.parse(r.toString());
    if (m.type === "say") { said.push(m.text); console.log(`   say: ${JSON.stringify(String(m.text).slice(0, 70))}`); }
    if (m.type === "audio") { audio++; ws.send(JSON.stringify({ type: "audio_played", seq: m.seq })); }
    if (m.type === "error") console.log(`   ERROR: ${m.text}`);
    if (m.type === "status") console.log(`   status: ${m.text}`);
  } catch {}
});
await new Promise<void>((r) => ws.on("open", () => r()));
await new Promise((r) => setTimeout(r, 9000));           // greeting
const afterGreeting = said.length;

console.log("\n--- turn 1 ---");
ws.send(JSON.stringify({ type: "user_message", text: "What are my usage numbers right now?", viaVoice: true }));
await new Promise((r) => setTimeout(r, 35000));
const afterOne = said.length;
console.log(`   (${afterOne - afterGreeting} lines)`);

console.log("\n--- turn 2 ---");
ws.send(JSON.stringify({ type: "user_message", text: "And which model is costing me the most?", viaVoice: true }));
await new Promise((r) => setTimeout(r, 40000));
const afterTwo = said.length;
console.log(`   (${afterTwo - afterOne} lines)`);

ws.close();
console.log(`\n  turn 1 replied: ${afterOne > afterGreeting ? "✓" : "✗"}`);
console.log(`  turn 2 replied: ${afterTwo > afterOne ? "✓" : "✗"}`);
console.log(afterTwo > afterOne ? "\n✅ agent answers both" : "\n❌ AGENT STOPS AFTER ONE TURN");
process.exit(afterTwo > afterOne ? 0 : 1);
