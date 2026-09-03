import http from "node:http";
import { WebSocketServer } from "ws";
import { config } from "./config.js";
import { getProduct } from "./products.js";
import { startAuthSession, authSessionStatus, captureAuthSession, getAuthSession } from "./authsession.js";
import { flushEvents } from "./events.js";

/**
 * Standalone streamed sign-in.
 *
 * The same capture flow the admin console offers, served on its own port with
 * no login of its own. Two reasons it exists separately:
 *
 *  1. The main server is deny-by-default, and the console's sign-in page sits
 *     behind a platform account. Adding a public route there to dodge that would
 *     be a real security regression for a convenience; a separate, localhost-only
 *     process costs nothing and leaves that posture untouched.
 *  2. The Chrome-profile route failed four times on HubSpot. It closes the
 *     browser before capturing, so a SESSION-SCOPED auth cookie — which is what
 *     a login guarded by an emailed code is likely to set — cannot survive it.
 *     This captures `storageState` from the LIVE context without ever closing it.
 *
 * The password and the emailed code go from the keyboard straight into the
 * product. Neither enters this process; we forward keystrokes and keep only the
 * resulting session.
 */

const PORT = Number(process.env.SIGNIN_PORT ?? 8899);
const productId = process.argv[2] ?? config.product;
const loginUrl = process.argv[3];

const rec = await getProduct(productId);
if (!rec) {
  console.error(`no such product: ${productId}`);
  await flushEvents();
  process.exit(1);
}

