import { htmlDocument } from "./shared.js";
import type { BrowserFixture } from "./types.js";

export const duplicateLabelsDialogFixture: BrowserFixture = {
  id: "duplicate-labels-dialog",
  title: "Duplicate labels with an active dialog",
  description:
    "Two visible Save buttons require dialog and section context instead of first-match selection.",
  initialPath: "/duplicate-dialog",
  routes: [
    {
      path: "/duplicate-dialog",
      html: htmlDocument({
        title: "Profile settings",
        body: `
<main>
  <h1>Profile settings</h1>
  <section aria-labelledby="profile-heading">
    <h2 id="profile-heading">Personal profile</h2>
    <button id="profile-save">Save</button>
  </section>
  <button id="open-team">Edit team</button>
  <div id="team-dialog" role="dialog" aria-modal="true" aria-labelledby="team-heading" hidden>
    <h2 id="team-heading">Edit team</h2>
    <label for="team-name">Team name</label>
    <input id="team-name" value="Growth">
    <button id="team-save">Save</button>
    <button id="cancel">Cancel</button>
  </div>
  <div id="proof" role="status"></div>
</main>`,
        script: `
const dialog = document.querySelector('#team-dialog');
document.querySelector('#open-team').addEventListener('click', () => { dialog.hidden = false; });
document.querySelector('#cancel').addEventListener('click', () => { dialog.hidden = true; });
document.querySelector('#profile-save').addEventListener('click', () => {
  document.querySelector('#proof').textContent = 'Personal profile saved';
});
document.querySelector('#team-save').addEventListener('click', () => {
  document.querySelector('#proof').textContent = 'Team settings saved';
  dialog.hidden = true;
});`,
      }),
    },
  ],
  expectation: {
    journeyId: "edit-team",
    startScreen: "profile-settings",
    targetControl: "Save inside Edit team dialog",
    successText: "Team settings saved",
    expectedCompatibility: "SDK_DIRECT",
  },
};
