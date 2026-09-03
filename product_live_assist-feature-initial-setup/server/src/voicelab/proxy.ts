import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

/**
 * VOICELAB — a throwaway diagnostic for the STT→LLM→TTS loop.
 *
 * TEMPORARY. Delete this directory and restore two ports when the voice work is
 * done; nothing in the product imports it, and it changes no product file.
 *
 * It answers four questions, in the words they get reported in:
 *   "it lagged before answering"   → where the seconds went, hop by hop
 *   "it broke up / stuttered"      → playback starved, and for how long
 *   "it talked over me"            → barge-in latency and overlap
 *   "it cut off mid-sentence"      → audio sent but never played
 *
 * HOW IT ATTACHES — and why this way. Everything needed already crosses the
 * wire: the client acknowledges every audio chunk it PLAYS, and the STT socket
 * carries speech onset, partials and finals. So this sits BETWEEN browser and
 * server as a plain proxy and derives all four from traffic it merely observes.
 * No client events were added, no product code touched — which is what stops it
 * becoming something you have to unpick later.
 *
 *   browser ──▶ :8787 (voicelab) ──▶ :8788 (real app)
 *   browser ──▶ :8089 (voicelab) ──▶ :8090 (real STT)
 *
 * The client is unchanged because voicelab occupies the ports it already dials.
 *
 * THE ONE MEASUREMENT THAT MATTERS: first audio PLAYED, never first audio sent.
 * This codebase learned that the hard way — barge-in was a no-op for weeks
 * because the server treated "finished emitting" as "finished speaking" while
 * the client still had ~40s queued. Latency here is mouth-to-ear.
 */

const LISTEN_APP = Number(process.env.VOICELAB_APP_PORT ?? 8787);
const LISTEN_STT = Number(process.env.VOICELAB_STT_PORT ?? 8089);
const UP_APP = Number(process.env.VOICELAB_UPSTREAM_APP ?? 8788);
const UP_STT = Number(process.env.VOICELAB_UPSTREAM_STT ?? 8090);
const OUT_DIR = fileURLToPath(new URL("../../data/voicelab", import.meta.url));

const t0 = Date.now();
const rel = (ms = Date.now()) => ((ms - t0) / 1000).toFixed(2).padStart(7);
const c = {
  you: "\x1b[36m", srv: "\x1b[35m", cli: "\x1b[32m",
  warn: "\x1b[33m", bad: "\x1b[31m", dim: "\x1b[90m", off: "\x1b[0m",
};

interface AudioChunk {
  seq: number;
  bytes: number;
  durationMs: number;
  sentAt: number;
  playedAt?: number;
  text?: string;
  file?: string;
}

interface Finding {
  kind: "lag" | "gap" | "overlap" | "truncated";
  detail: string;
  ms?: number;
  at: number;
}

/** One conversation's worth of derived state. */
class Session {
  readonly startedAt = Date.now();
  speechOnsetAt: number | null = null;
  lastPartialAt: number | null = null;
  finalAt: number | null = null;
  finalText = "";
  turnFirstSayAt: number | null = null;
  chunks = new Map<number, AudioChunk>();
  lastPlayedAt: number | null = null;
  stopAudioAt: number | null = null;
  bargeInAt: number | null = null;
  findings: Finding[] = [];
  transcripts: { at: number; who: "you" | "aidan"; text: string }[] = [];

  note(f: Omit<Finding, "at">) {
    const finding = { ...f, at: Date.now() };
    this.findings.push(finding);
    const colour = f.kind === "lag" ? c.warn : c.bad;
    console.log(`${rel()}  ${colour}⚠ ${f.kind.toUpperCase()}${c.off}  ${f.detail}`);
  }

  /** Reset the per-turn timers once a turn has been accounted for. */
  endTurn() {
    this.speechOnsetAt = null;
    this.lastPartialAt = null;
    this.finalAt = null;
    this.turnFirstSayAt = null;
  }
}

const session = new Session();

/**
 * Real duration of an audio chunk.
 *
 * Needed to tell a GAP from ordinary pacing: if the next chunk's play-ack
 * arrives later than the previous chunk's own length, playback ran dry. WAV is
 * exact from its header; MP3 is estimated from a nominal bitrate, which is
 * coarse but only ever used as a threshold.
 */
function durationMs(buf: Buffer, mime: string): number {
  if (/wav/i.test(mime) && buf.length > 44 && buf.toString("ascii", 0, 4) === "RIFF") {
    const sampleRate = buf.readUInt32LE(24);
    const channels = buf.readUInt16LE(22);
    const bits = buf.readUInt16LE(34);
    const bytesPerSec = sampleRate * channels * (bits / 8);
    if (bytesPerSec > 0) return Math.round(((buf.length - 44) / bytesPerSec) * 1000);
  }
  // ~32 kB/s at a typical 24 kHz mono MP3.
  return Math.round((buf.length / 32000) * 1000);
}

// ============================ observation ============================

