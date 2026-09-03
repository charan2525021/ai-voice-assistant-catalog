import "dotenv/config";
import { createDurableBackbone } from "../platform/backbone.js";
import { createMappingQueue } from "./queue.js";
import { MappingWorker } from "./worker.js";

const backbone = createDurableBackbone();
if (!backbone) throw new Error("DATABASE_URL is required");
const queue = createMappingQueue();
const worker = new MappingWorker(backbone.repositories, backbone.mapping, queue);
worker.start();
console.log("mapping worker ready");

const stop = async () => {
  await worker.stop();
  await queue.close();
  await backbone.close();
  process.exit(0);
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
