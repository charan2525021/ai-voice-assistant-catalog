import type { DocChunk } from "./store.js";
import { assertSafeKnowledgeUrl, fetchKnowledgeText } from "./source-safety.js";
import { emit } from "../events.js";
import {
  chunkStructuredSections,
  documentJourneyPlanningEnabled,
  parseDocumentSections,
  type DocumentSection,
} from "./document-structure.js";

/**
 * Real-scale document acquisition.
 *
 * The original crawler was a flat list of URLs, a bare `fetch`, a regex tag
 * strip, and 600-char chunks. That is fine for the 1–2 hand-written files each
 * product actually had, and it fails in four ways the moment a real
 * documentation site is pointed at it — every one of them SILENT:
 *
 *  1. It never checked the HTTP status. Fetching a 404 on knowledge.hubspot.com
 *     returned a styled error page, from which it happily extracted 2,033
 *     characters of language-picker and menu text and stored it as an official
 *     document. A corpus assembled this way is mostly navigation chrome.
 *  2. It had no main-content extraction. Even on a 200, the same page yields
 *     ~2k chars of nav versus 4.6k chars of article — so more than a third of
 *     every chunk was boilerplate, and boilerplate is IDENTICAL across pages,
 *     which is the worst possible thing to hand an embedding model: thousands
 *     of chunks that are all mutually similar and none of them about anything.
 *  3. Chunks had no overlap, so a fact spanning a boundary was unretrievable.
 *  4. It fetched serially, which at 500 pages is minutes of wall-clock.
 *
 * This module fixes all four and adds corpus-level deduplication, which can
 * only be done once you hold more than one page at a time.
 */

// ============================ HTML → text ============================

/** Tags whose CONTENT is never document text. Removed before anything else. */
/** Shortest article worth keeping. 0 disables the filter entirely. */
const MIN_PAGE_CHARS = Number(process.env.CRAWL_MIN_PAGE_CHARS ?? 400);

const DROP_TAGS = [
  "script", "style", "noscript", "svg", "canvas", "template", "iframe",
  "nav", "header", "footer", "aside", "form", "button", "select", "dialog",
];

function stripTag(html: string, tag: string): string {
  // Non-greedy, case-insensitive, tolerant of attributes. Self-closing and
  // unclosed tags are left alone — a malformed page should lose one element,
  // not everything after it.
  return html.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
}

const ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”",
  mdash: "—", ndash: "–", hellip: "…", trade: "™",
  reg: "®", copy: "©", times: "×", middot: "·",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

/**
 * Extract the readable article from a page.
 *
 * Preference order is <main>, then the LARGEST <article>, then <body>. Picking
 * the largest article rather than the first matters: documentation sites
 * routinely wrap "related articles" cards in their own <article> elements, and
 * the first one on the page is often a 40-character teaser.
 */
