import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, rmSync, promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { LiveBox } from "./livebox.js";
import { CONTENT_ROOT, getProduct, saveProduct, type ProductRecord } from "./products.js";
import { findChrome, PROFILE_LOCK_FILES, profileLocked } from "./chromebin.js";
import { assessProductAccess, looksLikeAuthenticationUrl } from "./access.js";

export { findChrome };

/**
 * Sign-in via a real Chrome profile — the path that actually works for Google SSO.
 *
 * Why this exists, when we already stream a browser the human can type into:
 * Google refuses to complete OAuth in Playwright's Chromium and says "this browser
 * or app may not be secure". That is not a fingerprint we can patch around —
 * the check keys on the browser being a non-Google-branded build that advertises
 * --enable-automation, and on the whole point of the flow (an automation harness
 * asking for account access). Spoofing it harder is both fragile and adversarial.
 *
 * So we stop fighting it. We launch the user's OWN installed Google Chrome, with
 * no automation flags, pointed at a profile directory we own. A local debugging
 * port is used only to copy the resulting session after the human finishes.
 * It is genuine Chrome, so Google treats it as genuine Chrome. The human signs in
 * on their own desktop. Then we close it and drive that same profile afterwards.
 *
 * Properties worth stating plainly:
 *  - Their password and 2FA codes never touch this process; they are typed into
 *    Chrome, by them, in a window we do not read.
 *  - We use a DEDICATED profile per product, never their personal Chrome profile,
 *    so linking a product cannot expose their other logged-in accounts.
 *  - The profile is a live credential once signed in. It lives in the product
 *    folder, is never returned by the API, and "unlink" deletes it.
 */

export function profileDirFor(productId: string): string {
  return path.join(CONTENT_ROOT, productId, "chrome-profile");
}

/*
 * profileLocked() and PROFILE_LOCK_FILES live in chromebin.ts because livebox.ts
 * needs them too, and chromeprofile.ts already imports livebox — defining them
 * here would close an import cycle. The lock filename differs per platform; see
 * chromebin.ts for why knowing only the Unix names broke this on Windows.
 */

interface DesktopSignIn {
  productId: string;
  child: ChildProcess;
  profileDir: string;
  url: string;
  startedAt: number;
  exited: boolean;
}

const DEBUG_PORT = Number(process.env.SIGNIN_DEBUG_PORT ?? 9333);
const open = new Map<string, DesktopSignIn>();

export function desktopSignInFor(productId: string): DesktopSignIn | undefined {
  return open.get(productId);
}

/**
 * Open genuine Chrome at the product's sign-in page and let the human do it.
 * Returns as soon as the window is launched — signing in takes as long as it takes.
 */
/**
 * The "you are in the right window" page.
 *
 * Served from a file beside the profile (see landingPageUrl) so it needs no
 * server and cannot fail to load. The page title is distinctive too, because
 * that is what shows in the window switcher — which is how someone with several
 * Chrome windows open actually finds this one.
 */
