import { WebSocket } from "ws";
/**
 * Can it answer about what is ON SCREEN, right now?
 *
 * The failure this guards against: asked about a dashboard, the agent answered
 * from nothing and invented figures, then did arithmetic on them. So we ask
 * about live screen content and require that the numbers it says are numbers
 * that are actually there.
 */
const SHARE = process.argv[2];
const PRODUCT = process.env.PRODUCT ?? "dolibarr";
const QUESTION = process.argv[3] ?? "Looking at the screen right now, how many open items or records can you see? Give me the actual numbers.";
const res = await fetch(`http://localhost:8787/api/session?share=${SHARE}`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ product: PRODUCT, mode: "text" }),
});
const s: any = await res.json();
if (!res.ok || !s.sessionId) { console.log(`\n  ❌ session failed: HTTP ${res.status} ${JSON.stringify(s).slice(0, 160)}`); process.exit(1); }
const ws = new WebSocket(`ws://localhost:8787/ws?sessionId=${s.sessionId}&share=${SHARE}`);
const said: string[] = [];
const tools: string[] = [];
ws.on("message", (raw) => {
  try {
    const m = JSON.parse(raw.toString());
    if (m.type === "say" || m.type === "agent") said.push(m.text || "");
    if (m.type === "demo.action" || m.tool) tools.push(m.tool || m.data?.tool || "");
    if (m.type === "action") tools.push(m.data?.tool || m.tool || "");
  } catch {}
});
await new Promise<void>((r) => ws.on("open", () => r()));
// Let the greeting land and settle first, so we measure the ANSWER, not the hello.
await new Promise((r) => setTimeout(r, 8000));
const greetingCount = said.length;
ws.send(JSON.stringify({ type: "user_message", text: QUESTION }));
// Wait for a reply rather than a fixed guess; a slow turn is not a failed one.
const deadline = Date.now() + 90000;
while (Date.now() < deadline && said.length === greetingCount) await new Promise((r) => setTimeout(r, 500));
await new Promise((r) => setTimeout(r, 12000)); // let the rest of the turn stream
ws.close();
const answer = said.slice(greetingCount).join(" ");
if (!answer.trim()) { console.log("\n  ❌ NO ANSWER within 90s"); process.exit(1); }
console.log(`\n  ANSWER: ${answer.slice(0, 300)}`);
console.log(`  tools seen: ${[...new Set(tools.filter(Boolean))].join(", ") || "(none captured)"}`);
const blind = /can'?t (see|read|verify)|unable to (see|read|verify)|cannot (see|read|verify)|no visibility/i.test(answer);
console.log(`\n  claims blindness : ${blind ? "❌ YES" : "✓ no"}`);
process.exit(blind ? 1 : 0);
