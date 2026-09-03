import { htmlDocument } from "./shared.js";
import type { BrowserFixture } from "./types.js";

export const openShadowFixture: BrowserFixture = {
  id: "open-shadow-dom",
  title: "Open shadow root",
  description: "A semantic control nested inside an inspectable open shadow root.",
  initialPath: "/shadow/open",
  routes: [
    {
      path: "/shadow/open",
      html: htmlDocument({
        title: "Billing preferences",
        body: `<main><h1>Billing preferences</h1><billing-card></billing-card><div id="proof" role="status"></div></main>`,
        script: `
customElements.define('billing-card', class extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>button{font:inherit;padding:8px}</style><h2>Invoices</h2><button aria-label="Enable invoice emails">Enable emails</button>';
    root.querySelector('button').addEventListener('click', () => {
      document.querySelector('#proof').textContent = 'Invoice emails enabled';
    });
  }
});`,
      }),
    },
  ],
  expectation: {
    journeyId: "enable-invoice-emails",
    startScreen: "billing-preferences",
    targetControl: "Enable invoice emails",
    successText: "Invoice emails enabled",
    expectedCompatibility: "SDK_DIRECT",
  },
};

export const closedShadowFixture: BrowserFixture = {
  id: "closed-shadow-dom",
  title: "Closed shadow root",
  description:
    "A closed component cannot be inspected and must be exposed through a registered client tool.",
  initialPath: "/shadow/closed",
  routes: [
    {
      path: "/shadow/closed",
      html: htmlDocument({
        title: "Secure preferences",
        body: `<main><h1>Secure preferences</h1><secure-toggle></secure-toggle><div id="proof" role="status"></div></main>`,
        script: `
let secureToggle;
customElements.define('secure-toggle', class extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'closed' });
    root.innerHTML = '<button>Enable secure alerts</button>';
    secureToggle = () => root.querySelector('button').click();
    root.querySelector('button').addEventListener('click', () => {
      document.querySelector('#proof').textContent = 'Secure alerts enabled';
    });
  }
});
globalThis.__SABLE_FIXTURE_TOOLS__ = {
  enableSecureAlerts: async () => { secureToggle(); return { enabled: true }; }
};`,
      }),
    },
  ],
  expectation: {
    journeyId: "enable-secure-alerts",
    startScreen: "secure-preferences",
    targetControl: "enableSecureAlerts registered tool",
    successText: "Secure alerts enabled",
    expectedCompatibility: "NEEDS_REGISTERED_TOOL",
  },
};
