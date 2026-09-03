import { WebSocket } from "ws";
const SHARE = process.argv[2];
const res = await fetch(`http://localhost:${process.env.APP_PORT ?? 8787}/api/session?share=${SHARE}`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ product: "dolibarr", mode: "voice" }),
});
const s: any = await res.json();
const ws = new WebSocket(`ws://localhost:${process.env.APP_PORT ?? 8787}/ws?sessionId=${s.sessionId}&share=${SHARE}`);
let asked = 0;
const ev: string[] = [];
ws.on("open", () => setTimeout(() => {
  asked = Date.now();
  ws.send(JSON.stringify({ type: "user_message", text: "what can this product do for a services business?", viaVoice: true }));
}, 1500));
ws.on("message", (raw) => {
  try {
    const m = JSON.parse(raw.toString());
    if (!asked) return;
    const dt = Date.now() - asked;
    if (m.type === "audio") { ev.push(`  +${dt}ms  AUDIO seq${m.seq} (${Math.round(String(m.b64||"").length*0.75/1024)}KB)`); ws.send(JSON.stringify({ type: "audio_played", seq: m.seq })); }
    else if (m.type === "say") ev.push(`  +${dt}ms  SAY "${String(m.text).slice(0,55)}"`);
  } catch {}
});
setTimeout(() => { console.log(ev.slice(0, 12).join("\n")); ws.close(); process.exit(0); }, 30000);