export function extractArticle(html: string): { title: string; text: string } {
  /*
   * The page heading beats <title>, because <title> is frequently the SITE name.
   * On the Dolibarr wiki every one of 279 pages reported the same
   * "Dolibarr Open Source ERP and CRM wiki documentation", which collapsed the
   * whole corpus into a single apparent article: the article-level metric became
   * meaningless and a citation could not tell a buyer which page a fact came
   * from. <h1> is where doc systems put the actual subject.
   */
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const h1Text = h1 ? decodeEntities(h1.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() : "";
  const rawTitle =
    (h1Text.length >= 3 && h1Text.length <= 120 ? h1Text : "") ||
    (html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1] ?? "") ||
    (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const title = decodeEntities(rawTitle).replace(/\s+/g, " ").trim();

  let body = html;
  for (const tag of DROP_TAGS) body = stripTag(body, tag);

  let scope = body.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];
  if (!scope) {
    const articles = [...body.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)].map((m) => m[1]);
    scope = articles.sort((a, b) => b.length - a.length)[0];
  }
  if (!scope) scope = body.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? body;

  // When document-led planning is enabled, retain headings and ordered-list
  // markers. The legacy extractor stays byte-for-byte on the old path when the
  // flag is disabled, which makes rollout and before/after measurement honest.
  if (documentJourneyPlanningEnabled()) {
    scope = scope
      .replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_all, list: string) => {
        let index = 0;
        return list.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_li, item: string) => `${++index}. ${item}\n`);
      })
      .replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (_all, list: string) =>
        list.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_li, item: string) => `- ${item}\n`))
      .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_all, level: string, heading: string) =>
        `\n\n${"#".repeat(Number(level))} ${heading}\n\n`);
  }

  // Block-level tags become paragraph breaks so the chunker has real boundaries
  // to respect; everything else collapses to spaces.
  const text = decodeEntities(
    scope
      .replace(/<\/(p|div|section|li|h[1-6]|tr|blockquote|pre)\s*>/gi, "\n\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .trim();

  return { title, text };
}

// ============================ Fetching ============================

export interface CrawlSpec {
  /** Sitemap URL to expand into page URLs. */
  sitemap?: string;
  /** Explicit page URLs (used as-is). */
  urls?: string[];
  trust?: DocChunk["trust"];
  /** Regexes a URL must match (any). */
  include?: string[];
  /** Regexes that disqualify a URL (any). */
  exclude?: string[];
  limit?: number;
  concurrency?: number;
}

async function getText(url: string, timeoutMs = 20000): Promise<{ ok: boolean; status: number; body: string }> {
  try {
    const res = await fetchKnowledgeText(url, timeoutMs);
    return { ok: res.ok, status: res.status, body: res.body };
  } catch (e) {
    return { ok: false, status: 0, body: (e as Error).message };
  }
}

/** Expand a sitemap (following nested sitemap indexes one level) into page URLs. */
export async function expandSitemap(url: string): Promise<string[]> {
  const res = await getText(url, 45000);
  if (!res.ok) {
    emit("crawl.sitemap", { status: "error", error: `HTTP ${res.status}`, data: { url, status: res.status } });
    return [];
  }
  const locs = [...res.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
  const isIndex = /<sitemapindex/i.test(res.body);
  if (!isIndex) return locs;
  const out: string[] = [];
  for (const child of locs.slice(0, 50)) {
    const sub = await getText(child, 45000);
    if (sub.ok) out.push(...[...sub.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]));
  }
  return out;
}

// ============================ Link discovery ============================

/**
 * Expand ONE seed URL into every documentation page beneath it.
 *
 * Why this is separate from extractArticle: DROP_TAGS removes <nav> and <aside>
 * before any text is pulled, which is right for content — the left menu repeated
 * on 300 pages is exactly the boilerplate you do not want embedded — and fatal
 * for discovery, because that menu IS the link list. Discovery therefore reads
 * the RAW html and never goes near the article extractor.
 *
 * Scope is a path prefix rather than an attempt to identify "the nav element":
 * on a documentation site every menu link is same-origin and shares the seed's
 * path, so a filter gets the menu with no per-site knowledge and no brittleness.
 */
export interface DiscoverOptions {
  /** How many link-hops from the seed. 1 is usually enough (the menu repeats on
   *  every page); 2 catches collapsible sections that only render their children
   *  on the section's own page. */
  maxDepth?: number;
  limit?: number;
  concurrency?: number;
  /** "path" keeps only URLs under the seed's directory; "origin" allows the host. */
  scope?: "path" | "origin";
  onProgress?: (found: number, visited: number) => void;
}

export interface DiscoverResult {
  seed: string;
  urls: string[];
  /** How the list was obtained — a sitemap is authoritative, links are inferred. */
  method: "sitemap" | "links";
  visited: number;
  /** Set when the result looks too thin to be real (usually a JS-rendered menu). */
  warning?: string;
}

/** Run `worker` over `items` with a fixed number of parallel slots. */
async function pool<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return out;
}

/** Every href on the page, resolved against the document URL. Raw html only. */
function hrefsFrom(html: string, base: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'\s>]+)["']/gi)) {
    const raw = m[1];
    if (/^(mailto:|tel:|javascript:|data:|#)/i.test(raw)) continue;
    try {
      out.push(new URL(raw, base).toString());
    } catch {
      /* malformed href — skip it rather than fail the page */
    }
  }
  return out;
}

/** Things that are never documentation, so never worth fetching. */
const ASSET_RE = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|json|zip|tar|gz|mp4|webm|mp3|woff2?|ttf|eot|pdf|docx?|xlsx?|pptx?)(\?|$)/i;

interface Robots { disallow: string[]; sitemaps: string[]; delayMs: number }

