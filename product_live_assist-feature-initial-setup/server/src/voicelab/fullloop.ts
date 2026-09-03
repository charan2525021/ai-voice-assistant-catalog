import { WebSocket } from "ws";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * THE WHOLE LOOP, with no human in it.
 *
 * Speaks a real question into the STT exactly as a microphone would, waits for
 * the transcript, sends it as the prospect's turn, collects the audio Aidan
 * sends back, and transcribes that audio to check he answered intelligibly.
 * Every stage is asserted, so "the port is open" can never again pass for
 * "voice works".
 */
const SHARE = process.argv[2];
// Without a token every call 401s and the run reports "no audio came back",
// which reads as a product failure when it is really a missing argument.
if (!SHARE) {
  console.error("usage: tsx src/voicelab/fullloop.ts <shareToken>");
  process.exit(2);
}
const PRODUCT = process.env.PRODUCT ?? "dolibarr";
const t0 = Date.now();
const at = () => `+${String(Date.now() - t0).padStart(5)}ms`;
let heardBySTT = "";
let audioBytes = 0;
const clips: Buffer[] = [];

// ---- 1. speak into the STT --------------------------------------------------
const pcm = readFileSync(process.env.ASK_WAV ?? "/tmp/ask.wav").subarray(44);
const stt = new WebSocket("ws://127.0.0.1:8089");
await new Promise<void>((r) => stt.on("open", () => r()));
// Mirror the browser: send this product's vocabulary before any audio, or the
// test measures a recogniser the real client never uses.
try {
  const meta: any = await (await fetch(`http://localhost:8787/api/session?share=${SHARE}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ product: PRODUCT, mode: "voice" }),
  })).json();
  if (meta?.speechHints) stt.send(JSON.stringify({ type: "vocabulary", terms: meta.speechHints }));
} catch {}
stt.on("message", (raw) => {
  try {
    const m = JSON.parse(raw.toString());
    if (m.type === "transcript") { heardBySTT = m.text; console.log(`${at()}  STT FINAL  ${JSON.stringify(m.text)}`); }
  } catch {}
});
let o = 0;
await new Promise<void>((done) => {
  const pump = setInterval(() => {
    if (o >= pcm.length) {
      clearInterval(pump);
      const sil = Buffer.alloc(2048); let n = 0;
      const q = setInterval(() => { stt.readyState === 1 && stt.send(sil); if (++n > 30) { clearInterval(q); done(); } }, 60);
      return;
    }
    stt.send(pcm.subarray(o, o + 2048)); o += 2048;
  }, 60);
});
await new Promise((r) => setTimeout(r, 2500));
stt.close();
if (!heardBySTT) { console.log("\n❌ STT never returned a transcript"); process.exit(1); }

// ---- 2. send it as the prospect's turn --------------------------------------
const res = await fetch(`http://localhost:8787/api/session?share=${SHARE}`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ product: PRODUCT, mode: "voice" }),
});
const s: any = await res.json();
if (!res.ok || !s.sessionId) {
  // A refused session reads as "no audio came back", which looks like a broken
  // product when it is a wrong token or wrong product name.
  console.log(`\n❌ session refused: HTTP ${res.status} ${JSON.stringify(s).slice(0, 160)}`);
  process.exit(2);
}
const ws = new WebSocket(`ws://localhost:8787/ws?sessionId=${s.sessionId}&share=${SHARE}`);
let askedAt = 0, firstAudio = 0;
await new Promise<void>((r) => ws.on("open", () => r()));
ws.on("message", (raw) => {
  try {
    const m = JSON.parse(raw.toString());
    if (m.type === "audio") {
      const b = Buffer.from(m.b64, "base64");
      audioBytes += b.length; clips.push(b);
      if (!firstAudio && askedAt) { firstAudio = Date.now() - askedAt; console.log(`${at()}  FIRST AUDIO  (${firstAudio}ms after asking)`); }
      ws.send(JSON.stringify({ type: "audio_played", seq: m.seq }));
    } else if (m.type === "say" && askedAt) console.log(`${at()}  AIDAN      ${JSON.stringify(String(m.text).slice(0, 62))}`);
  } catch {}
});
await new Promise((r) => setTimeout(r, 1200));
askedAt = Date.now();
console.log(`${at()}  ASKING     ${JSON.stringify(heardBySTT)}`);
ws.send(JSON.stringify({ type: "user_message", text: heardBySTT, viaVoice: true }));
await new Promise((r) => setTimeout(r, 22000));
ws.close();

// ---- 3. did what he said survive being heard? -------------------------------
console.log();
if (!clips.length) { console.log("❌ no audio came back"); process.exit(1); }
writeFileSync("/tmp/reply.wav", clips[clips.length - 1]);
const back = execFileSync("../.venv/bin/python", ["-c", `
import warnings; warnings.filterwarnings("ignore")
import mlx_whisper
print(mlx_whisper.transcribe("/tmp/reply.wav", path_or_hf_repo="mlx-community/whisper-base.en-mlx")["text"].strip())
`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

const ok = { stt: !!heardBySTT, audio: audioBytes > 20000, fast: firstAudio > 0 && firstAudio < 6000, clear: back.split(/\s+/).length >= 4 };
console.log(`  STT heard the question      ${ok.stt ? "✓" : "✗"}  ${JSON.stringify(heardBySTT)}`);
console.log(`  Aidan replied with audio    ${ok.audio ? "✓" : "✗"}  ${(audioBytes/1024).toFixed(0)}KB in ${clips.length} clips`);
console.log(`  First audio was prompt      ${ok.fast ? "✓" : "✗"}  ${firstAudio}ms`);
console.log(`  Reply is intelligible       ${ok.clear ? "✓" : "✗"}  ${JSON.stringify(back.slice(0, 90))}`);
const pass = Object.values(ok).every(Boolean);
console.log(`\n${pass ? "✅ VOICE LOOP WORKS END TO END" : "❌ VOICE LOOP BROKEN"}`);
process.exit(pass ? 0 : 1);
