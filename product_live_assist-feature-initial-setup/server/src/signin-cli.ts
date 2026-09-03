import { config } from "./config.js";
import { getProduct } from "./products.js";
import { openDesktopSignIn, finishDesktopSignIn, desktopSignInStatus } from "./chromeprofile.js";
import { flushEvents } from "./events.js";

/**
 * Drive the human-in-the-loop sign-in from the CLI.
 *
 * The HTTP routes for this are behind platform auth, which is right for a
 * hosted console but makes the flow unusable from a terminal. Same code path,
 * no HTTP: `open` launches real Chrome on a DEDICATED profile, the human signs
 * in there, `done` re-probes and commits only if genuinely authenticated.
 */
const [cmd, id = config.product] = process.argv.slice(2);
const rec = await getProduct(id);
if (!rec) { console.error(`no such product: ${id}`); process.exit(1); }

if (cmd === "open") {
  const r = await openDesktopSignIn(rec, process.argv[4]);
  console.log(JSON.stringify(r, null, 2));
} else if (cmd === "status") {
  console.log(JSON.stringify(desktopSignInStatus(id), null, 2));
} else if (cmd === "capture") {
  /*
   * Capture from the LIVE window. Required for apps that keep their session in
   * sessionStorage, which closing Chrome destroys — the reason "sign in, then
   * let me close it and look" could never work for them.
   */
  const { captureLiveSession } = await import("./chromeprofile.js");
  const { saveProduct } = await import("./products.js");
  const r = await captureLiveSession(id, rec.startUrl);
  if (!r.ok) { console.log(JSON.stringify(r, null, 2)); process.exit(1); }
  const sessionKeys = Object.values(JSON.parse(r.sessionStorage))[0] as Record<string, string>;
  rec.auth = {
    ...rec.auth,
    mode: "session",
    sessionState: JSON.stringify(r.storageState),
    sessionStorage: r.sessionStorage,
    sessionCapturedAt: new Date().toISOString(),
  } as any;
  if (/^https?:/.test(r.url) && !/\/login|\/signin/i.test(r.url)) rec.startUrl = r.url;
  await saveProduct(rec);
  console.log(JSON.stringify({
    ok: true, url: r.url, title: r.title,
    cookies: r.storageState.cookies.length,
    localStorageOrigins: r.storageState.origins.length,
    sessionStorageKeys: Object.keys(sessionKeys),
    startUrl: rec.startUrl,
  }, null, 2));
} else if (cmd === "done") {
  const r = await finishDesktopSignIn(id, { useCurrentUrlAsStart: true });
  console.log(JSON.stringify(r, null, 2));
} else {
  console.error("commands: open <id> [url] | status <id> | capture <id> | done <id>");
  await flushEvents();
  process.exit(1);
}
await flushEvents();
process.exit(0);
