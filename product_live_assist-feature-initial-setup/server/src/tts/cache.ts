import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Audio, VoiceSpec } from "./provider.js";
import { providerFor } from "./provider.js";

/**
 * Content-addressed audio cache — the reason voice is cheap here.
 *
 * Every per-step narration line (`JourneyStep.say`) is known at ONBOARDING time,
 * so it is synthesised once and then replayed by every future demo at zero
 * latency and zero cost. Only free-form conversation ever hits a provider live.
 *
 * Keyed on text + provider + speaker + language, so changing the voice doesn't
 * serve stale audio.
 */

const ROOT = fileURLToPath(new URL("../../data/tts", import.meta.url));
const extFor = (mime: string) => (mime.includes("mpeg") ? "mp3" : mime.includes("wav") ? "wav" : "bin");

export function cacheKey(text: string, voice: VoiceSpec): string {
  const p = providerFor(voice);
  const id = [p.id, voice.speaker ?? p.defaultSpeaker, voice.language ?? "", voice.pace ?? "", text.trim()].join("|");
  return crypto.createHash("sha256").update(id).digest("hex").slice(0, 32);
}

const dirFor = (product: string) => path.join(ROOT, product || "default");

let hits = 0;
let misses = 0;
export const cacheStats = () => ({ hits, misses, hitRate: hits + misses ? +(hits / (hits + misses)).toFixed(3) : 0 });

export async function readCache(product: string, key: string): Promise<Audio | null> {
  const dir = dirFor(product);
  for (const ext of ["wav", "mp3", "bin"]) {
    const f = path.join(dir, `${key}.${ext}`);
    if (existsSync(f)) {
      hits++;
      return { mime: ext === "mp3" ? "audio/mpeg" : ext === "wav" ? "audio/wav" : "application/octet-stream", bytes: await fs.readFile(f) };
    }
  }
  misses++;
  return null;
}

export async function writeCache(product: string, key: string, audio: Audio): Promise<void> {
  const dir = dirFor(product);
  await fs.mkdir(dir, { recursive: true });
  const f = path.join(dir, `${key}.${extFor(audio.mime)}`);
  const tmp = `${f}.${process.pid}.tmp`;
  await fs.writeFile(tmp, audio.bytes);
  await fs.rename(tmp, f); // atomic — a truncated audio file would play as a click
}
