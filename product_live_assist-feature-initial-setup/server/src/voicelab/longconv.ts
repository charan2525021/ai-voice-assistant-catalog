import { WebSocket } from "ws";
/** Does TTS keep working across a LONG conversation, or fall back to text only? */
const SHARE = process.argv[2];
const PRODUCT = process.env.PRODUCT ?? "llm-api";
const QUESTIONS = [
  "What are my usage numbers right now?",
  "Which model is costing me the most?",
  "How many requests has LiveAssist made?",
  "What is my total spend so far?",
  "Which provider am I using most?",
  "How many tokens have I used in total?",
];
const res = await fetch(`http://localhost:8787/api/session?share=${SHARE}`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ product: PRODUCT, mode: "voice" }),
});
const s: any = await res.json();
if (!res.ok || !s.sessionId) { console.log(`❌ session refused ${res.status}`); process.exit(2); }
const ws = new WebSocket(`ws://localhost:8787/ws?sessionId=${s.sessionId}&share=${SHARE}`);
let says = 0, clips = 0, bytes = 0;
ws.on("message", (r) => {
  try {
    const m = JSON.parse(r.toString());
    if (m.type === "say") says++;
    if (m.type === "audio") { clips++; bytes += Buffer.from(m.b64, "base64").length; ws.send(JSON.stringify({ type: "audio_played", seq: m.seq })); }
    if (m.type === "error") console.log(`   ERROR: ${String(m.text).slice(0, 120)}`);
  } catch {}
});
await new Promise<void>((r) => ws.on("open", () => r()));
await new Promise((r) => setTimeout(r, 9000));

const rows: string[] = [];
for (const [i, q] of QUESTIONS.entries()) {
  const s0 = says, c0 = clips, b0 = bytes;
  ws.send(JSON.stringify({ type: "user_message", text: q, viaVoice: true }));
  await new Promise((r) => setTimeout(r, 38000));
  const gotSay = says - s0, gotClips = clips - c0, gotKb = Math.round((bytes - b0) / 1024);
  const mark = gotClips > 0 ? "✓ audio" : (gotSay > 0 ? "✗ TEXT ONLY" : "✗ nothing");
  rows.push(`  turn ${i + 1}: ${String(gotSay).padStart(2)} lines, ${String(gotClips).padStart(2)} clips, ${String(gotKb).padStart(4)}KB  ${mark}`);
  console.log(rows[rows.length - 1]);
}
ws.close();
const silent = rows.filter((r) => r.includes("TEXT ONLY")).length;
console.log(`\n  ${QUESTIONS.length - silent}/${QUESTIONS.length} turns had audio`);
console.log(silent ? "❌ TTS DROPPED OUT mid-conversation" : "✅ TTS held up all the way");
process.exit(silent ? 1 : 0);
