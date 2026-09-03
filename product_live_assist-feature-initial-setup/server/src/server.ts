import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { LiveBox } from "./livebox.js";
import { Agent, type AgentRuntimeContext } from "./agent.js";
import { BrainStore, brainFor } from "./knowledge/store.js";
import { SessionMemory } from "./knowledge/memory.js";
import { Observer, type SignalKind } from "./observer.js";
import { emit, trace, withTrace, openTrace, readEvents, rollup, type TraceCtx } from "./events.js";
import { acquire, renew, release, stats as capacityStats, AtCapacity } from "./capacity.js";
import { archiveProduct, deleteProduct, getProduct, listProducts, saveProduct, scaffoldProduct, setStatus, type ProductAuth, type ProductRecord } from "./products.js";
import { controlTrainingJob, jobState, preflight, startOnboardingJob, subscribeTraining, trainingJobPromise } from "./onboarding.js";
import {
  authSessionStatus, cancelAuthSession, captureAuthSession, clearStoredSession, getAuthSession, startAuthSession,
} from "./authsession.js";
import {
  findChrome,
  openDesktopSignIn,
  desktopSignInStatus,
  finishDesktopSignIn,
  cancelDesktopSignIn,
  deleteProfile,
} from "./chromeprofile.js";
import { loadGraph, saveGraph, listGraphVersions, restoreGraphVersion, journeysToFlows } from "./mapper/graph.js";
import { isJourneyMachineVerified, isJourneyPublishable } from "./mapper/verifier.js";
import { journeyRevisionChecksum, reviewJourney } from "./mapper/journey-review.js";
import { ingestContent } from "./knowledge/ingest.js";
import { discoverLinks } from "./knowledge/crawl.js";
import { CONTENT_ROOT } from "./products.js";
import { promises as fs, existsSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  atLeast, bootstrap, clearCookie, createUser, deleteUser, listUsers, login, logout,
  parseCookie, sessionCookie, SESSION_COOKIE, userForToken, type AuthedUser, type Role,
} from "./auth.js";
import path from "node:path";
import { SpeechEngine } from "./tts/engine.js";
import { ttsEnabled, synthesizeChunk } from "./tts/provider.js";
import { cacheStats } from "./tts/cache.js";
import { TurnManager } from "./turn.js";
import { AudioSync } from "./tts/sync.js";
import { PhrasePicker, allPhrases, pacingFor, phrasesFor } from "./tts/conversation.js";
import {
  startDemonstration, getDemoSession, demonstrationStatus, demonstrationProofOptions,
  finishDemonstration, cancelDemonstration, recordClick, recordKey, recordPaste,
  recordScroll, recordNavigate,
} from "./demonstrate.js";
import { tenantContext, type TenantContext } from "./domain/context.js";
import { createSessionDirectory, WORKER_ID } from "./runtime/session-directory.js";
import { createDurableBackbone } from "./platform/backbone.js";
import { syncLegacyProduct } from "./storage/import-product.js";
import { distributedCapacity } from "./runtime/distributed-capacity.js";
import { evidenceToSystem } from "./runtime/evidence-router.js";
import type { CustomerSession, MappingJob } from "./domain/runtime.js";
import { createMappingQueue } from "./mapping/queue.js";
import { MappingWorker } from "./mapping/worker.js";
import { LiveScreenObserver, type ScreenState } from "./runtime/screen-state.js";
import { createOidcIdentityProvider } from "./identity/oidc.js";
import { issueEmbedToken, normalizedAllowedOrigin, verifyEmbedToken } from "./identity/embed-token.js";
import type { CredentialRef, EmbedGrant } from "./domain/catalog.js";

interface Session {
  product: string;
  tenant: TenantContext;
  /** One trace per demo, so every turn, action and model call groups together. */
  traceCtx: TraceCtx;
  box: LiveBox;
  agent: Agent;
  observer: Observer;
  kb: BrainStore;
  durableRecord?: CustomerSession;
  knowledgeSummary?: { docs: number; flows: number };
  /** Product-data narration lines warmed before the first customer action. */
  narrationLines?: string[];
  /**
   * Two distinct workflows, chosen by the user and switchable mid-session:
   *   "text"  → a chat assistant. Replies in text, never speaks.
   *   "voice" → a spoken guide. Voice is primary; the transcript mirrors it.
   */
  mode: "text" | "voice";
  /** Per-session speech + turn state (voice comes from the product manifest). */
  speech: SpeechEngine | null;
  turn: TurnManager;
  finalized: boolean;
  disconnectTimer?: NodeJS.Timeout;
  recoveryHeartbeat?: NodeJS.Timeout;
}
const sessions = new Map<string, Session>();
const sessionDirectory = createSessionDirectory();
const durableBackbone = createDurableBackbone();
const mappingQueue = durableBackbone ? createMappingQueue() : null;
const mappingWorker = durableBackbone && mappingQueue
  ? new MappingWorker(durableBackbone.repositories, durableBackbone.mapping, mappingQueue)
  : null;
if (mappingWorker && process.env.MAPPING_WORKER_EMBEDDED !== "false") mappingWorker.start();
const oidcIdentity = createOidcIdentityProvider();
if (durableBackbone && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(process.env.ADMIN_ORG_ID ?? "")) {
  throw new Error("DATABASE_URL requires ADMIN_ORG_ID to be a valid UUID");
}

/**
 * Strip live credentials from anything handed to a client.
 *
 * A captured session IS a credential — it can act as the account — so it must
 * never leave the server, even though its metadata (when, which hosts) is useful
 * in the admin console.
 */
function safeAuth(a: any) {
  // sessionStorage holds the live auth token for apps that keep it there. It is
  // a credential exactly like sessionState and must never leave the server.
  const { password, sessionState, sessionStorage, profileDir, ...rest } = a ?? {};
  return {
    ...rest,
    password: password ? "***" : undefined,
    hasSession: !!sessionState || !!sessionStorage,
    hasProfile: !!profileDir,
  };
}

/**
 * Spoken commands that mean "be quiet", not "answer this".
 * Anchored so an ordinary sentence containing "stop" ("how do I stop a payroll
 * run") is still treated as a question.
 */
const STOP_PHRASE =
  /^(wait|stop|hold on|hang on|pause|quiet|shush|shut up|be quiet|one sec(ond)?|one moment|just a (sec(ond)?|moment|minute)|give me a (sec(ond)?|moment|minute)|enough|that'?s enough|okay stop|ok stop)[\s.!,]*$/i;

const app = Fastify({
  logger: {
    serializers: {
      req(request: any) {
        let url = String(request.url ?? "");
        try {
          const parsed = new URL(url, "http://request.local");
          for (const key of ["embed", "share"]) if (parsed.searchParams.has(key)) parsed.searchParams.set(key, "[redacted]");
          url = `${parsed.pathname}${parsed.search}`;
        } catch { /* retain the non-sensitive raw path */ }
        return { method: request.method, url, host: request.headers?.host, remoteAddress: request.socket?.remoteAddress };
      },
    },
    redact: { paths: ["req.headers.authorization", "req.headers.cookie", "headers.authorization", "headers.cookie"], censor: "[redacted]" },
  },
});
await app.register(fastifyWebsocket, { options: { maxPayload: 16 * 1024 * 1024 } });
await app.register(fastifyStatic, { root: fileURLToPath(new URL("../../web", import.meta.url)), prefix: "/" });

const httpStarted = new WeakMap<object, number>();
app.addHook("onRequest", async (req) => {
  httpStarted.set(req, Date.now());
});
app.addHook("onResponse", async (req, reply) => {
  const url = new URL(req.url, "http://request.local");
  const routeProduct = url.pathname.match(/^\/api\/(?:v2\/)?products\/([^/]+)/)?.[1];
  const body = (req.body ?? {}) as Record<string, unknown>;
  const productId = routeProduct ? decodeURIComponent(routeProduct)
    : typeof body.product === "string" ? body.product
    : typeof body.productId === "string" ? body.productId
    : req.shareProduct ?? req.embedGrant?.productId ?? "_system";
  emit("http.request", {
    product: productId,
    trace: req.id,
    status: reply.statusCode >= 400 ? "error" : "ok",
    ms: Date.now() - (httpStarted.get(req) ?? Date.now()),
    data: {
      method: req.method,
      path: url.pathname,
      status: reply.statusCode,
      productId: productId === "_system" ? undefined : productId,
      requestId: req.id,
    },
  });
});

app.addHook("onSend", async (req, reply, payload) => {
  reply.header("referrer-policy", "no-referrer");
  reply.header("x-content-type-options", "nosniff");
  if (new URL(req.url, "http://x").searchParams.has("embed")) reply.header("cache-control", "no-store");
  return payload;
});


// ============================== Access control ================================
/*
 * Everything is closed unless it is explicitly opened. The previous build had no
 * authentication whatsoever — anyone who could reach the port could link products,
 * read the event log or revoke a stored session.
 *
 * Two doors are deliberately left open:
 *  - the prospect-facing demo, reachable with a per-product share token, so a
 *    customer can hand a demo to their buyer without provisioning an account;
 *  - liveness/readiness, which a load balancer must reach before anyone logs in.
 */
declare module "fastify" {
  interface FastifyRequest {
    user?: AuthedUser | null;
    shareProduct?: string | null;
    embedGrant?: EmbedGrant | null;
    tenant?: TenantContext;
  }
}

/** Paths served without a session. Exact matches only — no prefix wildcards. */
const PUBLIC_PATHS = new Set([
  "/login.html", "/api/auth/login", "/api/auth/logout", "/healthz", "/readyz",
  "/", "/index.html", // the demo page itself; /api/session is what actually gates it
]);

const isPublic = (p: string) => PUBLIC_PATHS.has(p);

/** A share token grants access to ONE product's demo, nothing else. */
async function shareProductFor(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  for (const p of await listProducts()) {
    if (p.share?.token && p.share.token === token) return p.id;
  }
  return null;
}

app.addHook("preHandler", async (req, reply) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  req.user = await oidcIdentity?.authenticate(req.headers.authorization) ??
    await userForToken(parseCookie(req.headers.cookie, SESSION_COOKIE));
  req.shareProduct = await shareProductFor(url.searchParams.get("share") ?? undefined);

  // Signed claims reveal only the tenant scope needed for the RLS-protected
  // grant lookup. The durable row is the revocation and origin authority.
  const rawEmbed = url.searchParams.get("embed") ??
    (typeof req.headers["x-aidan-embed-token"] === "string" ? req.headers["x-aidan-embed-token"] : undefined);
  const claims = rawEmbed ? verifyEmbedToken(rawEmbed) : null;
  if (claims && durableBackbone) {
    const embedTenant = tenantContext({ organizationId: claims.organizationId, actorId: `embed:${claims.jti}`, requestId: req.id });
    const grant = await durableBackbone.repositories.access.getEmbedGrant(embedTenant, claims.jti).catch(() => null);
    const requestOrigin = typeof req.headers.origin === "string" ? req.headers.origin : "";
    const valid = grant && !grant.revokedAt && Date.parse(grant.expiresAt) > Date.now() &&
      grant.productId === claims.productId && grant.roleProfileId === claims.roleProfileId &&
      (!requestOrigin || grant.allowedOrigins.includes(requestOrigin));
    if (valid) { req.embedGrant = grant; req.tenant = embedTenant; }
  }

  if (req.user) {
    req.tenant = tenantContext({ organizationId: req.user.orgId, actorId: req.user.id, requestId: req.id });
    // Compatibility-store guard. PostgreSQL repositories additionally enforce
    // this with row-level security, so a missed route check still fails closed.
    const match = p.match(/^\/api\/products\/([^/]+)/);
    if (match) {
      const rec = await getProduct(decodeURIComponent(match[1]), req.user.orgId);
      if (!rec) return reply.code(404).send({ error: "unknown product" });
    }
  }

  if (isPublic(p) || req.user) return;

  if (req.embedGrant && (p === "/api/v2/embed/session" || p === "/ws")) return;

  // A share link may reach only the routes needed to run that one demo.
  if (req.shareProduct && (p === "/api/session" || p === "/ws")) return;

  if (p.startsWith("/api/") || p === "/ws" || p.startsWith("/ws/") || p === "/metrics") {
    return reply.code(401).send({ error: "not signed in" });
  }
  // A browser asking for a page gets sent to the login form, not a JSON error.
  return reply.redirect(`/login.html?next=${encodeURIComponent(req.url)}`, 302);
});

/** Guard a route on a minimum role. */
function require_(role: Role) {
  return async (req: any, reply: any) => {
    if (!atLeast(req.user ?? null, role)) return reply.code(403).send({ error: `requires ${role}` });
  };
}

app.post("/api/auth/login", async (req, reply) => {
  const b = (req.body ?? {}) as any;
  const r = await login(String(b.email ?? ""), String(b.password ?? ""));
  if (!r) return reply.code(401).send({ error: "wrong email or password" });
  const secure = (req.headers["x-forwarded-proto"] ?? "").toString().includes("https");
  reply.header("set-cookie", sessionCookie(r.token, secure));
  return { user: r.user };
});

app.post("/api/auth/logout", async (req, reply) => {
  const t = parseCookie(req.headers.cookie, SESSION_COOKIE);
  if (t) logout(t);
  reply.header("set-cookie", clearCookie());
  return { ok: true };
});

app.get("/api/auth/me", async (req) => ({ user: req.user ?? null }));

app.get("/api/users", { preHandler: require_("owner") }, async (req) => ({ users: await listUsers(req.user!.orgId) }));

