import "dotenv/config";
import { readFile } from "node:fs/promises";
import WebSocket from "ws";
import { SDK_PROTOCOL_VERSION } from "@sable/sdk-contracts";
import { SarvamTextToSpeechProvider } from "@sable/speech-core";

const turns = Math.max(1, Math.min(100, Number(process.argv[2] ?? 25)));
const apiBase = (process.env.PUBLIC_API_URL ?? "http://localhost:8787").replace(/\/$/, "");
const origin = process.env.SAMPLE_APP_ORIGIN ?? "http://localhost:4173";
const secrets = JSON.parse(await readFile("data/sample-secrets.generated.json", "utf8")) as { installationId: string; installationCredential: string };

const tts = new SarvamTextToSpeechProvider({
  apiKey: process.env.SARVAM_API_KEY ?? "",
  model: process.env.SARVAM_TTS_MODEL ?? "bulbul:v3",
  defaultSpeaker: process.env.VOICE_SPEAKER ?? "shubh",
  defaultLanguage: process.env.VOICE_LANGUAGE_CODE ?? "en-IN",
  maxChars: 450,
  timeoutMs: 8_000,
  retryCount: 2,
});

function wavPcm16(bytes: Buffer): { samples: Float32Array; sampleRate: number } {
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") throw new Error("Sarvam TTS did not return a WAV file");
  let offset = 12;
  let format: { encoding: number; channels: number; sampleRate: number; bits: number } | undefined;
  let data: Buffer | undefined;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt ") format = { encoding: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2), sampleRate: bytes.readUInt32LE(start + 4), bits: bytes.readUInt16LE(start + 14) };
    if (id === "data") { data = bytes.subarray(start, start + size); break; }
    offset = start + size + (size % 2);
  }
  if (!format || !data || format.encoding !== 1 || format.bits !== 16) throw new Error("Sarvam TTS WAV must be PCM16");
  const frameCount = Math.floor(data.length / (2 * format.channels));
  const samples = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame++) samples[frame] = data.readInt16LE(frame * format.channels * 2) / 32_768;
  return { samples, sampleRate: format.sampleRate };
}

function resamplePcm16(input: Float32Array, inputRate: number): Buffer {
  const ratio = inputRate / 16_000;
  const output = Buffer.alloc(Math.max(1, Math.floor(input.length / ratio)) * 2);
  for (let index = 0; index < output.length / 2; index++) {
    const start = Math.floor(index * ratio);
    const end = Math.max(start + 1, Math.min(input.length, Math.floor((index + 1) * ratio)));
    let sum = 0;
    for (let cursor = start; cursor < end; cursor++) sum += input[cursor];
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    output.writeInt16LE(Math.round(sample < 0 ? sample * 32_768 : sample * 32_767), index * 2);
  }
  return output;
}

const identityResponse = await fetch(`${apiBase}/api/v3/sdk/identity-tokens`, {
  method: "POST",
  headers: { authorization: `SableInstallation ${secrets.installationCredential}`, "content-type": "application/json" },
  body: JSON.stringify({ installationId: secrets.installationId, userId: "voice-soak", roleProfileId: "member", origin }),
});
if (!identityResponse.ok) throw new Error(`Identity exchange failed (${identityResponse.status})`);
const identity = await identityResponse.json() as { identityToken: string };
const sessionResponse = await fetch(`${apiBase}/api/v3/sdk/sessions`, {
  method: "POST",
  headers: { origin, "content-type": "application/json" },
  body: JSON.stringify({
    kind: "sable.sdk.bootstrap.request", schemaVersion: SDK_PROTOCOL_VERSION, requestId: "voice-soak",
    installationId: secrets.installationId, identityToken: identity.identityToken,
    sdk: { version: "0.1.0", protocolVersion: SDK_PROTOCOL_VERSION, distribution: "script" },
    page: { origin, url: `${origin}/`, locale: "en-IN" },
    capabilities: { domObservation: true, shadowDom: true, sameOriginFrames: true, frameBridge: false, registeredTools: [], voice: true, screenshots: false },
  }),
});
if (!sessionResponse.ok) throw new Error(`Session bootstrap failed (${sessionResponse.status})`);
const bootstrap = await sessionResponse.json() as { voiceTransport: { websocketUrl: string; oneTimeTicket: string; languageCode: string; audioFrameMs: number } };
const protocol = `sable.ticket.${Buffer.from(bootstrap.voiceTransport.oneTimeTicket).toString("base64url")}`;
const socket = new WebSocket(bootstrap.voiceTransport.websocketUrl, [protocol]);
await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });

const queue: Record<string, unknown>[] = [];
const waiters: Array<(message: Record<string, unknown>) => void> = [];
socket.on("message", (raw) => {
  const message = JSON.parse(raw.toString()) as Record<string, unknown>;
  const waiter = waiters.shift();
  if (waiter) waiter(message); else queue.push(message);
});
const next = (types: string[], timeoutMs = 15_000): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
  const inspect = (message: Record<string, unknown>) => {
    if (types.includes(String(message.type))) { clearTimeout(timer); resolve(message); }
    else waiters.unshift(inspect);
  };
  const timer = setTimeout(() => reject(new Error(`Voice soak timed out waiting for ${types.join("/")}`)), timeoutMs);
  const queued = queue.shift();
  if (queued) inspect(queued); else waiters.push(inspect);
});

const synthesized = await tts.synthesize("Open settings please.", { language: process.env.VOICE_LANGUAGE_CODE ?? "en-IN", speaker: process.env.VOICE_SPEAKER ?? "shubh" });
const decoded = wavPcm16(synthesized.bytes);
const pcm = resamplePcm16(decoded.samples, decoded.sampleRate);
const frameBytes = 16_000 * 2 * bootstrap.voiceTransport.audioFrameMs / 1_000;
const latencies: number[] = [];
for (let turn = 1; turn <= turns; turn++) {
  socket.send(JSON.stringify({ type: "voice.start", languageCode: bootstrap.voiceTransport.languageCode, sampleRate: 16_000, audioFrameMs: bootstrap.voiceTransport.audioFrameMs }));
  const ready = await next(["voice.ready", "voice.error"]);
  if (ready.type === "voice.error") throw new Error(`Turn ${turn} could not start`);
  const startedAt = Date.now();
  for (let offset = 0; offset < pcm.length; offset += frameBytes) socket.send(pcm.subarray(offset, Math.min(offset + frameBytes, pcm.length)));
  socket.send(Buffer.alloc(16_000));
  socket.send(JSON.stringify({ type: "voice.flush", durationMs: Math.round(pcm.length / 32) }));
  const result = await next(["transcript.final", "voice.no_speech", "voice.error"]);
  if (result.type !== "transcript.final" || typeof result.text !== "string" || !result.text.trim()) throw new Error(`Turn ${turn} failed with ${String(result.type)}`);
  const latency = Date.now() - startedAt;
  latencies.push(latency);
  console.log(`voice turn ${turn}/${turns}: passed (${latency} ms, ${result.text.trim().split(/\s+/).length} words)`);
}
socket.close(1000, "voice soak complete");
latencies.sort((a, b) => a - b);
console.log(`voice soak passed: ${turns}/${turns}, p50=${latencies[Math.floor(latencies.length * 0.5)]} ms, p95=${latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))]} ms`);