/**
 * Minimal robots.txt reader — the directives that matter for a doc crawl.
 *
 * Fetching 400 pages from someone else's host without checking this is rude at
 * best. A missing or unreadable robots.txt is treated as "no restrictions",
 * which is the standard interpretation.
 */
async function readRobots(origin: string): Promise<Robots> {
  const robots: Robots = { disallow: [], sitemaps: [], delayMs: 0 };
  const res = await getText(`${origin}/robots.txt`, 10_000).catch(() => null);
  if (!res?.ok) return robots;
  let applies = false;
  for (const line of res.body.split("\n")) {
    const [rawKey, ...rest] = line.split("#")[0].split(":");
    const key = (rawKey ?? "").trim().toLowerCase();
    const value = rest.join(":").trim();
    if (!key) continue;
    if (key === "user-agent") applies = value === "*" || /aidan/i.test(value);
    else if (key === "sitemap") robots.sitemaps.push(value); // sitemap is global, not per-agent
    else if (applies && key === "disallow" && value) robots.disallow.push(value);
    else if (applies && key === "crawl-delay") robots.delayMs = Math.min(5000, Number(value) * 1000 || 0);
  }
  return robots;
}

const blockedByRobots = (url: string, robots: Robots): boolean => {
  const p = new URL(url).pathname;
  return robots.disallow.some((rule) => p.startsWith(rule));
};

export async function discoverLinks(seed: string, opts: DiscoverOptions = {}): Promise<DiscoverResult> {
  const maxDepth = opts.maxDepth ?? Number(process.env.CRAWL_DISCOVER_DEPTH ?? 2);
  const limit = opts.limit ?? Number(process.env.CRAWL_DISCOVER_LIMIT ?? 300);
  const concurrency = opts.concurrency ?? Number(process.env.CRAWL_CONCURRENCY ?? 8);
  const scope = opts.scope ?? "path";

  const seedUrl = new URL(seed);
  const origin = seedUrl.origin;
  /*
   * The seed path IS the scope.
   *
   * This used to take the seed's parent DIRECTORY — fine for "/docs/intro" →
   * "/docs/", and catastrophic for a section root. A seed of
   * "https://docs.llmapi.ai/features" has no trailing slash, so
   * `slice(0, lastIndexOf("/") + 1)` returned "/" and the crawl walked the whole
   * site: /guides, /resources and /quick-start were all ingested as if the
   * operator had asked for them.
   *
   * Using the seed path as a plain prefix gives the behaviour people expect when
   * they paste a section URL: "/features" covers "/features", "/features/x",
   * "/features-x" and "/features_x", and nothing else. A file-extension seed
   * still falls back to its directory, since "/docs/intro.html" as a prefix
   * would match only itself. Whole-site crawls remain available via
   * `scope: "origin"`.
   */
  const seedPath = seedUrl.pathname.replace(/\/+$/, "") || "/";
  const basePath = /\.[a-z0-9]{2,5}$/i.test(seedPath)
    ? seedPath.slice(0, seedPath.lastIndexOf("/") + 1)
    : seedPath;

  const inScope = (u: string): boolean => {
    let url: URL;
    try {
      url = new URL(u);
    } catch {
      return false;
    }
    if (url.origin !== origin) return false;
    if (ASSET_RE.test(url.pathname)) return false;
    return scope === "origin" || url.pathname.startsWith(basePath);
  };
  const normalise = (u: string) => {
    const url = new URL(u);
    url.hash = "";
    return url.toString();
  };

  const robots = await readRobots(origin);

  /*
   * A sitemap is authoritative and costs one request, so it is always preferred.
   * Fall through to link-walking when there is none, or when the one that exists
   * does not actually cover the seed's section.
   */
  for (const sitemap of [...robots.sitemaps, `${origin}/sitemap.xml`]) {
    const locs = await expandSitemap(sitemap).catch(() => [] as string[]);
    const scoped = [...new Set(locs.map((l) => { try { return normalise(l); } catch { return ""; } }).filter((l) => l && inScope(l)))];
    if (scoped.length >= 5) {
      return { seed, urls: scoped.slice(0, limit), method: "sitemap", visited: 1 };
    }
  }

  // Breadth-first link walk. Each DEPTH LEVEL is fetched in parallel, so a
  // 300-page manual costs a handful of round trips rather than 300 serial ones.
  const seen = new Set<string>([normalise(seed)]);
  const found = new Set<string>([normalise(seed)]);
  let level = [normalise(seed)];
  let visited = 0;

  for (let depth = 0; depth <= maxDepth && level.length && found.size < limit; depth++) {
    const pages = await pool(level, concurrency, async (url) => {
      if (robots.delayMs) await new Promise((r) => setTimeout(r, robots.delayMs));
      visited++;
      const res = await getText(url);
      return res.ok ? res.body : "";
    });

    const next: string[] = [];
    for (const [i, html] of pages.entries()) {
      if (!html) continue;
      for (const href of hrefsFrom(html, level[i])) {
        let clean: string;
        try {
          clean = normalise(href);
        } catch {
          continue;
        }
        if (seen.has(clean) || !inScope(clean) || blockedByRobots(clean, robots)) continue;
        seen.add(clean);
        if (found.size >= limit) break;
        found.add(clean);
        next.push(clean);
      }
    }
    opts.onProgress?.(found.size, visited);
    level = next;
  }

  const urls = [...found].slice(0, limit);
  /*
   * Failing loudly matters here. A client-rendered menu returns a shell with no
   * anchors, and silently writing a one-line source list is exactly how a
   * product ends up with a single documentation chunk and nobody notices.
   */
  const warning =
    urls.length < 5
      ? `Only ${urls.length} page(s) found under ${seed}. The menu may be rendered by JavaScript, which a plain HTTP fetch cannot see — add the URLs by hand, or point at a sitemap.`
      : undefined;

  return { seed, urls, method: "links", visited, warning };
}

