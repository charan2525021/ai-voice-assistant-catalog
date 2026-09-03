import { htmlDocument } from "./shared.js";
import type { BrowserFixture } from "./types.js";

export const responsiveLocaleFixture: BrowserFixture = {
  id: "responsive-locale",
  title: "Responsive and localized settings",
  description:
    "The same logical controls have desktop/mobile layout variants and English/Spanish labels.",
  initialPath: "/responsive",
  routes: [
    {
      path: "/responsive",
      html: htmlDocument({
        title: "Notification settings",
        head: `<style>
          #desktop-nav { display: flex; gap: 8px; }
          #mobile-menu { display: none; }
          @media (max-width: 520px) { #desktop-nav { display: none; } #mobile-menu { display: block; } }
        </style>`,
        body: `
<nav id="desktop-nav" aria-label="Primary"><button data-section="notifications">Notifications</button></nav>
<button id="mobile-menu" aria-label="Open navigation">☰</button>
<main>
  <label for="locale">Language</label>
  <select id="locale"><option value="en">English</option><option value="es">Español</option></select>
  <h1 id="heading">Notification settings</h1>
  <label><input id="mentions" type="checkbox"> <span id="mentions-label">Mention alerts</span></label>
  <button id="save">Save settings</button>
  <div id="proof" role="status"></div>
</main>`,
        script: `
const copy = {
  en: { heading: 'Notification settings', mentions: 'Mention alerts', save: 'Save settings', proof: 'Notification settings saved' },
  es: { heading: 'Configuración de notificaciones', mentions: 'Alertas de menciones', save: 'Guardar configuración', proof: 'Configuración de notificaciones guardada' }
};
let locale = 'en';
document.querySelector('#locale').addEventListener('change', event => {
  locale = event.target.value; document.documentElement.lang = locale;
  document.querySelector('#heading').textContent = copy[locale].heading;
  document.querySelector('#mentions-label').textContent = copy[locale].mentions;
  document.querySelector('#save').textContent = copy[locale].save;
});
document.querySelector('#save').addEventListener('click', () => { document.querySelector('#proof').textContent = copy[locale].proof; });`,
      }),
    },
  ],
  expectation: {
    journeyId: "enable-mention-alerts",
    startScreen: "notification-settings",
    targetControl: "Mention alerts / Alertas de menciones",
    successText: "Configuración de notificaciones guardada",
    expectedCompatibility: "SDK_DIRECT",
  },
};
