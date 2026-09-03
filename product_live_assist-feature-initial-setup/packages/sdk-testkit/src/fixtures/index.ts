export * from "./types.js";
export * from "./semantic.js";
export * from "./controlled-input.js";
export * from "./spa.js";
export * from "./duplicate-dialog.js";
export * from "./shadow-dom.js";
export * from "./iframes.js";
export * from "./canvas-tool.js";
export * from "./virtualized-list.js";
export * from "./overlay-proof.js";
export * from "./responsive-locale.js";
export * from "./private-fields.js";
export * from "./user-gesture.js";

import { canvasRegisteredToolFixture } from "./canvas-tool.js";
import { controlledInputFixture } from "./controlled-input.js";
import { duplicateLabelsDialogFixture } from "./duplicate-dialog.js";
import { crossOriginIframeFixture, sameOriginIframeFixture } from "./iframes.js";
import { overlayTransientProofFixture } from "./overlay-proof.js";
import { privateFieldsFixture } from "./private-fields.js";
import { responsiveLocaleFixture } from "./responsive-locale.js";
import { semanticHtmlFixture } from "./semantic.js";
import { closedShadowFixture, openShadowFixture } from "./shadow-dom.js";
import { spaFixture } from "./spa.js";
import type { BrowserFixture } from "./types.js";
import { userGestureManualFixture } from "./user-gesture.js";
import { virtualizedListFixture } from "./virtualized-list.js";

export const browserFixtures = [
  semanticHtmlFixture,
  controlledInputFixture,
  spaFixture,
  duplicateLabelsDialogFixture,
  openShadowFixture,
  closedShadowFixture,
  sameOriginIframeFixture,
  crossOriginIframeFixture,
  canvasRegisteredToolFixture,
  virtualizedListFixture,
  overlayTransientProofFixture,
  responsiveLocaleFixture,
  privateFieldsFixture,
  userGestureManualFixture,
] as const satisfies readonly BrowserFixture[];

export const browserFixturesById: ReadonlyMap<string, BrowserFixture> = new Map(
  browserFixtures.map((fixture) => [fixture.id, fixture]),
);

export function getBrowserFixture(id: string): BrowserFixture {
  const fixture = browserFixturesById.get(id);
  if (!fixture) {
    throw new Error(`Unknown SDK browser fixture: ${id}`);
  }
  return fixture;
}
