import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const port = Number(process.env.SAMPLE_APP_PORT ?? 4173);
const publicDir = resolve("sample-app/public");
const sdkDir = resolve("../product_live_assist/packages");
const runtime = process.env.PUBLIC_API_URL ?? "http://localhost:8787";
const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".css": "text/css" };

createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? "/", `http://localhost:${port}`).pathname;
    if (pathname === "/api/sable-token") {
      const secrets = JSON.parse(await readFile("data/sample-secrets.generated.json", "utf8")) as { installationId: string; installationCredential: string };
      const result = await fetch(`${runtime}/api/v3/sdk/identity-tokens`, { method: "POST", headers: { authorization: `SableInstallation ${secrets.installationCredential}`, "content-type": "application/json" }, body: JSON.stringify({ installationId: secrets.installationId, userId: "sample-user", roleProfileId: "member", origin: `http://localhost:${port}` }) });
      response.writeHead(result.status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(await result.text()); return;
    }
    const asset = pathname === "/sable.min.js" ? join(sdkDir, "web-sdk/dist/sable.min.js") : pathname === "/sable-ui.min.js" ? join(sdkDir, "web-sdk-ui/dist/sable-ui.min.js") : join(publicDir, pathname === "/" ? "index.html" : pathname.replace(/^\//, ""));
    if (!asset.startsWith(publicDir) && !asset.startsWith(sdkDir)) throw new Error("invalid path");
    const body = await readFile(asset); response.writeHead(200, { "content-type": mime[extname(asset)] ?? "application/octet-stream", "cache-control": "no-store" }); response.end(body);
  } catch { response.writeHead(404); response.end("Not found"); }
}).listen(port, "127.0.0.1", () => console.log(`Sample product: http://localhost:${port}`));
