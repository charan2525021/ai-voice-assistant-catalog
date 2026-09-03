import { htmlDocument } from "./shared.js";
import type { BrowserFixture } from "./types.js";

export const semanticHtmlFixture: BrowserFixture = {
  id: "semantic-html",
  title: "Semantic project creation",
  description:
    "A well-labelled form that should be recognized and operated without CSS selectors.",
  initialPath: "/semantic",
  routes: [
    {
      path: "/semantic",
      html: htmlDocument({
        title: "Projects",
        body: `
<nav aria-label="Primary"><a href="/semantic">Projects</a></nav>
<main>
  <h1>Projects</h1>
  <p>Manage the projects in your workspace.</p>
  <button id="open-create" type="button">Create project</button>
  <form id="create-form" hidden aria-label="Create project">
    <label for="project-name">Project name</label>
    <input id="project-name" name="projectName" autocomplete="off" required>
    <button type="submit">Save project</button>
  </form>
  <ul id="projects" aria-label="Project list"></ul>
  <div id="status" role="status" aria-live="polite"></div>
</main>`,
        script: `
const form = document.querySelector('#create-form');
document.querySelector('#open-create').addEventListener('click', () => {
  form.hidden = false;
  document.querySelector('#project-name').focus();
});
form.addEventListener('submit', event => {
  event.preventDefault();
  const name = new FormData(form).get('projectName');
  const row = document.createElement('li');
  row.textContent = String(name);
  document.querySelector('#projects').append(row);
  document.querySelector('#status').textContent = 'Project created successfully';
});`,
      }),
    },
  ],
  expectation: {
    journeyId: "create-project",
    startScreen: "projects-list",
    targetControl: "Create project",
    successText: "Project created successfully",
    expectedCompatibility: "SDK_DIRECT",
  },
};