app.post("/api/users", { preHandler: require_("owner") }, async (req, reply) => {
  const b = (req.body ?? {}) as any;
  try {
    return { user: await createUser(String(b.email ?? ""), String(b.password ?? ""), (b.role ?? "admin") as Role, req.user!.orgId) };
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
});

app.delete("/api/users/:id", { preHandler: require_("owner") }, async (req, reply) => {
  try {
    const ok = await deleteUser((req.params as any).id, req.user!.orgId);
    if (!ok) return reply.code(404).send({ error: "unknown user" });
    return { ok: true };
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
});

// ---- Share links: hand a demo to a prospect without an account ----
app.post("/api/products/:id/share", { preHandler: require_("admin") }, async (req, reply) => {
  const rec = await getProduct((req.params as any).id, req.user!.orgId);
  if (!rec) return reply.code(404).send({ error: "unknown product" });
  if (rec.archivedAt) return reply.code(409).send({ error: "archived products cannot be shared" });
  rec.share = { token: randomBytes(18).toString("base64url"), createdAt: new Date().toISOString() };
  await saveProduct(rec);
  emit("share.created", { product: rec.id, status: "ok", data: { rotated: true } });
  return { url: `/?product=${encodeURIComponent(rec.id)}&share=${rec.share.token}`, createdAt: rec.share.createdAt };
});

/**
 * Mirror a product into PostgreSQL so the demo picker can see it.
 *
 * The console creates products through the file-backed path, while the demo
 * picker lists /api/v2/products, which reads PostgreSQL. Nothing joined the two,
 * so a product linked and mapped in the console was invisible to the picker and
 * could only be reached by running db:import-legacy by hand.
 *
 * Called twice per product on purpose: once at link time, so it appears
 * immediately as an unpublished entry, and again when mapping settles, which is
 * when it has verified journeys and can actually be published. Publishing
 * requires at least one verified journey, so the first call registers it and the
 * second is what makes it demoable.
 *
 * Never throws. A mirroring failure must not fail the link or the mapping run
 * that just succeeded — it is logged, and re-running mapping retries it.
 */
async function syncProductToDurable(productId: string): Promise<void> {
  if (!durableBackbone) return;
  try {
    const rec = await getProduct(productId);
    if (!rec || rec.archivedAt) return;
    const ctx = tenantContext({ organizationId: rec.organizationId, actorId: "product-sync", requestId: randomUUID() });
    const result = await syncLegacyProduct(durableBackbone.database, ctx, durableBackbone.catalogs, rec, durableBackbone.secrets);
    console.log(
      `[sync] ${productId} → PostgreSQL: ${result.verified} verified journey(s), ` +
        `${result.docs} chunk(s) — ${result.published ? "published" : "review draft (needs a verified journey)"}`,
    );
  } catch (e) {
    console.warn(`[sync] ${productId} could not be mirrored to PostgreSQL: ${(e as Error).message}`);
  }
}

/** Recoverable default: stop activity, revoke access, and hide the product. */
app.post("/api/products/:id/archive", { preHandler: require_("admin") }, async (req, reply) => {
  const id = String((req.params as any).id);
  const rec = await getProduct(id, req.user!.orgId);
  if (!rec) return reply.code(404).send({ error: "unknown product" });

  const live = [...sessions.entries()].filter(([, s]) => s.product === id).map(([sid]) => sid);
  for (const sid of live) await endSession(sid).catch(() => {});
  await cancelDesktopSignIn(id).catch(() => {});

  // Remove the durable row too when the backbone is on, or the product would
  // vanish from this console and still be demoable from the customer UI.
  let durable = false;
  if (durableBackbone && req.tenant) {
    const aggregates = await durableBackbone.repositories.products.list(req.tenant).catch(() => []);
    const match = aggregates.find((a) => a.product.key === id);
    if (match) durable = await durableBackbone.repositories.products.remove(req.tenant, match.product.id).catch(() => false);
  }

  const archived = await archiveProduct(id, req.user!.orgId);
  emit("product.archived", {
    product: id,
    status: "ok",
    data: { sessionsEnded: live.length, durable },
  });
  return { ok: !!archived, id, archivedAt: archived?.archivedAt, sessionsEnded: live.length, durable };
});

/** Irreversible purge is owner-only and intentionally absent from the console. */
app.delete("/api/products/:id", { preHandler: require_("owner") }, async (req, reply) => {
  const id = String((req.params as any).id);
  const rec = await getProduct(id, req.user!.orgId);
  if (!rec) return reply.code(404).send({ error: "unknown product" });
  const live = [...sessions.entries()].filter(([, s]) => s.product === id).map(([sid]) => sid);
  for (const sid of live) await endSession(sid).catch(() => {});
  await cancelDesktopSignIn(id).catch(() => {});
  const removed = await deleteProduct(id);
  emit("product.purged", { product: id, status: "ok", data: { sessionsEnded: live.length, ...removed } });
  return { ok: true, id, sessionsEnded: live.length, ...removed };
});

app.delete("/api/products/:id/share", { preHandler: require_("admin") }, async (req, reply) => {
  const rec = await getProduct((req.params as any).id, req.user!.orgId);
  if (!rec) return reply.code(404).send({ error: "unknown product" });
  rec.share = undefined;
  await saveProduct(rec);
  emit("share.revoked", { product: rec.id, status: "ok" });
  return { ok: true };
});


// ================================ Operations ==================================
/*
 * A load balancer must be able to ask "are you alive" and "can you serve" before
 * anyone signs in, so these sit outside the auth gate. They deliberately answer
 * different questions: liveness is about this process, readiness is about the
 * dependencies a demo actually needs.
 */
const STARTED_AT = Date.now();

app.get("/healthz", async () => ({
  ok: true,
  capacity: capacityStats(),
  uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
  version: process.env.npm_package_version ?? "dev",
}));

app.get("/readyz", async (_req, reply) => {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};

  checks.chrome = { ok: !!findChrome(), detail: findChrome() ? "found" : "no real Chrome — Google SSO sign-in unavailable" };

  /*
   * Speech-to-text runs as a SEPARATE process (voice/server.py on VOICE_PORT).
   * Nothing here knew it existed, so when it wedged, voice input died silently:
   * the mic button appeared to work, the user spoke, and nothing whatsoever
   * happened. A dependency this load-bearing has to be observable.
   */
  checks.stt = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
    const port = Number(process.env.VOICE_PORT ?? 8089);
    /*
     * A TCP connect is NOT enough. The failure actually observed was a process
     * that had been up for days, accepted connections, took audio and returned
     * nothing at all — voice was dead while every port check passed. So complete
     * the websocket handshake and wait for the server's own {"type":"ready"}.
     */
    const sock = new WebSocket(`ws://127.0.0.1:${port}`);
    let settled = false;
    const done = (ok: boolean, detail: string) => {
      if (settled) return;
      settled = true;
      try { sock.close(); } catch { /* already closing */ }
      resolve({ ok, detail });
    };
    const timer = setTimeout(
      () => done(false, `connected on ${port} but never sent "ready" — the STT process is wedged; restart it`),
      3000,
    );
    sock.on("message", (raw: any) => {
      try {
        const m = JSON.parse(String(raw));
        if (m.type === "ready") {
          clearTimeout(timer);
          done(true, `ready on ${port} (provider=${m.provider})`);
        }
      } catch { /* not the message we want */ }
    });
    sock.on("error", () => {
      clearTimeout(timer);
      done(false, `not running on ${port} — voice input will be dead (start: python -m voice.server)`);
    });
  });

  const content = existsSync(CONTENT_ROOT);
  checks.content = { ok: content, detail: content ? "readable" : "content root missing" };
  if (durableBackbone) checks.database = {
    ok: await durableBackbone.healthcheck(),
    detail: "durable multi-tenant backbone",
  };

  try {
    const started = Date.now();
    const r = await fetch(`${config.openai.baseUrl.replace(/\/$/, "")}/models`, {
      headers: { authorization: `Bearer ${config.openai.apiKey}` },
      signal: AbortSignal.timeout(4000),
    });
    checks.model = { ok: r.ok, detail: `${r.status} in ${Date.now() - started}ms` };
  } catch (e) {
    checks.model = { ok: false, detail: (e as Error).message };
  }

  // Chrome missing only disables one sign-in path; it must not fail readiness.
  // STT missing disables voice entirely, but text demos still work — report it
  // loudly without taking the whole service out of rotation.
  const ready = checks.content.ok && checks.model.ok && (checks.database?.ok ?? true);
  return reply.code(ready ? 200 : 503).send({ ready, checks });
});

/** Prometheus exposition. Protected: it reveals usage and spend. */
app.get("/metrics", { preHandler: require_("viewer") }, async (req, reply) => {
  const lines: string[] = [];
  const add = (name: string, help: string, type: string, samples: [string, number][]) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, v] of samples) lines.push(`${name}${labels} ${v}`);
  };

  const products = await listProducts(req.user!.orgId);
  const perProduct: [string, number][] = [];
  const errs: [string, number][] = [];
  const cost: [string, number][] = [];
  for (const p of products) {
    const evs = await readEvents(p.id, { limit: 5000 });
    const r = rollup(evs);
    perProduct.push([`{product="${p.id}"}`, r.total]);
    errs.push([`{product="${p.id}"}`, r.errors]);
    cost.push([`{product="${p.id}"}`, r.costUsd]);
  }
  add("aidan_events_total", "Recorded events", "counter", perProduct);
  add("aidan_event_errors_total", "Recorded failures", "counter", errs);
  add("aidan_model_cost_usd", "Model spend", "counter", cost);
  add("aidan_uptime_seconds", "Process uptime", "gauge", [["", Math.round((Date.now() - STARTED_AT) / 1000)]]);
  add("aidan_live_sessions", "Demo sessions in flight", "gauge", [["", sessions.size]]);
  const cap = capacityStats();
  add("aidan_demo_slots_used", "Demo capacity in use", "gauge", [["", cap.demos.running]]);
  add("aidan_demo_slots_limit", "Demo capacity limit", "gauge", [["", cap.demos.limit]]);
  add("aidan_mapping_slots_used", "Mapping capacity in use", "gauge", [["", cap.mappings.running]]);

  reply.header("content-type", "text/plain; version=0.0.4");
  return lines.join("\n") + "\n";
});

// ============================ Products (onboarding) ============================
// Many products live side by side; a session names the one it wants. Nothing here
// depends on a global "current product", which is what forced a restart before.

app.get("/api/products", { preHandler: require_("viewer") }, async (req) => {
  const products = await listProducts(req.user!.orgId);
  return {
    products: await Promise.all(
      products.map(async (p) => {
        const g = await loadGraph(p.id, p.startUrl).catch(() => null);
        const verified = g ? g.journeys.filter(isJourneyPublishable).length : 0;
        const machineVerifiedJourneys = g ? g.journeys.filter(isJourneyMachineVerified).length : 0;
        return { ...p, auth: safeAuth(p.auth), verifiedJourneys: verified, machineVerifiedJourneys,
          mappedJourneys: g?.journeys.length ?? 0, job: jobState(p.id) };
      }),
    ),
    default: config.product,
  };
});

// ======================== Durable multi-tenant API =============================
// Kept under /api/v2 during the compatibility migration. These routes never read
// the filesystem product registry and therefore require the durable backbone.
const needBackbone = (reply: any) => {
  if (durableBackbone) return durableBackbone;
  reply.code(503).send({ error: "durable backend is disabled; configure DATABASE_URL" });
  return null;
};

function productUrl(value: unknown): string {
  const url = new URL(String(value));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error("startUrl must be an http(s) URL without embedded credentials");
  }
  return url.toString();
}

app.get("/api/v2/products", { preHandler: require_("viewer") }, async (req, reply) => {
  const backend = needBackbone(reply);
  if (!backend) return;
  return { products: await backend.repositories.products.list(req.tenant!) };
});

app.post("/api/v2/products/:id/embed-tokens", { preHandler: require_("admin") }, async (req, reply) => {
  const backend = needBackbone(reply);
  if (!backend) return;
  const body = (req.body ?? {}) as any;
  if (!body.roleProfileId || !Array.isArray(body.allowedOrigins) || !body.allowedOrigins.length) {
    return reply.code(400).send({ error: "roleProfileId and at least one allowedOrigins entry are required" });
  }
  try {
    const ctx = req.tenant!;
    const productId = String((req.params as any).id);
    const aggregate = await backend.repositories.products.get(ctx, productId);
    const bundle = aggregate ? await backend.catalogs.activeBundle(ctx, productId) : null;
    const role = aggregate?.roles.find((item) => item.id === String(body.roleProfileId) && item.environmentId === bundle?.environmentId);
    if (!aggregate || !bundle || !role) throw new Error("published product or role not found");
    const allowedOrigins: string[] = [...new Set<string>(body.allowedOrigins.map((value: unknown) => normalizedAllowedOrigin(String(value))))];
    const ttlSeconds = Math.max(300, Math.min(30 * 24 * 60 * 60, Number(body.ttlSeconds ?? 7 * 24 * 60 * 60)));
    const timestamp = new Date().toISOString();
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const grant: EmbedGrant = {
      id, organizationId: ctx.organizationId, productId, roleProfileId: role.id,
      allowedOrigins, expiresAt, createdAt: timestamp, updatedAt: timestamp,
    };
    await backend.repositories.access.saveEmbedGrant(ctx, grant);
    const token = issueEmbedToken({
      v: 1, jti: id, organizationId: ctx.organizationId, productId, roleProfileId: role.id,
      exp: Math.floor(Date.parse(expiresAt) / 1000),
    });
    return reply.code(201).send({ grant, token, query: `?product=${encodeURIComponent(productId)}&role=${encodeURIComponent(role.id)}&embed=${encodeURIComponent(token)}` });
  } catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
});

/**
 * Delete a durable product and everything versioned under it.
 *
 * The legacy DELETE /api/products/:id removes the same product's files and, when
 * it has a durable row, that too. This is the other direction: a product created
 * through /api/v2 has no content folder to delete, so it needs its own route or
 * it could never be removed at all.
 */
app.delete("/api/v2/products/:id", { preHandler: require_("admin") }, async (req, reply) => {
  const backend = needBackbone(reply);
  if (!backend) return;
  const productId = String((req.params as any).id);
  const aggregate = await backend.repositories.products.get(req.tenant!, productId);
  if (!aggregate) return reply.code(404).send({ error: "unknown product" });

  // End live demos first so deleting cannot strand a browser process.
  const live = [...sessions.entries()].filter(([, s]) => s.product === aggregate.product.key).map(([sid]) => sid);
  for (const sid of live) await endSession(sid).catch(() => {});

  const removed = await backend.repositories.products.remove(req.tenant!, productId);
  emit("product.deleted", {
    product: aggregate.product.key,
    status: removed ? "ok" : "error",
    data: { durable: removed, sessionsEnded: live.length },
  });
  return { ok: removed, id: productId, key: aggregate.product.key, sessionsEnded: live.length };
});

app.delete("/api/v2/embed-tokens/:id", { preHandler: require_("admin") }, async (req, reply) => {
  const backend = needBackbone(reply);
  if (!backend) return;
  try {
    await backend.repositories.access.revokeEmbedGrant(req.tenant!, String((req.params as any).id));
    return { ok: true };
  } catch (error) { return reply.code(404).send({ error: (error as Error).message }); }
});

app.post("/api/v2/products", { preHandler: require_("admin") }, async (req, reply) => {
  const backend = needBackbone(reply);
  if (!backend) return;
  const body = (req.body ?? {}) as any;
  if (!body.key || !body.name || !body.startUrl) return reply.code(400).send({ error: "key, name and startUrl are required" });
  try {
    const startUrl = productUrl(body.startUrl);
    return await backend.repositories.products.create(req.tenant!, {
      key: String(body.key), name: String(body.name),
      environment: {
        key: String(body.environmentKey ?? "default"), name: String(body.environmentName ?? "Default"),
        startUrl, productVersion: body.productVersion ? String(body.productVersion) : undefined,
        locale: body.locale ? String(body.locale) : undefined,
        featureFlags: body.featureFlags && typeof body.featureFlags === "object" ? body.featureFlags : {},
      },
    });
  } catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
});

app.post("/api/v2/products/:id/catalogs", { preHandler: require_("admin") }, async (req, reply) => {
  const backend = needBackbone(reply);
  if (!backend) return;
  const body = (req.body ?? {}) as any;
  if (!body.environmentId) return reply.code(400).send({ error: "environmentId is required" });
  try { return { catalog: await backend.repositories.catalogs.createDraft(req.tenant!, String((req.params as any).id), String(body.environmentId)) }; }
  catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
});

app.get("/api/v2/catalogs/:id", { preHandler: require_("viewer") }, async (req, reply) => {
  const backend = needBackbone(reply);
  if (!backend) return;
  const snapshot = await backend.repositories.catalogs.get(req.tenant!, String((req.params as any).id));
  if (!snapshot) return reply.code(404).send({ error: "catalog not found" });
  return snapshot;
});