function selectUrls(all: string[], spec: CrawlSpec): string[] {
  const inc = (spec.include ?? []).map((r) => new RegExp(r));
  const exc = (spec.exclude ?? []).map((r) => new RegExp(r));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of all) {
    const clean = u.split("#")[0];
    if (seen.has(clean)) continue;
    seen.add(clean);
    if (inc.length && !inc.some((r) => r.test(clean))) continue;
    if (exc.some((r) => r.test(clean))) continue;
    out.push(clean);
  }
  return spec.limit ? out.slice(0, spec.limit) : out;
}

export interface Page { url: string; title: string; text: string; status: number; bytes: number; rendered?: boolean }

/** Fetch pages concurrently, skipping non-2xx and anything too short to be an article. */
export async function fetchPages(
  urls: string[],
  concurrency = Number(process.env.CRAWL_CONCURRENCY ?? 8),
  onProgress?: (done: number, total: number) => void,
): Promise<Page[]> {
  const out: Page[] = [];
  let cursor = 0;
  let done = 0;
  let skippedStatus = 0;
  let skippedShort = 0;

  const worker = async () => {
    while (cursor < urls.length) {
      const url = urls[cursor++];
      const res = await getText(url);
      done++;
      if (done % 25 === 0) onProgress?.(done, urls.length);
      /*
       * THE bug this module exists for: a non-2xx response still has a body,
       * and that body is a full styled error page. Chunking it produces
       * confident-looking documentation made entirely of site furniture.
       */
      if (!res.ok) {
        skippedStatus++;
        emit("crawl.page", { status: "error", error: `HTTP ${res.status}`, data: {
          url, status: res.status, bytes: Buffer.byteLength(res.body), chunksProduced: 0,
          duplicate: false, skippedReason: "non-success HTTP status",
        } });
        continue;
      }
      const { title, text } = extractArticle(res.body);
      /*
       * An article shorter than this is usually a stub, a redirect notice, or a
       * page rendered client-side (which we cannot read here). Configurable, and
       * CRAWL_MIN_PAGE_CHARS=0 keeps everything — useful when indexing a whole
       * product's help centre where short pages are still real answers.
       *
       * Dropping it entirely is safe-ish rather than free: the HTTP status check
       * above already rejects error pages, which was the actual failure this
       * guard was added for, and chunks under 80 characters are discarded later.
       * What gets through at 0 is thin-but-real pages plus some navigation stubs.
       */
      if (text.length < MIN_PAGE_CHARS) {
        skippedShort++;
        emit("crawl.page", { status: "ok", data: {
          url, status: res.status, bytes: Buffer.byteLength(res.body), chunksProduced: 0,
          duplicate: false, skippedReason: `readable text below ${MIN_PAGE_CHARS} characters`,
        } });
        continue;
      }
      out.push({ url, title: title || url, text, status: res.status, bytes: Buffer.byteLength(res.body) });
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, urls.length)) }, worker));
  return out;
}

