import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";

/**
 * Load aidan/.env no matter where a command was started from.
 *
 * Import this FIRST — before any module that reads process.env at import time.
 *
 * Bare `import "dotenv/config"` resolves .env against the current working
 * directory, i.e. server/.env, which does not exist in this repo: the real file
 * is aidan/.env, one level up. Commands using it therefore ran with none of the
 * configuration set and silently fell back to built-in defaults — db:migrate
 * would try the Docker default port 5433 and fail with ECONNREFUSED even though
 * DATABASE_URL was correctly configured, and the user CLI would write accounts
 * to JSON while the server read PostgreSQL.
 *
 * config.ts has always done this correctly; this is the same two lines, shared
 * so every entry point behaves identically.
 */
loadEnv({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });
loadEnv(); // also honour a server/.env if someone adds one
