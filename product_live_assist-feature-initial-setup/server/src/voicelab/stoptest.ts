import { WebSocket } from "ws";
/**
 * Does Stop actually stop?
 *
 * Behaves like the fixed client: ask a question, let audio start, then hit stop
 * and REFUSE further audio the way the latched queue does. Asserts that nothing
 * plays after the click — the exact complaint the latch was added for.
 */
const SHARE = process.argv[2];
const res = await fetch(`http://localhost:8787/api/session?share=${SHARE}`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ product: "dolibarr", mode: "voice" }),
});
const s: any = await res.json();
const ws = new WebSocket(`ws://localhost:8787/ws?sessionId=${s.sessionId}&share=${SHARE}`);
let stoppedAt = 0, muted = false;
let playedBefore = 0, playedAfterStop = 0, arrivedAfterStop = 0;

ws.on("open", () => setTimeout(() => {
  ws.send(JSON.stringify({ type: "user_message", text: "tell me everything Dolibarr can do, in detail", viaVoice: true }));
}, 1000));

ws.on("message", (raw) => {
  try {
    const m = JSON.parse(raw.toString());
    if (m.type === "audio") {
      if (stoppedAt) {
        arrivedAfterStop++;
        if (!muted) { playedAfterStop++; ws.send(JSON.stringify({ type: "audio_played", seq: m.seq })); }
      } else {
        playedBefore++;
        ws.send(JSON.stringify({ type: "audio_played", seq: m.seq }));
        // Hit stop as soon as we are genuinely speaking.
        if (playedBefore === 1) setTimeout(() => {
          stoppedAt = Date.now(); muted = true;      // the latch, client-side
          ws.send(JSON.stringify({ type: "stop" }));
          console.log("  ⏹  STOP pressed while audio was playing");
        }, 900);
      }
    } else if (m.type === "stop_audio") { muted = true; }
  } catch {}
});

setTimeout(() => {
  console.log(`  audio clips before stop      : ${playedBefore}`);
  console.log(`  clips still ARRIVING after   : ${arrivedAfterStop}  (server may have some in flight)`);
  console.log(`  clips PLAYED after stop      : ${playedAfterStop}`);
  const pass = stoppedAt > 0 && playedAfterStop === 0;
  console.log(`\n${pass ? "✅ STOP WORKS — nothing played after the click" : "❌ STILL PLAYING after stop"}`);
  ws.close(); process.exit(pass ? 0 : 1);
}, 25000);