/**
 * Fetch pages with a real browser, for documentation that renders client-side.
 *
 * Most modern API documentation (Mintlify, Docusaurus, Nextra, GitBook) ships an
 * empty shell and paints the article with JavaScript. `fetch` sees HTTP 200 and
 * a few kilobytes of bootstrap, extractArticle finds no prose, and every page is
 * dropped as "too short" — silently, because a 200 is not an error. Measured on
 * docs.llmapi.ai: 147 URLs, every one returning an identical 2,860-byte shell
 * and 0 characters of extractable text.
 *
 * Rendering is far slower than fetching, so it is a FALLBACK, not the default.
 */
async function renderPages(
  urls: string[],
  concurrency = Number(process.env.CRAWL_RENDER_CONCURRENCY ?? 3),
  onProgress?: (done: number, total: number) => void,
): Promise<Page[]> {
  if (!urls.length) return [];
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const out: Page[] = [];
  let cursor = 0;
  let done = 0;
  const timeout = Number(process.env.CRAWL_RENDER_TIMEOUT_MS ?? 20_000);

  const worker = async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      // Validate every network request, not only the initial page. A public
      // documentation page can redirect or load a subresource from a private
      // address; allowing that would turn rendered crawling into an SSRF path.
      await page.route("**/*", async (route) => {
        const request = route.request();
        const url = request.url();
        if (/^(data:|blob:|about:)/i.test(url)) return route.continue();
        if (["image", "media", "font"].includes(request.resourceType())) return route.abort();
        try {
          await assertSafeKnowledgeUrl(url);
          await route.continue();
        } catch {
          await route.abort("blockedbyclient");
        }
      });
      while (cursor < urls.length) {
        const url = urls[cursor++];
        try {
          // The SSRF guard still applies: rendering must not become a way to
          // reach private addresses that the plain fetcher rejects.
          await assertSafeKnowledgeUrl(url);
          const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout });
          await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
          const html = await page.content();
          const { title, text } = extractArticle(html);
          if (text.length >= MIN_PAGE_CHARS) {
            out.push({ url, title: title || url, text, status: response?.status() ?? 200, bytes: Buffer.byteLength(html), rendered: true });
          } else {
            emit("crawl.page", { status: "ok", data: {
              url, status: response?.status() ?? 200, bytes: Buffer.byteLength(html), chunksProduced: 0,
              duplicate: false, rendered: true, skippedReason: `rendered text below ${MIN_PAGE_CHARS} characters`,
            } });
          }
        } catch (error) {
          emit("crawl.page", { status: "error", error: (error as Error).message, data: {
            url, status: 0, bytes: 0, chunksProduced: 0, duplicate: false, rendered: true,
            skippedReason: "browser rendering failed",
          } });
        }
        done++;
        if (done % 25 === 0) onProgress?.(done, urls.length);
      }
    } finally {
      await page.close().catch(() => {});
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, urls.length)) }, worker));
  } finally {
    await browser.close().catch(() => {});
  }
  return out;
}

// ============================ Boilerplate + chunking ============================

/**
 * Strip lines that appear on a large fraction of pages.
 *
 * Even after removing <nav>/<footer>, documentation sites repeat breadcrumbs,
 * subscription banners ("Available with any of the following subscriptions"),
 * feedback prompts and legal lines inside <main>. Per-page cleaning cannot see
 * these; a corpus can. Anything on more than `threshold` of pages is furniture
 * by definition — no real fact is restated verbatim on 30% of a site.
 */
