import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import type { Audio, TextToSpeechProvider, VoiceSpec } from "./provider.js";

export interface NarrationAudioCache {
  get(productId: string, key: string): Promise<Audio | undefined>;
  put(productId: string, key: string, audio: Audio): Promise<void>;
}

export function narrationCacheKey(text: string, voice: VoiceSpec, provider: TextToSpeechProvider): string {
  const identity = [provider.id, voice.speaker ?? provider.defaultSpeaker, voice.language ?? "", voice.pace ?? "", text.trim()].join("|");
  return createHash("sha256").update(identity).digest("hex").slice(0, 32);
}

const extensionFor = (mime: string) => mime.includes("mpeg") ? "mp3" : mime.includes("wav") ? "wav" : "bin";

/** Persistent caching is restricted to signed, reusable catalog narration. */
export class FileNarrationAudioCache implements NarrationAudioCache {
  constructor(private readonly root: string) {}
  async get(productId: string, key: string): Promise<Audio | undefined> {
    for (const extension of ["wav", "mp3", "bin"]) {
      const file = path.join(this.root, productId || "default", `${key}.${extension}`);
      if (existsSync(file)) return { mime: extension === "mp3" ? "audio/mpeg" : extension === "wav" ? "audio/wav" : "application/octet-stream", bytes: await fs.readFile(file) };
    }
    return undefined;
  }
  async put(productId: string, key: string, audio: Audio): Promise<void> {
    const directory = path.join(this.root, productId || "default");
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, `${key}.${extensionFor(audio.mime)}`);
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, audio.bytes);
    await fs.rename(temporary, file);
  }
}
