import type { RuntimeConfig } from "../config.js";
import type { RuntimeStores } from "../contracts.js";
import { createFileStores } from "./file.js";
import { createPostgresStores } from "./postgres.js";

export async function createStores(config: RuntimeConfig): Promise<RuntimeStores> {
  return config.runtimeStore === "postgres"
    ? createPostgresStores(config.databaseUrl!)
    : createFileStores(config.runtimeFile);
}
