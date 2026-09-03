# @sable/web-sdk

Framework-neutral browser runtime for the Sable agent. It observes and acts in
the end user's current logged-in page. It contains no Playwright, LiveBox,
Node.js, client-specific workflow, or remotely supplied JavaScript.

## npm integration

```ts
import { createSableAgent } from "@sable/web-sdk";
import { mountSableUi } from "@sable/web-sdk-ui";

const agent = await createSableAgent({
  installationId: "install_123",
  apiBaseUrl: "https://sdk.sable.example/",
  tokenProvider: async (signal) => {
    const response = await fetch("/api/sable-token", { signal });
    if (!response.ok) throw new Error("Sable identity token request failed");
    return response.text();
  },
  catalogTrustKeys: [{ keyId: "sable-production-1", algorithm: "ES256", jwk: publicJwk }],
});

mountSableUi(agent, { title: "Product guide", greeting: "How can I help?" });
```

`createSableAgent()` is idempotent per installation ID. Call `shutdown()` on
logout or when removing the host application. Use `stop()` to interrupt only
the current journey.

## Script integration

The browser build exposes `Sable.init()` and the optional UI build exposes
`SableUI.mountSableUi()`:

```html
<script src="https://cdn.example/sable/0.1.0/sable.min.js"></script>
<script src="https://cdn.example/sable/0.1.0/sable-ui.min.js"></script>
<script nonce="CLIENT_NONCE">
  Sable.init({
    installationId: "install_123",
    apiBaseUrl: "https://sdk.sable.example/",
    tokenProvider: async signal => {
      const response = await fetch("/api/sable-token", { signal });
      if (!response.ok) throw new Error("Sable identity token request failed");
      return response.text();
    },
    catalogTrustKeys: window.SABLE_CATALOG_PUBLIC_KEYS,
    distribution: "script"
  }).then(agent => SableUI.mountSableUi(agent, { styleNonce: "CLIENT_NONCE" }));
</script>
```

Pin both file versions and publish Subresource Integrity hashes. The client CSP
must allow the pinned CDN under `script-src` and the SDK HTTPS/WSS domains under
`connect-src`. No permanent installation credential belongs in browser code.

## Network contract

- `POST /api/v3/sdk/sessions`: bootstrap with a short-lived identity token.
- `GET /api/v3/sdk/catalog`: fetch a signed catalog using the session bearer.
- `POST /api/v3/sdk/events`: send a redacted telemetry batch.
- `DELETE /api/v3/sdk/session`: close the session.
- WebSocket ticket protocol: `sable.ticket.<base64url(UTF8(ticket))>`.

Catalogs are verified against configured public keys, scoped to the current
tenant/product/environment/role/origin, and pinned for the session. Commands can
only name signed journeys; they cannot carry selectors, coordinates, or code.

## Same-tab continuity

SPA transitions caused by the product's own controls and same-document/hash
navigation stay in the current SDK session. Final chat messages and a bounded
read-only journey checkpoint are saved in `sessionStorage` for 30 minutes idle
and at most eight hours. They are scoped to the installation, user, role,
catalog version, origin and browser tab. Scope changes, logout, expiry,
corruption or a catalog update clear the checkpoint.

A full-document step is executable only when the signed catalog classifies it
as `SDK_RESUMABLE_NAVIGATION` and provides exact destination origins and trained
screen IDs. The destination reloads the SDK, recognizes the page from the
catalog, restores the overlay and asks the runtime to resume at the next step.
Cross-origin destinations use a two-minute, one-use opaque URL-fragment token;
the token is removed immediately and the actual snapshot stays in the runtime.

This mechanism is intentionally read-only. Form submission, saving, deletion,
payment and other cross-page writes remain blocked until they have server-side
idempotency and action receipts.

Every source and destination page must load the same pinned SDK/UI, expose the
same-origin `/api/sable-token` endpoint, and be included in the installation's
allowed origins. Call `agent.stop("logout")` before shutdown on logout so both
browser and server continuity are cleared.
