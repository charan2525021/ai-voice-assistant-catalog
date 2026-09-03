/**
 * Ephemeral Phase 6.5C host for the real brochure acceptance test.
 *
 * It serves the already-built SDK/UI bundles and mints short-lived identity
 * tokens without ever exposing the permanent installation credential to the
 * brochure page. Run this only for a bounded local test and tunnel this port
 * separately from the cloud runtime port.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NIROGGYAN_BROCHURE_ROUTE_MARKERS,
  NIROGGYAN_CLIENT_ROUTER_TOOL_DEFINITION,
} from "./client-router-tool.js";

const here = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(process.env.BROCHURE_TEST_RUNTIME_DIR ?? resolve(here, "../.."));
const allowedOrigin = "https://www.brochure.niroggyan.com";
const hostPort = Number(process.env.BROCHURE_TEST_HOST_PORT ?? 8790);
const publicAssetUrl = String(process.env.BROCHURE_TEST_ASSET_URL ?? "").replace(/\/$/, "");
const publicApiUrl = String(process.env.PUBLIC_API_URL ?? "").replace(/\/$/, "");
const runtimeInternalUrl = String(process.env.RUNTIME_INTERNAL_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const brokerSecret = String(process.env.BROCHURE_TEST_BROKER_SECRET ?? "");
if (!publicAssetUrl.startsWith("https://")) throw new Error("BROCHURE_TEST_ASSET_URL must be the HTTPS Cloudflare tunnel for this host");
if (!publicApiUrl.startsWith("https://")) throw new Error("PUBLIC_API_URL must be the HTTPS Cloudflare tunnel for the cloud runtime");
if (brokerSecret.length < 24) throw new Error("BROCHURE_TEST_BROKER_SECRET must contain at least 24 characters");

const artifactDir = resolve(runtimeRoot, "client-catalogs/niroggyan-brochure/guided-demo-test");
const secretsPath = resolve(runtimeRoot, "data/niroggyan-brochure-guided-demo-secrets.generated.json");
const sdkPath = resolve(runtimeRoot, "../product_live_assist/packages/web-sdk/dist/sable.min.js");
const uiPath = resolve(runtimeRoot, "../product_live_assist/packages/web-sdk-ui/dist/sable-ui.min.js");
const baseConfig = JSON.parse(await readFile(resolve(artifactDir, "runtime-config.generated.json"), "utf8")) as Record<string, unknown>;
const runtimeEndpoint = new URL(runtimeInternalUrl);

const cors = (origin: string | undefined): Record<string, string> => origin === allowedOrigin ? {
  "access-control-allow-origin": allowedOrigin,
  "access-control-allow-methods": "GET,OPTIONS",
  "access-control-allow-headers": "content-type,x-sable-test-key",
  vary: "Origin",
} : {};
const send = (response: import("node:http").ServerResponse, status: number, type: string, body: string | Buffer, headers: Record<string, string> = {}) => {
  response.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
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
  const requestBody = await readRequestBody(request);
  const result = await fetch(new URL(`${url.pathname}${url.search}`, runtimeEndpoint), {
    method: request.method,
    headers,
    body: requestBody ? new Uint8Array(requestBody) : undefined,
  });
  const responseHeaders: Record<string, string> = {};
  result.headers.forEach((value, name) => {
    if (!["connection", "content-length", "transfer-encoding"].includes(name.toLowerCase())) responseHeaders[name] = value;
  });
  response.writeHead(result.status, responseHeaders);
  response.end(Buffer.from(await result.arrayBuffer()));
};

const server = createServer(async (request, response) => {
  try {
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${hostPort}`);
    if (url.pathname.startsWith("/api/v3/")) return await proxyRuntimeHttp(request, response, url);
    if (request.method === "OPTIONS") {
      if (origin !== allowedOrigin) return send(response, 403, "text/plain", "Origin not allowed");
      return send(response, 204, "text/plain", "", cors(origin));
    }
    if (request.method !== "GET") return send(response, 405, "text/plain", "Method not allowed");

    if (url.pathname === "/healthz") return send(response, 200, "application/json", JSON.stringify({ ok: true }));
    if (url.pathname === "/sable.min.js") return send(response, 200, "text/javascript; charset=utf-8", await readFile(sdkPath));
    if (url.pathname === "/sable-ui.min.js") return send(response, 200, "text/javascript; charset=utf-8", await readFile(uiPath));
    if (url.pathname === "/runtime-config.generated.json") {
      return send(response, 200, "application/json", JSON.stringify({ ...baseConfig, apiBaseUrl: publicApiUrl }), cors(origin));
    }
    if (url.pathname === "/api/sable-token") {
      if (origin !== allowedOrigin) return send(response, 403, "application/json", JSON.stringify({ error: "Origin not allowed" }));
      if (request.headers["x-sable-test-key"] !== brokerSecret) return send(response, 401, "application/json", JSON.stringify({ error: "Test broker key is invalid" }), cors(origin));
      const secrets = JSON.parse(await readFile(secretsPath, "utf8")) as { installationId: string; installationCredential: string };
      const result = await fetch(`${runtimeInternalUrl}/api/v3/sdk/identity-tokens`, {
        method: "POST",
        headers: { authorization: `SableInstallation ${secrets.installationCredential}`, "content-type": "application/json" },
        body: JSON.stringify({ installationId: secrets.installationId, userId: "brochure-live-acceptance", roleProfileId: "public", origin: allowedOrigin }),
      });
      return send(response, result.status, "application/json", await result.text(), cors(origin));
    }
    if (url.pathname === "/injection.js") {
      if (url.searchParams.get("key") !== brokerSecret) return send(response, 401, "text/plain", "Test broker key is invalid");
      const isolatedJourneyTest = url.searchParams.get("isolated") === "1";
      const automaticPersona = ["lab", "hospital", "default"].includes(url.searchParams.get("auto") ?? "")
        ? url.searchParams.get("auto") as "lab" | "hospital" | "default"
        : undefined;
      const voiceEnabled = url.searchParams.get("voice") !== "0" && !automaticPersona;
      const script = `;(async()=>{\n` +
        `if(location.origin!==${JSON.stringify(allowedOrigin)})throw new Error("Wrong brochure origin");\n` +
        `const host=${JSON.stringify(publicAssetUrl)},key=${JSON.stringify(brokerSecret)};\n` +
        `const load=src=>new Promise((resolve,reject)=>{const s=document.createElement("script");s.src=src;s.onload=resolve;s.onerror=()=>reject(new Error("Could not load "+src));document.head.appendChild(s)});\n` +
        `await load(host+"/sable.min.js");await load(host+"/sable-ui.min.js");\n` +
        `const cfg=await fetch(host+"/runtime-config.generated.json").then(r=>{if(!r.ok)throw new Error("Runtime config failed");return r.json()});\n` +
        `const routeMarkers=${JSON.stringify(NIROGGYAN_BROCHURE_ROUTE_MARKERS)},routerDefinition=${JSON.stringify(NIROGGYAN_CLIENT_ROUTER_TOOL_DEFINITION)};\n` +
        `const waitForRouteReady=(route,signal)=>new Promise((resolve,reject)=>{let deadlineTimer,settled=false;const marker=routeMarkers[route];const cleanup=()=>{clearTimeout(deadlineTimer);observer.disconnect();signal.removeEventListener("abort",onAbort)};const finish=error=>{if(settled)return;settled=true;cleanup();error?reject(error):resolve()};const ready=()=>location.pathname===route&&document.body&&document.body.innerText.includes(marker);const check=()=>{if(ready())finish()};const onAbort=()=>finish(new Error("Navigation was cancelled"));const observer=new MutationObserver(check);observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true});deadlineTimer=setTimeout(()=>finish(new Error("Brochure route marker did not appear: "+route)),7000);signal.addEventListener("abort",onAbort,{once:true});requestAnimationFrame(()=>requestAnimationFrame(check))});\n` +
        `const routerTool={definition:routerDefinition,execute:async(input,{signal})=>{const route=input&&typeof input==="object"&&typeof input.route==="string"?input.route:"";if(!routeMarkers[route])throw new Error("Route is outside the signed brochure allowlist");if(location.origin!==${JSON.stringify(allowedOrigin)})throw new Error("Current origin is not the approved brochure");if(signal.aborted)throw new Error("Navigation was cancelled");history.pushState({},"",route);dispatchEvent(new PopStateEvent("popstate"));scrollTo(0,0);if(location.pathname!==route)throw new Error("Brochure router did not accept the signed route: "+route);await waitForRouteReady(route,signal);return {route,navigated:true,stable:true}}};\n` +
        `const isolated=${JSON.stringify(isolatedJourneyTest)},automaticPersona=${JSON.stringify(automaticPersona)},voiceEnabled=${JSON.stringify(voiceEnabled)};\n` +
        `if(window.__SABLE_BROCHURE_TEST__?.agent)await window.__SABLE_BROCHURE_TEST__.agent.shutdown().catch(()=>{});\n` +
        `const agent=await Sable.init({...cfg,voice:voiceEnabled,distribution:"script",tools:[routerTool],...(isolated||automaticPersona?{continuity:false}:{}),tokenProvider:async signal=>{const r=await fetch(host+"/api/sable-token",{signal,headers:{"x-sable-test-key":key}});if(!r.ok)throw new Error("Identity token failed");return (await r.json()).identityToken}});\n` +
        `if(isolated){try{agent.controlDemo("stop")}catch{}}\n` +
        `const events=[],ui=SableUI.mountSableUi(agent,{initiallyOpen:true,greeting:"NirogGyan guided-demo acceptance test",onEvent:event=>{events.push({at:new Date().toISOString(),event});if(events.length>500)events.shift()}});\n` +
        `const test={agent,ui,events,automaticPersona,voiceEnabled,snapshot:()=>agent.snapshot(),stop:()=>agent.stop("live acceptance stopped")};window.__SABLE_BROCHURE_TEST__=test;\n` +
        `if(automaticPersona){const answers={lab:{"visitor-organisation":"I run a diagnostic laboratory","visitor-goal":"Show reporting, engagement, and ROI","lab-volume":"About 12000 reports each month"},hospital:{"visitor-organisation":"We are a hospital group","visitor-goal":"Show reporting and integrations","hospital-integration":"Our HIS and EHR matter most"},default:{"visitor-organisation":"I am exploring for a consulting team","visitor-goal":"Give me a complete overview"}}[automaticPersona],handled=new Set();let started=false;agent.subscribe(event=>{if(event.type!=="demo")return;const snapshot=event.snapshot;if(!started&&snapshot.controls.canStart){started=true;queueMicrotask(()=>agent.controlDemo("start"));return}if(snapshot.phase==="intake"&&snapshot.activeQuestionId&&!handled.has(snapshot.activeQuestionId)){const answer=answers[snapshot.activeQuestionId];if(answer){handled.add(snapshot.activeQuestionId);setTimeout(()=>agent.sendMessage(answer,"text"),250)}}});}\n` +
        `console.info("Sable brochure test ready",{automaticPersona,voiceEnabled,catalogVersionId:agent.snapshot().session?.catalogVersionId});\n` +
        `})().catch(error=>console.error("Sable brochure injection failed",error));\n`;
      return send(response, 200, "text/javascript; charset=utf-8", script);
    }
    return send(response, 404, "text/plain", "Not found");
  } catch (error) {
    return send(response, 500, "application/json", JSON.stringify({ error: error instanceof Error ? error.message : "Test host failed" }));
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
  console.log(`Brochure test asset/token host: http://127.0.0.1:${hostPort}`);
  console.log(`Manual injection URL: ${publicAssetUrl}/injection.js?key=${encodeURIComponent(brokerSecret)}&voice=1`);
  console.log(`Automated lab demo URL: ${publicAssetUrl}/injection.js?key=${encodeURIComponent(brokerSecret)}&auto=lab&voice=0`);
});