function onServerToClient(raw: string) {
  let m: any;
  try { m = JSON.parse(raw); } catch { return; }

  switch (m.type) {
    case "frame": return; // video, high volume, irrelevant here

    case "speech_start":
      session.speechOnsetAt = Date.now();
      console.log(`${rel()}  ${c.you}YOU ▶ speech onset${c.off}`);
      return;

    case "partial":
      session.lastPartialAt = Date.now();
      if (m.text) console.log(`${rel()}  ${c.dim}YOU … "${String(m.text).slice(0, 60)}"${c.off}`);
      return;

    case "transcript": {
      session.finalAt = Date.now();
      session.finalText = String(m.text ?? "");
      session.transcripts.push({ at: Date.now(), who: "you", text: session.finalText });
      const heard = session.speechOnsetAt ? `  ${c.dim}(+${Date.now() - session.speechOnsetAt}ms to transcribe)${c.off}` : "";
      console.log(`${rel()}  ${c.you}YOU ✓ "${session.finalText}"${c.off}${heard}`);
      return;
    }

    case "say": {
      const text = String(m.text ?? "");
      if (session.turnFirstSayAt === null) {
        session.turnFirstSayAt = Date.now();
        if (session.finalAt) {
          const think = session.turnFirstSayAt - session.finalAt;
          console.log(`${rel()}  ${c.srv}SRV first words${c.off}  ${c.dim}(+${think}ms thinking)${c.off}`);
          if (think > 3000) session.note({ kind: "lag", ms: think, detail: `${think}ms from your words to Aidan's first line` });
        }
      }
      session.transcripts.push({ at: Date.now(), who: "aidan", text });
      console.log(`${rel()}  ${c.srv}AID 🗣 "${text.slice(0, 70)}"${c.off}`);
      return;
    }

    case "audio": {
      const buf = Buffer.from(String(m.b64 ?? ""), "base64");
      const seq = Number(m.seq ?? session.chunks.size);
      const chunk: AudioChunk = { seq, bytes: buf.length, durationMs: durationMs(buf, String(m.mime ?? "")), sentAt: Date.now() };
      session.chunks.set(seq, chunk);
      void saveAudio(seq, buf, String(m.mime ?? "")).then((f) => (chunk.file = f));
      return;
    }

    case "stop_audio":
      session.stopAudioAt = Date.now();
      if (session.bargeInAt) {
        const delta = session.stopAudioAt - session.bargeInAt;
        console.log(`${rel()}  ${c.cli}CLI audio stopped${c.off}  ${c.dim}(${delta}ms after you spoke)${c.off}`);
        if (delta > 500) session.note({ kind: "overlap", ms: delta, detail: `Aidan kept talking ${delta}ms after you started` });
        session.bargeInAt = null;
      }
      return;
  }
}

function onClientToServer(raw: string) {
  let m: any;
  try { m = JSON.parse(raw); } catch { return; }

  if (m.type === "user_speaking") {
    // Client-side VAD fires locally, so this is the truest onset we can see.
    session.bargeInAt = Date.now();
    const speaking = [...session.chunks.values()].some((k) => k.playedAt && Date.now() - k.playedAt < k.durationMs);
    console.log(`${rel()}  ${c.you}YOU ▶ speaking${speaking ? " (while Aidan is talking — barge-in)" : ""}${c.off}`);
    return;
  }

  if (m.type === "audio_played") {
    const seq = Number(m.seq);
    const chunk = session.chunks.get(seq);
    const now = Date.now();
    if (chunk) {
      chunk.playedAt = now;
      // FIRST audio actually heard — the number that defines perceived lag.
      if (session.turnFirstSayAt !== null && !session.chunks.get(seq - 1)?.playedAt) {
        const mouthToEar = session.finalAt ? now - session.finalAt : null;
        if (mouthToEar !== null) {
          console.log(`${rel()}  ${c.cli}CLI ♪ first audio HEARD${c.off}  ${c.dim}(${mouthToEar}ms mouth-to-ear)${c.off}`);
          if (mouthToEar > 4000) session.note({ kind: "lag", ms: mouthToEar, detail: `${mouthToEar}ms before you heard anything` });
        }
      }
      /*
       * GAP: playback starved. The previous chunk's own length tells us when it
       * should have finished; an ack later than that means the queue ran dry and
       * the listener heard silence mid-sentence.
       */
      const prev = session.chunks.get(seq - 1);
      if (prev?.playedAt) {
        const expectedNext = prev.playedAt + prev.durationMs;
        const late = now - expectedNext;
        if (late > 250) session.note({ kind: "gap", ms: late, detail: `${late}ms of silence before chunk ${seq}` });
      }
    }
    session.lastPlayedAt = now;
    return;
  }

  if (m.type === "audio_ended") {
    /*
     * TRUNCATION: everything sent should have been played. A sent-but-never-
     * acked chunk is audio the listener never heard — the sentence stopped
     * early even though the server believed it had spoken.
     */
    const sent = [...session.chunks.values()];
    const unplayed = sent.filter((k) => !k.playedAt);
    if (unplayed.length) {
      const lostMs = unplayed.reduce((a, k) => a + k.durationMs, 0);
      session.note({
        kind: "truncated",
        ms: lostMs,
        detail: `${unplayed.length} chunk(s) never played (~${lostMs}ms of speech): seq ${unplayed.map((u) => u.seq).join(", ")}`,
      });
    }
    console.log(`${rel()}  ${c.cli}CLI ■ playback finished${c.off}`);
    session.endTurn();
    return;
  }
}

