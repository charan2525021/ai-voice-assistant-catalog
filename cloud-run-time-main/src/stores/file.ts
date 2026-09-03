import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ContinuityStore, Installation, KnowledgeChunk, RuntimeContinuity, RuntimeEvent, RuntimeStores } from "../contracts.js";
import type { SignedCatalogEnvelope } from "@sable/sdk-contracts";
import type { RuntimeBundle } from "@sable/runtime-core";
import { MemoryHandoffStore, MemorySessionStore } from "./memory.js";

interface FileDatabase { installations: Installation[]; catalogs: SignedCatalogEnvelope[]; runtimeBundles: RuntimeBundle[]; knowledge: KnowledgeChunk[]; }

function cosine(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0; let leftSize = 0; let rightSize = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    leftSize += left[index] ** 2;
    rightSize += right[index] ** 2;
  }
  return leftSize && rightSize ? dot / Math.sqrt(leftSize * rightSize) : 0;
}

export async function createFileStores(file: string): Promise<RuntimeStores> {
  const filename = resolve(file);
  const parsed = JSON.parse(await readFile(filename, "utf8")) as FileDatabase;
  if (!Array.isArray(parsed.installations) || !Array.isArray(parsed.catalogs) || !Array.isArray(parsed.runtimeBundles) || !Array.isArray(parsed.knowledge)) throw new Error(`Invalid runtime file: ${filename}`);
  const sessions = new MemorySessionStore();
  const handoffs = new MemoryHandoffStore();
  const eventFile = `${filename}.events.ndjson`;
  const continuityFile = `${filename}.continuity.json`;
  let continuityValues: Record<string, RuntimeContinuity> = {};
  try {
    const decoded = JSON.parse(await readFile(continuityFile, "utf8")) as Record<string, RuntimeContinuity>;
    if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) continuityValues = decoded;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let continuityWrite = Promise.resolve();
  const persistContinuities = async () => {
    const temporary = `${continuityFile}.tmp`;
    await mkdir(dirname(continuityFile), { recursive: true });
    await writeFile(temporary, JSON.stringify(continuityValues, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, continuityFile);
  };
  const continuities: ContinuityStore = {
    put: async (value, expectedRevision) => {
      let written = false;
      continuityWrite = continuityWrite.catch(() => undefined).then(async () => {
        const currentRevision = continuityValues[value.continuityId]?.revision ?? 0;
        if (expectedRevision !== undefined && currentRevision !== expectedRevision) return;
        continuityValues[value.continuityId] = structuredClone(value);
        await persistContinuities();
        written = true;
      });
      await continuityWrite;
      return written;
    },
    get: async (id) => {
      await continuityWrite.catch(() => undefined);
      const value = continuityValues[id];
      if (!value) return undefined;
      if (Date.parse(value.expiresAt) <= Date.now()) {
        delete continuityValues[id];
        continuityWrite = continuityWrite.catch(() => undefined).then(persistContinuities);
        await continuityWrite;
        return undefined;
      }
      return structuredClone(value);
    },
    delete: async (id) => {
      if (!continuityValues[id]) return;
      delete continuityValues[id];
      continuityWrite = continuityWrite.catch(() => undefined).then(persistContinuities);
      await continuityWrite;
    },
  };
  const persist = async () => {
    const temporary = `${filename}.tmp`;
    await writeFile(temporary, JSON.stringify(parsed, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, filename);
  };
  return {
    installations: {
      get: async (id) => parsed.installations.find((value) => value.installationId === id),
      list: async (organizationId) => parsed.installations.filter((value) => value.organizationId === organizationId),
      put: async (installation) => { const index = parsed.installations.findIndex((value) => value.installationId === installation.installationId); if (index >= 0) parsed.installations[index] = installation; else parsed.installations.push(installation); await persist(); },
    },
    catalogs: {
      get: async (version, installation) => parsed.catalogs.find((value) => value.payload.manifest.catalogVersionId === version && value.payload.manifest.organizationId === installation.organizationId && value.payload.manifest.productId === installation.productId),
      getBundle: async (scope) => parsed.runtimeBundles.find((value) => value.catalogVersionId === scope.catalogVersionId && value.organizationId === scope.organizationId && value.productId === scope.productId),
    },
    knowledge: {
      search: async (scope, input) => {
        const words = input.query.toLowerCase().split(/\W+/).filter((word) => word.length > 2);
        return parsed.knowledge
          .filter((chunk) => chunk.tenantId === scope.organizationId && chunk.productId === scope.productId && chunk.catalogVersionId === scope.catalogVersionId)
          .map((chunk) => ({
            ...chunk,
            score: input.embedding && chunk.embedding
              ? cosine(input.embedding, chunk.embedding)
              : words.reduce((score, word) => score + (`${chunk.title} ${chunk.section} ${chunk.content}`.toLowerCase().includes(word) ? 1 : 0), 0) / Math.max(1, words.length),
          }))
          .filter((chunk) => chunk.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, input.limit);
      },
    },
    sessions,
    continuities,
    handoffs,
    events: {
      append: async (event: RuntimeEvent) => {
        // Events are redacted before reaching the store. Audio bytes never reach this interface.
        await mkdir(dirname(eventFile), { recursive: true });
        await appendFile(eventFile, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
      },
    },
    close: async () => undefined,
  };
}
