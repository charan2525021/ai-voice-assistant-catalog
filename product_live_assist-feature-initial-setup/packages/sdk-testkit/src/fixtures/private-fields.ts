import { htmlDocument } from "./shared.js";
import type { BrowserFixture } from "./types.js";

const PRIVATE_PASSWORD = "NeverSend-Password-42";
const PRIVATE_TOKEN = "sk-fixture-secret-token";
const PRIVATE_CARD = "4111111111111111";

export const privateFieldsFixture: BrowserFixture = {
  id: "private-fields",
  title: "Private and excluded content",
  description:
    "Sensitive values must be removed before observation, logs, screenshots, telemetry, or cloud requests.",
  initialPath: "/private",
  routes: [
    {
      path: "/private",
      html: htmlDocument({
        title: "Security settings",
        body: `
<main>
  <h1>Security settings</h1>
  <label>Password <input type="password" value="${PRIVATE_PASSWORD}" autocomplete="current-password"></label>
  <label>API token <input data-sable-private value="${PRIVATE_TOKEN}"></label>
  <section data-sable-private><h2>Payment method</h2><p>${PRIVATE_CARD}</p></section>
  <section data-sable-observe="off"><h2>Internal audit notes</h2><p>Never transmit this excluded region.</p></section>
  <button>Review privacy settings</button>
</main>`,
      }),
    },
  ],
  expectation: {
    startScreen: "security-settings",
    targetControl: "Review privacy settings",
    expectedCompatibility: "SDK_DIRECT",
    privateValues: [
      PRIVATE_PASSWORD,
      PRIVATE_TOKEN,
      PRIVATE_CARD,
      "Never transmit this excluded region.",
    ],
  },
};
