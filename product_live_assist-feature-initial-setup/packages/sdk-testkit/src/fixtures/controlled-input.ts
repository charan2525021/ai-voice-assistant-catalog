import { htmlDocument } from "./shared.js";
import type { BrowserFixture } from "./types.js";

export const controlledInputFixture: BrowserFixture = {
  id: "controlled-input-rerender",
  title: "Controlled input and rerender",
  description:
    "A framework-like controlled field whose DOM node is replaced after every input event.",
  initialPath: "/controlled",
  routes: [
    {
      path: "/controlled",
      html: htmlDocument({
        title: "Create campaign",
        body: `
<main>
  <h1>Create campaign</h1>
  <form id="campaign-form">
    <div id="field-root"></div>
    <button id="submit" type="submit" disabled>Create campaign</button>
  </form>
  <div id="proof" role="status" aria-live="polite"></div>
</main>`,
        script: `
let state = '';
const root = document.querySelector('#field-root');
const submit = document.querySelector('#submit');
function render() {
  root.innerHTML = '<label for="campaign-name">Campaign name</label>' +
    '<input id="campaign-name" name="campaignName" value="' +
    state.replaceAll('&', '&amp;').replaceAll('"', '&quot;') + '">';
  root.querySelector('input').addEventListener('input', event => {
    state = event.target.value;
    submit.disabled = state.trim().length === 0;
    render();
  });
}
render();
document.querySelector('#campaign-form').addEventListener('submit', event => {
  event.preventDefault();
  document.querySelector('#proof').textContent = 'Campaign ' + state + ' created';
});`,
      }),
    },
  ],
  expectation: {
    journeyId: "create-campaign",
    startScreen: "campaign-create",
    targetControl: "Campaign name",
    successText: "Campaign Summer launch created",
    expectedCompatibility: "SDK_DIRECT",
    notes: ["Resolver must reacquire the input after the framework-style rerender."],
  },
};
