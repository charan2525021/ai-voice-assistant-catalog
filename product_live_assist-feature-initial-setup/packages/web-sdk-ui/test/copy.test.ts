import assert from "node:assert/strict";
import test from "node:test";
import { approvalCopy } from "../src/copy.js";
import { dispatchVoiceOutput, type VoiceUiHooks } from "../src/index.js";
import { createPageDock, SABLE_SIDEBAR_WIDTH_PX } from "../src/layout.js";
import { UI_STYLES } from "../src/styles.js";

test("approval copy clearly labels destructive operations", () => {
  const copy = approvalCopy({
    requestId: "request",
    reason: "Delete this workspace",
    journeyId: "delete-workspace",
    journeyName: "Delete workspace",
    stepId: "confirm",
    risk: "destructive",
    expiresAt: new Date().toISOString(),
  });
  assert.equal(copy.title, "Destructive action");
  assert.match(copy.detail, /Delete this workspace/);
  assert.match(copy.detail, /Delete workspace/);
});

test("UI stylesheet keeps the host isolated and Stop visually distinct", () => {
  assert.match(UI_STYLES, /:host/);
  assert.match(UI_STYLES, /\.stop/);
  assert.match(UI_STYLES, /prefers-reduced-motion/);
  assert.match(UI_STYLES, /\.demo-actions/);
  assert.match(UI_STYLES, /\.demo-control/);
});

test("default overlay is full-height, isolated, and does not capture page clicks outside the panel", () => {
  assert.equal(SABLE_SIDEBAR_WIDTH_PX, 400);
  assert.match(UI_STYLES, /top:\s*0/);
  assert.match(UI_STYLES, /bottom:\s*0/);
  assert.match(UI_STYLES, /width:\s*min\(400px, 100vw\)/);
  assert.match(UI_STYLES, /max-width:\s*899px/);
  assert.match(UI_STYLES, /pointer-events:\s*none/);
  assert.match(UI_STYLES, /\.panel[\s\S]*pointer-events:\s*auto/);
});

test("docked layout narrows the page and restores its exact original styles", () => {
  const values = new Map<string, { value: string; priority: string }>([["width", { value: "92%", priority: "" }]]);
  const attributes = new Map<string, string>();
  const hostAttributes = new Map<string, string>();
  const style = {
    getPropertyValue: (name: string) => values.get(name)?.value ?? "",
    getPropertyPriority: (name: string) => values.get(name)?.priority ?? "",
    setProperty: (name: string, value: string, priority = "") => { values.set(name, { value, priority }); },
    removeProperty: (name: string) => { values.delete(name); return ""; },
  };
  const document = {
    documentElement: {
      style,
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: (name: string, value: string) => { attributes.set(name, value); },
      removeAttribute: (name: string) => { attributes.delete(name); },
    },
    defaultView: { innerWidth: 1_200, matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) },
  } as unknown as Document;
  const host = {
    setAttribute: (name: string, value: string) => { hostAttributes.set(name, value); },
    removeAttribute: (name: string) => { hostAttributes.delete(name); },
  } as unknown as HTMLElement;

  const dock = createPageDock(document, host, true);
  dock.setOpen(true);
  assert.deepEqual(values.get("width"), { value: "calc(100% - 400px)", priority: "important" });
  assert.equal(attributes.get("data-sable-page-docked"), "true");
  assert.equal(hostAttributes.get("data-sable-docked"), "true");

  dock.setOpen(false);
  assert.deepEqual(values.get("width"), { value: "92%", priority: "" });
  assert.equal(attributes.has("data-sable-page-docked"), false);
  assert.equal(hostAttributes.get("data-sable-docked"), "false");
  dock.destroy();
});

test("routes speak commands and terminal states through the host voice bridge", () => {
  const spoken: Array<{ text: string; turnId: string; voice?: string }> = [];
  let cancellations = 0;
  const voice: VoiceUiHooks = {
    enabled: true,
    start() {},
    stop() {},
    speak(text, context) { spoken.push({ text, ...context }); },
    cancelSpeech() { cancellations++; },
  };

  dispatchVoiceOutput(voice, { type: "speak", turnId: "turn-1", text: "Hello", voice: "alloy" });
  dispatchVoiceOutput(voice, { type: "state", state: "failed", detail: "offline" });

  assert.deepEqual(spoken, [{ text: "Hello", turnId: "turn-1", voice: "alloy" }]);
  assert.equal(cancellations, 1);
});