function landingPage(productName: string, loginUrl: string): string {
  const html = `<!doctype html><html><head><meta charset="utf-8">
<title>&#9989; SIGN IN HERE &mdash; Aidan window for ${escapeHtml(productName)}</title>
<style>
 body{font:16px/1.6 -apple-system,system-ui,sans-serif;margin:0;background:#0b1020;color:#e7ecf5;
      display:flex;align-items:center;justify-content:center;height:100vh}
 .card{max-width:620px;padding:40px;background:#141b33;border:2px solid #4f7cff;border-radius:14px}
 h1{margin:0 0 8px;font-size:26px}
 p{color:#b9c4dc}
 code{background:#0b1020;padding:2px 6px;border-radius:5px;color:#9fd0ff}
 a.btn{display:inline-block;margin-top:22px;background:#4f7cff;color:#fff;text-decoration:none;
       padding:14px 24px;border-radius:9px;font-weight:600}
 .warn{margin-top:22px;padding:12px 16px;background:#3a2410;border-left:3px solid #ffab4f;border-radius:6px;color:#ffd9a8}
</style></head><body><div class="card">
<h1>Sign in to ${escapeHtml(productName)} <em>in this window</em></h1>
<p>This is a separate Chrome profile that Aidan controls. It is the only window whose
   sign-in Aidan can use &mdash; signing in to your normal Chrome will not work, even
   though it looks the same.</p>
<div class="warn">Signing in anywhere else leaves this profile empty, and mapping will
   just find a login page.</div>
<a class="btn" href="${escapeHtml(loginUrl)}">Continue to ${escapeHtml(productName)} sign-in &rarr;</a>
<p style="margin-top:26px;font-size:14px">When you can see the product&rsquo;s own dashboard,
   leave this window open, return to the Admin Console and press <b>I&rsquo;m signed in &mdash; grant access</b>.</p>
</div></body></html>`;
  return html;
}

/**
 * Write the instruction page next to the profile and return a file:// URL.
 *
 * It used to be handed to Chrome as `data:text/html,...`, which Chrome has
 * REFUSED to navigate to at the top level since Chrome 60 — the window opened on
 * `about:blank#blocked` instead. The person then saw an empty window with no
 * link and no explanation, could not sign in, and mapping went on to explore a
 * profile with no session in it.
 *
 * The file lives inside the profile directory because that directory is already
 * ours, is already treated as a credential, and is deleted when access is
 * revoked — so the page cannot outlive the thing it describes.
 */
