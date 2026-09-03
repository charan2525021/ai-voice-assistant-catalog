import { promises as fs } from "node:fs";

/**
 * Write a file atomically: full contents to a temporary file, then rename over
 * the target. A reader never sees a half-written file, and a crash mid-write
 * leaves the previous version intact.
 *
 * Two things this fixes that a bare write-then-rename does not:
 *
 * 1. UNIQUE TEMP NAMES. Several call sites used a fixed `<file>.tmp`, so two
 *    concurrent writers to the same file used the SAME scratch path — one
 *    renamed it away while the other was still writing, and the loser's rename
 *    hit a file that had already moved. saveProduct() is called from every
 *    onboarding status transition as well as the auth-capture path, so this
 *    overlapped in normal use and surfaced as:
 *      EPERM: operation not permitted, rename '….auth.local.json.tmp' -> '….auth.local.json'
 *    A pid suffix alone is not enough — the collisions are inside one process.
 *
 * 2. RETRY ON WINDOWS. Windows cannot always replace a file that another handle
 *    has open, and virus scanners and the search indexer open files briefly the
 *    moment they are created. That is transient, so a rename that fails with
 *    EPERM/EACCES/EBUSY is retried rather than reported as a failed save. On
 *    POSIX rename(2) is atomic and these codes do not occur, so the retry loop
 *    simply never runs.
 */

let counter = 0;
const RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

async function renameWithRetry(from: string, to: string, attempts = 6): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!RETRY_CODES.has(code) || attempt >= attempts) throw error;
      // 20ms, 40, 80, 160, 320 — well past a scanner's grab, still imperceptible.
      await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** (attempt - 1)));
    }
  }
}

export async function atomicWrite(
  file: string,
  data: string | Buffer,
  options: { mode?: number } = {},
): Promise<void> {
  const temporary = `${file}.${process.pid}.${(counter++).toString(36)}.tmp`;
  try {
    await fs.writeFile(temporary, data, options.mode === undefined ? undefined : { mode: options.mode });
    // writeFile's mode only applies when it CREATES the file, and is masked by
    // umask; set it explicitly so a credential file is not left world-readable.
    if (options.mode !== undefined) await fs.chmod(temporary, options.mode).catch(() => {});
    await renameWithRetry(temporary, file);
  } catch (error) {
    // Never leave scratch files behind — they accumulate in content folders and
    // look like real data to anything that lists the directory.
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
