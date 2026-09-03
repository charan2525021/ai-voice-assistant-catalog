import { randomUUID } from "node:crypto";
import { tenantContext } from "../domain/context.js";
import type { PlatformRepositories } from "../storage/contracts.js";
import { acquire, AtCapacity, release } from "../capacity.js";
import { distributedCapacity } from "../runtime/distributed-capacity.js";
import { WORKER_ID } from "../runtime/session-directory.js";
import type { DurableMappingPipeline } from "./durable-pipeline.js";
import { MappingJobRunner } from "./job-runner.js";
import type { MappingQueue, MappingQueueItem } from "./queue.js";

export class MappingWorker {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private stopping = false;
  constructor(
    private readonly repositories: PlatformRepositories,
    private readonly pipeline: DurableMappingPipeline,
    private readonly queue: MappingQueue,
    private readonly workerId = `${WORKER_ID}:mapping`,
  ) {}

  start(): void {
    if (this.timer) return;
    const poll = async () => {
      if (this.stopping || this.busy) return;
      const item = await this.queue.next().catch((error) => {
        console.warn("[mapping-worker] queue read failed", error.message);
        return null;
      });
      if (!item) return;
      this.busy = true;
      await this.run(item).catch((error) => console.warn(`[mapping-worker:${item.jobId}]`, error.message));
      this.busy = false;
    };
    this.timer = setInterval(() => void poll(), Number(process.env.MAPPING_QUEUE_POLL_MS ?? 750));
    this.timer.unref?.();
    void poll();
  }

  private async run(item: MappingQueueItem): Promise<void> {
    const ctx = tenantContext({ organizationId: item.organizationId, actorId: "mapping-worker", requestId: randomUUID() });
    const capacityId = `mapping:${item.jobId}`;
    try {
      await distributedCapacity.acquire("mapping", capacityId);
      try { acquire("mapping", capacityId, item.jobId, async () => {}); }
      catch (error) { await distributedCapacity.release(capacityId).catch(() => {}); throw error; }
    } catch (error) {
      if (error instanceof AtCapacity) { await this.queue.defer(item, 2_000); return; }
      throw error;
    }

    const heartbeat = setInterval(() => {
      void distributedCapacity.renew("mapping", capacityId).catch(() => {});
    }, 30_000);
    heartbeat.unref?.();
    try {
      const runner = new MappingJobRunner(
        this.repositories.mappingJobs,
        [
          { name: "preflight", run: (job, signal) => this.pipeline.preflight(ctx, job, signal) },
          { name: "map", run: (job, signal, checkpoint) => this.pipeline.map(ctx, job, signal, checkpoint) },
          { name: "persist", run: (job, signal) => this.pipeline.persist(ctx, job, signal) },
        ],
        this.workerId,
        Number(process.env.MAPPING_JOB_LEASE_SECONDS ?? 10 * 60),
      );
      await runner.run(ctx, item.jobId);
      await this.queue.complete(item);
    } catch (error) {
      const job = await this.repositories.mappingJobs.get(ctx, item.jobId).catch(() => null);
      if (job && ["failed", "waiting_for_human", "cancelled", "completed"].includes(job.status)) await this.queue.complete(item);
      else await this.queue.defer(item, 5_000);
      if (!/already leased/.test((error as Error).message)) throw error;
    } finally {
      clearInterval(heartbeat);
      release(capacityId);
      await distributedCapacity.release(capacityId).catch(() => {});
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    while (this.busy) await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