const { authSessionId, url } = await startAuthSession(rec, loginUrl);
console.log(`[signin] streaming "${rec.name}" from ${url}`);

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Sign in to ${rec.name}</title>
<style>
 body{margin:0;background:#0b1020;color:#e7ecf5;font:15px/1.5 -apple-system,system-ui,sans-serif}
 header{padding:12px 18px;background:#141b33;}
 header{border-bottom:1px solid #2b3558;display:flex;gap:14px;align-items:center;flex-wrap:wrap}
 h1{font-size:16px;margin:0;font-weight:600}
 #url{color:#8fa3c8;font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 button{background:#4f7cff;color:#fff;border:0;padding:9px 16px;border-radius:8px;font-weight:600;cursor:pointer}
 button.ghost{background:#2b3558}
 #stage{position:relative;width:1280px;max-width:100%;margin:14px auto}
 #shot{width:100%;display:block;border-radius:10px;background:#000}
 #keys{position:absolute;inset:0;opacity:0;border:0;resize:none;outline:none}
 #chip{position:fixed;bottom:14px;left:14px;background:#141b33;border:1px solid #2b3558;padding:7px 12px;border-radius:8px;font-size:12px;color:#9fd0ff}
 #msg{padding:0 18px;color:#ffd9a8}
</style></head><body>
<header>
  <h1>Sign in to ${rec.name}</h1>
  <span id="url"></span>
  <button id="grant">I'm signed in &mdash; capture session</button>
  <button class="ghost" id="refocus">Click here if typing doesn't work</button>
</header>
<p id="msg"></p>
<div id="stage">
  <img id="shot" alt="">
  <textarea id="keys" autocomplete="off" spellcheck="false"></textarea>
</div>
<div id="chip">connecting&hellip;</div>
<script>
const ws = new WebSocket("ws://" + location.host + "/ws");
const shot = document.getElementById("shot"), keys = document.getElementById("keys");
const chip = document.getElementById("chip"), msg = document.getElementById("msg");
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.type === "frame") shot.src = "data:image/jpeg;base64," + m.data;
  else if (m.type === "url") document.getElementById("url").textContent = m.url;
  else if (m.type === "error") msg.textContent = m.text;
};
const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
/* Keyboard goes to a REAL focusable element overlaying the stream. A window-level
   listener looks right and silently never fires depending on what the page has
   focused — that cost two debugging rounds the first time round. */
function focusKeys(){ keys.focus({preventScroll:true}); }
setTimeout(focusKeys, 80);
setInterval(() => { chip.textContent = (document.activeElement === keys)
  ? "keyboard connected \\u2014 type into the window" : "click the window to type"; }, 600);
/* Clicks must be bound to the TEXTAREA, not the image. The textarea overlays the
   stream to capture keys, which means it is the top element and swallows every
   click — the image's handler never fires, nothing reaches the remote browser,
   and the window looks frozen. Coordinates come from the textarea's own rect,
   which covers the image exactly. */
keys.addEventListener("click", (ev) => {
  const r = keys.getBoundingClientRect();
  send({ type: "click", x: (ev.clientX - r.left) / r.width, y: (ev.clientY - r.top) / r.height });
  focusKeys();
});
document.getElementById("refocus").onclick = focusKeys;
keys.addEventListener("keydown", (ev) => {
  const mods = []; if (ev.metaKey) mods.push("Meta"); if (ev.ctrlKey) mods.push("Control");
  if (ev.altKey) mods.push("Alt"); if (ev.shiftKey) mods.push("Shift");
  /* Let the browser's own paste happen so we can forward the clipboard text. */
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "v") return;
  ev.preventDefault();
  send({ type: "key", key: ev.key, text: ev.key.length === 1 ? ev.key : "", modifiers: mods });
});
keys.addEventListener("paste", (ev) => {
  const t = (ev.clipboardData || window.clipboardData).getData("text");
  ev.preventDefault(); if (t) send({ type: "paste", text: t });
});
keys.addEventListener("input", () => { keys.value = ""; });
keys.addEventListener("wheel", (ev) => { ev.preventDefault(); send({ type: "wheel", dy: ev.deltaY }); }, {passive:false});
document.getElementById("grant").onclick = async () => {
  msg.textContent = "checking\\u2026";
  const r = await fetch("/capture", { method: "POST" }).then((x) => x.json());
  msg.textContent = r.ok
    ? "Captured. You can close this tab \\u2014 the terminal has taken over."
    : ("NOT captured \\u2014 " + (r.error || "still on a login page"));
};
setInterval(() => send({ type: "where" }), 2000);
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  if (req.url === "/" || req.url?.startsWith("/index")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(PAGE);
  }
  if (req.url === "/status") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(await authSessionStatus(authSessionId)));
  }
  if (req.url === "/capture" && req.method === "POST") {
    const out = await captureAuthSession(authSessionId, { useCurrentUrlAsStart: true }).catch((e) => ({
      ok: false,
      error: (e as Error).message,
    }));
    res.writeHead(200, { "content-type": "application/json" });
    if ((out as any).ok) {
      console.log(`\n[signin] ✓ session captured for "${productId}" — you can close the browser tab.`);
      setTimeout(async () => { await flushEvents(); process.exit(0); }, 500);
    } else {
      console.log(`[signin] capture refused: ${(out as any).error ?? "still on a login page"}`);
    }
    return res.end(JSON.stringify(out));
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (socket) => {
  const s = getAuthSession(authSessionId);
  if (!s) return socket.close();
  const send = (o: unknown) => socket.readyState === 1 && socket.send(JSON.stringify(o));
  let last = 0;
  s.box.onFrame((jpeg) => {
    const now = Date.now();
    if (now - last < 66) return; // ~15fps is ample for typing
    last = now;
    send({ type: "frame", data: jpeg });
  });
  send({ type: "url", url: s.box.currentUrl() });
  socket.on("message", async (raw: Buffer) => {
    let m: any;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    try {
      if (m.type === "click") await s.box.userClick(Number(m.x), Number(m.y));
      else if (m.type === "wheel") await s.box.userWheel(Number(m.dy));
      else if (m.type === "key") await s.box.userKey(String(m.key), String(m.text ?? ""), m.modifiers ?? []);
      else if (m.type === "paste") await s.box.userPaste(String(m.text ?? ""));
      else if (m.type === "where") send({ type: "url", url: s.box.currentUrl() });
    } catch (e) {
      console.warn(`[signin] input ${m?.type} failed: ${(e as Error).message}`);
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  ▶ open  http://localhost:${PORT}  and sign in there\n`);
});
