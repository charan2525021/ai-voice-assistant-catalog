import { htmlDocument } from "./shared.js";
import type { BrowserFixture } from "./types.js";

export const spaFixture: BrowserFixture = {
  id: "spa-navigation",
  title: "Single-page application navigation",
  description:
    "History API navigation changes route, heading, and controls without a document reload.",
  initialPath: "/spa",
  routes: [
    {
      path: "/spa",
      html: htmlDocument({
        title: "Workspace",
        body: `
<nav aria-label="Primary">
  <a href="/spa" data-route="home">Home</a>
  <a href="/spa/settings" data-route="settings">Settings</a>
</nav>
<main id="app"></main>`,
        script: `
function render() {
  const settings = location.pathname.endsWith('/settings');
  document.querySelector('#app').innerHTML = settings
    ? '<h1>Workspace settings</h1><label><input id="digest" type="checkbox"> Weekly digest</label><button id="save">Save settings</button><div role="status" id="proof"></div>'
    : '<h1>Workspace overview</h1><p>Welcome to Acme workspace.</p>';
  document.querySelector('#save')?.addEventListener('click', () => {
    document.querySelector('#proof').textContent = 'Settings saved';
  });
}
document.querySelector('nav').addEventListener('click', event => {
  const link = event.target.closest('[data-route]');
  if (!link) return;
  event.preventDefault();
  history.pushState({}, '', link.getAttribute('href'));
  render();
});
addEventListener('popstate', render);
render();`,
      }),
    },
    {
      path: "/spa/settings",
      html: htmlDocument({
        title: "Workspace settings",
        body: "<p>This route is served for direct entry; SPA navigation uses history.pushState.</p>",
      }),
    },
  ],
  expectation: {
    journeyId: "enable-weekly-digest",
    startScreen: "workspace-overview",
    targetControl: "Settings",
    successText: "Settings saved",
    expectedCompatibility: "SDK_DIRECT",
  },
};
