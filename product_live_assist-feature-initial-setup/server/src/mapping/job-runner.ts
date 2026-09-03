import type { TenantContext } from "../domain/context.js";
import type { MappingJob } from "../domain/runtime.js";
import type { MappingJobRepository } from "../storage/contracts.js";

export interface MappingStage {
  name: string;
  run(
    job: MappingJob,
    signal?: AbortSignal,
    checkpoint?: (cursorPatch: Record<string, unknown>) => Promise<void>,
  ): Promise<Record<string, unknown>>;
}

/** Durable, resumable orchestration. Stages are platform-fixed; product work is data. */
export class MappingJobRunner {
  constructor(
    private readonly repository: MappingJobRepository,
    private readonly stages: MappingStage[],
    private readonly workerId = process.env.WORKER_ID ?? `worker-${process.pid}`,
    private readonly leaseSeconds = 5 * 60,
  ) {}

  async run(ctx: TenantContext, jobId: string, signal?: AbortSignal): Promise<MappingJob> {
    let job = await this.repository.claim(ctx, jobId, this.workerId, this.leaseSeconds);
    if (!job) throw new Error("mapping job is missing or already leased by another worker");
    const checkpoint = () => this.repository.checkpoint(ctx, job!, { owner: this.workerId, seconds: this.leaseSeconds });
    const start = Math.max(0, this.stages.findIndex((stage) => stage.name === job!.stage));
    try {
      for (let index = start; index < this.stages.length; index++) {
        if (signal?.aborted) throw new Error("mapping interrupted");
        const stage = this.stages[index];
        job.stage = stage.name;
        await checkpoint();
        const output = await stage.run(job, signal, async (cursorPatch) => {
          job.cursor = { ...job.cursor, ...cursorPatch };
          job.updatedAt = new Date().toISOString();
          await checkpoint();
        });
        job.cursor = { ...job.cursor, [stage.name]: output };
        job.stage = this.stages[index + 1]?.name ?? "complete";
        job.updatedAt = new Date().toISOString();
        await checkpoint();
      }
      job.status = "completed";
      job.error = undefined;
      await checkpoint();
      return job;
    } catch (error) {
      // A reviewer can pause/cancel from another process. That deliberately
      // clears our lease, so do not overwrite the human decision with the stale
      // in-memory "running" job during error recovery.
      const controlled = await this.repository.get(ctx, jobId).catch(() => null);
      if (controlled && ["waiting_for_human", "cancelled"].includes(controlled.status)) return controlled;
      // Browser fleets and external products fail transiently. Keep the exact
      // stage/cursor and make the durable queue retry it; only exhaust the job
      // after a bounded number of attempts so poison work cannot loop forever.
      const maximumAttempts = Math.max(1, Number(process.env.MAPPING_JOB_MAX_ATTEMPTS ?? 3));
      job.status = signal?.aborted || job.attempts < maximumAttempts ? "queued" : "failed";
      job.error = (error as Error).message;
      job.updatedAt = new Date().toISOString();
      await checkpoint();
      throw error;
    }
  }
}
