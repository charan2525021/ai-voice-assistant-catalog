import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RuntimeContinuity } from "../src/contracts.js";
import { createFileStores } from "../src/stores/file.js";

test("file runtime continuity survives restart and rejects a stale writer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sable-continuity-"));
  const runtimeFile = join(directory, "runtime.json");
  await writeFile(runtimeFile, JSON.stringify({ installations: [], catalogs: [], runtimeBundles: [], knowledge: [] }));
  const now = new Date().toISOString();
  const value: RuntimeContinuity = {
    continuityId: "continuity-file", organizationId: "org", installationId: "installation", userId: "user", role: "member", catalogVersionId: "v1",
    messages: [], transcript: [{ key: "assistant:1", role: "assistant", text: "Persisted", createdAt: now }],
    startedAt: now, updatedAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString(), revision: 1,
  };
  try {
    const first = await createFileStores(runtimeFile);
    assert.equal(await first.continuities.put(value, 0), true);
    await first.close();

    const second = await createFileStores(runtimeFile);
    assert.equal((await second.continuities.get(value.continuityId))?.transcript[0]?.text, "Persisted");
    assert.equal(await second.continuities.put({ ...value, revision: 2 }, 0), false);
    assert.equal(await second.continuities.put({ ...value, revision: 2 }, 1), true);
    await second.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
