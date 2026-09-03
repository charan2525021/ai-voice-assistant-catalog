import { htmlDocument } from "./shared.js";
import type { BrowserFixture } from "./types.js";

export const canvasRegisteredToolFixture: BrowserFixture = {
  id: "canvas-registered-tool",
  title: "Canvas editor with a registered tool",
  description:
    "A canvas exposes no meaningful controls, so a client-reviewed tool performs the stable operation.",
  initialPath: "/canvas",
  routes: [
    {
      path: "/canvas",
      html: htmlDocument({
        title: "Journey canvas",
        body: `
<main>
  <h1>Journey canvas</h1>
  <canvas id="journey" width="640" height="320" aria-label="Journey builder canvas"></canvas>
  <p id="proof" role="status"></p>
</main>`,
        script: `
const canvas = document.querySelector('#journey');
const context = canvas.getContext('2d');
context.fillStyle = '#eef3ff'; context.fillRect(0, 0, 640, 320);
context.fillStyle = '#172033'; context.font = '18px system-ui'; context.fillText('Visual journey builder', 24, 42);
const nodes = [];
globalThis.__SABLE_FIXTURE_TOOLS__ = {
  addJourneyNode: async ({ label }) => {
    nodes.push(String(label));
    context.fillStyle = '#246bfd';
    context.fillRect(24, 70 + ((nodes.length - 1) * 50), 220, 36);
    context.fillStyle = '#fff';
    context.fillText(String(label), 36, 95 + ((nodes.length - 1) * 50));
    document.querySelector('#proof').textContent = 'Node ' + label + ' added';
    return { nodeId: 'node-' + nodes.length, label };
  }
};`,
      }),
    },
  ],
  expectation: {
    journeyId: "add-journey-node",
    startScreen: "journey-canvas",
    targetControl: "addJourneyNode registered tool",
    successText: "Node Send email added",
    expectedCompatibility: "NEEDS_REGISTERED_TOOL",
  },
};