async function landingPageUrl(profileDir: string, productName: string, loginUrl: string): Promise<string> {
  const file = path.join(profileDir, "aidan-sign-in.html");
  await fs.writeFile(file, landingPage(productName, loginUrl), "utf8");
  return pathToFileURL(file).href;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Pid recorded in Chrome's SingletonLock symlink ("hostname-pid"), if any. */
async function lockOwnerPid(dir: string): Promise<number | null> {
  try {
    const target = await fs.readlink(path.join(dir, "SingletonLock"));
    const pid = Number(target.split("-").pop());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Is that pid still running? Signal 0 tests existence without touching it. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function openDesktopSignIn(rec: ProductRecord, signInUrl?: string) {
  const bin = findChrome();
  if (!bin) {
    return {
      ok: false as const,
      error:
        "No Google Chrome found on this machine. Google SSO needs real Chrome — install it from google.com/chrome, or set CHROME_PATH to a Chromium-based browser.",
    };
  }

  // Don't open a second window onto a profile that's already open — Chrome would
  // just focus the existing one and the caller would wait on the wrong process.
  const existing = open.get(rec.id);
  if (existing && !existing.exited) return { ok: true as const, alreadyOpen: true, url: existing.url, browser: path.basename(bin) };

  const profileDir = profileDirFor(rec.id);
  await fs.mkdir(profileDir, { recursive: true });

  const url = signInUrl || rec.startUrl;
  const child = spawn(
    bin,
    [
      `--user-data-dir=${profileDir}`,
      "--profile-directory=Default",
      /*
       * A debugging port so the live, signed-in browser can be READ without
       * closing it. Closing is what destroyed sessionStorage-based sessions,
       * and it was also the only way to check whether sign-in had worked.
       */
      `--remote-debugging-port=${DEBUG_PORT}`,
      "--no-first-run",
      "--no-default-browser-check",
      // Match the viewport the mapper will later see, so the layout it learns is
      // the layout that was signed into.
      "--window-size=1280,860",
      // Offset so it cannot land exactly on top of the user's own Chrome.
      "--window-position=90,60",
      "--new-window",
      /*
       * Land on an instruction page FIRST, not straight on the login form.
       *
       * This is an ordinary Chrome window on a different profile, so it looks
       * identical to the user's everyday browser. Three separate sign-in
       * attempts went into the wrong window: the profile finished with four
       * Cloudflare cookies and no session at all, while the person reasonably
       * believed they had signed in. Nothing in the flow said which window
       * mattered, and "are you sure you used the right window?" is a terrible
       * thing to have to ask. So say it on the page, before anything is typed.
       */
      await landingPageUrl(profileDir, rec.name, url),
    ],
    { stdio: "ignore" },
  );

  const entry: DesktopSignIn = { productId: rec.id, child, profileDir, url, startedAt: Date.now(), exited: false };
  child.on("exit", () => {
    entry.exited = true;
    console.log(`[chrome] sign-in window for "${rec.id}" closed`);
  });
  child.on("error", (e) => console.warn(`[chrome] sign-in window for "${rec.id}" failed: ${e.message}`));
  open.set(rec.id, entry);

  // Remember where the profile lives even before it's verified, so a retry or an
  // unlink can find it.
  rec.auth = { ...rec.auth, profileDir };
  await saveProduct(rec);

  console.log(`[chrome] opened ${path.basename(bin)} for "${rec.id}" at ${url} (profile: ${profileDir})`);
  return { ok: true as const, alreadyOpen: false, url, browser: path.basename(bin), profileDir };
}

/** Is the human's Chrome window still open? */
/*
 * Cookie names that mean "there is a logged-in session here". Analytics and
 * bot-check cookies are set just by LOADING a login page, so their presence
 * proves nothing — which is how a profile with nothing but Cloudflare and
 * Clarity cookies kept being mistaken for a signed-in one.
 */
const SESSION_COOKIE_HINTS = /session|sid$|^sb-|auth|token|jwt|login|remember|identity|csrf.?token|connect\.sid/i;
const NON_SESSION_COOKIES = /^(_clck|_clsk|cf_clearance|__stripe|_ga|_gid|MUID|MR|SM|SRM_B|ANONCHK|CLID|_fbp)/i;

/**
 * Does this profile actually hold a session? Read-only — it never closes Chrome.
 *
 * This exists because the only way to find out used to be `done`, which KILLS
 * the window and rewrites the profile. Checking therefore destroyed the thing
 * being checked, and a wrong guess cost the whole sign-in.
 */
export function profileSessionCookies(productId: string): { total: number; session: string[]; hosts: string[] } {
  const db = path.join(profileDirFor(productId), "Default", "Cookies");
  if (!existsSync(db)) return { total: 0, session: [], hosts: [] };
  try {
    // Copy first: Chrome holds the live DB open and a direct read can lock.
    const tmp = path.join(os.tmpdir(), `aidan-cookies-${productId}-${Date.now()}.db`);
    copyFileSync(db, tmp);
    const out = execFileSync("sqlite3", [tmp, "select host_key || '|' || name from cookies;"], { encoding: "utf8" });
    rmSync(tmp, { force: true });
    const rows = out.split("\n").map((l) => l.trim()).filter(Boolean);
    const session = rows
      .map((r) => r.split("|"))
      .filter(([, name]) => SESSION_COOKIE_HINTS.test(name) && !NON_SESSION_COOKIES.test(name))
      .map(([host, name]) => `${host} ${name}`);
    return { total: rows.length, session, hosts: [...new Set(rows.map((r) => r.split("|")[0]))] };
  } catch {
    return { total: 0, session: [], hosts: [] };
  }
}

/**
 * Read cookies, localStorage AND sessionStorage out of the LIVE sign-in browser.
 *
 * Everything here exists because sessionStorage dies with the window: capturing
 * by closing Chrome deletes the token for any app that stores it there, so the
 * capture has to happen while the browser is still open and signed in.
 */
export async function captureLiveSession(productId?: string, expectedUrl?: string): Promise<
  { ok: true; storageState: any; sessionStorage: string; url: string; title: string } | { ok: false; error: string }
> {
  if (productId) {
    const signIn = open.get(productId);
    if (!signIn || signIn.exited) {
      return { ok: false, error: "the dedicated Chrome sign-in window is closed; reopen it and leave the product dashboard open" };
    }
  }
  const { chromium } = await import("playwright");
  let browser: any;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
  } catch (e) {
    return { ok: false, error: `could not attach to the sign-in window on :${DEBUG_PORT} — ${(e as Error).message}` };
  }
  try {
    const ctx = browser.contexts()[0];
    if (!ctx) return { ok: false, error: "the sign-in window has no open context" };
    const pages = ctx.pages().filter((pg: any) => /^https?:/.test(pg.url()));
    if (!pages.length) return { ok: false, error: "no real page is open in the sign-in window" };
    let wantedOrigin = "";
    try { wantedOrigin = expectedUrl ? new URL(expectedUrl).origin : ""; } catch { /* use the active page */ }
    const productPages = wantedOrigin ? pages.filter((pg: any) => {
      try { return new URL(pg.url()).origin === wantedOrigin; } catch { return false; }
    }) : [];
    const page = (productPages.length ? productPages : pages)[(productPages.length ? productPages : pages).length - 1];
    // indexedDB=true matters for Firebase/Auth0-style clients whose refresh token
    // never appears in cookies or localStorage.
    const storageState = await ctx.storageState({ indexedDB: true });
    const byOrigin: Record<string, Record<string, string>> = {};
    for (const candidate of pages) {
      const session = await candidate.evaluate(() => {
        const entries: Record<string, string> = {};
        for (let i = 0; i < window.sessionStorage.length; i++) {
          const key = window.sessionStorage.key(i);
          if (key) entries[key] = window.sessionStorage.getItem(key) ?? "";
        }
        return { origin: window.location.origin, entries };
      }).catch(() => null);
      if (session) byOrigin[session.origin] = { ...(byOrigin[session.origin] ?? {}), ...session.entries };
    }
    return {
      ok: true,
      storageState,
      sessionStorage: JSON.stringify(byOrigin),
      url: page.url(),
      title: await page.title().catch(() => ""),
    };
  } finally {
    // Detach only. Never close the user's window from under them.
    await browser.close().catch(() => {});
  }
}

export function desktopSignInStatus(productId: string) {
  const s = open.get(productId);
  const profileDir = profileDirFor(productId);
  const cookies = profileSessionCookies(productId);
  return {
    windowOpen: !!s && !s.exited,
    profileExists: existsSync(profileDir),
    profileLocked: profileLocked(profileDir),
    startedAt: s?.startedAt,
    cookiesTotal: cookies.total,
    sessionCookies: cookies.session,
    looksSignedIn: cookies.session.length > 0,
    verdict: cookies.session.length
      ? `Session cookies present (${cookies.session.length}) — safe to run "done".`
      : cookies.total
        ? `${cookies.total} cookies but NONE are a session — the page loaded, no sign-in completed. Check you are typing into the dedicated window.`
        : "Nothing stored yet — that window has not loaded the product.",
  };
}

/** Close the sign-in window cleanly so Chrome flushes cookies and drops the lock. */
async function closeChromeAndWait(productId: string): Promise<{ blockedBy?: number }> {
  const s = open.get(productId);
  if (s && !s.exited) {
    // SIGTERM lets Chrome shut down properly. That matters: a killed Chrome can
    // leave freshly-set cookies unflushed, which looks exactly like a failed
    // sign-in when we reopen the profile.
    /*
     * Windows has no signals: Node maps BOTH SIGTERM and SIGKILL onto
     * TerminateProcess, which is the hard kill this code exists to avoid — and
     * it does not reach Chrome's child processes, so the browser can keep the
     * profile locked after we believe it is closed. `taskkill /T` without /F
     * posts WM_CLOSE to the whole tree, which is the actual graceful equivalent.
     */
    if (process.platform === "win32" && s.child.pid) {
      try {
        execFileSync("taskkill", ["/pid", String(s.child.pid), "/T"], { stdio: "ignore" });
      } catch {
        /* already gone, or refused — the force path below still applies */
      }
    } else {
      // SIGTERM lets Chrome shut down properly. That matters: a killed Chrome can
      // leave freshly-set cookies unflushed, which looks exactly like a failed
      // sign-in when we reopen the profile.
      s.child.kill("SIGTERM");
    }
    for (let i = 0; i < 40 && !s.exited; i++) await new Promise((r) => setTimeout(r, 250));
    if (!s.exited) {
      console.warn(`[chrome] sign-in window for "${productId}" ignored the close request — forcing`);
      if (process.platform === "win32" && s.child.pid) {
        try { execFileSync("taskkill", ["/pid", String(s.child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* gone */ }
      } else {
        s.child.kill("SIGKILL");
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  open.delete(productId);

  // Wait for the profile lock to clear, otherwise launchPersistentContext throws.
  const dir = profileDirFor(productId);
  for (let i = 0; i < 40 && profileLocked(dir); i++) await new Promise((r) => setTimeout(r, 250));
  if (profileLocked(dir)) {
    /*
     * A lock is only STALE if the process that owns it is gone.
     *
     * This used to delete the lock unconditionally, so calling it while the
     * person was still signing in ripped the profile out from under a live
     * Chrome — which is exactly how a profile ends up showing "Something went
     * wrong when opening your profile". Each attempt to CHECK the sign-in
     * destroyed the sign-in, and the next attempt started from a more broken
     * profile than the last.
     */
    /*
     * Close the process that actually HOLDS the lock.
     *
     * Chrome re-execs on macOS, so the pid we spawned is not the browser process
     * that owns SingletonLock — SIGTERM to our child leaves the real one running.
     * The old code then deleted the lock while that process was alive, which is
     * what corrupted the profile. Ask the true owner to quit (SIGTERM, so cookies
     * are flushed), and only treat the lock as stale once it is genuinely gone.
     */
    let owner = await lockOwnerPid(dir);
    if (owner && processAlive(owner)) {
      try { process.kill(owner, "SIGTERM"); } catch { /* already gone */ }
      for (let i = 0; i < 60 && processAlive(owner); i++) await new Promise((r) => setTimeout(r, 250));
    }
    owner = await lockOwnerPid(dir);
    if (owner && processAlive(owner)) return { blockedBy: owner };
    /*
     * `lockfile` is included because that is the Windows lock, where
     * lockOwnerPid() can never identify an owner: it reads the pid out of
     * SingletonLock's symlink target, and Windows has no such symlink. Removing
     * it here is safe only because we reach this point after the close above and
     * after confirming no owning process is alive.
     */
    for (const f of [...PROFILE_LOCK_FILES, "SingletonCookie"]) {
      await fs.rm(path.join(dir, f), { force: true }).catch(() => {});
    }
    console.warn(`[chrome] cleared a stale profile lock for "${productId}" (owner ${owner ?? "unknown"} is gone)`);
  }
  return {};
}

/**
 * The human says they're signed in. Copy the LIVE browser state first, prove the
 * copied state in the same kind of isolated browser the mapper will use, and
 * only then close Chrome and commit it.
 *
 * Closing first loses sessionStorage. That made a successful LLM API sign-in
 * look expired moments later and is why the mapper kept landing on /login.
 */
export async function finishDesktopSignIn(productId: string, opts: { useCurrentUrlAsStart?: boolean } = {}) {
  const rec = await getProduct(productId);
  if (!rec) return { ok: false as const, error: "unknown product" };

  const profileDir = profileDirFor(productId);
  if (!existsSync(profileDir)) return { ok: false as const, error: "no sign-in window has been opened for this product yet" };

  const signIn = open.get(productId);
  if (!signIn || signIn.exited) {
    return {
      ok: false as const,
      error: "The dedicated Chrome window is closed, so its live sign-in cannot be captured safely.",
      hint: "Press Reopen Chrome, make sure the product dashboard is visible there, leave that window open, then grant access.",
    };
  }

  const captured = await captureLiveSession(productId, rec.startUrl);
  if (!captured.ok) {
    return { ok: false as const, error: captured.error, hint: "Leave the dedicated Chrome window open on the product dashboard and try again." };
  }
  if (looksLikeAuthenticationUrl(captured.url)) {
    return {
      ok: false as const,
      error: `The dedicated Chrome window is still on an authentication page (${captured.url}).`,
      url: captured.url,
      title: captured.title,
      hint: "Finish signing in until the product's own dashboard is visible, leave Chrome open, then grant access.",
    };
  }

  const sessionState = JSON.stringify(captured.storageState);
  const sessionOrigins = [...new Set([
    ...(captured.storageState.origins ?? []).map((item: { origin?: string }) => item.origin).filter(Boolean),
    ...Object.keys(JSON.parse(captured.sessionStorage || "{}")),
  ])] as string[];
  const candidateAuth = {
    ...rec.auth,
    mode: "session" as const,
    profileDir,
    sessionState,
    sessionStorage: captured.sessionStorage,
    sessionCapturedAt: new Date().toISOString(),
    sessionOrigins,
  };

  // The only meaningful proof is a clean replay in the isolated runtime used by
  // mapping and demos. Cookie-name guesses cannot prove sessionStorage/IndexedDB
  // authentication and produced both false positives and false negatives.
  const probe = new LiveBox({ startUrl: rec.startUrl, auth: candidateAuth, allowActions: rec.allowActions });
  let snap: Awaited<ReturnType<LiveBox["snapshot"]>>;
  try {
    await probe.start();
    await new Promise((resolve) => setTimeout(resolve, 1800));
    snap = await probe.snapshot(false);
  } catch (error) {
    await probe.stop().catch(() => {});
    return {
      ok: false as const,
      error: `The live sign-in was captured, but the mapper could not replay it: ${(error as Error).message}`,
      hint: "Chrome has been left open and nothing was replaced. Keep the dashboard open and try again.",
    };
  }
  await probe.stop().catch(() => {});

  const access = assessProductAccess(rec.startUrl, snap, true);
  if (!access.ok || snap.elements.length === 0) {
    return {
      ok: false as const,
      error: !access.ok
        ? `The sign-in is visible in Chrome, but the copied session did not open the product: ${access.message}`
        : `The copied session opened ${snap.url}, but the product rendered no usable controls.`,
      url: snap.url,
      title: snap.title,
      hint: "Chrome has been left open. Confirm its dashboard is fully loaded, then grant access again.",
    };
  }

  rec.auth = candidateAuth;
  if (opts.useCurrentUrlAsStart && /^https?:/i.test(captured.url)) rec.startUrl = captured.url;
  await saveProduct(rec);
  await closeChromeAndWait(productId);

  console.log(`[chrome] "${productId}" sign-in captured and replay-verified (${sessionOrigins.join(", ") || "no stored origins"})`);
  return {
    ok: true as const,
    product: rec.id,
    startUrl: rec.startUrl,
    url: snap.url,
    title: snap.title,
    controls: snap.elements.length,
    origins: sessionOrigins,
    cookieCount: captured.storageState.cookies?.length ?? 0,
  };
}

/** Abandon a sign-in window without capturing anything. */
export async function cancelDesktopSignIn(productId: string): Promise<void> {
  await closeChromeAndWait(productId);
}

/** Unlink: delete the profile. This is the revoke path, so it must really delete. */
export async function deleteProfile(productId: string): Promise<boolean> {
  await closeChromeAndWait(productId);
  const dir = profileDirFor(productId);
  if (!existsSync(dir)) return false;
  await fs.rm(dir, { recursive: true, force: true });
  console.log(`[chrome] deleted profile for "${productId}"`);
  return true;
}