app.post("/api/v2/journeys/:id/review", { preHandler: require_("admin") }, async (req, reply) => {
  const backend = needBackbone(reply);
  if (!backend) return;
  const body = (req.body ?? {}) as any;
  const decision = String(body.decision ?? "");
  if (!['approved', 'rejected', 'rework_requested'].includes(decision)) {
    return reply.code(400).send({ error: "decision must be approved, rejected or rework_requested" });
  }
  try {
    const journey = await backend.repositories.catalogs.reviewJourney(req.tenant!, String((req.params as any).id), {
      decision: decision as "approved" | "rejected" | "rework_requested",
      comment: body.comment ? String(body.comment) : undefined,
      instruction: body.instruction ? String(body.instruction) : undefined,
    });
    const timestamp = new Date().toISOString();
    const reviewSnapshot = await backend.repositories.catalogs.get(req.tenant!, journey.catalogVersionId);
    if (reviewSnapshot) {
      await backend.repositories.training.append(req.tenant!, {
        id: randomUUID(), organizationId: req.tenant!.organizationId, productId: reviewSnapshot.catalog.productId,
        catalogVersionId: journey.catalogVersionId, journeyVersionId: journey.id,
        eventType: `journey.review.${decision}`, actorType: "human", actorId: req.tenant!.actorId,
        payload: { revision: journey.revision, checksum: journey.revisionChecksum, comment: body.comment, instruction: body.instruction },
        createdAt: timestamp, updatedAt: timestamp,
      });
    }
    let reworkJob: MappingJob | undefined;
    if (decision === "rework_requested") {
      const snapshot = reviewSnapshot;
      const sourceJobId = typeof journey.evidence.mappingJobId === "string" ? journey.evidence.mappingJobId : undefined;
      const roleProfileId = journey.roleProfileIds[0];
      if (snapshot && sourceJobId && roleProfileId && mappingQueue) {
        reworkJob = {
          id: randomUUID(), organizationId: req.tenant!.organizationId, productId: snapshot.catalog.productId,
          environmentId: snapshot.catalog.environmentId, catalogVersionId: snapshot.catalog.id,
          status: "queued", stage: "preflight", attempts: 0,
          cursor: {
            roleProfileId, sourceJobId, skipSurvey: true, skipExistingVerification: true,
            targetedJobs: [{ goal: journey.workflow.name, why: "Human-requested correction", instruction: String(body.instruction), source: "human_rework" }],
            maxJobs: 1,
          },
          createdAt: timestamp, updatedAt: timestamp,
        };
        await backend.repositories.mappingJobs.enqueue(req.tenant!, reworkJob);
        await mappingQueue.enqueue(req.tenant!, reworkJob);
      }
    }
    return { journey, reworkJob, reworkQueued: Boolean(reworkJob) };
  } catch (error) {
    return reply.code(400).send({ error: (error as Error).message });
  }
});

app.post("/api/v2/products/:id/mapping-jobs", { preHandler: require_("admin") }, async (req, reply) => {
  const backend = needBackbone(reply);
  if (!backend) return;
  const body = (req.body ?? {}) as any;
  if (!body.environmentId || !body.roleProfileId) {
    return reply.code(400).send({ error: "environmentId and roleProfileId are required" });
  }
  const jobId = randomUUID();
  try {
    const ctx = req.tenant!;
    const aggregate = await backend.repositories.products.get(ctx, String((req.params as any).id));
    const environment = aggregate?.environments.find((item) => item.id === String(body.environmentId));
    const role = aggregate?.roles.find((item) => item.id === String(body.roleProfileId) && item.environmentId === environment?.id);
    if (!aggregate || !environment || !role) throw new Error("product environment or role not found");
    let catalog = body.catalogVersionId
      ? (await backend.repositories.catalogs.get(ctx, String(body.catalogVersionId)))?.catalog ?? null
      : null;
    if (catalog && (catalog.productId !== aggregate.product.id || catalog.environmentId !== environment.id || ["published", "retired"].includes(catalog.status))) {
      throw new Error("catalogVersionId is not an open catalog for this product environment");
    }
    if (!catalog && body.newCatalog !== true) {
      catalog = await backend.repositories.catalogs.getOpenDraft(ctx, aggregate.product.id, environment.id);
    }
    catalog ??= await backend.repositories.catalogs.createDraft(ctx, aggregate.product.id, environment.id);
    const timestamp = new Date().toISOString();
    const job: MappingJob = {
      id: jobId, organizationId: ctx.organizationId, productId: aggregate.product.id,
      environmentId: environment.id, catalogVersionId: catalog.id, status: "queued",
      stage: "preflight", cursor: {
        roleProfileId: role.id,
        maxJobs: Math.max(1, Math.min(200, Number(body.maxJobs ?? process.env.MAPPING_MAX_JOBS ?? 30))),
        maxScreens: Math.max(1, Math.min(500, Number(body.maxScreens ?? process.env.MAPPING_MAX_SCREENS ?? 50))),
      },
      attempts: 0, createdAt: timestamp, updatedAt: timestamp,
    };
    await backend.repositories.mappingJobs.enqueue(ctx, job);
    if (!mappingQueue) throw new Error("mapping queue is unavailable");
    await mappingQueue.enqueue(ctx, job);
    return reply.code(202).send({ job, catalog });
  } catch (error) {
    return reply.code(400).send({ error: (error as Error).message });
  }
});

app.get("/api/v2/mapping-jobs/:id", { preHandler: require_("viewer") }, async (req, reply) => {
  const backend = needBackbone(reply);
  if (!backend) return;
  const job = await backend.repositories.mappingJobs.get(req.tenant!, String((req.params as any).id));
  if (!job) return reply.code(404).send({ error: "mapping job not found" });
  return { job };
});

app.post("/api/v2/mapping-jobs/:id/:action", { preHandler: require_("admin") }, async (req, reply) => {
  const backend = needBackbone(reply);
  if (!backend) return;
  const action = String((req.params as any).action) as "pause" | "resume" | "cancel";
  if (!["pause", "resume", "cancel"].includes(action)) return reply.code(400).send({ error: "invalid mapping control" });
  try {
    const job = await backend.repositories.mappingJobs.control(req.tenant!, String((req.params as any).id), action);
    if (action === "resume") {
      if (!mappingQueue) throw new Error("mapping queue is unavailable");
      await mappingQueue.enqueue(req.tenant!, job);
    }
    const timestamp = new Date().toISOString();
    await backend.repositories.training.append(req.tenant!, {
      id: randomUUID(), organizationId: req.tenant!.organizationId, productId: job.productId,
      catalogVersionId: job.catalogVersionId, mappingJobId: job.id,
      eventType: `mapping.${action}`, actorType: "human", actorId: req.tenant!.actorId,
      payload: { status: job.status, stage: job.stage }, createdAt: timestamp, updatedAt: timestamp,
    });
    return { job };
  } catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
});

app.get("/api/v2/products/:id/training-events", { preHandler: require_("viewer") }, async (req, reply) => {
  const backend = needBackbone(reply);
  if (!backend) return;
  const productId = String((req.params as any).id);
  const limit = Number((req.query as any)?.limit ?? 500);
  const [events, corrections] = await Promise.all([
    backend.repositories.training.list(req.tenant!, productId, limit),
    backend.repositories.training.listCorrections(req.tenant!, productId),
  ]);
  return { events, corrections };
});

app.post("/api/v2/credential-refs", { preHandler: require_("admin") }, async (req, reply) => {
  const backend = needBackbone(reply);
  if (!backend) return;
  const body = (req.body ?? {}) as any;
  if (!body.provider || !body.secretPath) return reply.code(400).send({ error: "provider and secretPath are required" });
  const timestamp = new Date().toISOString();
  const value = {
    id: randomUUID(), organizationId: req.tenant!.organizationId,
    provider: String(body.provider), secretPath: String(body.secretPath),
    metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : {},
    expiresAt: body.expiresAt ? String(body.expiresAt) : undefined,
    createdAt: timestamp, updatedAt: timestamp,
  };
  await backend.repositories.access.saveCredentialRef(req.tenant!, value);
  return reply.code(201).send({ credentialRef: value });
});

/** Store credential material in Vault and only its pointer in PostgreSQL. */
app.post("/api/v2/credentials", { preHandler: require_("admin") }, async (req, reply) => {
  const backend = needBackbone(reply);
  if (!backend) return;
  const body = (req.body ?? {}) as any;
  if (!body.roleProfileId) return reply.code(400).send({ error: "roleProfileId is required" });
  // Default to the always-available encrypted PostgreSQL store. It used to be
  // "vault", which meant this route failed on every install without a Vault
  // server — and that is the only way the Add-product UI can store a login.
  const provider = String(body.provider ?? process.env.SECRET_PROVIDER ?? "postgres");
  const id = randomUUID();
  const secretPath = String(body.secretPath ?? `organizations/${req.tenant!.organizationId}/credentials/${id}`);
  const timestamp = new Date().toISOString();
  try {
    const aggregates = await backend.repositories.products.list(req.tenant!);
    const aggregate = aggregates.find((item) => item.roles.some((role) => role.id === String(body.roleProfileId)));
    const role = aggregate?.roles.find((item) => item.id === String(body.roleProfileId));
    if (!role) throw new Error("role profile not found");
    await backend.secrets.store(provider, secretPath, {
      username: body.username ? String(body.username) : undefined,
      password: body.password ? String(body.password) : undefined,
      sessionState: body.sessionState ? String(body.sessionState) : undefined,
      sessionStorage: body.sessionStorage ? String(body.sessionStorage) : undefined,
      profileDir: body.profileDir ? String(body.profileDir) : undefined,
    });
    const ref: CredentialRef = {
      id, organizationId: req.tenant!.organizationId, provider, secretPath,
      metadata: body.accountLabel ? { accountLabel: String(body.accountLabel) } : {},
      expiresAt: body.expiresAt ? String(body.expiresAt) : undefined,
      createdAt: timestamp, updatedAt: timestamp,
    };
    await backend.repositories.access.saveCredentialRef(req.tenant!, ref);
    await backend.repositories.access.saveRoleProfile(req.tenant!, { ...role, credentialRefId: id, updatedAt: timestamp });
    return reply.code(201).send({ credentialRef: { ...ref, secretPath: "stored securely" }, roleProfileId: role.id });
  } catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
});

app.post("/api/v2/environments/:id/roles", { preHandler: require_("admin") }, async (req, reply) => {
  const backend = needBackbone(reply);
  if (!backend) return;
  const body = (req.body ?? {}) as any;
  if (!body.key || !body.name) return reply.code(400).send({ error: "key and name are required" });
  const timestamp = new Date().toISOString();
  const value = {
    id: randomUUID(), organizationId: req.tenant!.organizationId, environmentId: String((req.params as any).id),
    key: String(body.key), name: String(body.name), credentialRefId: body.credentialRefId ? String(body.credentialRefId) : undefined,
    permissionHints: Array.isArray(body.permissionHints) ? body.permissionHints.map(String) : [],
    createdAt: timestamp, updatedAt: timestamp,
  };
  try { await backend.repositories.access.saveRoleProfile(req.tenant!, value); return reply.code(201).send({ roleProfile: value }); }
  catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
});

app.get("/api/v2/environments/:id/roles", { preHandler: require_("viewer") }, async (req, reply) => {
  const backend = needBackbone(reply);
  if (!backend) return;
  return { roles: await backend.repositories.access.listRoleProfiles(req.tenant!, String((req.params as any).id)) };
});

app.post("/api/v2/catalogs/:id/publish", { preHandler: require_("admin") }, async (req, reply) => {
  const backend = needBackbone(reply);
  if (!backend) return;
  try {
    const bundle = await backend.catalogs.publish(req.tenant!, String((req.params as any).id));
    return { catalogVersionId: bundle.catalogVersionId, journeys: bundle.journeys.length, coverage: bundle.coverage };
  } catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
});

app.post("/api/v2/evidence", { preHandler: require_("viewer") }, async (req, reply) => {
  const backend = needBackbone(reply);
  if (!backend) return;
  const body = (req.body ?? {}) as any;
  if (!body.productId || !body.roleProfileId || !body.text) return reply.code(400).send({ error: "productId, roleProfileId and text are required" });
  try {
    return await backend.evidence.route(req.tenant!, {
      productId: String(body.productId), roleProfileId: String(body.roleProfileId), text: String(body.text),
      screen: body.screen,
    });
  } catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
});

app.post("/api/v2/products/:id/knowledge", { preHandler: require_("admin") }, async (req, reply) => {
  const backend = needBackbone(reply);
  if (!backend) return;
  const body = (req.body ?? {}) as any;
  if (!body.title || !body.content) return reply.code(400).send({ error: "title and content are required" });
  const trust = String(body.trust ?? "official");
  if (!["official", "marketing", "community", "sales_expert"].includes(trust)) {
    return reply.code(400).send({ error: "invalid knowledge trust level" });
  }
  try {
    const result = await backend.knowledgeIngestion.ingest(req.tenant!, {
      productId: String((req.params as any).id), title: String(body.title), content: String(body.content),
      uri: String(body.uri ?? `manual://${randomUUID()}`), sourceType: String(body.sourceType ?? "manual"),
      externalKey: body.externalKey ? String(body.externalKey) : undefined,
      trust: trust as "official" | "marketing" | "community" | "sales_expert",
      sourceModifiedAt: body.sourceModifiedAt ? String(body.sourceModifiedAt) : undefined,
    });
    return reply.code(201).send(result);
  } catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
});

app.post("/api/v2/products/:id/knowledge/sync", { preHandler: require_("admin") }, async (req, reply) => {
  const backend = needBackbone(reply);
  if (!backend) return;
  const body = (req.body ?? {}) as any;
  const urls = Array.isArray(body.urls) ? body.urls.map(String) : [];
  const sitemap = body.sitemap ? String(body.sitemap) : undefined;
  if ((!urls.length && !sitemap) || urls.length > 50) return reply.code(400).send({ error: "provide a sitemap or 1 to 50 URLs" });
  const trust = String(body.trust ?? "official");
  if (!["official", "marketing", "community", "sales_expert"].includes(trust)) return reply.code(400).send({ error: "invalid knowledge trust level" });
  try {
    const result = await backend.knowledgeIngestion.syncWeb(req.tenant!, {
      productId: String((req.params as any).id),
      spec: {
        urls, sitemap, trust: trust as any,
        include: Array.isArray(body.include) ? body.include.slice(0, 20).map((value: unknown) => String(value).slice(0, 200)) : undefined,
        exclude: Array.isArray(body.exclude) ? body.exclude.slice(0, 20).map((value: unknown) => String(value).slice(0, 200)) : undefined,
        limit: Math.max(1, Math.min(500, Number(body.limit ?? (sitemap ? 100 : urls.length)))),
        concurrency: Math.max(1, Math.min(12, Number(body.concurrency ?? 8))),
      },
    });
    return reply.code(201).send(result);
  } catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
});

app.get("/api/v2/products/:id/feedback", { preHandler: require_("viewer") }, async (req, reply) => {
  const backend = needBackbone(reply);
  if (!backend) return;
  const limit = Math.max(1, Math.min(1000, Number((req.query as any)?.limit ?? 100)));
  return { signals: await backend.repositories.feedback.listForProduct(req.tenant!, String((req.params as any).id), limit) };
});

