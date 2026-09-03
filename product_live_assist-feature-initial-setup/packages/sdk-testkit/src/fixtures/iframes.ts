import { htmlDocument } from "./shared.js";
import type { BrowserFixture } from "./types.js";

export const sameOriginIframeFixture: BrowserFixture = {
  id: "same-origin-iframe",
  title: "Same-origin iframe",
  description: "The SDK may inspect and operate this frame under the same-origin policy.",
  initialPath: "/frames/same",
  routes: [
    {
      path: "/frames/same",
      html: htmlDocument({
        title: "Integration settings",
        body: `<main><h1>Integration settings</h1><iframe title="Connector settings" src="/frames/same/content"></iframe><div id="proof" role="status"></div></main>`,
        script: `addEventListener('message', event => {
  if (event.origin === location.origin && event.data === 'connector-enabled') {
    document.querySelector('#proof').textContent = 'Connector enabled';
  }
});`,
      }),
    },
    {
      path: "/frames/same/content",
      html: htmlDocument({
        title: "Connector settings",
        body: `<main><h1>CRM connector</h1><button id="enable">Enable connector</button></main>`,
        script: `document.querySelector('#enable').addEventListener('click', () => parent.postMessage('connector-enabled', location.origin));`,
      }),
    },
  ],
  expectation: {
    journeyId: "enable-connector",
    startScreen: "integration-settings",
    targetControl: "Enable connector in Connector settings frame",
    successText: "Connector enabled",
    expectedCompatibility: "SDK_DIRECT",
  },
};

export const crossOriginIframeFixture: BrowserFixture = {
  id: "cross-origin-iframe",
  title: "Cross-origin iframe",
  description:
    "The parent SDK cannot inspect this frame; a separately installed frame bridge is required.",
  initialPath: "/frames/cross",
  routes: [
    {
      path: "/frames/cross",
      html: htmlDocument({
        title: "Payment provider",
        body: `<main><h1>Payment provider</h1><iframe title="External payment settings" src="{{SECONDARY_ORIGIN}}/frames/cross/content"></iframe><div id="proof" role="status"></div></main>`,
        script: `addEventListener('message', event => {
  if (event.origin === '{{SECONDARY_ORIGIN}}' && event.data?.type === 'sable:provider-connected') {
    document.querySelector('#proof').textContent = 'Provider connected';
  }
});`,
      }),
    },
    {
      origin: "secondary",
      path: "/frames/cross/content",
      headers: {
        "access-control-allow-origin": "{{PRIMARY_ORIGIN}}",
      },
      html: htmlDocument({
        title: "External provider",
        body: `<main><h1>External provider</h1><button id="connect">Connect provider</button></main>`,
        script: `document.querySelector('#connect').addEventListener('click', () => parent.postMessage({ type: 'sable:provider-connected' }, '{{PRIMARY_ORIGIN}}'));`,
      }),
    },
  ],
  expectation: {
    journeyId: "connect-payment-provider",
    startScreen: "payment-provider",
    targetControl: "Connect provider in cross-origin frame",
    successText: "Provider connected",
    expectedCompatibility: "NEEDS_FRAME_BRIDGE",
  },
};
