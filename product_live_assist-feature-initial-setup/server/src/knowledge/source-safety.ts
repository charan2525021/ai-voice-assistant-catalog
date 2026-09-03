import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

function privateIpv4(address: string): boolean {
  const p = address.split(".").map(Number);
  return p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168);
}

function privateIp(address: string): boolean {
  if (isIP(address) === 4) return privateIpv4(address);
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:")) return privateIpv4(lower.slice(7));
  return lower === "::" || lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe8") ||
    lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb");
}

/** Block credentialed, local, metadata-service, and private-network sources. */
export async function assertSafeKnowledgeUrl(value: string): Promise<URL> {
  const url = new URL(value);
  const insecureAllowed = process.env.ALLOW_INSECURE_KNOWLEDGE_HTTP === "true";
  if (url.protocol !== "https:" && !(insecureAllowed && url.protocol === "http:")) {
    throw new Error("knowledge sources must use HTTPS");
  }
  if (url.username || url.password) throw new Error("knowledge source URLs cannot contain credentials");
  if (["localhost", "localhost.localdomain"].includes(url.hostname.toLowerCase())) throw new Error("private knowledge source host is not allowed");
  const addresses = isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((item) => privateIp(item.address))) throw new Error("private knowledge source address is not allowed");
  return url;
}

export async function fetchKnowledgeText(value: string, timeoutMs = 20_000, maxBytes = 5 * 1024 * 1024) {
  let current = value;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const safe = await assertSafeKnowledgeUrl(current);
    const response = await fetch(safe, {
      redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "AidanKnowledgeSync/1.0", accept: "text/html,application/xhtml+xml,application/xml,text/plain" },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`knowledge redirect ${response.status} has no location`);
      current = new URL(location, safe).toString();
      continue;
    }
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > maxBytes) throw new Error(`knowledge source exceeds ${maxBytes} bytes`);
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > maxBytes) { await reader.cancel(); throw new Error(`knowledge source exceeds ${maxBytes} bytes`); }
        chunks.push(next.value);
      }
    }
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    return { ok: response.ok, status: response.status, body: bytes.toString("utf8"), url: safe.toString() };
  }
  throw new Error("knowledge source redirected too many times");
}
