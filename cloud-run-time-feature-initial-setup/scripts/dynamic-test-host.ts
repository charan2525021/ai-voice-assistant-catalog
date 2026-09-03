/**
 * Generic dynamic-mode test host. Serves the compiled Sable SDK bundle, mints
 * short-lived identity tokens without ever exposing the permanent installation
 * credential to the browser, and proxies HTTP + WebSocket to the cloud runtime
 * running locally.
 *
 * Unlike `client-catalogs/niroggyan-brochure/live-test-host.ts` this host is
 * intentionally client-agnostic: point it at any web app by setting
 * `DYNAMIC_TEST_ORIGIN`, and the same host serves any installation that has
 * `dynamicMode.enabled = true`.
 *
 * Required env:
 *   DYNAMIC_TEST_ORIGIN            Origin allowed to mount (`https://your.app`).
 *   DYNAMIC_INSTALLATION_SECRETS   Path to the JSON produced by
 *                                  `scripts/generate-dynamic-installation.ts`.
 *   DYNAMIC_TEST_BROKER_SECRET     32+ hex string; guards /injection.js and
 *                                  /api/sable-token.
 * Optional env:
 *   DYNAMIC_TEST_HOST_PORT         Default 8790.
 *   DYNAMIC_TEST_ASSET_URL         Public URL where this host is reachable.
 *                                  Defaults to http://127.0.0.1:<port>.
 *                                  Set to your cloudflared tunnel to allow the
 *                                  browser on the target origin to fetch the
 *                                  bundle over HTTPS.
 *   PUBLIC_API_URL                 Public URL of the cloud runtime the browser
 *                                  will call for /api/v3/sdk/*. Defaults to
 *                                  the asset URL above.
 *   RUNTIME_INTERNAL_URL           Internal cloud runtime URL to proxy to.
 *                                  Default http://127.0.0.1:8787.
 *   DYNAMIC_TEST_USER_ID           Default "dynamic-tester".
 *   DYNAMIC_TEST_ROLE              Default the first allowedRole on the
 *                                  installation, or "guest".
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(here, "..");

const secretsPath = process.env.DYNAMIC_INSTALLATION_SECRETS;
if (!secretsPath) throw new Error("DYNAMIC_INSTALLATION_SECRETS must point at the JSON produced by generate-dynamic-installation.ts");
const secretsRaw = await readFile(resolve(secretsPath), "utf8");
const secrets = JSON.parse(secretsRaw) as {
  installationId: string;
  installationCredential: string;
  publicKeys: Array<{ keyId: string; algorithm: string; jwk: unknown }>;
  allowedOrigins: string[];
  allowedRoles: string[];
  organizationId: string;
  productId: string;
  environmentId: string;
};

const brokerSecret = String(process.env.DYNAMIC_TEST_BROKER_SECRET ?? "");
if (brokerSecret.length < 24) throw new Error("DYNAMIC_TEST_BROKER_SECRET must be at least 24 characters");

const allowedOrigin = String(process.env.DYNAMIC_TEST_ORIGIN ?? "");
if (!allowedOrigin) throw new Error("DYNAMIC_TEST_ORIGIN is required");
if (!secrets.allowedOrigins.includes(allowedOrigin)) {
  throw new Error(`Installation allowedOrigins does not include ${allowedOrigin}. Regenerate with the correct origin.`);
}

const hostPort = Number(process.env.DYNAMIC_TEST_HOST_PORT ?? 8790);
const runtimeInternalUrl = String(process.env.RUNTIME_INTERNAL_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const publicAssetUrl = String(process.env.DYNAMIC_TEST_ASSET_URL ?? `http://127.0.0.1:${hostPort}`).replace(/\/$/, "");
const publicApiUrl = String(process.env.PUBLIC_API_URL ?? publicAssetUrl).replace(/\/$/, "");
const userId = String(process.env.DYNAMIC_TEST_USER_ID ?? "dynamic-tester");
const roleProfileId = String(process.env.DYNAMIC_TEST_ROLE ?? secrets.allowedRoles[0] ?? "guest");

const runtimeEndpoint = new URL(runtimeInternalUrl);

const sdkPath = resolve(runtimeRoot, "../product_live_assist/packages/web-sdk/dist/sable.min.js");
const uiPath = resolve(runtimeRoot, "../product_live_assist/packages/web-sdk-ui/dist/sable-ui.min.js");

const runtimeConfig = {
  installationId: secrets.installationId,
  apiBaseUrl: publicApiUrl,
  catalogTrustKeys: secrets.publicKeys,
  organizationId: secrets.organizationId,
  productId: secrets.productId,
  environmentId: secrets.environmentId,
};

const cors = (origin: string | undefined): Record<string, string> => origin === allowedOrigin ? {
  "access-control-allow-origin": allowedOrigin,
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type,authorization,x-sable-test-key",
  vary: "Origin",
} : {};

const send = (
  response: import("node:http").ServerResponse,
  status: number,
  type: string,
  body: string | Buffer,
  headers: Record<string, string> = {},
) => {
  response.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(body);
};

const readRequestBody = async (request: import("node:http").IncomingMessage): Promise<Buffer | undefined> => {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method ?? "GET")) return undefined;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > 1_000_000) throw new Error("Runtime proxy request exceeded the 1 MB test limit");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
};

const proxyRuntimeHttp = async (
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  url: URL,
) => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (!value || ["host", "connection", "content-length"].includes(name.toLowerCase())) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const body = await readRequestBody(request);
  const upstream = await fetch(new URL(`${url.pathname}${url.search}`, runtimeEndpoint), {
    method: request.method,
    headers,
    body: body ? new Uint8Array(body) : undefined,
  });
  const responseHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, name) => {
    if (!["connection", "content-length", "transfer-encoding"].includes(name.toLowerCase())) responseHeaders[name] = value;
  });
  const buf = Buffer.from(await upstream.arrayBuffer());
  const origin = String(request.headers.origin ?? "");
  send(response, upstream.status, responseHeaders["content-type"] ?? "application/octet-stream", buf, { ...responseHeaders, ...cors(origin) });
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${hostPort}`);
    const origin = String(request.headers.origin ?? "");
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors(origin));
      response.end();
      return;
    }
    if (url.pathname === "/healthz") return send(response, 200, "application/json", JSON.stringify({ ok: true }));
    if (url.pathname === "/sable.min.js") return send(response, 200, "text/javascript; charset=utf-8", await readFile(sdkPath), cors(origin));
    if (url.pathname === "/sable-ui.min.js") return send(response, 200, "text/javascript; charset=utf-8", await readFile(uiPath), cors(origin));
    if (url.pathname === "/runtime-config.generated.json") return send(response, 200, "application/json", JSON.stringify(runtimeConfig), cors(origin));
    if (url.pathname === "/api/sable-token") {
      if (request.method !== "POST") return send(response, 405, "text/plain", "POST required");
      if (String(request.headers["x-sable-test-key"] ?? "") !== brokerSecret) return send(response, 401, "text/plain", "Test broker key is invalid");
      const identity = await fetch(new URL("/api/v3/sdk/identity-tokens", runtimeEndpoint), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `SableInstallation ${secrets.installationCredential}`,
        },
        body: JSON.stringify({ installationId: secrets.installationId, userId, roleProfileId, origin: allowedOrigin }),
      });
      if (!identity.ok) {
        const text = await identity.text();
        return send(response, identity.status, "application/json", text, cors(origin));
      }
      const payload = (await identity.json()) as { identityToken: string };
      return send(response, 200, "application/json", JSON.stringify({ identityToken: payload.identityToken }), cors(origin));
    }
    if (url.pathname === "/injection.js") {
      if (url.searchParams.get("key") !== brokerSecret) return send(response, 401, "text/plain", "Test broker key is invalid");
      const voiceEnabled = url.searchParams.get("voice") !== "0";
      const script = `;(async()=>{\n` +
        `if(location.origin!==${JSON.stringify(allowedOrigin)})throw new Error("Wrong host origin for Sable dynamic-mode test");\n` +
        `const host=${JSON.stringify(publicAssetUrl)},key=${JSON.stringify(brokerSecret)};\n` +
        `const load=src=>new Promise((resolve,reject)=>{const s=document.createElement("script");s.src=src;s.onload=resolve;s.onerror=()=>reject(new Error("Could not load "+src));document.head.appendChild(s)});\n` +
        `await load(host+"/sable.min.js");await load(host+"/sable-ui.min.js");\n` +
        `const cfg=await fetch(host+"/runtime-config.generated.json").then(r=>{if(!r.ok)throw new Error("Runtime config failed");return r.json()});\n` +
        `if(window.__SABLE_DYNAMIC_TEST__?.agent)await window.__SABLE_DYNAMIC_TEST__.agent.shutdown().catch(()=>{});\n` +
        `const agent=await Sable.init({...cfg,voice:${voiceEnabled ? "true" : "false"},distribution:"script",dynamicMode:true,tokenProvider:async signal=>{const r=await fetch(host+"/api/sable-token",{method:"POST",signal,headers:{"x-sable-test-key":key}});if(!r.ok)throw new Error("Identity token failed");return (await r.json()).identityToken}});\n` +
        `const events=[],ui=SableUI.mountSableUi(agent,{initiallyOpen:true,greeting:"Ask me to click, fill, or navigate anything on this page.",onEvent:event=>{events.push({at:new Date().toISOString(),event});if(events.length>500)events.shift()}});\n` +
        `const test={agent,ui,events,snapshot:()=>agent.snapshot(),stop:()=>agent.stop("dynamic acceptance stopped")};window.__SABLE_DYNAMIC_TEST__=test;\n` +
        `console.info("Sable dynamic-mode test ready",{catalogVersionId:agent.snapshot().session?.catalogVersionId});\n` +
        `})().catch(error=>console.error("Sable dynamic-mode injection failed",error));\n`;
      return send(response, 200, "text/javascript; charset=utf-8", script, cors(origin));
    }
    if (url.pathname.startsWith("/api/v3/sdk/")) return await proxyRuntimeHttp(request, response, url);
    return send(response, 404, "text/plain", "Not found");
  } catch (error) {
    return send(response, 500, "application/json", JSON.stringify({ error: error instanceof Error ? error.message : "Dynamic test host failed" }));
  }
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${hostPort}`);
  if (!["/ws/sdk", "/ws/sdk/voice"].includes(url.pathname) || runtimeEndpoint.protocol !== "http:") {
    socket.destroy();
    return;
  }
  const upstream = connect(Number(runtimeEndpoint.port || 80), runtimeEndpoint.hostname);
  upstream.once("connect", () => {
    const forwardedHeaders: string[] = [];
    for (const [name, value] of Object.entries(request.headers)) {
      if (!value || name.toLowerCase() === "host") continue;
      for (const item of Array.isArray(value) ? value : [value]) forwardedHeaders.push(`${name}: ${item}`);
    }
    upstream.write([
      `${request.method ?? "GET"} ${url.pathname}${url.search} HTTP/${request.httpVersion}`,
      `host: ${runtimeEndpoint.host}`,
      ...forwardedHeaders,
      "",
      "",
    ].join("\r\n"));
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  const close = () => {
    if (!socket.destroyed) socket.destroy();
    if (!upstream.destroyed) upstream.destroy();
  };
  upstream.once("error", close);
  socket.once("error", close);
});

server.listen(hostPort, "127.0.0.1", () => {
  const params = new URLSearchParams({ key: brokerSecret, voice: "1" });
  console.log(`Sable dynamic-mode test host: http://127.0.0.1:${hostPort}`);
  console.log(`Allowed origin: ${allowedOrigin}`);
  console.log(`Public asset URL: ${publicAssetUrl}`);
  console.log(`Public API URL:   ${publicApiUrl}`);
  console.log(`Installation:     ${secrets.installationId}`);
  console.log(`Injection URL:    ${publicAssetUrl}/injection.js?${params.toString()}`);
});
