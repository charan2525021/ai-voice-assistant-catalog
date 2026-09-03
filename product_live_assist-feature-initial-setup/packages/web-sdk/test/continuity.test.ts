import assert from "node:assert/strict";
import test from "node:test";
import {
  BrowserContinuityStore,
  attachHandoffToken,
  takeHandoffToken,
  type ContinuityScope,
  type ContinuityStorage,
} from "../src/continuity.js";

class MemoryStorage implements ContinuityStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const scope: ContinuityScope = {
  installationId: "installation-1",
  organizationId: "org-1",
  productId: "product-1",
  environmentId: "production",
  userId: "user-1",
  roleProfileId: "member",
  catalogVersionId: "catalog-v2",
  origin: "https://app.example",
};

test("same-browser continuity restores final messages and a journey checkpoint", () => {
  const storage = new MemoryStorage();
  const first = new BrowserContinuityStore(scope, storage);
  first.appendMessage({ key: "user:1", role: "user", text: "Open reports" }, 1_000);
  first.appendMessage({ key: "assistant:1", role: "assistant", text: "Opening reports." }, 2_000);
  first.setJourney({
    journeyId: "open-reports", journeyVersion: 2, turnId: "turn-1", originalRequest: "Open reports",
    inputs: {}, completedStepIds: ["navigate"], nextStepId: "verify", nextStepIndex: 1,
    navigationStepId: "navigate", destinationUrl: "https://app.example/reports", expectedScreenIds: ["reports"],
  }, 3_000);

  const second = new BrowserContinuityStore(scope, storage);
  const restored = second.load(4_000).snapshot;
  assert.equal(restored?.transcript.length, 2);
  assert.equal(restored?.journey?.nextStepId, "verify");
});

test("same-tab continuity restores a bounded catalog navigation checkpoint", () => {
  const storage = new MemoryStorage();
  const first = new BrowserContinuityStore(scope, storage);
  first.setCatalogNavigation({
    turnId: "turn-2", originalRequest: "Open Mystery", sourceScreenId: "home", controlId: "mystery-link",
    targetScreenId: "mystery", destinationUrl: "https://app.example/mystery",
  }, 1_000);
  const restored = new BrowserContinuityStore(scope, storage).load(2_000).snapshot;
  assert.equal(restored?.catalogNavigation?.controlId, "mystery-link");
  assert.equal(restored?.catalogNavigation?.targetScreenId, "mystery");
});

test("expired or differently scoped continuity is cleared instead of restored", () => {
  const storage = new MemoryStorage();
  const first = new BrowserContinuityStore(scope, storage, { idleTtlMs: 60_000, absoluteTtlMs: 60_000 });
  first.appendMessage({ key: "user:1", role: "user", text: "Hello" }, 1_000);
  const expired = new BrowserContinuityStore(scope, storage, { idleTtlMs: 60_000, absoluteTtlMs: 60_000 }).load(62_001);
  assert.equal(expired.cleared, "expired");
  assert.equal(storage.values.size, 0);

  first.appendMessage({ key: "user:2", role: "user", text: "Again" }, 70_000);
  const otherUser = new BrowserContinuityStore({ ...scope, userId: "user-2" }, storage).load(71_000);
  assert.equal(otherUser.cleared, "scope_changed");
  assert.equal(storage.values.size, 0);
});

test("transcript is bounded and repeat keys update instead of duplicating", () => {
  const storage = new MemoryStorage();
  const store = new BrowserContinuityStore(scope, storage, { maximumMessages: 2 });
  store.appendMessage({ key: "assistant:1", role: "assistant", text: "partial" }, 1_000);
  store.appendMessage({ key: "assistant:1", role: "assistant", text: "final" }, 2_000);
  store.appendMessage({ key: "user:2", role: "user", text: "two" }, 3_000);
  store.appendMessage({ key: "user:3", role: "user", text: "three" }, 4_000);
  assert.deepEqual(store.messages().map((message) => message.text), ["two", "three"]);
});

test("the server-issued continuity ID replaces a stale browser scope and survives an empty browser cache", () => {
  const storage = new MemoryStorage();
  const stale = new BrowserContinuityStore(scope, storage, {}, "continuity-old");
  stale.appendMessage({ key: "user:old", role: "user", text: "Old" }, 1_000);

  const current = new BrowserContinuityStore(scope, storage, {}, "continuity-server");
  assert.equal(current.load(2_000).cleared, "scope_changed");
  assert.equal(current.ensure(2_000).continuityId, "continuity-server");

  storage.values.clear();
  const emptyTab = new BrowserContinuityStore(scope, storage, {}, "continuity-server");
  assert.equal(emptyTab.ensure(3_000).continuityId, "continuity-server");
  emptyTab.replaceTranscript([{ key: "assistant:1", role: "assistant", text: "Restored by server", createdAt: new Date(3_000).toISOString() }], 7, 3_000);
  assert.equal(emptyTab.current()?.serverRevision, 7);
  assert.deepEqual(emptyTab.messages().map((message) => message.text), ["Restored by server"]);
});

test("cross-origin handoff fragment carries only the token and is immediately removed", () => {
  const withToken = attachHandoffToken("https://other.example/page#section", "opaque-token");
  assert.equal(withToken.includes("Open reports"), false);
  let replaced = "";
  const token = takeHandoffToken(
    { href: withToken } as Location,
    { replaceState: (_data: unknown, _unused: string, url?: string | URL | null) => { replaced = String(url); } } as History,
  );
  assert.equal(token, "opaque-token");
  assert.equal(new URL(replaced).hash, "#section");
});
