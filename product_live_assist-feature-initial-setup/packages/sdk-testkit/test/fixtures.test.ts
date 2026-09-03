import assert from "node:assert/strict";
import test from "node:test";
import {
  browserFixtures,
  crossOriginIframeFixture,
  findFixtureRoute,
  getBrowserFixture,
  materializeFixture,
  privateFieldsFixture,
} from "../src/fixtures/index.js";

test("all browser fixture IDs and routes are unique", () => {
  const ids = browserFixtures.map((fixture) => fixture.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.length >= 14);

  for (const fixture of browserFixtures) {
    const routeKeys = fixture.routes.map(
      (route) => `${route.origin ?? "primary"}:${route.path}`,
    );
    assert.equal(new Set(routeKeys).size, routeKeys.length, fixture.id);
    assert.ok(findFixtureRoute(fixture, fixture.initialPath), fixture.id);
  }
});

test("cross-origin fixture materializes independent origins", () => {
  const fixture = materializeFixture(crossOriginIframeFixture, {
    primaryOrigin: "https://primary.test",
    secondaryOrigin: "https://frame.test",
  });
  const parent = findFixtureRoute(fixture, "/frames/cross");
  const frame = findFixtureRoute(fixture, "/frames/cross/content", "secondary");
  assert.match(parent!.html, /https:\/\/frame\.test\/frames\/cross\/content/);
  assert.equal(frame!.headers?.["access-control-allow-origin"], "https://primary.test");
});

test("private fixture declares every value that must never leave the browser", () => {
  const route = privateFieldsFixture.routes[0]!;
  for (const value of privateFieldsFixture.expectation.privateValues ?? []) {
    assert.ok(route.html.includes(value));
  }
});

test("unknown fixture names fail clearly", () => {
  assert.equal(getBrowserFixture("semantic-html").id, "semantic-html");
  assert.throws(() => getBrowserFixture("missing"), /Unknown SDK browser fixture/);
});