async function saveAudio(seq: number, buf: Buffer, mime: string): Promise<string> {
  const dir = path.join(OUT_DIR, "audio");
  await fs.mkdir(dir, { recursive: true });
  const ext = /wav/i.test(mime) ? "wav" : "mp3";
  const file = path.join(dir, `${String(seq).padStart(4, "0")}.${ext}`);
  await fs.writeFile(file, buf).catch(() => {});
  return file;
}

// ============================ proxying ============================

/** Relay one client socket to upstream, observing every text frame. */
function bridge(client: WebSocket, upstreamUrl: string, label: "app" | "stt") {
  const up = new WebSocket(upstreamUrl);
  const queue: (string | Buffer)[] = [];

  up.on("open", () => { for (const q of queue) up.send(q); queue.length = 0; });
  up.on("message", (data, isBinary) => {
    if (!isBinary) {
      const s = data.toString();
      onServerToClient(s);
      // The STT socket carries the same event names; feed both through one path.
      if (label === "stt") { /* already handled above */ }
    }
    if (client.readyState === 1) client.send(data, { binary: isBinary });
  });
  up.on("close", () => client.close());
  up.on("error", (e) => console.log(`${rel()}  ${c.bad}upstream ${label} error: ${e.message}${c.off}`));

  client.on("message", (data, isBinary) => {
    if (!isBinary) onClientToServer(data.toString());
    if (up.readyState === 1) up.send(data, { binary: isBinary });
    else if (up.readyState === 0) queue.push(isBinary ? (data as Buffer) : data.toString());
  });
  client.on("close", () => up.close());
  client.on("error", () => up.close());
}

/** Plain HTTP pass-through so the page, APIs and assets all still work. */
const appServer = http.createServer((req, res) => {
  const proxied = http.request(
    { hostname: "127.0.0.1", port: UP_APP, path: req.url, method: req.method, headers: req.headers },
    (up) => { res.writeHead(up.statusCode ?? 502, up.headers); up.pipe(res); },
  );
  proxied.on("error", () => { res.writeHead(502).end("voicelab: upstream app unreachable"); });
  req.pipe(proxied);
});

const appWss = new WebSocketServer({ noServer: true });
appServer.on("upgrade", (req, socket, head) => {
  appWss.handleUpgrade(req, socket, head, (ws) => bridge(ws, `ws://127.0.0.1:${UP_APP}${req.url}`, "app"));
});

const sttServer = http.createServer((_req, res) => res.writeHead(426).end("websocket only"));
const sttWss = new WebSocketServer({ noServer: true });
sttServer.on("upgrade", (req, socket, head) => {
  sttWss.handleUpgrade(req, socket, head, (ws) => bridge(ws, `ws://127.0.0.1:${UP_STT}${req.url}`, "stt"));
});

// ============================ report ============================

async function writeReport() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `session-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  const chunks = [...session.chunks.values()];
  const report = {
    startedAt: new Date(session.startedAt).toISOString(),
    transcripts: session.transcripts.map((t) => ({ ...t, at: new Date(t.at).toISOString() })),
    audio: { sent: chunks.length, played: chunks.filter((k) => k.playedAt).length, chunks },
    findings: session.findings.map((f) => ({ ...f, at: new Date(f.at).toISOString() })),
  };
  await fs.writeFile(file, JSON.stringify(report, null, 2));

  const byKind = (k: Finding["kind"]) => session.findings.filter((f) => f.kind === k);
  console.log(`\n${c.dim}────────── voicelab summary ──────────${c.off}`);
  console.log(`  turns heard      : ${session.transcripts.filter((t) => t.who === "you").length}`);
  console.log(`  audio chunks     : ${chunks.length} sent, ${chunks.filter((k) => k.playedAt).length} played`);
  console.log(`  lagged answers   : ${byKind("lag").length}`);
  console.log(`  playback gaps    : ${byKind("gap").length}`);
  console.log(`  talked over you  : ${byKind("overlap").length}`);
  console.log(`  cut off          : ${byKind("truncated").length}`);
  console.log(`  report           : ${file}`);
  console.log(`${c.dim}──────────────────────────────────────${c.off}`);
}

let closing = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (closing) return;
    closing = true;
    await writeReport().catch((e) => console.error(e));
    process.exit(0);
  });
}

appServer.listen(LISTEN_APP, () => {
  sttServer.listen(LISTEN_STT, () => {
    console.log(`${c.dim}voicelab listening — app :${LISTEN_APP}→:${UP_APP}, stt :${LISTEN_STT}→:${UP_STT}${c.off}`);
    console.log(`${c.dim}open the demo as usual; Ctrl-C to stop and write the report${c.off}\n`);
  });
});
