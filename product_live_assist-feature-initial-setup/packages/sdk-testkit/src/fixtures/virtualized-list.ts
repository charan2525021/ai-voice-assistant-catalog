import { htmlDocument } from "./shared.js";
import type { BrowserFixture } from "./types.js";

export const virtualizedListFixture: BrowserFixture = {
  id: "virtualized-list",
  title: "Virtualized customer list",
  description:
    "Only a moving window of rows exists in the DOM; the target appears after bounded scrolling.",
  initialPath: "/virtualized",
  routes: [
    {
      path: "/virtualized",
      html: htmlDocument({
        title: "Customers",
        head: `<style>
          #viewport { position: relative; height: 240px; overflow: auto; border: 1px solid #ccd3df; }
          #spacer { height: 4000px; }
          #window { position: absolute; inset: 0 auto auto 0; width: 100%; }
          .row { height: 40px; display: flex; justify-content: space-between; align-items: center; }
        </style>`,
        body: `
<main>
  <h1>Customers</h1>
  <div id="viewport" role="list" aria-label="Customer list"><div id="spacer"></div><div id="window"></div></div>
  <div id="proof" role="status"></div>
</main>`,
        script: `
const viewport = document.querySelector('#viewport');
const windowRoot = document.querySelector('#window');
const rowHeight = 40;
const total = 100;
function render() {
  const start = Math.max(0, Math.floor(viewport.scrollTop / rowHeight) - 1);
  const end = Math.min(total, start + 9);
  windowRoot.style.transform = 'translateY(' + (start * rowHeight) + 'px)';
  windowRoot.innerHTML = '';
  for (let index = start; index < end; index += 1) {
    const row = document.createElement('div');
    row.className = 'row'; row.setAttribute('role', 'listitem');
    const name = index === 96 ? 'Northstar Industries' : 'Customer ' + (index + 1);
    row.innerHTML = '<span>' + name + '</span><button data-index="' + index + '">Open</button>';
    row.querySelector('button').addEventListener('click', () => {
      document.querySelector('#proof').textContent = name + ' opened';
    });
    windowRoot.append(row);
  }
}
viewport.addEventListener('scroll', render);
render();`,
      }),
    },
  ],
  expectation: {
    journeyId: "open-customer",
    startScreen: "customer-list",
    targetControl: "Open in Northstar Industries row",
    successText: "Northstar Industries opened",
    expectedCompatibility: "SDK_DIRECT",
    notes: ["Scrolling must be bounded and stop when the target or list end is reached."],
  },
};
