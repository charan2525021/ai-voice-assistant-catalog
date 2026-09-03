import { htmlDocument } from "./shared.js";
import type { BrowserFixture } from "./types.js";

export const userGestureManualFixture: BrowserFixture = {
  id: "user-gesture-manual",
  title: "Protected and manual browser operations",
  description:
    "File selection and clipboard access require a fresh user gesture and must not be reported as SDK-direct.",
  initialPath: "/user-gesture",
  routes: [
    {
      path: "/user-gesture",
      html: htmlDocument({
        title: "Import certificate",
        body: `
<main>
  <h1>Import certificate</h1>
  <label for="certificate">Certificate file</label>
  <input id="certificate" type="file" accept=".pem,.crt">
  <button id="clipboard">Copy verification code</button>
  <code id="code">VERIFY-4821</code>
  <div id="proof" role="status"></div>
</main>`,
        script: `
document.querySelector('#certificate').addEventListener('change', event => {
  document.querySelector('#proof').textContent = event.target.files.length ? 'Certificate selected by user' : '';
});
document.querySelector('#clipboard').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(document.querySelector('#code').textContent);
    document.querySelector('#proof').textContent = 'Verification code copied';
  } catch {
    document.querySelector('#proof').textContent = 'Clipboard permission required';
  }
});`,
      }),
    },
  ],
  expectation: {
    journeyId: "import-certificate",
    startScreen: "certificate-import",
    targetControl: "Certificate file",
    successText: "Certificate selected by user",
    expectedCompatibility: "NEEDS_USER_GESTURE",
    notes: ["The SDK may explain and highlight the input but cannot choose a local file."],
  },
};