/** Register a product, preflight it, and (unless told otherwise) start mapping. */
app.post("/api/products", { preHandler: require_("admin") }, async (req, reply) => {
  const b = (req.body ?? {}) as any;
  if (!b.name || !b.startUrl) return reply.code(400).send({ error: "name and startUrl are required" });

  const rec = await scaffoldProduct({
    organizationId: req.user!.orgId,
    name: String(b.name),
    startUrl: String(b.startUrl),
    /*
     * Accept BOTH the flat form the console posts and a nested `auth` object.
     * The nested shape was silently discarded, so an API caller who sent the
     * obvious thing got a product with no credentials and a preflight failure
     * that blamed the product rather than the request.
     */
    auth: b.auth && typeof b.auth === "object"
      ? {
          mode: (b.auth.mode as any) ?? (b.auth.username ? "login" : "none"),
          username: b.auth.username ? String(b.auth.username) : undefined,
          password: b.auth.password ? String(b.auth.password) : undefined,
          accountLabel: b.auth.accountLabel ? String(b.auth.accountLabel) : b.accountLabel ? String(b.accountLabel) : undefined,
        }
      : b.username
        ? { mode: "login", username: String(b.username), password: String(b.password ?? ""), accountLabel: b.accountLabel ? String(b.accountLabel) : undefined }
        : { mode: "none", accountLabel: b.accountLabel ? String(b.accountLabel) : undefined },
    allowActions: Array.isArray(b.allowActions) ? b.allowActions.map(String) : [],
    notes: b.notes ? String(b.notes) : undefined,
  });

  /*
   * An SSO product will obviously show a login page, so preflighting it first only
   * produces a confusing "failed". Skip straight to interactive sign-in.
   */
  if (b.skipPreflight) {
    rec.onboarding = { status: "new", message: "Waiting for interactive sign-in.", updatedAt: new Date().toISOString() };
    await saveProduct(rec);
    return { product: { ...rec, auth: safeAuth(rec.auth) }, preflight: null, mapping: false };
  }

  const pre = await preflight(rec);
  rec.onboarding = { status: pre.ok ? "preflight_ok" : "preflight_failed", message: pre.message, updatedAt: new Date().toISOString() };
  await saveProduct(rec);
  // Register it durably straight away, so a product exists in PostgreSQL from
  // the moment it is linked rather than only once mapping happens to succeed.
  await syncProductToDurable(rec.id);

  // Only map when we know we're actually inside the product — mapping a login
  // page used to "succeed" and produce a useless catalogue.
  if (pre.ok && b.autoMap !== false) {
    void startOnboardingJob(rec, {
      maxJobs: b.maxJobs === undefined ? undefined : Number(b.maxJobs),
      maxScreens: b.maxScreens === undefined ? undefined : Number(b.maxScreens),
    })
      .catch(() => {}) // already recorded by the pipeline's own trace
      .finally(() => syncProductToDurable(rec.id));
  }
  emit("product.linked", {
    product: rec.id,
    status: pre.ok ? "ok" : "error",
    error: pre.ok ? undefined : pre.message,
    data: {
      name: rec.name, startUrl: rec.startUrl, authMode: rec.auth.mode,
      reachable: pre.reachable, needsLogin: pre.needsLogin, loggedIn: pre.loggedIn,
      screens: pre.screens, controls: pre.controls,
    },
  });
  return { product: { ...rec, auth: safeAuth(rec.auth) }, preflight: pre, mapping: pre.ok && b.autoMap !== false };
});

/**
 * Upload knowledge for a product.
 *
 * Docs are what stop Aidan inventing features, and until now they had to be
 * hand-copied into content/<id>/docs/ — which made "add a product I've never
 * seen" a developer task. Accepts pasted text or file contents, writes them into
 * the product's docs folder, re-ingests, and re-embeds.
 *
 *   POST /api/products/:id/docs  { files: [{ name, text }], sources?: ["https://…"] }
 */
