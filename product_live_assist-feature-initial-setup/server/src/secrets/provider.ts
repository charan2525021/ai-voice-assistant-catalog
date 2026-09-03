import { promises as fs } from "node:fs";
import path from "node:path";

export interface SecretValue {
  username?: string;
  password?: string;
  sessionState?: string;
  sessionStorage?: string;
  profileDir?: string;
  metadata?: Record<string, string>;
}

export interface SecretProvider {
  readonly name: string;
  get(path: string): Promise<SecretValue | null>;
  put?(path: string, value: SecretValue): Promise<void>;
}

/** Development-only provider. Production should use a KMS-backed provider. */
export class EnvironmentSecretProvider implements SecretProvider {
  readonly name = "environment";
  constructor(private readonly prefix = "AIDAN_SECRET_") {}
  async get(path: string): Promise<SecretValue | null> {
    const key = `${this.prefix}${path.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`;
    const raw = process.env[key];
    if (!raw) return null;
    try { return JSON.parse(raw) as SecretValue; }
    catch { throw new Error(`${key} must contain a JSON secret object`); }
  }
}

/**
 * Local-UAT provider for captured browser sessions.
 *
 * Each reference is a product-neutral directory key and resolves to
 * `<root>/<key>/.auth.local.json`.  It is deliberately read-only, opt-in, and
 * rejects permissive or symlinked files. Production deployments should leave
 * LOCAL_SECRET_ROOT unset and use Vault/KMS instead.
 */
export class LocalFileSecretProvider implements SecretProvider {
  readonly name = "local-file";
  private readonly root: string;

  constructor(root: string) {
    if (!root.trim()) throw new Error("local secret root is required");
    this.root = path.resolve(root);
  }

  async get(secretPath: string): Promise<SecretValue | null> {
    const file = path.resolve(this.root, ...secretPath.split("/"), ".auth.local.json");
    const prefix = this.root.endsWith(path.sep) ? this.root : `${this.root}${path.sep}`;
    if (!file.startsWith(prefix)) throw new Error("local secret path escapes its configured root");
    const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) return null;
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("local secret must be a regular file");
    if ((stat.mode & 0o077) !== 0) throw new Error("local secret permissions must be 0600");

    const [realRoot, realFile] = await Promise.all([fs.realpath(this.root), fs.realpath(file)]);
    const realPrefix = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`;
    if (!realFile.startsWith(realPrefix)) throw new Error("local secret resolves outside its configured root");
    const parsed = JSON.parse(await fs.readFile(realFile, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("local secret must contain a JSON object");
    return parsed as SecretValue;
  }
}

/** HashiCorp Vault-compatible HTTP provider; its token is never logged. */
export class VaultSecretProvider implements SecretProvider {
  readonly name = "vault";
  constructor(private readonly baseUrl: string, private readonly token: () => string, private readonly mount = "secret") {}
  async get(path: string): Promise<SecretValue | null> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/v1/${this.mount}/data/${path.replace(/^\//, "")}`, {
      headers: { "x-vault-token": this.token() },
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`secret provider returned ${response.status}`);
    const body = await response.json() as any;
    return body?.data?.data ?? null;
  }
  async put(path: string, value: SecretValue): Promise<void> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/v1/${this.mount}/data/${path.replace(/^\//, "")}`, {
      method: "POST", headers: { "x-vault-token": this.token(), "content-type": "application/json" },
      body: JSON.stringify({ data: value }), signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`secret provider returned ${response.status}`);
  }
}

export class SecretProviderRegistry {
  private providers = new Map<string, SecretProvider>();
  register(provider: SecretProvider): void { this.providers.set(provider.name, provider); }
  async resolve(ref: { provider: string; secretPath: string; expiresAt?: string }): Promise<SecretValue> {
    if (ref.expiresAt && new Date(ref.expiresAt).getTime() <= Date.now()) {
      throw new Error("credential reference has expired");
    }
    const provider = this.providers.get(ref.provider);
    if (!provider) throw new Error(`secret provider "${ref.provider}" is not configured`);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/.test(ref.secretPath) || ref.secretPath.includes("..")) {
      throw new Error("credential secret path is invalid");
    }
    const value = await provider.get(ref.secretPath);
    if (!value) throw new Error("credential is missing or expired");
    return value;
  }
  async store(providerName: string, path: string, value: SecretValue): Promise<void> {
    const provider = this.providers.get(providerName);
    if (!provider?.put) throw new Error(`secret provider "${providerName}" is not configured for secure writes`);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/.test(path) || path.includes("..")) throw new Error("credential secret path is invalid");
    if (!value.username && !value.sessionState && !value.sessionStorage && !value.profileDir) throw new Error("credential secret is empty");
    await provider.put(path, value);
  }
}
