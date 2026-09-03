import assert from "node:assert/strict";
import { assessProductAccess, looksLikeAuthenticationUrl } from "./access.js";

const snap = (url: string, elements: any[] = []) => ({ url, title: "Product", elements });

assert.equal(looksLikeAuthenticationUrl("https://app.example.com/login"), true);
assert.equal(looksLikeAuthenticationUrl("https://app.example.com/dashboard"), false);

assert.equal(
  assessProductAccess("https://app.example.com/dashboard", snap("https://app.example.com/dashboard"), true).ok,
  true,
  "an authenticated dashboard should pass",
);

assert.equal(
  assessProductAccess("https://app.example.com/dashboard", snap("https://app.example.com/login"), true).ok,
  false,
  "an email-first login URL must fail even before a password field appears",
);

assert.equal(
  assessProductAccess("https://app.example.com/dashboard", snap("https://app.example.com/", [
    { tag: "input", role: "textbox", type: "email", name: "Email" },
    { tag: "button", role: "button", type: "", name: "Sign in" },
  ])).authenticationSurface,
  true,
  "a generic identity form should be recognised without product selectors",
);

assert.equal(
  assessProductAccess("https://app.example.com/dashboard", snap("https://login.vendor.test/authorize"), true).ok,
  false,
  "an authenticated product must not silently leave its product origin",
);

assert.equal(
  assessProductAccess("https://app.example.com/dashboard", snap("https://app.example.com/dashboard/home"), true).ok,
  true,
  "ordinary same-origin product routing must not be mistaken for logout",
);

console.log("access gate tests passed");