export function stripBoilerplate(pages: Page[], threshold = 0.3): Page[] {
  if (pages.length < 5) return pages;
  const freq = new Map<string, number>();
  for (const p of pages) {
    for (const line of new Set(p.text.split("\n"))) {
      const k = line.trim();
      // Long lines are prose even if repeated; very short ones are headings we
      // would rather keep than risk deleting a real one.
      if (k.length < 12 || k.length > 200) continue;
      freq.set(k, (freq.get(k) ?? 0) + 1);
    }
  }
  const cut = Math.max(3, Math.floor(pages.length * threshold));
  const junk = new Set([...freq.entries()].filter(([, n]) => n >= cut).map(([k]) => k));
  if (junk.size) emit("crawl.boilerplate", { status: "ok", data: {
    pageCount: pages.length, linesRemoved: junk.size, occurrenceThreshold: threshold,
  } });
  return pages.map((p) => ({
    ...p,
    text: p.text.split("\n").filter((l) => !junk.has(l.trim())).join("\n").replace(/\n{3,}/g, "\n\n").trim(),
  }));
}

/**
 * Chunk with OVERLAP.
 *
 * Fixed 600-char non-overlapping chunks cut sentences — and a fact that spans a
 * boundary ("To create a contact, click Create in the upper right" / "then
 * choose Contact") is then retrievable by neither half. Carrying the tail of
 * the previous chunk forward costs a little storage and removes the failure.
 */
export function chunkText(text: string, target = 900, overlap = 150): string[] {
  /*
   * Split on blank lines, then HARD-split any paragraph still larger than the
   * target. Without the second step a page with no blank lines is one
   * paragraph: HubSpot's "Domains blocked from form submissions" is a 67,000
   * character list of domains, which became a single chunk of which the
   * embedder saw only the first 6,000 characters. Long paragraphs are broken at
   * sentence ends where possible and at line ends otherwise, so a list splits
   * per entry rather than mid-token.
   */
  const paras = text
    .split(/\n\s*\n/)
    .flatMap((p) => (p.length <= target ? [p] : splitLong(p, target)))
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const out: string[] = [];
  let buf = "";
  const flush = () => {
    const t = buf.trim();
    if (t.length >= 80) out.push(t); // drop slivers — they embed to noise
    // Carry a tail forward so the next chunk has the end of this one.
    buf = t.length > overlap ? t.slice(-overlap) : t;
  };
  for (const p of paras) {
    if (buf && (buf + " " + p).length > target) flush();
    buf += (buf ? " " : "") + p;
  }
  const last = buf.trim();
  if (last.length >= 80) out.push(last);
  return out;
}

/** Break an oversized paragraph at sentence ends, then line ends, then hard length. */
function splitLong(p: string, target: number): string[] {
  const units = p.split(/(?<=[.!?])\s+|\n/).filter(Boolean);
  const out: string[] = [];
  let buf = "";
  for (const u of units) {
    // A single unit longer than the target (one enormous line) is cut by length.
    if (u.length > target) {
      if (buf) { out.push(buf); buf = ""; }
      for (let i = 0; i < u.length; i += target) out.push(u.slice(i, i + target));
      continue;
    }
    if (buf && (buf + " " + u).length > target) { out.push(buf); buf = ""; }
    buf += (buf ? " " : "") + u;
  }
  if (buf) out.push(buf);
  return out;
}

/** Normalised hash for exact-duplicate detection across pages. */
function fingerprint(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 400);
}

export interface CrawlResult {
  chunks: Omit<DocChunk, "id">[];
  pages: number;
  duplicates: number;
  /** Planner-only source structure; live retrieval continues to use chunks. */
  sections: DocumentSection[];
}

