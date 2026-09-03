# `@sable/sdk-testkit`

This package tests the Web SDK without importing the training mapper, LiveBox,
the production server, or a client application. It provides:

- signed and deliberately invalid SDK catalog fixtures;
- an in-memory Fetch-compatible mock of the SDK cloud APIs;
- small browser fixtures for difficult DOM and browser cases; and
- a Playwright-compatible supervisor guard that rejects browser actions after
  SDK execution starts.

The testkit intentionally uses only the public, data-only contract package.
Consumers can pass the catalog objects to `@sable/sdk-contracts` validators and inject the returned
`fetch` and `webSocketFactory` functions into `@sable/web-sdk` without coupling
the testkit to either package's internal implementation. Catalogs, bootstrap
requests/responses, telemetry batches, socket subprotocols, and server commands
use the public `@sable/sdk-contracts` types exactly. Fixture digests and
signatures use the shared canonical JSON serializer.

```ts
const cloud = createMockCloud({
  commands: [createMockRunJourneyCommand()],
});

const agent = await createSableAgent({
  installationId: "installation-fixture",
  apiBaseUrl: cloud.baseUrl,
  tokenProvider: async () => cloud.identityToken,
  trustKeys: [{
    keyId: cloud.getEnvelope().signature.keyId,
    algorithm: "ES256",
    jwk: cloud.getSigningKeys().publicJwk,
  }],
  fetcher: cloud.fetch,
  webSocketFactory: cloud.webSocketFactory,
});
```

## Supervisor-only browser tests

```ts
const guard = createSupervisorOnlyGuard(rawPage);

await guard.page.goto(fixtureUrl);
await injectBuiltSdk(guard.page);
guard.startSdkExecution();

await guard.page.evaluate(() => window.Sable.runJourney("create-project"));

// Observation remains allowed.
await guard.page.screenshot();

// This throws SupervisorActionViolation.
await guard.page.getByRole("button", { name: "Create" }).click();
```

The raw Playwright page must not be retained after wrapping it. The guard
blocks page, locator, frame-locator, mouse, keyboard, and touchscreen action
APIs while allowing navigation during setup and observation during replay.

## Fixture hosting

Each `BrowserFixture` contains one or more routes. A test runner may host these
routes with any static test server. `materializeFixture` substitutes the
primary and secondary origins, and `findFixtureRoute` resolves a request path.
Cross-origin fixtures deliberately describe routes for two origins instead of
starting a server inside this package.
