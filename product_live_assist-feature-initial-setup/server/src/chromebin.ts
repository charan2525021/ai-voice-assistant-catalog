import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Locating the machine's real Google Chrome, and describing it honestly.
 *
 * Kept in its own module because both the profile launcher (chromeprofile.ts) and
 * the browser (livebox.ts) need it, and chromeprofile already imports livebox —
 * putting it in either would create an import cycle.
 */

/**
 * Real Chrome is preferred over any other Chromium build because Google's OAuth
 * check keys on the browser being genuine Chrome; Edge is a workable fallback
 * for products that use ordinary SSO, so it is listed last on every platform.
 */
function candidates(): string[] {
  if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const localAppData = process.env.LOCALAPPDATA ?? "";
    const joins = (root: string, ...rest: string[]) => (root ? path.join(root, ...rest) : "");
    return [
      joins(programFiles, "Google\\Chrome\\Application\\chrome.exe"),
      joins(programFilesX86, "Google\\Chrome\\Application\\chrome.exe"),
      joins(localAppData, "Google\\Chrome\\Application\\chrome.exe"),
      joins(programFiles, "Google\\Chrome Beta\\Application\\chrome.exe"),
      joins(programFiles, "BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
      joins(programFiles, "Microsoft\\Edge\\Application\\msedge.exe"),
      joins(programFilesX86, "Microsoft\\Edge\\Application\\msedge.exe"),
    ].filter(Boolean);
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/opt/google/chrome/chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/microsoft-edge",
  ];
}

export function findChrome(): string | null {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  return candidates().find((p) => existsSync(p)) ?? null;
}

/**
 * Files Chrome uses to mark a profile directory as in use.
 *
 * The name differs by platform: Unix builds create SingletonLock (a symlink
 * naming the owner) plus SingletonSocket, Windows creates `lockfile` and neither
 * of the others. Code that knows only the Unix names silently believes every
 * Windows profile is free.
 */
export const PROFILE_LOCK_FILES = ["SingletonLock", "SingletonSocket", "lockfile"];

export function profileLocked(dir: string): boolean {
  return PROFILE_LOCK_FILES.some((f) => existsSync(path.join(dir, f)));
}

/**
 * Wait until a profile directory is free, and report whether it became free.
 *
 * ONE Chrome may own a profile at a time, and `context.close()` resolving is not
 * the same event as the browser process exiting — the lock outlives the promise
 * by a moment. The mapper opens a fresh browser per stage against the same
 * profile (survey, then each exploration, then each verification), so without
 * this the next stage races the previous one's shutdown and Chrome hands off to
 * the still-live instance and exits, surfacing as
 * "Target page, context or browser has been closed".
 */
export async function waitForProfileUnlock(dir: string, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (profileLocked(dir)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return true;
}

let cachedUA: string | null = null;

/**
 * A user-agent that matches the Chrome we are actually running.
 *
 * Headless Chrome reports "HeadlessChrome/150.0.0.0", which some products use to
 * serve a degraded page — the same problem that made an earlier product render an
 * empty body. The non-persistent path spoofs a UA to avoid that, but a hardcoded
 * version would contradict navigator.userAgentData.brands (which reports the real
 * major version and cannot be overridden here), and a contradiction is a stronger
 * signal than a plain headless UA. So read the real version off the binary.
 */
export async function chromeUserAgent(): Promise<string> {
  if (process.env.BROWSER_UA) return process.env.BROWSER_UA;
  if (cachedUA) return cachedUA;
  const bin = findChrome();
  let major = "131"; // only reached if Chrome is missing, in which case it is unused
  if (bin) {
    const version = await chromeVersion(bin);
    if (version) major = version;
  }
  /*
   * The platform token must match the machine we are actually on. This string
   * was Mac-only, so on Windows it contradicted navigator.userAgentData.platform
   * — and per the note above, a contradiction is a stronger bot signal than the
   * headless UA it exists to hide.
   */
  const platform = process.platform === "win32"
    ? "Windows NT 10.0; Win64; x64"
    : process.platform === "darwin"
      ? "Macintosh; Intel Mac OS X 10_15_7"
      : "X11; Linux x86_64";
  cachedUA = `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  return cachedUA;
}

/**
 * Read Chrome's major version.
 *
 * `chrome.exe --version` writes nothing to stdout on Windows — it is a GUI
 * subsystem binary — so the Unix path silently yielded the fallback version. The
 * installer instead keeps a directory named for the exact version beside the
 * executable, which is a reliable read with no process launch at all.
 */
async function chromeVersion(bin: string): Promise<string | null> {
  if (process.platform === "win32") {
    try {
      const versioned = readdirSync(path.dirname(bin))
        .filter((entry) => /^\d+\.\d+\.\d+\.\d+$/.test(entry))
        .sort((a, b) => Number(b.split(".")[0]) - Number(a.split(".")[0]))[0];
      if (versioned) return versioned.split(".")[0];
    } catch (e) {
      console.warn("[chrome] could not read Chrome's version directory:", (e as Error).message);
    }
    return null;
  }
  try {
    const { stdout } = await run(bin, ["--version"], { timeout: 5000 });
    return stdout.match(/(\d+)\.\d+\.\d+/)?.[1] ?? null;
  } catch (e) {
    console.warn("[chrome] could not read Chrome's version, using a default UA:", (e as Error).message);
    return null;
  }
}
