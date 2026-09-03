import { htmlDocument } from "./shared.js";
import type { BrowserFixture } from "./types.js";

export const overlayTransientProofFixture: BrowserFixture = {
  id: "overlay-transient-proof",
  title: "Loading overlay and transient success proof",
  description:
    "An overlay temporarily blocks controls, then a short-lived toast provides the postcondition.",
  initialPath: "/overlay",
  routes: [
    {
      path: "/overlay",
      html: htmlDocument({
        title: "Data import",
        head: `<style>
          #overlay { position: fixed; inset: 0; display: grid; place-items: center; background: rgb(255 255 255 / .88); z-index: 10; }
          #toast { position: fixed; right: 20px; bottom: 20px; }
        </style>`,
        body: `
<main><h1>Data import</h1><button id="start">Start import</button><p id="state">Ready</p></main>
<div id="overlay" role="status" aria-live="polite">Preparing workspace…</div>
<div id="toast" role="status" aria-live="assertive"></div>`,
        script: `
const overlay = document.querySelector('#overlay');
setTimeout(() => { overlay.hidden = true; }, 350);
document.querySelector('#start').addEventListener('click', () => {
  overlay.hidden = false; overlay.textContent = 'Importing…';
  setTimeout(() => {
    overlay.hidden = true;
    document.querySelector('#state').textContent = 'Last import: completed';
    const toast = document.querySelector('#toast');
    toast.textContent = 'Import completed successfully';
    setTimeout(() => { toast.textContent = ''; }, 800);
  }, 300);
});`,
      }),
    },
  ],
  expectation: {
    journeyId: "start-import",
    startScreen: "data-import",
    targetControl: "Start import",
    successText: "Import completed successfully",
    expectedCompatibility: "SDK_DIRECT",
    notes: ["Observer must capture transient proof while preserving the durable state signal."],
  },
};
