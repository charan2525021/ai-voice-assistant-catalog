import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, createHmac } from "node:crypto";

export interface ObjectStore {
  put(key: string, data: Uint8Array | string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
}

export class MemoryObjectStore implements ObjectStore {
  private values = new Map<string, Uint8Array>();
  async put(key: string, data: Uint8Array | string): Promise<void> {
    this.values.set(key, typeof data === "string" ? Buffer.from(data) : new Uint8Array(data));
  }
  async get(key: string): Promise<Uint8Array | null> {
    const value = this.values.get(key);
    return value ? new Uint8Array(value) : null;
  }
}

/** Development object store. The key validation is shared with cloud adapters. */
export class LocalObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}
  private file(key: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(key) || key.includes("..")) throw new Error("invalid object key");
    return path.join(this.root, key);
  }
  async put(key: string, data: Uint8Array | string): Promise<void> {
    const file = this.file(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, data);
    await fs.rename(temporary, file);
  }
  async get(key: string): Promise<Uint8Array | null> {
    return fs.readFile(this.file(key)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  }
}

const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const hmac = (key: Uint8Array | string, value: string) => createHmac("sha256", key).update(value).digest();

/** Dependency-free AWS Signature V4 adapter for S3, MinIO and compatible stores. */
export class S3ObjectStore implements ObjectStore {
  constructor(private readonly options: {
    endpoint: string;
    bucket: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  }) {}

  private url(key: string): URL {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(key) || key.includes("..")) throw new Error("invalid object key");
    const endpoint = this.options.endpoint.endsWith("/") ? this.options.endpoint : `${this.options.endpoint}/`;
    return new URL(`${encodeURIComponent(this.options.bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`, endpoint);
  }

  private async request(method: "GET" | "PUT", key: string, data: Uint8Array = new Uint8Array()): Promise<Response> {
    const url = this.url(key);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const date = amzDate.slice(0, 8);
    const payloadHash = sha256(data);
    const headers: Record<string, string> = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };
    if (this.options.sessionToken) headers["x-amz-security-token"] = this.options.sessionToken;
    const signedHeaders = Object.keys(headers).sort().join(";");
    const canonicalHeaders = Object.keys(headers).sort().map((name) => `${name}:${headers[name].trim()}\n`).join("");
    const canonical = [method, url.pathname, url.searchParams.toString(), canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const scope = `${date}/${this.options.region}/s3/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
    const kDate = hmac(`AWS4${this.options.secretAccessKey}`, date);
    const kRegion = hmac(kDate, this.options.region);
    const kService = hmac(kRegion, "s3");
    const kSigning = hmac(kService, "aws4_request");
    const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");
    const authorization = `AWS4-HMAC-SHA256 Credential=${this.options.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return fetch(url, {
      method,
      headers: { ...headers, authorization },
      ...(method === "PUT" ? { body: Buffer.from(data) } : {}),
      signal: AbortSignal.timeout(Math.max(1000, Number(process.env.OBJECT_STORE_TIMEOUT_MS ?? 10_000))),
    });
  }

  async put(key: string, data: Uint8Array | string): Promise<void> {
    const bytes = typeof data === "string" ? Buffer.from(data) : data;
    const response = await this.request("PUT", key, bytes);
    if (!response.ok) throw new Error(`object store PUT failed: HTTP ${response.status}`);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const response = await this.request("GET", key);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`object store GET failed: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}