/** Run one crawl spec end to end: expand → fetch → de-boilerplate → chunk → dedup. */
export async function runCrawl(spec: CrawlSpec): Promise<CrawlResult> {
  const started = Date.now();
  const trust = spec.trust ?? "official";
  const all = spec.sitemap ? await expandSitemap(spec.sitemap) : (spec.urls ?? []);
  const urls = selectUrls(all, spec);
  emit("crawl.run", { status: "start", data: {
    sitemap: spec.sitemap, explicitUrls: spec.urls?.length ?? 0,
    discoveredUrls: all.length, selectedUrls: urls.length, trust,
  } });
  if (!urls.length) {
    const empty = { chunks: [], pages: 0, duplicates: 0, sections: [] };
    emit("crawl.run", { status: "ok", ms: Date.now() - started, data: {
      discoveredUrls: all.length, selectedUrls: 0, pages: 0, chunkCount: 0, duplicates: 0,
    } });
    return empty;
  }

  const mode = (process.env.CRAWL_RENDER ?? "auto").toLowerCase(); // auto | always | off
  const threshold = Number(process.env.CRAWL_RENDER_THRESHOLD ?? 0.2);

  /*
   * PROBE before committing to a static pass.
   *
   * The ratio check below already catches a client-rendered site — but only
   * after fetching every URL, so a corpus that is 100% unreadable is downloaded
   * twice. Measured on docs.llmapi.ai: 147 URLs fetched statically at 11:41 for
   * zero chunks, then all 147 rendered at 11:43. Two minutes and a doubled
   * request load on the customer's docs host, to learn something a handful of
   * pages would have said.
   *
   * A sample is enough because the failure is a property of the SITE, not of
   * individual pages: the shell is identical every time.
   */
  const probeSize = Number(process.env.CRAWL_PROBE_PAGES ?? 8);
  let fetched: Page[] = [];
  let staticSkipped = false;
  if (mode === "always") {
    staticSkipped = true;
  } else if (mode !== "off" && urls.length > probeSize * 2) {
    const sample = urls.slice(0, probeSize);
    const probe = await fetchPages(sample, spec.concurrency ?? 8);
    if (probe.length / sample.length < threshold) {
      // Client-rendered: don't pay for the other (urls.length - probeSize) fetches.
      staticSkipped = true;
      emit("crawl.probe", { status: "ok", data: {
        probed: sample.length, readable: probe.length, decision: "render-all",
        reason: "sample is a JavaScript-rendered shell — skipping the static pass",
      } });
    } else {
      fetched = [...probe, ...(await fetchPages(urls.slice(probeSize), spec.concurrency ?? 8))];
    }
  } else {
    fetched = await fetchPages(urls, spec.concurrency ?? 8);
  }

  /*
   * Retry what static fetching could not read, with a browser.
   *
   * "auto" triggers when almost nothing came back, which is the signature of a
   * client-rendered docs site rather than of a few broken pages — every URL
   * returns 200 and no prose. Keyed on a RATIO so a handful of genuinely thin
   * pages in a healthy crawl does not launch a browser for the whole corpus.
   */
  const readable = fetched.length / Math.max(1, urls.length);
  if (staticSkipped || (mode !== "off" && readable < threshold)) {
    const got = new Set(fetched.map((p) => p.url));
    const missing = urls.filter((u) => !got.has(u));
    if (missing.length) {
      emit("crawl.render", { status: "start", data: {
        selectedUrls: urls.length, staticReadable: fetched.length, renderingUrls: missing.length,
      } });
      fetched = [...fetched, ...(await renderPages(missing))];
    }
  }
  const pages = stripBoilerplate(fetched);

  const seen = new Set<string>();
  const chunks: Omit<DocChunk, "id">[] = [];
  const sections: DocumentSection[] = [];
  let duplicates = 0;
  const freshness = new Date().toISOString();
  for (const p of pages) {
    const section = decodeURIComponent(new URL(p.url).pathname.split("/").filter(Boolean).slice(-2, -1)[0] ?? "").replace(/-/g, " ");
    const sourceSections = documentJourneyPlanningEnabled()
      ? parseDocumentSections(p.text, { source: p.url, title: p.title, trust, freshness })
      : [];
    sections.push(...sourceSections);
    const pageChunks: Omit<DocChunk, "id">[] = sourceSections.length
      ? chunkStructuredSections(sourceSections)
      : chunkText(p.text).map((text) => ({ text, source: p.url, title: p.title, section: section || p.title, trust, freshness }));
    let produced = 0;
    let pageDuplicates = 0;
    for (const chunk of pageChunks) {
      const fp = fingerprint(chunk.text);
      if (seen.has(fp)) { duplicates++; pageDuplicates++; continue; }
      seen.add(fp);
      chunks.push(chunk);
      produced++;
    }
    emit("crawl.page", { status: "ok", data: {
      url: p.url, status: p.status, bytes: p.bytes, chunksProduced: produced,
      duplicate: produced === 0 && pageDuplicates > 0, duplicateChunks: pageDuplicates,
      rendered: !!p.rendered,
    } });
  }
  const result = { chunks, pages: pages.length, duplicates, sections };
  emit("crawl.run", { status: "ok", ms: Date.now() - started, data: {
    discoveredUrls: all.length, selectedUrls: urls.length, pages: pages.length,
    chunkCount: chunks.length, duplicates, sectionCount: sections.length,
  } });
  return result;
}
