import "dotenv/config";
import { loadConfig } from "./config.js";
import { createProviders } from "./providers/index.js";
import { buildServer } from "./server.js";
import { createStores } from "./stores/index.js";

const config = loadConfig();
const stores = await createStores(config);
const providers = createProviders(config);
const app = await buildServer(config, stores, providers);

const shutdown = async () => { await app.close(); process.exit(0); };
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await app.listen({ host: "0.0.0.0", port: config.port });