app.post("/api/products/:id/docs", { preHandler: require_("admin") }, async (req, reply) => {
  const rec = await getProduct((req.params as any).id, req.user!.orgId);
  if (!rec) return reply.code(404).send({ error: "unknown product" });
  const b = (req.body ?? {}) as any;
  const files: { name?: string; text?: string }[] = Array.isArray(b.files) ? b.files : [];
  const sources: string[] = Array.isArray(b.sources) ? b.sources.map(String) : [];
  if (!files.length && !sources.length) return reply.code(400).send({ error: "provide files[] and/or sources[]" });

  const dir = path.join(CONTENT_ROOT, rec.id);
  await fs.mkdir(path.join(dir, "docs"), { recursive: true });

  let written = 0;
  for (const f of files) {
    const text = String(f.text ?? "").trim();
    if (!text) continue;
    // Keep the filename safe and always .md — ingest only reads md/txt.
    const base = String(f.name ?? `upload-${written + 1}`).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/\.(md|txt|markdown)$/i, "");
    await fs.writeFile(path.join(dir, "docs", `${base || `upload-${written + 1}`}.md`), text);
    written++;
  }
  /*
   * "Read all docs under this URL".
   *
   * Expansion happens HERE, at write time, rather than inside the crawler at
   * read time. That keeps sources.txt the single source of truth: the operator
   * can see exactly which pages will be indexed and delete the ones they do not
   * want, and re-ingesting crawls the same list rather than silently drifting
   * because the vendor added a nav item. The cost is that the list goes stale,
   * which is why the seed is recorded in a comment so it can be re-expanded.
   */
  const expanded: { seed: string; urls: string[]; method: string; warning?: string }[] = [];
  let finalSources = sources;
  if (b.expand && sources.length) {
    finalSources = [];
    for (const seed of sources) {
      try {
        const found = await discoverLinks(seed, {
          maxDepth: b.maxDepth === undefined ? undefined : Number(b.maxDepth),
          limit: b.limit === undefined ? undefined : Number(b.limit),
        });
        expanded.push({ seed, urls: found.urls, method: found.method, warning: found.warning });
        finalSources.push(...found.urls);
      } catch (e) {
        // One unreachable seed must not lose the others, or the uploaded files.
        expanded.push({ seed, urls: [seed], method: "failed", warning: (e as Error).message });
        finalSources.push(seed);
      }
    }
    finalSources = [...new Set(finalSources)];
  }

  // URLs are crawled by ingest via sources.txt.
  if (finalSources.length) {
    const file = path.join(dir, "sources.txt");
    const existing = existsSync(file) ? await fs.readFile(file, "utf8") : "";
    // `#` lines are comments to the sources.txt parser (ingest.ts), so the
    // provenance header costs nothing and survives a round trip.
    const header = expanded
      .filter((e) => e.method !== "failed")
      .map((e) => `# ${e.urls.length} page(s) expanded from ${e.seed} via ${e.method} on ${new Date().toISOString().slice(0, 10)}`);
    const merged = [...new Set([...existing.split("\n"), ...header, ...finalSources].map((l) => l.trim()).filter(Boolean))];
    await fs.writeFile(file, merged.join("\n") + "\n");
  }

  // Re-ingest so the new knowledge is live immediately (no restart).
  const kb = await brainFor(rec.id);
  const before = kb.docs.length;
  await ingestContent(dir, kb);
  const gained = kb.docs.length - before;

  /*
   * Say so when a large source list produced almost no knowledge.
   *
   * Every page of a client-rendered docs site answers 200 with an empty shell,
   * so nothing looks like an error anywhere: the crawl "succeeds", the pages are
   * dropped as too short, and the only signal is a chunk count that the operator
   * has to notice is wrong. docs.llmapi.ai added 147 URLs and produced one chunk
   * — the untouched template — and reported success.
   */
  const warnings: string[] = [];
  if (finalSources.length >= 5 && gained < finalSources.length * 0.5) {
    warnings.push(
      `${finalSources.length} URL(s) produced only ${gained} new chunk(s). If this documentation renders with JavaScript, ` +
        `set CRAWL_RENDER=always to fetch it with a browser, or check the pages are publicly reachable.`,
    );
  }

  return {
    ok: true,
    filesWritten: written,
    sourcesAdded: finalSources.length,
    docChunks: kb.docs.length,
    chunksGained: gained,
    ...(expanded.length ? { expanded } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
});

/** Set the spoken voice for a product (admin console). */
app.post("/api/products/:id/voice", { preHandler: require_("admin") }, async (req, reply) => {
  const rec = await getProduct((req.params as any).id, req.user!.orgId);
  if (!rec) return reply.code(404).send({ error: "unknown product" });
  const b = (req.body ?? {}) as any;
  rec.voice = {
    ...(rec.voice ?? {}),
    ...(b.provider ? { provider: b.provider === "openai" ? "openai" : "sarvam" } : {}),
    ...(b.speaker ? { speaker: String(b.speaker) } : {}),
    ...(b.language ? { language: String(b.language) } : {}),
    ...(b.pace ? { pace: Number(b.pace) } : {}),
  };
  await saveProduct(rec);
  return { ok: true, voice: rec.voice };
});

/* ===================== Interactive sign-in (SSO / 2FA) =====================
 * The user signs in themselves inside our streamed browser; we capture the
 * resulting session. No password ever reaches this process.
 */

/** Open a sign-in window and return its id — stream it over /ws/auth. */
app.post("/api/products/:id/auth/start", { preHandler: require_("admin") }, async (req, reply) => {
  const rec = await getProduct((req.params as any).id, req.user!.orgId);
  if (!rec) return reply.code(404).send({ error: "unknown product" });
  const loginUrl = String(((req.body ?? {}) as any).loginUrl ?? "").trim() || undefined;
  try {
    return await startAuthSession(rec, loginUrl);
  } catch (e) {
    return reply.code(502).send({ error: `could not open a browser: ${(e as Error).message}` });
  }
});

/** Where has the human got to? Drives the "grant access to this?" prompt. */
app.get("/api/auth/:authId/status", { preHandler: require_("admin") }, async (req, reply) => {
  const session = getAuthSession((req.params as any).authId);
  if (!session || session.organizationId !== req.user!.orgId) return reply.code(404).send({ error: "sign-in window not found or expired" });
  const st = await authSessionStatus((req.params as any).authId);
  if (!st) return reply.code(404).send({ error: "sign-in window not found or expired" });
  return st;
});

/** The user confirms: store the session (and optionally adopt the landing URL). */
app.post("/api/auth/:authId/capture", { preHandler: require_("admin") }, async (req, reply) => {
  const session = getAuthSession((req.params as any).authId);
  if (!session || session.organizationId !== req.user!.orgId) return reply.code(404).send({ error: "sign-in window not found or expired" });
  const r = await captureAuthSession((req.params as any).authId, {
    useCurrentUrlAsStart: ((req.body ?? {}) as any).useCurrentUrlAsStart !== false,
  });
  if (!r.ok) return reply.code(400).send({ error: r.error });
  return r;
});

app.post("/api/auth/:authId/cancel", { preHandler: require_("admin") }, async (req, reply) => {
  const session = getAuthSession((req.params as any).authId);
  if (!session || session.organizationId !== req.user!.orgId) return reply.code(404).send({ error: "sign-in window not found or expired" });
  await cancelAuthSession((req.params as any).authId);
  return { ok: true };
});


/*
 * ---- Sign-in in real Chrome (the Google / SSO path) --------------------------
 * The streamed window above works for ordinary login forms, but Google refuses
 * OAuth inside Playwright's Chromium ("this browser or app may not be secure").
 * These routes hand the sign-in to genuine Chrome on the user's own desktop and
 * then adopt the profile. See chromeprofile.ts for why that is the right call.
 */

/** Does this machine even have real Chrome? The UI hides the option if not. */
app.get("/api/capabilities", async () => {
  const chrome = findChrome();
  return { realChrome: !!chrome, chromePath: chrome ? chrome.split("/").pop() : null };
});

/** Open genuine Chrome at the sign-in page for the human to use. */
app.post("/api/products/:id/auth/desktop", { preHandler: require_("admin") }, async (req, reply) => {
  const rec = await getProduct((req.params as any).id, req.user!.orgId);
  if (!rec) return reply.code(404).send({ error: "unknown product" });
  const signInUrl = String(((req.body ?? {}) as any).signInUrl ?? "").trim() || undefined;
  const r = await openDesktopSignIn(rec, signInUrl);
  if (!r.ok) return reply.code(400).send({ error: r.error });
  return r;
});

/** Is their Chrome window still open? Lets the console show live state. */
app.get("/api/products/:id/auth/desktop", { preHandler: require_("admin") }, async (req, reply) => {
  const rec = await getProduct((req.params as any).id, req.user!.orgId);
  if (!rec) return reply.code(404).send({ error: "unknown product" });
  return desktopSignInStatus(rec.id);
});

/** "I'm signed in." Copy and replay-prove the live session before committing it. */
app.post("/api/products/:id/auth/desktop/done", { preHandler: require_("admin") }, async (req, reply) => {
  const id = (req.params as any).id;
  if (!await getProduct(id, req.user!.orgId)) return reply.code(404).send({ error: "unknown product" });
  const r = await finishDesktopSignIn(id, {
    useCurrentUrlAsStart: ((req.body ?? {}) as any).useCurrentUrlAsStart !== false,
  });
  emit(r.ok ? "auth.granted" : "auth.rejected", {
    product: id,
    status: r.ok ? "ok" : "error",
    error: r.ok ? undefined : r.error,
    // Deliberately no session material, only its shape — see events.ts scrubbing.
    data: r.ok ? { method: "chrome-profile", origins: r.origins, cookieCount: r.cookieCount, landedOn: r.url } : { method: "chrome-profile" },
  });
  if (!r.ok) return reply.code(400).send(r);
  return r;
});

app.post("/api/products/:id/auth/desktop/cancel", { preHandler: require_("admin") }, async (req, reply) => {
  if (!await getProduct((req.params as any).id, req.user!.orgId)) return reply.code(404).send({ error: "unknown product" });
  await cancelDesktopSignIn((req.params as any).id);
  return { ok: true };
});

/** Revoke a stored session. */
app.post("/api/products/:id/auth/clear", { preHandler: require_("admin") }, async (req, reply) => {
  const id = (req.params as any).id;
  if (!await getProduct(id, req.user!.orgId)) return reply.code(404).send({ error: "unknown product" });
  const ok = await clearStoredSession(id);
  if (!ok) return reply.code(404).send({ error: "unknown product" });
  // The Chrome profile grants account access on its own, so revoking has to
  // remove it as well — otherwise "clear" would only clear the copy.
  const profileDeleted = await deleteProfile(id).catch(() => false);
  emit("auth.revoked", { product: id, status: "ok", data: { profileDeleted } });
  return { ok: true, profileDeleted };
});


/**
 * Demonstration capture (Mapper M2) — teach a journey by doing it once.
 *
 * The escape hatch for everything autonomous exploration cannot reach: custom
 * widgets, multi-step wizards, screens with no confirmation. A demonstration
 * still earns no special trust — `finish` replays it from a clean state through
 * the same gate as an explored journey, and publishes only if it passes.
 */
app.post("/api/products/:id/demonstrate", { preHandler: require_("admin") }, async (req, reply) => {
  const rec = await getProduct((req.params as any).id, req.user!.orgId);
  if (!rec) return reply.code(404).send({ error: "unknown product" });
  try {
    return await startDemonstration(rec);
  } catch (e) {
    return reply.code(502).send({ error: (e as Error).message });
  }
});

app.get("/api/demo/:demoId/status", { preHandler: require_("admin") }, async (req, reply) => {
  const session = getDemoSession((req.params as any).demoId);
  if (!session || session.organizationId !== req.user!.orgId) return reply.code(404).send({ error: "recording not found or expired" });
  const st = await demonstrationStatus((req.params as any).demoId);
  if (!st) return reply.code(404).send({ error: "recording not found or expired" });
  return st;
});

/** Observed proof options, best first — the person picks rather than invents. */
app.get("/api/demo/:demoId/proofs", { preHandler: require_("admin") }, async (req, reply) => {
  const session = getDemoSession((req.params as any).demoId);
  if (!session || session.organizationId !== req.user!.orgId) return reply.code(404).send({ error: "recording not found or expired" });
  return { options: await demonstrationProofOptions((req.params as any).demoId) };
});

app.post("/api/demo/:demoId/finish", { preHandler: require_("admin") }, async (req, reply) => {
  const session = getDemoSession((req.params as any).demoId);
  if (!session || session.organizationId !== req.user!.orgId) return reply.code(404).send({ error: "recording not found or expired" });
  const b = (req.body ?? {}) as any;
  const out = await finishDemonstration((req.params as any).demoId, {
    goal: String(b.goal ?? ""),
    postcondition: b.postcondition ? String(b.postcondition) : undefined,
    capability: b.capability ? String(b.capability) : undefined,
    publish: b.publish !== false,
  });
  if (out.ok) await cancelDemonstration((req.params as any).demoId);
  // A demonstration that does not replay is a 200 with ok:false, not an error —
  // the caller needs the detail and the proof candidates to try again.
  return reply.code(out.ok ? 200 : 422).send(out);
});

app.post("/api/demo/:demoId/cancel", { preHandler: require_("admin") }, async (req, reply) => {
  const session = getDemoSession((req.params as any).demoId);
  if (!session || session.organizationId !== req.user!.orgId) return reply.code(404).send({ error: "recording not found or expired" });
  await cancelDemonstration((req.params as any).demoId);
  return { ok: true };
});

/** Previous graphs, so a bad re-map is recoverable rather than terminal. */
app.get("/api/products/:id/graph/versions", { preHandler: require_("viewer") }, async (req, reply) => {
  const rec = await getProduct((req.params as any).id, req.user!.orgId);
  if (!rec) return reply.code(404).send({ error: "unknown product" });
  return { versions: await listGraphVersions(rec.id) };
});

app.post("/api/products/:id/graph/restore", { preHandler: require_("admin") }, async (req, reply) => {
  const id = (req.params as any).id;
  if (!await getProduct(id, req.user!.orgId)) return reply.code(404).send({ error: "unknown product" });
  const versionId = String(((req.body ?? {}) as any).version ?? "");
  const g = await restoreGraphVersion(id, versionId);
  if (!g) return reply.code(404).send({ error: "unknown version" });
  // The published flows are derived from the graph, so they must be rebuilt or the
  // live agent would keep replaying journeys from the version we just replaced.
  // Flows are DERIVED from the graph, so restoring the graph without rebuilding
  // them would leave the live agent replaying journeys from the version we just
  // replaced — the restore would look successful and change nothing.
  const kb = await brainFor(id);
  const restoredFlows = journeysToFlows(g);
  kb.setMappedFlows(restoredFlows as any);
  await kb.buildEmbeddings();
  await kb.save("docs", "flows");
  emit("map.publish", { product: id, status: "ok", data: {
    reason: "published restored graph version",
    flowsPublished: restoredFlows.map((flow) => flow.name),
    flowCount: restoredFlows.length,
    executablePrograms: restoredFlows.filter((flow: any) => Array.isArray(flow.program) && flow.program.length > 0).length,
  } });
  emit("graph.restored", { product: id, status: "ok", data: { version: versionId, journeys: g.journeys.length } });
  return { ok: true, journeys: g.journeys.length, verified: g.journeys.filter(isJourneyPublishable).length };
});

app.post("/api/products/:id/preflight", { preHandler: require_("admin") }, async (req, reply) => {
  const rec = await getProduct((req.params as any).id, req.user!.orgId);
  if (!rec) return reply.code(404).send({ error: "unknown product" });
  return preflight(rec);
});

/** Re-run (or start) the catalogue for an existing product. */
app.post("/api/products/:id/onboard", { preHandler: require_("admin") }, async (req, reply) => {
  const rec = await getProduct((req.params as any).id, req.user!.orgId);
  if (!rec) return reply.code(404).send({ error: "unknown product" });
  // Never enqueue a multi-minute mapping job on an unverified browser session.
  // This endpoint used to bypass the existing /preflight route, so an expired
  // session was only discovered after the survey had mapped the login screen.
  const access = await preflight(rec);
  if (!access.ok) {
    await setStatus(rec.id, "preflight_failed", access.message);
    emit("map.blocked", {
      product: rec.id,
      status: "error",
      error: access.message,
      data: { reason: access.needsLogin ? "authentication_required" : "preflight_failed" },
    });
    return reply.code(409).send({
      started: false,
      code: access.needsLogin ? "AUTH_REQUIRED" : "PREFLIGHT_FAILED",
      error: access.message,
      preflight: access,
    });
  }
  const b = (req.body ?? {}) as any;
  const opts = {
    maxJobs: Number(b.maxJobs ?? process.env.MAPPING_MAX_JOBS ?? 30),
    maxScreens: Number(b.maxScreens ?? process.env.MAPPING_MAX_SCREENS ?? 50),
  };
  /*
   * Wrapping the job in a trace is what makes mapping observable: every model
   * call, verification and failure underneath lands in one activity, without
   * the mapper having to know the event log exists.
   */
  try {
    // Mapping drives its own browsers and is the heaviest thing here, so it is
    // capped separately and much lower than demos.
    await distributedCapacity.acquire("mapping", `map-${rec.id}`);
    try {
      acquire("mapping", `map-${rec.id}`, rec.id, async () => {});
    } catch (error) {
      await distributedCapacity.release(`map-${rec.id}`).catch(() => {});
      throw error;
    }
  } catch (e) {
    if (e instanceof AtCapacity) return reply.code(503).send({ error: e.message, capacity: capacityStats() });
    throw e;
  }
  // No trace wrapper here: `onboardProduct` opens its own, so every caller —
  // HTTP and CLI alike — is traced exactly once. Wrapping again would nest a
  // second trace around the same run and split it across two ids.
  void startOnboardingJob(rec, opts)
    .catch(() => {}) // already recorded by the pipeline's own trace
    .finally(async () => {
      release(`map-${rec.id}`);
      await distributedCapacity.release(`map-${rec.id}`).catch(() => {});
      await syncProductToDurable(rec.id);
    });
  return { started: true, product: rec.id };
});

/** Live training state — SSE keeps the cockpit current without log polling. */
app.get("/api/products/:id/training/stream", { preHandler: require_("viewer") }, async (req, reply) => {
  const id = String((req.params as any).id);
  if (!await getProduct(id, req.user!.orgId)) return reply.code(404).send({ error: "unknown product" });
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  const send = (state: ReturnType<typeof jobState>) => reply.raw.write(`event: training\ndata: ${JSON.stringify(state)}\n\n`);
  const unsubscribe = subscribeTraining(id, send);
  const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
  req.raw.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
});

app.post("/api/products/:id/training/:action", { preHandler: require_("admin") }, async (req, reply) => {
  const id = String((req.params as any).id);
  const action = String((req.params as any).action) as "pause" | "resume" | "cancel";
  if (!await getProduct(id, req.user!.orgId)) return reply.code(404).send({ error: "unknown product" });
  if (!["pause", "resume", "cancel"].includes(action)) return reply.code(400).send({ error: "invalid training control" });
  const job = controlTrainingJob(id, action);
  emit(`training.${action}`, { product: id, status: "ok", data: { actor: req.user!.email, runId: (job as any).runId } });
  return { ok: true, job };
});

/** Human review is bound to one exact journey revision checksum. */
app.post("/api/products/:id/journeys/:journeyId/review", { preHandler: require_("admin") }, async (req, reply) => {
  const id = String((req.params as any).id);
  const journeyId = String((req.params as any).journeyId);
  const rec = await getProduct(id, req.user!.orgId);
  if (!rec) return reply.code(404).send({ error: "unknown product" });
  const body = (req.body ?? {}) as any;
  const action = String(body.action ?? "");
  if (!['approve', 'reject', 'rework'].includes(action)) return reply.code(400).send({ error: "action must be approve, reject or rework" });
  const graph = await loadGraph(id, rec.startUrl);
  const journey = graph.journeys.find((item) => item.id === journeyId);
  if (!journey) return reply.code(404).send({ error: "journey not found" });
  if (action === "approve" && !isJourneyMachineVerified(journey)) {
    return reply.code(409).send({ error: "journey must pass automated verification before approval" });
  }
  const instruction = String(body.instruction ?? "").trim();
  if (action === "rework" && !instruction) return reply.code(400).send({ error: "a rework instruction is required" });
  if (action === "rework" && jobState(id).running) controlTrainingJob(id, "pause");
  reviewJourney(
    journey,
    action === "approve" ? "approved" : action === "reject" ? "rejected" : "rework_requested",
    req.user!.email,
    String(body.comment ?? ""),
    instruction,
  );
  if (action === "rework") {
    graph.backlog = graph.backlog.filter((item) => item.goal !== journey.goal).concat({
      goal: journey.goal,
      why: `Reviewer requested revision ${Number(journey.revision ?? 1) + 1}`,
      status: "pending",
      instruction,
      source: "human_rework",
    });
  }
  await saveGraph(graph);
  const machinePassed = graph.journeys.filter(isJourneyMachineVerified).length;
  const approved = graph.journeys.filter(isJourneyPublishable).length;
  const releaseReady = machinePassed > 0 && approved === machinePassed;
  if (releaseReady) {
    const kb = await brainFor(id);
    const publishedFlows = journeysToFlows(graph);
    kb.setMappedFlows(publishedFlows as any);
    await kb.buildEmbeddings();
    await kb.save("flows");
    emit("map.publish", { product: id, status: "ok", data: {
      reason: "all machine-verified journey revisions received human approval",
      flowsPublished: publishedFlows.map((flow) => flow.name),
      flowCount: publishedFlows.length,
      executablePrograms: publishedFlows.filter((flow: any) => Array.isArray(flow.program) && flow.program.length > 0).length,
    } });
  } else {
    emit("map.publish", { product: id, status: "ok", data: {
      published: false,
      reason: machinePassed ? "waiting for remaining human approvals" : "no machine-verified journeys",
      machineVerified: machinePassed,
      approved,
    } });
  }
  await setStatus(id, releaseReady ? "ready" : machinePassed ? "awaiting_review" : "failed",
    releaseReady ? `Ready — ${approved} approved journey(s).` : `${approved}/${machinePassed} machine-verified journey(s) approved; current live catalog is unchanged.`,
    { verifiedJourneys: approved });
  emit(`journey.review.${action}`, {
    product: id, status: "ok",
    data: {
      actor: req.user!.email, journeyId, goal: journey.goal, revision: journey.revision,
      checksum: journeyRevisionChecksum(journey), comment: body.comment ? String(body.comment) : undefined,
      instruction: action === "rework" ? instruction : undefined,
    },
  });
  if (action === "rework") {
    controlTrainingJob(id, "cancel");
    void trainingJobPromise(id).then(() => startOnboardingJob(rec, {
      maxJobs: 1,
      targetedJobs: [{ goal: journey.goal, why: "Human-requested correction", instruction, source: "human_rework" }],
      skipSurvey: true,
      skipExistingVerification: true,
    })).catch((error) => console.warn(`[training:${id}] targeted rework failed`, error.message));
  }
  await syncProductToDurable(id).catch(() => {});
  return { ok: true, journey, machinePassed, approved, released: releaseReady, reworkStarted: action === "rework" };
});

app.get("/api/products/:id", { preHandler: require_("viewer") }, async (req, reply) => {
  const id = (req.params as any).id as string;
  const rec = await getProduct(id, req.user!.orgId);
  if (!rec) return reply.code(404).send({ error: "unknown product" });
  const g = await loadGraph(id, rec.startUrl).catch(() => null);
  return {
    ...rec,
    auth: safeAuth(rec.auth),
    job: jobState(id),
    graph: g && {
      screens: g.screens.map((s) => s.title),
      capabilities: g.capabilities.map((c) => ({ name: c.name, description: c.description, flows: c.journeys.length })),
      journeys: g.journeys.map((j) => ({ goal: j.goal, status: j.status, steps: j.steps.length, narrated: j.steps.filter((s) => s.say).length })),
    },
  };
});

/**
 * Full inspection view for one product — everything the platform knows and stores.
 * This is the super-admin surface: journeys with their exact steps and narration,
 * the docs behind the answers, what it learned from real demos, and where it failed.
 */
app.get("/api/products/:id/inspect", { preHandler: require_("viewer") }, async (req, reply) => {
  const id = (req.params as any).id as string;
  const rec = await getProduct(id, req.user!.orgId);
  if (!rec) return reply.code(404).send({ error: "unknown product" });

  const kb = await brainFor(id);
  const g = await loadGraph(id, rec.startUrl).catch(() => null);
  const dir = path.join(CONTENT_ROOT, id);

  // What documents are on disk, and where they came from.
  const docFiles: { name: string; bytes: number; kind: string }[] = [];
  for (const sub of ["docs", "marketing"]) {
    const d = path.join(dir, sub);
    if (!existsSync(d)) continue;
    for (const f of await fs.readdir(d)) {
      const st = await fs.stat(path.join(d, f)).catch(() => null);
      if (st?.isFile()) docFiles.push({ name: f, bytes: st.size, kind: sub });
    }
  }
  const sourcesFile = path.join(dir, "sources.txt");
  const sources = existsSync(sourcesFile)
    ? (await fs.readFile(sourcesFile, "utf8")).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    : [];

  const signals = kb.signals();
  return {
    product: { ...rec, auth: safeAuth(rec.auth) },
    job: jobState(id),
    knowledge: {
      docChunks: kb.docs.length,
      embedded: kb.docs.filter((d) => d.embedding?.length).length,
      flows: kb.flows.length,
      personas: kb.personas.length,
      playbook: kb.playbook.length,
      structuredSections: kb.sections.length,
      documentedProcedures: kb.procedures.length,
      files: docFiles,
      sources,
      chunks: kb.docs.slice(0, 40).map((d) => ({ title: d.title, trust: d.trust, source: d.source, preview: d.text.slice(0, 180) })),
    },
    graph: g && {
      builtAt: g.builtAt,
      survey: g.survey,
      screens: g.screens.map((sc) => ({ title: sc.title, url: sc.url, kind: sc.kind, controls: sc.controls.length })),
      capabilities: g.capabilities.map((c) => ({ name: c.name, description: c.description, flows: c.journeys.length })),
      journeys: g.journeys.map((j) => ({
        id: j.id,
        goal: j.goal,
        capability: j.capability,
        status: j.status,
        reliability: j.reliability,
        proof: j.proof ?? "text",
        evidence: j.evidence,
        documentation: j.documentation,
        attempts: j.attempts,
        verificationRuns: j.verificationRuns ?? [],
        failure: j.failure,
        machineVerified: isJourneyMachineVerified(j),
        publishEligible: isJourneyPublishable(j),
        revision: j.revision ?? 1,
        revisionChecksum: j.revisionChecksum ?? journeyRevisionChecksum(j),
        approval: j.approval ?? { status: "pending", revision: j.revision ?? 1, checksum: j.revisionChecksum ?? journeyRevisionChecksum(j) },
        revisionHistory: j.revisionHistory ?? [],
        postcondition: j.postcondition,
        requires: j.requiresJourney ?? [],
        meaning: j.meaning,
        steps: j.steps.map((st) => ({
          action: st.action,
          target: st.role ? `${st.role} "${st.name}"` : st.url ?? "",
          value: st.value,
          say: st.say,
        })),
      })),
      backlog: g.backlog,
      trainingMetrics: g.trainingMetrics,
    },
    learning: {
      sessions: signals.totalSessions,
      engaged: signals.engaged,
      kbGaps: signals.kbGaps.slice(0, 25),
      topObjections: signals.topObjections.slice(0, 10),
      topFlows: signals.topFlows.slice(0, 10),
    },
    voice: rec.voice ?? {},
  };
});

// ============================ Demo sessions ============================

interface LiveSessionOptions {
  tenant: TenantContext;
  product: ProductRecord;
  mode: "text" | "voice";
  runtimeContext?: (text: string, screen?: ScreenState) => Promise<AgentRuntimeContext>;
  proactiveContext?: (text: string, screen: ScreenState) => Promise<string>;
  durable?: { environmentId: string; roleProfileId: string; catalogVersionId: string };
  openers?: string[];
  knowledge?: { docs: number; flows: number; personas: number; playbook: number };
  narrationLines?: string[];
  /** Existing durable record + Steel browser handle after a fenced worker recovery. */
  resume?: CustomerSession;
}

const RECOVERY_LEASE_SECONDS = Math.max(20, Number(process.env.SESSION_RECOVERY_LEASE_SECONDS ?? 45));

function restoreSessionMemory(memory: SessionMemory, value: Record<string, unknown>): void {
  const arrays = ["needs", "shownFeatures", "objections", "kbGaps", "flowsSuggested", "frictionPoints", "journeyFailures", "transcript"] as const;
  for (const key of arrays) if (Array.isArray(value[key])) (memory as any)[key] = structuredClone(value[key]);
  // Normalize sessions written before speaker roles became product-neutral.
  memory.transcript = memory.transcript.map((entry: any) => ({
    role: entry?.role === "prospect" || entry?.role === "user" ? "user" : "assistant",
    text: String(entry?.text ?? ""),
  }));
  if (typeof value.persona === "string") memory.persona = value.persona;
  if (value.qualification && typeof value.qualification === "object") memory.qualification = structuredClone(value.qualification as Record<string, string>);
  if (Number.isFinite(value.turns)) memory.turns = Number(value.turns);
  if (Number.isFinite(value.actionFailures)) memory.actionFailures = Number(value.actionFailures);
}

async function startLiveSession(options: LiveSessionOptions) {
  const { product: rec } = options;
  const kb = options.durable ? new BrainStore(rec.id) : await brainFor(rec.id);
  const box = new LiveBox({
    startUrl: rec.startUrl, auth: rec.auth, allowActions: rec.allowActions,
    resumeSessionId: options.resume?.browserSessionId,
  });
  // Reserve fleet capacity before launching Chromium; otherwise a burst at the
  // limit still launches a burst of browsers merely to reject them.
  const sessionId = options.resume?.id ?? randomUUID();

  try {
    await distributedCapacity.acquire("demo", sessionId);
    try {
      acquire("demo", sessionId, rec.id, async () => { await endSession(sessionId); });
    } catch (error) {
      await distributedCapacity.release(sessionId).catch(() => {});
      throw error;
    }
  } catch (error) {
    throw error;
  }
  try {
    var browserStart = await box.start();
  } catch (error) {
    release(sessionId);
    await distributedCapacity.release(sessionId).catch(() => {});
    throw error;
  }

  const memory = new SessionMemory();
  if (options.resume) restoreSessionMemory(memory, options.resume.memory);
  const screenObserver = new LiveScreenObserver(sessionId, box);
  const agent = new Agent(box, memory, kb, rec.name, rec.allowActions ?? [], options.runtimeContext, screenObserver);
  const observer = new Observer(box, memory, kb, screenObserver, options.proactiveContext);
  const traceCtx = openTrace(rec.id, "demo");
  const timestamp = new Date().toISOString();
  const durableRecord: CustomerSession | undefined = options.durable ? {
    ...(options.resume ?? {}),
    id: sessionId, organizationId: options.tenant.organizationId, productId: rec.id,
    environmentId: options.durable.environmentId, roleProfileId: options.durable.roleProfileId,
    catalogVersionId: options.durable.catalogVersionId, mode: options.mode, status: "active",
    lastSeenAt: timestamp, memory: sessionMemoryPayload(memory), createdAt: options.resume?.createdAt ?? timestamp, updatedAt: timestamp,
    browserSessionId: browserStart.sessionId, workerId: WORKER_ID,
    recoveryLeaseExpiresAt: new Date(Date.now() + RECOVERY_LEASE_SECONDS * 1000).toISOString(),
  } : undefined;
  const session: Session = {
    product: rec.id, tenant: options.tenant, box, agent, observer, kb, traceCtx,
    mode: options.mode, durableRecord, knowledgeSummary: options.knowledge,
    narrationLines: options.narrationLines,
    speech: null, turn: new TurnManager({ stopAudio: () => {}, cancelSpeech: () => {} }), finalized: false,
  };
  try {
    await sessionDirectory.register(options.tenant, {
      sessionId, organizationId: rec.organizationId, productId: rec.id,
      catalogVersionId: options.durable?.catalogVersionId,
      browserSessionId: durableRecord?.browserSessionId,
      mode: options.mode, workerId: WORKER_ID, wsUrl: process.env.WORKER_PUBLIC_URL
        ? new URL("/ws", process.env.WORKER_PUBLIC_URL).toString().replace(/^http/, "ws")
        : undefined,
      status: "active", updatedAt: timestamp,
    });
    if (durableRecord) {
      if (options.resume) await durableBackbone!.repositories.sessions.update(options.tenant, durableRecord);
      else await durableBackbone!.repositories.sessions.create(options.tenant, durableRecord);
    }
  } catch (error) {
    await sessionDirectory.remove(options.tenant, sessionId).catch(() => {});
    await box.stop().catch(() => {});
    release(sessionId);
    await distributedCapacity.release(sessionId).catch(() => {});
    throw new Error(`could not register session: ${(error as Error).message}`);
  }

  sessions.set(sessionId, session);
  if (durableRecord) {
    session.recoveryHeartbeat = setInterval(() => {
      void Promise.all([
        checkpointDurableSession(session), sessionDirectory.touch(session.tenant, sessionId),
        distributedCapacity.renew("demo", sessionId),
      ]).catch((error) => console.warn("[session] recovery heartbeat failed", error.message));
    }, Math.max(5_000, Math.floor(RECOVERY_LEASE_SECONDS * 1000 / 3)));
    session.recoveryHeartbeat.unref?.();
  }
  const knowledge = options.knowledge ?? { docs: kb.docs.length, flows: kb.flows.length, personas: kb.personas.length, playbook: kb.playbook.length };
  const openers = options.openers ?? kb.flows.filter((flow) => (flow.program?.length ?? 0) > 0).slice(0, 4).map((flow) => flow.name);
  withTrace(traceCtx, () => emit("demo.start", {
    status: "start", data: { mode: options.mode, demo: rec.name, brain: agent.brainLabel(), flows: knowledge.flows,
      catalogVersionId: options.durable?.catalogVersionId },
  }));

  return {
    sessionId, product: rec.id, demo: rec.name, assistant: config.assistantName,
    brain: agent.brainLabel(), mode: options.mode,
    voice: ttsEnabled() ? { enabled: true, ...(rec.voice ?? {}) } : { enabled: false },
    knowledge,
    speechHints: [rec.name, ...openers].filter(Boolean).join(", ").slice(0, 380),
    openers,
    catalogVersionId: options.durable?.catalogVersionId,
  };
}

async function durableLiveOptions(
  ctx: TenantContext,
  productId: string,
  roleProfileId: string,
  mode: "text" | "voice",
  resume?: CustomerSession,
): Promise<LiveSessionOptions> {
  if (!durableBackbone) throw new Error("durable backend is disabled");
  const backend = durableBackbone;
  const aggregate = await backend.repositories.products.get(ctx, productId);
  if (!aggregate) throw new Error("unknown product");
  const bundle = resume
    ? await backend.catalogs.bundle(ctx, resume.catalogVersionId)
    : await backend.catalogs.activeBundle(ctx, aggregate.product.id);
  if (!bundle) throw new Error("product has no published catalog");
  if (bundle.productId !== aggregate.product.id) throw new Error("session catalog does not belong to product");
  const environment = aggregate.environments.find((item) => item.id === bundle.environmentId);
  const role = aggregate.roles.find((item) => item.id === roleProfileId && item.environmentId === environment?.id);
  if (!environment || !role) throw new Error("role or published environment not found");

  let auth: ProductAuth = { mode: "none" };
  if (role.credentialRefId) {
    const ref = await backend.repositories.access.getCredentialRef(ctx, role.credentialRefId);
    if (!ref) throw new Error("role credential reference is missing");
    const secret = await backend.secrets.resolve(ref);
    // Portable captured state can be opened concurrently by many isolated
    // workers. A persistent Chrome profile cannot: Chromium takes a singleton
    // lock and every second customer session fails to launch. Some migrated
    // secrets contain both, so session state must always win.
    auth = secret.sessionState || secret.sessionStorage ? { mode: "session", sessionState: secret.sessionState, sessionStorage: secret.sessionStorage }
      : secret.profileDir ? { mode: "profile", profileDir: secret.profileDir }
      : secret.username ? { mode: "login", username: secret.username, password: secret.password }
      : { mode: "none" };
  }
  const rec: ProductRecord = {
    id: aggregate.product.id, organizationId: aggregate.product.organizationId, name: aggregate.product.name,
    startUrl: environment.startUrl, auth, allowActions: [], createdAt: aggregate.product.createdAt,
  };
  const runtimeContext = async (text: string, screen?: ScreenState): Promise<AgentRuntimeContext> => {
    const routed = await backend.evidence.route(ctx, {
      productId: rec.id, roleProfileId: role.id, catalogVersionId: bundle.catalogVersionId, text, screen,
    });
    return { intent: routed.intent, system: evidenceToSystem(routed), workflow: routed.journey?.workflow, flowName: routed.journey?.name };
  };
  const proactiveContext = async (text: string, screen: ScreenState): Promise<string> =>
    evidenceToSystem(await backend.evidence.route(ctx, {
      productId: rec.id, roleProfileId: role.id, catalogVersionId: bundle.catalogVersionId, text, screen,
    }));
  return {
    tenant: ctx, product: rec, mode, runtimeContext, proactiveContext, resume,
    durable: { environmentId: environment.id, roleProfileId: role.id, catalogVersionId: bundle.catalogVersionId },
    openers: bundle.journeys.slice(0, 4).map((journey) => journey.name),
    narrationLines: bundle.journeys.flatMap((journey) =>
      journey.workflow.steps.map((step) => step.say?.trim()).filter((line): line is string => !!line)),
    knowledge: { docs: 0, flows: bundle.journeys.length, personas: 0, playbook: bundle.salesPlays.length },
  };
}

async function startDurableSession(req: any, reply: any, supplied: any, embedGrant?: EmbedGrant) {
  const backend = needBackbone(reply);
  if (!backend) return;
  const body = embedGrant ? {
    ...supplied, productId: embedGrant.productId, roleProfileId: embedGrant.roleProfileId,
  } : supplied;
  if (!body.productId || !body.roleProfileId) return reply.code(400).send({ error: "productId and roleProfileId are required" });
  try {
    const ctx = req.tenant!;
    return await startLiveSession(await durableLiveOptions(
      ctx, String(body.productId), String(body.roleProfileId), String(body.mode ?? "voice") === "text" ? "text" : "voice",
    ));
  } catch (error) {
    if (error instanceof AtCapacity) return reply.code(503).send({ error: error.message, capacity: capacityStats() });
    return reply.code(502).send({ error: (error as Error).message });
  }
}

app.post("/api/v2/session", { preHandler: require_("viewer") }, async (req, reply) => {
  return startDurableSession(req, reply, (req.body ?? {}) as any);
});

app.post("/api/v2/embed/session", async (req, reply) => {
  if (!req.embedGrant) return reply.code(401).send({ error: "invalid, expired, revoked, or origin-mismatched embed token" });
  return startDurableSession(req, reply, (req.body ?? {}) as any, req.embedGrant);
});

app.post("/api/session", async (req, reply) => {
  const wanted = String(((req.body ?? {}) as any).product ?? (req.query as any)?.product ?? config.product);
  /*
   * A share token authorises ONE product. The gate proves the token is real; only
   * here do we know which product was actually asked for, so the binding has to be
   * enforced here too — otherwise a link to a public demo becomes a key to every
   * other product on the install, including ones behind a captured session.
   */
  if (!req.user && req.shareProduct && req.shareProduct !== wanted) {
    return reply.code(403).send({ error: "this link is not valid for that product" });
  }
  const rec = await getProduct(wanted);
  if (!rec) return reply.code(404).send({ error: `unknown product "${wanted}" — add it via POST /api/products` });
  if (req.user && rec.organizationId !== req.user.orgId) return reply.code(404).send({ error: "unknown product" });
  if (rec.archivedAt) return reply.code(410).send({ error: "this product is archived" });

  try {
    const mode = String(((req.body ?? {}) as any).mode ?? "voice") === "text" ? "text" : "voice";
    const sessionTenant = req.tenant ?? tenantContext({ organizationId: rec.organizationId, actorId: "shared-demo", requestId: req.id });
    return await startLiveSession({ tenant: sessionTenant, product: rec, mode });
  } catch (e) {
    if (e instanceof AtCapacity) return reply.code(503).send({ error: e.message, capacity: capacityStats() });
    return reply.code(502).send({ error: (e as Error).message });
  }
});

function sessionMemoryPayload(memory: SessionMemory): Record<string, unknown> {
  return {
    persona: memory.persona, needs: memory.needs, shownFeatures: memory.shownFeatures,
    qualification: memory.qualification, objections: memory.objections, kbGaps: memory.kbGaps,
    frictionPoints: memory.frictionPoints, actionFailures: memory.actionFailures,
    journeyFailures: memory.journeyFailures, flowsSuggested: memory.flowsSuggested,
    turns: memory.turns, transcript: memory.transcript.slice(-40),
  };
}

async function checkpointDurableSession(session: Session): Promise<void> {
  if (!session.durableRecord || !durableBackbone) return;
  const timestamp = new Date().toISOString();
  session.durableRecord = {
    ...session.durableRecord, mode: session.mode, status: "active",
    lastSeenAt: timestamp, updatedAt: timestamp, memory: sessionMemoryPayload(session.agent.memory),
    workerId: WORKER_ID,
    recoveryLeaseExpiresAt: new Date(Date.now() + RECOVERY_LEASE_SECONDS * 1000).toISOString(),
  };
  await durableBackbone.repositories.sessions.update(session.tenant, session.durableRecord);
}

async function endSession(id: string): Promise<void> {
  const s = sessions.get(id);
  if (!s) return;
  if (s.disconnectTimer) clearTimeout(s.disconnectTimer);
  if (s.recoveryHeartbeat) clearInterval(s.recoveryHeartbeat);
  if (!s.finalized) {
    s.finalized = true;
    if (s.durableRecord && durableBackbone) {
      const memory = s.agent.memory;
      s.durableRecord = {
        ...s.durableRecord,
        status: "ended",
        lastSeenAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        memory: sessionMemoryPayload(memory),
      };
      await durableBackbone.repositories.sessions.update(s.tenant, s.durableRecord)
        .catch((e) => console.warn("[session] durable finalize failed:", e.message));
      const createdAt = new Date().toISOString();
      const signals = [
        ...memory.kbGaps.map((content) => ({ kind: "unanswered_question" as const, content, metadata: {} })),
        ...memory.frictionPoints.map((content) => ({ kind: "friction" as const, content, metadata: {} })),
        ...memory.journeyFailures.map((failure) => ({
          kind: "journey_failure" as const, content: failure.error, metadata: { journey: failure.journey },
        })),
        ...(memory.turns >= 2 ? [{ kind: "positive_engagement" as const, content: "customer completed an engaged session", metadata: { turns: memory.turns } }] : []),
      ];
      await Promise.all(signals.map((signal) => durableBackbone.repositories.feedback.save(s.tenant, {
        id: randomUUID(), organizationId: s.tenant.organizationId, productId: s.durableRecord!.productId,
        catalogVersionId: s.durableRecord!.catalogVersionId, sessionId: s.durableRecord!.id,
        ...signal, createdAt, updatedAt: createdAt,
      }))).catch((e) => console.warn("[session] feedback capture failed:", e.message));
    } else {
      await s.agent.memory.finalize(s.kb).catch((e) => console.warn("[session] finalize failed:", e.message));
    }
    withTrace(s.traceCtx, () =>
      emit("demo.end", {
        status: "ok",
        data: {
          turns: s.agent.memory.turns,
          persona: s.agent.memory.persona,
          needs: s.agent.memory.needs.length,
          shown: s.agent.memory.shownFeatures,
          objections: s.agent.memory.objections.length,
          kbGaps: s.agent.memory.kbGaps,
          actionFailures: s.agent.memory.actionFailures,
        },
      }),
    );
  }
  await s.box.stop().catch(() => {});
  await sessionDirectory.remove(s.tenant, id).catch((error) => console.warn("[session] directory cleanup failed", error.message));
  sessions.delete(id);
  release(id);
  await distributedCapacity.release(id).catch((error) => console.warn("[capacity] cluster cleanup failed", error.message));
}

/**
 * Voice preview — synthesise a line with an arbitrary speaker so a human can
 * A/B the voices by ear. Audio quality is not something the server can judge.
 *   GET /api/voice/preview?speaker=anushka&provider=sarvam&text=hello
 */
app.get("/api/voice/preview", async (req, reply) => {
  const q = (req.query ?? {}) as any;
  const text = String(q.text ?? "Hi! I can walk you through this product live. Where would you like to start?");
  try {
    const audio = await synthesizeChunk(text, {
      provider: q.provider === "openai" ? "openai" : "sarvam",
      speaker: q.speaker ? String(q.speaker) : undefined,
      language: q.language ? String(q.language) : undefined,
      pace: q.pace ? Number(q.pace) : undefined,
    });
    return reply.type(audio.mime).send(audio.bytes);
  } catch (e) {
    return reply.code(502).send({ error: (e as Error).message });
  }
});

/** Measured cost/latency, so cost claims are data rather than estimates. */
/**
 * The recorded trail for one product — what ran, in what order, how long, what it
 * cost and what failed. This is the "data recorded at each step" surface.
 */
app.get("/api/products/:id/events", { preHandler: require_("viewer") }, async (req, reply) => {
  const rec = await getProduct((req.params as any).id, req.user!.orgId);
  if (!rec) return reply.code(404).send({ error: "unknown product" });
  const q = (req.query ?? {}) as any;
  const events = await readEvents(rec.id, {
    limit: Number(q.limit ?? 300),
    since: q.since ? String(q.since) : undefined,
    kind: q.kind ? String(q.kind) : undefined,
    trace: q.trace ? String(q.trace) : undefined,
  });
  return { events, rollup: rollup(events) };
});

app.get("/api/telemetry", { preHandler: require_("viewer") }, async (req) => {
  // The in-process counter is global to the worker and would leak another
  // tenant's spend. Aggregate this organization's product event ledgers instead.
  const products = await listProducts(req.user!.orgId);
  const reports = await Promise.all(products.map(async (product) => rollup(await readEvents(product.id, { limit: 5000 }))));
  return {
    total: {
      calls: reports.reduce((sum, report) => sum + Number(report.kinds["model.call"]?.n ?? 0), 0),
      inTokens: reports.reduce((sum, report) => sum + report.inTokens, 0),
      outTokens: reports.reduce((sum, report) => sum + report.outTokens, 0),
      costUsd: Number(reports.reduce((sum, report) => sum + report.costUsd, 0).toFixed(5)),
    },
    byPurpose: {},
    ttsCache: cacheStats(),
  };
});

app.delete("/api/session/:id", async (req) => {
  await endSession((req.params as any).id);
  return { ok: true };
});

/**
 * Sign-in window bridge: stream the browser to the admin and forward their real
 * clicks/keys/scrolling into it, so they can complete Google SSO, 2FA, anything.
 */
app.get("/ws/auth", { websocket: true }, (socket, req) => {
  const authId = new URL(req.url, "http://x").searchParams.get("authSessionId") ?? "";
  const s = getAuthSession(authId);
  const send = (o: unknown) => { if (socket.readyState === 1) socket.send(JSON.stringify(o)); };
  if (!s || s.organizationId !== req.user?.orgId) { send({ type: "error", text: "sign-in window not found or expired" }); socket.close(); return; }

  let last = 0;
  s.box.onFrame((jpeg) => {
    const now = Date.now();
    if (now - last < 66) return; // ~15fps is plenty for typing
    last = now;
    send({ type: "frame", data: jpeg });
  });
  send({ type: "ready", url: s.box.currentUrl() });

  socket.on("message", async (raw: Buffer) => {
    let m: any;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    try {
      if (m.type === "click") {
        await s.box.userClick(Number(m.x), Number(m.y));
        send({ type: "focus", focused: await s.box.focusedDescription() });
      } else if (m.type === "wheel") await s.box.userWheel(Number(m.dy));
      else if (m.type === "key") {
        await s.box.userKey(String(m.key), String(m.text ?? ""), Array.isArray(m.modifiers) ? m.modifiers.map(String) : []);
      } else if (m.type === "paste") await s.box.userPaste(String(m.text ?? ""));
      else if (m.type === "nav" && typeof m.url === "string") await s.box.goto(m.url);
      else if (m.type === "where") send({ type: "url", url: s.box.currentUrl() });
      else if (m.type === "focus") send({ type: "focus", focused: await s.box.focusedDescription() });
    } catch {
      /* a stray input must never kill the sign-in window */
    }
  });
});

/**
 * Demonstration recorder bridge (Mapper M2).
 *
 * Same shape as the sign-in bridge — stream the browser, forward real input —
 * but every action is also RECORDED as a durable step, and each recorded step is
 * echoed back so the person can see their demonstration being captured. A
 * recorder that silently drops an action is worse than none, because the loss
 * only surfaces minutes later when the replay fails.
 */
app.get("/ws/demo", { websocket: true }, (socket, req) => {
  const demoId = new URL(req.url, "http://x").searchParams.get("demoId") ?? "";
  const s = getDemoSession(demoId);
  const send = (o: unknown) => { if (socket.readyState === 1) socket.send(JSON.stringify(o)); };
  if (!s || s.organizationId !== req.user?.orgId) { send({ type: "error", text: "recording not found or expired" }); socket.close(); return; }

  let last = 0;
  s.box.onFrame((jpeg) => {
    const now = Date.now();
    if (now - last < 66) return;
    last = now;
    send({ type: "frame", data: jpeg });
  });
  send({ type: "ready", url: s.box.currentUrl() });

  socket.on("message", async (raw: Buffer) => {
    let m: any;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    try {
      if (m.type === "click") {
        const r = await recordClick(demoId, Number(m.x), Number(m.y));
        send({ type: "step", recorded: r.recorded, label: r.label });
        send({ type: "focus", focused: await s.box.focusedDescription() });
      } else if (m.type === "wheel") await recordScroll(demoId, Number(m.dy));
      else if (m.type === "key") {
        await recordKey(demoId, String(m.key), String(m.text ?? ""), Array.isArray(m.modifiers) ? m.modifiers.map(String) : []);
      } else if (m.type === "paste") await recordPaste(demoId, String(m.text ?? ""));
      else if (m.type === "nav" && typeof m.url === "string") await recordNavigate(demoId, m.url);
      else if (m.type === "where") send({ type: "url", url: s.box.currentUrl() });
      else if (m.type === "status") send({ type: "status", ...(await demonstrationStatus(demoId)) });
      else if (m.type === "proofs") send({ type: "proofs", options: await demonstrationProofOptions(demoId) });
    } catch (e) {
      // A stray input must never kill the recording, but it must not vanish
      // either — a dropped action is the failure mode that matters here.
      console.warn(`[demo] input ${m?.type} failed: ${(e as Error).message}`);
      send({ type: "warn", text: `that action could not be recorded: ${(e as Error).message}` });
    }
  });
});

async function recoverDurableBrowserSession(ctx: TenantContext, sessionId: string): Promise<Session | null> {
  if (!durableBackbone || config.liveboxProvider !== "steel") return null;
  const claimed = await durableBackbone.repositories.sessions.claimRecovery(
    ctx, sessionId, WORKER_ID, RECOVERY_LEASE_SECONDS,
  );
  if (!claimed?.browserSessionId) return null;
  try {
    await startLiveSession(await durableLiveOptions(
      ctx, claimed.productId, claimed.roleProfileId, claimed.mode, claimed,
    ));
    return sessions.get(sessionId) ?? null;
  } catch (error) {
    console.warn(`[session] could not recover ${sessionId}`, (error as Error).message);
    return null;
  }
}

app.get("/ws", { websocket: true }, async (socket, req) => {
  const sessionId = new URL(req.url, "http://x").searchParams.get("sessionId") ?? "";
  let session = sessions.get(sessionId);
  const send = (obj: unknown) => {
    if (socket.readyState === 1) socket.send(JSON.stringify(obj));
  };

  if (!session) {
    const location = req.tenant ? await sessionDirectory.locate(req.tenant, sessionId).catch(() => null) : null;
    const stale = !location || Date.now() - Date.parse(location.updatedAt) > RECOVERY_LEASE_SECONDS * 1000;
    if (req.tenant && stale) session = (await recoverDurableBrowserSession(req.tenant, sessionId)) ?? undefined;
    if (!session && location?.workerId !== WORKER_ID && location?.wsUrl && !stale) {
      const target = new URL(location.wsUrl);
      target.searchParams.set("sessionId", sessionId);
      send({ type: "redirect", url: target.toString(), workerId: location.workerId });
      socket.close(1012, "connect to session worker");
      return;
    }
    if (!session) {
      send({ type: "error", text: stale && config.liveboxProvider === "steel"
        ? "This browser session could not be recovered. Reload to start a new demo."
        : "Unknown session. Reload to start a new demo." });
      socket.close();
      return;
    }
  }
  if ((req.user && req.user.orgId !== session.tenant.organizationId) ||
      (req.shareProduct && req.shareProduct !== session.product) ||
      (req.embedGrant && (req.embedGrant.organizationId !== session.tenant.organizationId ||
        req.embedGrant.productId !== session.product ||
        req.embedGrant.roleProfileId !== session.durableRecord?.roleProfileId))) {
    send({ type: "error", text: "Unknown session." });
    socket.close();
    return;
  }
  void sessionDirectory.touch(session.tenant, sessionId).catch(() => {});
  if (session.disconnectTimer) { clearTimeout(session.disconnectTimer); session.disconnectTimer = undefined; }

  const picker = new PhrasePicker();
  let phrases = phrasesFor(undefined);

  // ---- Voice: speak every line Aidan produces, and honour barge-in ----
  const speechReady = (async () => {
    const rec = await getProduct(session.product, session.tenant.organizationId);
    const pacing = pacingFor(rec?.voice);
    session.speech = new SpeechEngine(
      session.product,
      rec?.voice ?? {},
      (a) => {
        session.turn.noteAudioSent(speakingFiller); // still "speaking" until the client drains
        send({ type: "audio", seq: a.seq, mime: a.mime, b64: a.b64, text: a.text, gapMs: a.gapMs });
      },
      pacing,
    );
    phrases = phrasesFor(rec?.voice);
    // Rebind turn events now that we can actually reach the client.
    (session.turn as any).events = {
      // An interruption clears obsolete audio; only an explicit Stop latches
      // the client mute for the following replacement turn.
      stopAudio: () => send({ type: "stop_audio", latch: false }),
      cancelSpeech: () => session.speech?.interrupt(),
    };
    // Warm the cache for this product's journey narration so the guided
    // walkthrough is instant (all lines are known from onboarding).
    // Warm journey narration AND the conversational phrases — an acknowledgement
    // that takes 4s to synthesise is worse than no acknowledgement at all.
    const lines = [
      ...allPhrases(rec?.voice),
      ...(session.kb.flows.flatMap((f) => (f.program ?? []).map((st) => st.say).filter(Boolean) as string[])),
      ...(session.narrationLines ?? []),
    ];
    if (lines.length) session.speech.prefetch(lines.slice(0, 60));
  })().catch(() => {});

  const audioSync = new AudioSync();
  /** Cleared on barge-in; the agent checks it between walkthrough steps. */
  let interrupted = false;
  /** Exactly one turn owns the agent/browser at a time. New input aborts the old owner. */
  let turnSequence = 0;
  let activeTurn: { id: number; controller: AbortController; done: Promise<void>; finish: () => void } | null = null;
  /*
   * Hard mute after an explicit stop.
   *
   * Setting `interrupted` only stops the agent at its next boundary, so a line
   * already being synthesised still reached the prospect — they said "wait" and
   * heard one more sentence. When someone asks for silence, silence has to be
   * immediate and total, so nothing is emitted at all until they speak again.
   */
  let muted = false;
  /** Set while the line currently being synthesised is conversational filler. */
  let speakingFiller = false;

  /**
   * Say a line. VOICE-FIRST: the transcript is released when the audio is ready,
   * not before. Emitting text first made the voice feel like subtitles being read
   * back — you'd already read the line by the time you heard it.
   * If speech is unavailable the text still goes out immediately.
   */
  const speak = async (rawText: string, proactive = false, filler = false): Promise<number | null> => {
    /*
     * The chat panel is now a TRANSCRIPT of what was said, not a separate written
     * channel — so strip anything that exists only for the eye. Citations and
     * markdown leaking into it made the voice feel like it was reading a document.
     */
    const text = rawText
      .replace(/\[[^\]]*\]/g, "")
      .replace(/\*\*/g, "")
      .replace(/\s*\n\s*\n\s*/g, " ")
      .replace(/\s+([.,!?])/g, "$1")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (!text) return null;
    if (muted) return null; // an explicit stop means nothing more comes out
    /*
     * Backstop for listenability. The prompt asks for two short sentences, but
     * models drift into paragraphs; five sentences in one breath is unlistenable.
     * Keep the first two and drop the rest rather than speaking a monologue.
     */
    const spoken = (() => {
      if (text.length <= 200) return text; // short enough to say in one breath
      const parts = (text.match(/[^.!?]+[.!?]*/g) ?? [text]).map((x) => x.trim()).filter(Boolean);
      // Greetings and acknowledgements ("Hi!", "Sure.") must not consume a slot —
      // counting them truncated "Hi! I'm Aidan. Where would you like to start?"
      // down to just the greeting.
      const out: string[] = [];
      let substantive = 0;
      for (const part of parts) {
        const words = part.split(/\s+/).length;
        if (words > 3) substantive++;
        if (substantive > 2) break;
        out.push(part);
      }
      return out.join(" ").trim() || parts[0];
    })();
    session.turn.noteSpoken(spoken); // remember it, to recognise our own echo
    // TEXT MODE: a chat assistant, not a speaker. Full text, no audio.
    if (session.mode === "text" || !session.speech) {
      // Fillers exist to cover latency in a SPOKEN conversation. In text they are
      // just noise, so they are never written.
      if (!filler) send({ type: "say", text, proactive });
      return null;
    }
    session.turn.beginSpeaking();
    speakingFiller = filler;
    let released = false;
    /*
     * Acknowledgements and yields are audio-only. Writing them produced a
     * transcript of "Yes?" / "Of course." / "Sorry, go ahead." bubbles that
     * buried the actual answer — nobody wants a written record of throat-clearing.
     */
    const release = () => {
      if (!released) { released = true; if (!filler) send({ type: "say", text: spoken, proactive }); }
    };
    // Don't let a slow provider hide the transcript — release after a short grace.
    const grace = setTimeout(release, Number(process.env.TEXT_RELEASE_CAP_MS ?? 1500));
    const seq = await session.speech.say(spoken, release).catch(() => null);
    clearTimeout(grace);
    release();
    return seq;
  };

  /**
   * Speak a line and resolve when it has actually been HEARD.
   * This is what keeps a walkthrough's voice in step with its clicks — without
   * it the actions race ahead and the narration describes a stale screen.
   */
  const speakAndWait = async (text: string): Promise<void> => {
    const seq = await speak(text);
    if (seq === null) return;
    await audioSync.waitFor(seq);
  };

  // Give the agent its voice + interruption view.
  session.agent.setVoice({
    speakAndWait,
    isInterrupted: () => interrupted,
    reconnectLine: () => (session.mode === "voice" ? picker.pick("reconnect", phrases) : ""),
  });

  let lastFrame = 0;
  session.box.onFrame((jpeg) => {
    const now = Date.now();
    if (now - lastFrame < 66) return;
    lastFrame = now;
    send({ type: "frame", data: jpeg });
  });

  /** Tier 1→3: gated understanding, then a grounded interjection (or silence). */
  const rescue = async (s: Session, sig: { kind: SignalKind; x?: number; y?: number; detail?: string }) => {
    try {
      const message = await s.observer.onSignal(sig);
      if (message) {
        s.observer.lastAgentActivityAt = Date.now();
        await speak(message, true);
      }
    } catch {
      /* observation must never break the demo */
    }
  };

  send({
    type: "meta",
    brain: session.agent.brainLabel(),
    demo: session.agent.productLabel,
    product: session.product,
    knowledge: session.knowledgeSummary ?? { docs: session.kb.docs.length, flows: session.kb.flows.length },
  });
  // Wait for the speech engine: the greeting is the first impression, and
  // emitting it before TTS exists made it silent text.
  void speechReady.then(() =>
    speak(`Hi! I'm ${config.assistantName}. I can walk you through ${session.agent.productLabel} live. Where would you like to start?`),
  );

  socket.on("message", async (raw: Buffer) => {
    let m: any;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    try {
      /*
       * Explicit stop — the button, or a spoken "wait"/"stop".
       * Everything a barge-in does, minus the assumption that a question follows.
       */
      if (m.type === "stop") {
        interrupted = true;
        muted = true;
        activeTurn?.controller.abort();
        session.turn.onUserVoice();
        send({ type: "stop_audio", latch: true });
        session.speech?.interrupt();
        audioSync.reset();
        send({ type: "status", text: "" });
        console.log("[turn] explicit stop from the client");
        return;
      }

      if (m.type === "user_message" && typeof m.text === "string") {
        if (m.viaVoice && m.voiceTiming && typeof m.voiceTiming === "object") {
          const finite = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : undefined;
          const voiceTiming = {
            packetMs: finite(m.voiceTiming.packet_ms),
            endpointMs: finite(m.voiceTiming.endpoint_ms),
            decodeMs: finite(m.voiceTiming.decode_ms),
            speechToFinalMs: finite(m.voiceTiming.speech_to_final_ms),
          };
          emit("voice.transcription", {
            product: session.product,
            trace: session.traceCtx.trace,
            status: "ok",
            ms: voiceTiming.speechToFinalMs,
            data: voiceTiming,
          });
        }
        /*
         * A microphone transcript is provisional until echo/noise guards accept
         * it. This check MUST precede stop handling and active-turn cancellation:
         * the old order rejected an echo only after it had already aborted the
         * useful answer, which is exactly the observed "gets stuck" failure.
         */
        if (m.viaVoice) {
          const verdict = session.turn.acceptTranscript(m.text);
          if (!verdict.accept) {
            console.log(`[turn] ignored transcript — ${verdict.reason}`);
            send({ type: "user_rejected", clientMessageId: m.clientMessageId, reason: verdict.reason });
            return;
          }
          // The browser waits for this acknowledgement before rendering a user
          // bubble, so rejected assistant echo is never mislabeled as the user.
          send({ type: "user_accepted", clientMessageId: m.clientMessageId, text: m.text });
        }

        /*
         * "Wait", "stop", "hold on" are COMMANDS, not questions. Routing them to
         * the model produced another paragraph of speech — the opposite of what
         * was asked — and made the thing feel like it wasn't listening at all.
         */
        if (STOP_PHRASE.test(m.text.trim())) {
          interrupted = true;
          muted = true;
          activeTurn?.controller.abort();
          session.turn.onUserVoice();
          send({ type: "stop_audio", latch: true });
          session.speech?.interrupt();
          audioSync.reset();
          send({ type: "status", text: "" });
          console.log(`[turn] stop command: "${m.text.trim().slice(0, 40)}"`);
          return;
        }

        // One turn at a time. A new question must cancel the one still running,
        // or two agent loops narrate over each other.
        if (activeTurn) {
          const previous = activeTurn;
          interrupted = true;
          previous.controller.abort();
          session.speech?.interrupt();
          send({ type: "stop_audio", latch: false });
          audioSync.reset();
          // Abort reaches model fetch, narration and workflow execution. Give the
          // old owner a brief chance to release the shared Agent history before
          // starting the replacement turn.
          await Promise.race([previous.done, new Promise((resolve) => setTimeout(resolve, 750))]);
        }
        renew(sessionId); // real activity keeps the local cleanup lease alive
        void distributedCapacity.renew("demo", sessionId).catch((error) => console.warn("[capacity] cluster renew failed", error.message));
        send({ type: "status", text: `${config.assistantName} is working…` });
        muted = false;       // they're talking to us again
        interrupted = false; // fresh turn: stop suppressing walkthrough steps
        session.turn.beginThinking();
        /*
         * NO pre-emptive acknowledgement.
         *
         * This used to speak "Sure." / "Good question." the instant a turn began,
         * because the model took 15-20 seconds and silence read as "it didn't hear
         * me". Sentence streaming removed that wait — the real answer now starts
         * in well under a second — so the filler bought nothing and cost a lot: it
         * was chosen BEFORE the model saw the question, so it cheerfully answered
         * "Good question." to statements, corrections and objections alike. A
         * canned reaction to something you have not yet understood is worse than a
         * moment of quiet.
         */
        session.observer.lastAgentActivityAt = Date.now(); // turn-taking: don't interject over this
        /*
         * The turn runs inside the demo's trace, so the model calls, tool calls and
         * journey replays it triggers are all attributed to this turn rather than
         * floating free — that attribution is what makes per-demo cost and latency
         * answerable at all.
         */
        const turnStarted = Date.now();
        const beforeTurns = session.agent.memory.turns;
        const turnId = ++turnSequence;
        const controller = new AbortController();
        let finishTurn!: () => void;
        const done = new Promise<void>((resolve) => { finishTurn = resolve; });
        activeTurn = { id: turnId, controller, done, finish: finishTurn };
        await withTrace(session.traceCtx, async () => {
          try {
            /*
             * speakAndWait, not speak: the agent acts on the tool calls that follow
             * each line, so the line has to be HEARD first or the screen changes
             * before the words describing it. In text mode this returns immediately
             * (there is no audio to wait for), and a barge-in releases the wait.
             */
            await session.agent.handleUserMessage(m.text, (line) => speakAndWait(line), controller.signal);
            if (controller.signal.aborted) {
              const decision = session.agent.lastTurnDecision;
              emit("demo.turn", {
                status: "ok", ms: Date.now() - turnStarted,
                data: {
                  userText: m.text, intent: decision.intent, matchedFlow: decision.matchedFlow,
                  via: m.viaVoice ? "voice" : "text", mode: session.mode,
                  cancelled: true, superseded: activeTurn?.id !== turnId, turn: beforeTurns + 1,
                },
              });
              return;
            }
            await checkpointDurableSession(session).catch((error) =>
              console.warn("[session] durable turn checkpoint failed:", error.message));
            emit("demo.turn", {
              status: "ok",
              ms: Date.now() - turnStarted,
              data: {
                userText: m.text,
                intent: session.agent.lastTurnDecision.intent,
                matchedFlow: session.agent.lastTurnDecision.matchedFlow,
                via: m.viaVoice ? "voice" : "text", mode: session.mode,
                chars: m.text.length, turn: beforeTurns + 1,
              },
            });
          } catch (e) {
            if (controller.signal.aborted || (e as Error).name === "AbortError") {
              emit("demo.turn", {
                status: "ok", ms: Date.now() - turnStarted,
                data: {
                  userText: m.text,
                  intent: session.agent.lastTurnDecision.intent,
                  matchedFlow: session.agent.lastTurnDecision.matchedFlow,
                  via: m.viaVoice ? "voice" : "text", mode: session.mode,
                  cancelled: true, superseded: activeTurn?.id !== turnId, turn: beforeTurns + 1,
                },
              });
              return;
            }
            emit("demo.turn", {
              status: "error",
              ms: Date.now() - turnStarted,
              error: (e as Error).message,
              data: {
                userText: m.text,
                intent: session.agent.lastTurnDecision.intent,
                matchedFlow: session.agent.lastTurnDecision.matchedFlow,
                via: m.viaVoice ? "voice" : "text", mode: session.mode, turn: beforeTurns + 1,
              },
            });
            throw e;
          } finally {
            finishTurn();
            if (activeTurn?.id === turnId) activeTurn = null;
          }
        });
        // Do NOT mark speaking finished here — the client may still be playing.
        session.observer.lastAgentActivityAt = Date.now();
        if (!activeTurn || activeTurn.id === turnId) send({ type: "status", text: "" });
      } else if (m.type === "client_audio_started") {
        emit("voice.playback", {
          product: session.product,
          trace: session.traceCtx.trace,
          status: "start",
          data: { phase: "started", seq: Number.isFinite(Number(m.seq)) ? Number(m.seq) : undefined },
        });
      } else if (m.type === "client_audio_error") {
        const reason = String(m.reason ?? "unknown").slice(0, 80);
        const detail = String(m.detail ?? "").slice(0, 160);
        emit("voice.playback", {
          product: session.product,
          trace: session.traceCtx.trace,
          status: "error",
          error: detail || reason,
          data: { reason, seq: Number.isFinite(Number(m.seq)) ? Number(m.seq) : undefined },
        });
        console.warn(`[voice] client playback failed: ${reason}${detail ? ` — ${detail}` : ""}`);
      } else if (m.type === "user_speaking") {
        // First voiced frame from STT — the ONLY signal early enough to feel human.
        const res = session.turn.onUserVoice();
        if (res.interrupted) {
          interrupted = true; // the agent stops between steps and remembers where
          activeTurn?.controller.abort();
          send({ type: "stop_audio", latch: false });
          session.speech?.interrupt();
          audioSync.reset(); // stop waiting on audio that will never play
          send({ type: "status", text: "listening…" });
          console.log(`[turn] barge-in — audio cut, walkthrough will pause`);
          // Yield the floor out loud — but only once per episode. See onUserVoice.
          if (res.shouldYield) {
            const yieldLine = picker.pick("interrupted", phrases);
            if (session.mode === "voice" && yieldLine) void speak(yieldLine, false, true);
          }
        }
      } else if (m.type === "set_mode") {
        // Switchable mid-session: someone who started typing can pick up the
        // headset without losing the demo they're in.
        const next = m.mode === "text" ? "text" : "voice";
        if (next !== session.mode) {
          session.mode = next;
          if (next === "text") { send({ type: "stop_audio", latch: true }); session.speech?.interrupt(); audioSync.reset(); }
          send({ type: "mode", mode: next });
          console.log(`[mode] switched to ${next}`);
        }
      } else if (m.type === "audio_played" && typeof m.seq === "number") {
        audioSync.notePlayed(m.seq);
        emit("voice.playback", {
          product: session.product,
          trace: session.traceCtx.trace,
          status: "ok",
          data: { phase: "played", seq: m.seq },
        });
      } else if (m.type === "audio_ended") {
        session.turn.noteAudioDrained();
        audioSync.noteDrained();
      } else if (m.type === "click") {
        const { target, changed } = await session.box.userClick(Number(m.x), Number(m.y));
        session.observer.note(`Prospect clicked ${target}${changed ? "" : " — the screen did not change"}.`);
        if (!changed) void rescue(session, { kind: "dead_click", detail: target });
      } else if (m.type === "wheel") {
        await session.box.userWheel(Number(m.dy));
      } else if (m.type === "key") {
        await session.box.userKey(String(m.key), String(m.text ?? ""));
      } else if (m.type === "signal" && typeof m.kind === "string") {
        void rescue(session, { kind: m.kind as SignalKind, x: Number(m.x), y: Number(m.y), detail: m.detail });
      }
    } catch (err) {
      send({ type: "error", text: `Something went wrong: ${(err as Error).message}` });
      send({ type: "status", text: "" });
    }
  });

  socket.on("close", () => {
    // Normal proxy/network reconnects must not destroy the browser. A bounded
    // grace period preserves continuity; the existing idle lease remains the
    // outer cleanup bound for abandoned tabs.
    if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
    session.disconnectTimer = setTimeout(() => void endSession(sessionId),
      Math.max(5_000, Number(process.env.SESSION_RECONNECT_GRACE_MS ?? 30_000)));
    session.disconnectTimer.unref?.();
  });
});

async function shutdown() {
  for (const id of [...sessions.keys()]) await endSession(id).catch(() => {});
  await mappingWorker?.stop().catch(() => {});
  await mappingQueue?.close().catch(() => {});
  await sessionDirectory.close().catch(() => {});
  await durableBackbone?.close().catch(() => {});
  await distributedCapacity.close().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// An install with no accounts would be an install nobody can administer.
await bootstrap();

try {
  const addr = await app.listen({ port: config.port, host: "0.0.0.0" });
  const products = await listProducts();
  app.log.info(
    `Aidan running at ${addr} | ${products.length} product(s): ${products.map((p) => `${p.id}(${p.onboarding?.status ?? "new"})`).join(", ") || "none"}`,
  );
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
