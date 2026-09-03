import { WebSocket } from "ws";
/** Does it still open turns with canned filler? Includes a correction and a statement. */
const SHARE = process.argv[2];
const TURNS = [
  "What are my usage numbers right now?",
  "That's wrong, those numbers look off to me.",
  "I already know about the dashboard.",
  "Which model costs the most?",
];
/*
 * Filler = a standalone acknowledgement, i.e. the word followed by punctuation
 * or nothing. "Right now, you've made 8,751 requests" is an ANSWER, not filler,
 * and an earlier version of this pattern flagged it — a test that cries wolf on
 * correct output is worse than no test.
 */
const FILLER = /^\s*(sure|of course|certainly|absolutely|great question|good question|happy to help|let me take a look|right|okay|ok)\s*[.,!?]/i;
const res = await fetch(`http://localhost:8787/api/session?share=${SHARE}`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ product: process.env.PRODUCT ?? "llm-api", mode: "voice" }),
});
const s: any = await res.json();
const ws = new WebSocket(`ws://localhost:8787/ws?sessionId=${s.sessionId}&share=${SHARE}`);
const lines: string[] = [];
ws.on("message", (r) => {
  try { const m = JSON.parse(r.toString());
    if (m.type === "say") lines.push(m.text);
    if (m.type === "audio") ws.send(JSON.stringify({ type: "audio_played", seq: m.seq }));
  } catch {}
});
await new Promise<void>((r) => ws.on("open", () => r()));
await new Promise((r) => setTimeout(r, 9000));
let bad = 0;
for (const q of TURNS) {
  const n = lines.length;
  ws.send(JSON.stringify({ type: "user_message", text: q, viaVoice: true }));
  await new Promise((r) => setTimeout(r, 34000));
  const first = lines[n] ?? "(nothing)";
  const isFiller = FILLER.test(first);
  if (isFiller) bad++;
  console.log(`  ${isFiller ? "✗" : "✓"} "${q.slice(0, 34)}…" → ${JSON.stringify(first.slice(0, 60))}`);
}
ws.close();
console.log(`\n${bad ? `❌ ${bad} turn(s) opened with filler` : "✅ no canned filler openers"}`);
process.exit(bad ? 1 : 0);
