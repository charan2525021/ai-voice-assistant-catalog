import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { chromeUserAgent, waitForProfileUnlock } from "./chromebin.js";
import { config } from "./config.js";
import type { ProductAuth } from "./products.js";
import Steel from "steel-sdk";
import { emit } from "./events.js";
// safety.ts depends only on events.js, so this does not close a cycle.
import { checkAction } from "./mapper/safety.js";

/**
 * What product this browser is driving. Passed per instance so ONE server can
 * demo several products at once; omit it and we fall back to the env-configured
 * product (which is how the single-product CLIs still work).
 */
export interface LiveTarget {
  startUrl: string;
  auth?: ProductAuth;
  allowActions?: string[];
  /** Reattach to a still-live managed browser after a worker failure. */
  resumeSessionId?: string;
}

/** One interactive element the agent can act on, from the page snapshot. */
export interface PageElement {
  id: number;
  tag: string;
  type: string;
  text: string;
  placeholder: string;
  value: string;
  href: string;
  /** ARIA role + accessible name — the durable way to address this element. */
  role?: string;
  name?: string;
  /**
   * A test hook the product's own developers put there (`data-testid` and
   * friends). Captured ALWAYS, not just when the accessible name is empty,
   * because it is the one identifier that does not change when the label does —
   * which is what makes it the right thing to record for a control whose text
   * varies per account ("Default Organization") or per locale.
   */
  testId?: string;
  /** True when ARIA says the control reveals more UI rather than committing an action. */
  discloses?: boolean;
  /** True when the control belongs to a transient menu, dialog, listbox or tooltip. */
  overlay?: boolean;
}

export interface PageSnapshot {
  url: string;
  title: string;
  elements: PageElement[];
  /*
   * What the page SAYS, not just what it offers to click.
   *
   * The element list is interactive controls only, so every figure a dashboard
   * renders as plain content — counts, totals, chart labels, KPI tiles — was
   * absent from everything the agent received. Measured on one product's home
   * screen: 60 numbers a person can read, 23 present in the element list. The
   * agent answered questions about the other 37 by inventing them.
   */
  text: string;
  screenshot: string; // base64 PNG (viewport) — the agent's "eyes"
}

/**
 * A LiveBox: a local, open-source Chromium the agent drives and the prospect
 * watches / takes over. Provides:
 *   - Hands: goto / clickElement / typeText / scroll (agent actions)
 *   - Eyes:  snapshot() (labeled elements + screenshot for the model)
 *   - Live view: a steady JPEG stream to the browser (onFrame)
 *   - Takeover: userClick / userWheel / userKey (human input forwarded in)
 */
export class LiveBox {
  private browser!: Browser;
  private context!: BrowserContext;
  /** True when the context owns its browser process (persistent profile mode). */
  private persistent = false;
  /**
   * Nothing has happened since start() finished authenticating and landing on
   * startUrl — so there is no state to reset. Cleared by the first real action.
   */
  private pristine = false;
  private page!: Page;
  private frameCb: ((jpegBase64: string) => void) | null = null;
  private streamTimer: NodeJS.Timeout | null = null;
  private steel?: Steel;
  private steelSessionId?: string;
  private browserSessionId?: string;
  private lastElements = new Map<number, PageElement>();
  /**
   * Tabs this box opened after the first one, newest last.
   *
   * Kept so resetState() can close them. Without this the agent accumulates
   * orphaned tabs across a run and the profile-mode context leaks them between
   * jobs.
   */
  private extraPages: Page[] = [];
  /** The tab this box was born with. Never closed as an "extra". */
  private mainPage?: Page;
  /** Set when a click opened a tab, and read once by the next snapshot. */
  private adoptedTab: string | null = null;
  private readonly W = config.viewport.width;
  private readonly H = config.viewport.height;
  private readonly target: Required<Pick<LiveTarget, "startUrl">> & { auth: ProductAuth };
  private readonly resumeSessionId?: string;
  /**
   * Mutations this product has explicitly opted into, as declared in
   * product.json. The execution-layer gate consults it so a sandbox that
   * permits "create" can still replay a journey that creates something —
   * without that, adding the gate to runProgram would have silently broken
   * every legitimately allowlisted write.
   */
  private allowedActions: string[];

  constructor(target?: LiveTarget) {
    this.target = {
      startUrl: target?.startUrl ?? config.demo.startUrl,
      auth: target?.auth ?? {
        mode: config.demo.authMode === "login" ? "login" : "none",
        username: config.demo.username,
        password: config.demo.password,
      },
    };
    this.resumeSessionId = target?.resumeSessionId;
    this.allowedActions = target?.allowActions ?? config.allowActions;
  }

  /**
   * Narrow or widen what replay may do, for a box shared across jobs.
   *
   * The explorer is handed a per-journey allowlist that the box it was given
   * knows nothing about; without this the gate below would judge a shared box
   * by the product default and refuse a step the caller had authorised.
   */
  setAllowedActions(allow: string[] | undefined): void {
    this.allowedActions = allow ?? config.allowActions;
  }

  get startUrl() {
    return this.target.startUrl;
  }

  /**
   * Follow the agent's own clicks into new tabs.
   *
   * `this.page` was bound once at startup and never rebound, so a control with
   * target="_blank" (or any window.open) left the box driving the ORIGINAL tab
   * while the product it was sent to opened somewhere invisible. The failure is
   * silent and expensive: every subsequent snapshot, visibleText and currentUrl
   * reads the stale page, so the explorer sees an unchanged screen, concludes
   * the control did nothing, and either burns its budget retrying or gives up.
   * Even the "did that leave the product?" guard could not fire, because it
   * asks currentUrl() — which was still answering for the old tab.
   *
   * Adopting the new tab is the behaviour a person would have: the click opened
   * something, so look at it.
   */
  private watchForNewTabs(): void {
    this.context.on("page", async (opened: Page) => {
      try {
        /*
         * Never adopt the tab we are already driving.
         *
         * This listener must be attached AFTER the main page exists, because
         * context.on("page") fires for our own newPage() call at startup too.
         * When it was attached first, the main tab was filed as an "extra" and
         * the next resetState() closed it — after which every goto failed with
         * "Target page, context or browser has been closed" and every snapshot
         * returned an empty screen, so the explorer saw no controls and gave up
         * on 22 consecutive jobs. This guard is the belt to that braces.
         */
        if (opened === this.page) return;
        await opened.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
        if (opened.isClosed()) return;
        this.extraPages.push(opened);
        this.page = opened;
        this.adoptedTab = opened.url();
        opened.on("close", () => {
          this.extraPages = this.extraPages.filter((p) => p !== opened);
          // Fall back to the newest surviving tab so the box is never left
          // pointing at a closed page.
          if (this.page === opened) {
            const survivor = [...this.extraPages].reverse().find((p) => !p.isClosed())
              ?? this.context.pages().find((p) => !p.isClosed());
            if (survivor) this.page = survivor;
          }
        });
      } catch {
        /* the tab closed itself before we could adopt it */
      }
    });
  }

  /**
   * Report (once) that the last action opened a tab.
   *
   * Read into the action outcome so the model is told what happened in words,
   * rather than having to infer it from a screen that suddenly looks unrelated.
   */
  private takeTabNotice(): string {
    const url = this.adoptedTab;
    this.adoptedTab = null;
    return url ? ` — that opened a new tab (${url}), which I am now looking at.` : "";
  }

  /** Close every tab this box opened beyond the main one, and return to it. */
  private async closeExtraTabs(): Promise<void> {
    for (const extra of this.extraPages.splice(0)) {
      // Closing the tab we are driving would leave the box holding a dead page.
      if (extra === this.mainPage || extra.isClosed()) continue;
      await extra.close().catch(() => {});
    }
    this.adoptedTab = null;
    const home = this.mainPage && !this.mainPage.isClosed()
      ? this.mainPage
      : this.context.pages().find((p) => !p.isClosed());
    if (home) this.page = home;
  }

  async start(): Promise<{ sessionId: string }> {
    const started = Date.now();
    const provider = this.target.auth.mode === "profile" ? "chrome-profile" : config.liveboxProvider === "steel" ? "steel" : "local-playwright";
    emit("browser.start", { status: "start", data: { provider, startUrl: this.target.startUrl, resumeSessionId: this.resumeSessionId } });
    try {
      const result = await this.startBrowser();
      this.browserSessionId = result.sessionId;
      emit("browser.start", { status: "ok", ms: Date.now() - started, data: { provider, sessionId: result.sessionId, startUrl: this.target.startUrl } });
      return result;
    } catch (error) {
      emit("browser.start", { status: "error", ms: Date.now() - started, error: (error as Error).message, data: { provider, startUrl: this.target.startUrl } });
      throw error;
    }
  }

  private async startBrowser(): Promise<{ sessionId: string }> {
    /*
     * Profile mode: drive a REAL Chrome profile the human already signed into.
     *
     * This exists because Google (and Microsoft, and Okta) refuse OAuth from
     * Playwright's bundled Chromium — "this browser or app may not be secure".
     * That check is not a fingerprint we can spoof away: the build is not
     * Google-branded and Playwright advertises --enable-automation. So the
     * sign-in happens in genuine Chrome (see chromeprofile.ts) and we attach to
     * the profile directory afterwards, where the session already lives.
     */
    if (this.target.auth.mode === "profile" && this.target.auth.profileDir) {
      this.persistent = true;
      if (!(await waitForProfileUnlock(this.target.auth.profileDir))) {
        throw new Error(
          `the Chrome profile at ${this.target.auth.profileDir} is still in use. ` +
            "Close any sign-in window for this product and retry.",
        );
      }
      this.context = await chromium.launchPersistentContext(this.target.auth.profileDir, {
        channel: "chrome", // genuine Chrome, never the bundled Chromium
        headless: true,
        viewport: config.viewport,
        // Headless Chrome otherwise announces "HeadlessChrome/<v>", which some
        // products answer with a degraded page.
        userAgent: await chromeUserAgent(),
        args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"],
        // Playwright adds --enable-automation by default; that one flag is enough
        // for some apps to degrade, and it is the flag Google looks for.
        ignoreDefaultArgs: ["--enable-automation"],
        locale: process.env.BROWSER_LOCALE ?? "en-US",
        timezoneId: process.env.BROWSER_TZ ?? "UTC",
        deviceScaleFactor: 1,
      });
      await this.context.addInitScript(`Object.defineProperty(navigator, 'webdriver', { get: () => undefined });`).catch(() => {});
    await this.restoreSessionStorage();
      this.page = this.context.pages()[0] ?? (await this.context.newPage());
      this.mainPage = this.page;
      this.watchForNewTabs(); // only ever sees tabs opened AFTER this point
      await this.goto(this.target.startUrl);
      this.startStreaming();
      this.pristine = true;
      return { sessionId: Math.random().toString(36).slice(2) };
    }

    if (config.liveboxProvider === "steel") {
      this.steel = new Steel({
        steelAPIKey: config.steelApiKey(),
        timeout: Number(process.env.STEEL_API_TIMEOUT_MS ?? 20_000),
        maxRetries: 1,
      });
      let sessionContext: any = undefined;
      if (this.target.auth.mode === "session" && this.target.auth.sessionState) {
        try {
          const state = JSON.parse(this.target.auth.sessionState);
          const localStorage: Record<string, Record<string, string>> = {};
          for (const origin of state.origins ?? []) {
            localStorage[origin.origin] = Object.fromEntries((origin.localStorage ?? []).map((item: any) => [item.name, item.value]));
          }
          sessionContext = { cookies: state.cookies ?? [], localStorage };
          if (this.target.auth.sessionStorage) sessionContext.sessionStorage = JSON.parse(this.target.auth.sessionStorage);
        } catch {
          console.warn("[livebox] stored session could not be converted for the browser fleet");
        }
      }
      const session = this.resumeSessionId
        ? await this.steel.sessions.retrieve(this.resumeSessionId)
        : await this.steel.sessions.create({
            timeout: Number(process.env.STEEL_SESSION_TIMEOUT_MS ?? 30 * 60_000),
            dimensions: config.viewport,
            sessionContext,
            region: (process.env.STEEL_REGION || undefined) as any,
            solveCaptcha: process.env.STEEL_SOLVE_CAPTCHA === "true",
          });
      if (session.status !== "live") throw new Error(`managed browser session ${session.id} is ${session.status}`);
      this.steelSessionId = session.id;
      this.browser = await chromium.connectOverCDP(session.websocketUrl);
      this.context = this.browser.contexts()[0] ?? await this.browser.newContext({ viewport: config.viewport });
      await this.context.addInitScript(`Object.defineProperty(navigator, 'webdriver', { get: () => undefined });`).catch(() => {});
      await this.restoreSessionStorage();
      this.page = this.context.pages()[0] ?? await this.context.newPage();
      this.mainPage = this.page;
      this.watchForNewTabs();
      if (!this.resumeSessionId) {
        await this.goto(this.target.startUrl);
        await this.loginIfNeeded();
      }
      this.startStreaming();
      this.pristine = true;
      return { sessionId: session.id };
    }

    /*
     * Look like a normal browser.
     *
     * Plenty of real platforms serve a blank shell to obvious automation — we hit
     * exactly that on a live demo app: the HTML loaded, the title was right, and
     * the SPA rendered NOTHING (bodyLen 0). A realistic user-agent, locale and
     * the automation flag disabled is what makes an unseen product actually load.
     */
    this.browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage"],
    });
    /*
     * If a human signed in interactively, reuse THAT session.
     *
     * This is what makes SSO / 2FA products work at all: we cannot type a Google
     * password (and should never hold one), but we can carry the cookies the
     * user's own sign-in produced.
     */
    let storageState: any = undefined;
    if (this.target.auth.mode === "session" && this.target.auth.sessionState) {
      try {
        storageState = JSON.parse(this.target.auth.sessionState);
      } catch {
        console.warn("[livebox] stored session is unreadable — continuing signed out");
      }
    }
    this.context = await this.browser.newContext({
      viewport: config.viewport,
      ...(storageState ? { storageState } : {}),
      userAgent:
        process.env.BROWSER_UA ??
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: process.env.BROWSER_LOCALE ?? "en-US",
      timezoneId: process.env.BROWSER_TZ ?? "UTC",
      deviceScaleFactor: 1,
    });
    // navigator.webdriver is the cheapest automation tell.
    await this.context.addInitScript(`Object.defineProperty(navigator, 'webdriver', { get: () => undefined });`).catch(() => {});
    await this.restoreSessionStorage();
    this.page = await this.context.newPage();
    this.mainPage = this.page;
    this.watchForNewTabs();
    await this.goto(this.target.startUrl);
    await this.loginIfNeeded();
    this.startStreaming();
    this.pristine = true;
    return { sessionId: Math.random().toString(36).slice(2) };
  }

  /**
   * Real products sit behind a login. Sign in once at session start so both the
   * demo agent and the mapper operate on the authenticated app.
   * Best-effort and non-fatal: if the form isn't found we continue unauthenticated.
   */
  async loginIfNeeded(): Promise<boolean> {
    const auth = this.target.auth;
    // A captured session is already authenticated; there is no form to fill.
    if (auth.mode === "session") return true;
    if (auth.mode !== "login" || !auth.username) return false;
    try {
      const user = this.page
        .locator('input[type="email"], input[name*="user" i], input[id*="user" i], input[name*="email" i], input[type="text"]')
        .first();
      const pass = this.page.locator('input[type="password"]').first();
      if ((await pass.count()) === 0) return false;

      let actionStarted = Date.now();
      const beforeUrl = this.page.url();
      const userOk = await user.fill(auth.username, { timeout: 8000 }).then(() => true).catch(() => false);
      this.tracedAction(actionStarted, { action: "fill", role: "textbox", name: "login username", value: "[redacted]", beforeUrl }, userOk ? "filled login username" : "error: could not fill login username");
      actionStarted = Date.now();
      const passOk = await pass.fill(auth.password ?? "", { timeout: 8000 }).then(() => true).catch(() => false);
      this.tracedAction(actionStarted, { action: "fill", role: "textbox", name: "login password", value: "[redacted]", beforeUrl }, passOk ? "filled login password" : "error: could not fill login password");
      const submit = this.page
        .locator('button[type="submit"], input[type="submit"], button:has-text("Log in"), button:has-text("Sign in"), button:has-text("Login")')
        .first();
      actionStarted = Date.now();
      if ((await submit.count()) > 0) {
        const ok = await submit.click({ timeout: 8000 }).then(() => true).catch(() => false);
        this.tracedAction(actionStarted, { action: "click", role: "button", name: "sign in", beforeUrl }, ok ? "clicked sign in" : "error: could not click sign in");
      } else {
        const ok = await this.page.keyboard.press("Enter").then(() => true).catch(() => false);
        this.tracedAction(actionStarted, { action: "keypress", name: "login form", value: "Enter", beforeUrl }, ok ? "submitted login form with Enter" : "error: could not submit login form");
      }

      await this.page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
      await this.settle();
      const stillHasPassword = (await this.page.locator('input[type="password"]').count()) > 0;
      return !stillHasPassword;
    } catch {
      return false;
    }
  }

  /** Save the authenticated session so later boxes (e.g. the Verifier) skip login. */
  /*
   * Put sessionStorage back.
   *
   * Playwright's storageState carries cookies and localStorage only —
   * sessionStorage is per-tab and the browser DESTROYS it on close, which is
   * exactly what a capture-by-closing-Chrome flow does. An app that keeps its
   * token there (llmapi.ai does) could therefore never be captured: the user
   * signed in correctly, and closing the window to "save" the session deleted
   * the one thing that mattered. So it is captured from the LIVE browser and
   * replayed into every page here.
   */
  private async restoreSessionStorage(): Promise<void> {
    const raw = (this.target.auth as any).sessionStorage;
    if (!raw || !this.context) return;
    try {
      const byOrigin = JSON.parse(raw) as Record<string, Record<string, string>>;
      await this.context.addInitScript((data: Record<string, Record<string, string>>) => {
        try {
          const entries = data[window.location.origin];
          if (!entries) return;
          for (const [k, v] of Object.entries(entries)) window.sessionStorage.setItem(k, v);
        } catch {
          /* storage disabled for this origin */
        }
      }, byOrigin);
    } catch {
      /* malformed capture: fall through to an unauthenticated session */
    }
  }

  async saveAuthState(): Promise<string | null> {
    try {
      // Some modern auth SDKs keep refresh credentials only in IndexedDB.
      // Omitting it makes a capture appear successful but signed out on replay.
      return JSON.stringify(await this.context.storageState({ indexedDB: true }));
    } catch {
      return null;
    }
  }

  onFrame(cb: (jpegBase64: string) => void): void {
    this.frameCb = cb;
  }

  /**
   * Serialise browser work. The Agent and the Observer share one LiveBox; without
   * this, a rescue snapshot can interleave with an agent action mid-flow and each
   * sees a page the other is halfway through changing.
   */
  private lock: Promise<unknown> = Promise.resolve();
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => {});
    return run;
  }

  /** Steady ~2.5fps live view — reliable regardless of page repaint behavior. */
  private startStreaming(): void {
    if (this.streamTimer) return;
    this.streamTimer = setInterval(async () => {
      if (!this.frameCb) return;
      try {
        const jpeg = await this.page.screenshot({ type: "jpeg", quality: 50, timeout: 4000, animations: "disabled", caret: "hide" });
        this.frameCb(jpeg.toString("base64"));
      } catch {
        /* mid-navigation; skip this frame */
      }
    }, 400);
  }

  currentUrl(): string {
    return this.page.url();
  }

  /** The product's own origin — the boundary replay is allowed to stay within. */
  private origin(): string {
    try {
      return new URL(this.target.startUrl).origin;
    } catch {
      return this.target.startUrl;
    }
  }

  /**
   * What currently has keyboard focus in the remote page.
   *
   * Typing "not landing" is almost always nothing focused, and the user has no way
   * to know: the streamed image shows a caret at best. Reporting focus back turns
   * an invisible failure into an obvious one.
   */
  async focusedDescription(): Promise<string> {
    return (await this.page
      .evaluate(`(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return "";
        const tag = el.tagName.toLowerCase();
        const type = el.getAttribute('type') || '';
        const name = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.id || '';
        const kind = type ? tag + '/' + type : tag;
        return name ? kind + ' "' + name + '"' : kind;
      })()`)
      .catch(() => "")) as string;
  }

  /** Which hosts the captured session covers — shown to the admin before storing. */
  async sessionOrigins(): Promise<string[]> {
    try {
      const st = await this.context.storageState();
      const hosts = [
        ...st.cookies.map((c) => c.domain.replace(/^\./, "")),
        ...(st.origins ?? []).map((o) => {
          try { return new URL(o.origin).hostname; } catch { return o.origin; }
        }),
      ];
      return [...new Set(hosts)].slice(0, 12);
    } catch {
      return [];
    }
  }

  // ---- Agent actions (Hands) ----

  private tracedAction(
    started: number,
    input: { action: string; role?: string; name?: string; value?: string; elementId?: number; beforeUrl?: string },
    detail: string,
  ): string {
    const sensitive = /password|secret|api[-_ ]?key|authorization|cookie|token/i.test(input.name ?? "");
    const safeValue = sensitive && input.value ? "[redacted]" : input.value;
    const safeDetail = sensitive && input.value ? detail.split(input.value).join("[redacted]") : detail;
    const ok = !/^(NOT_FOUND|No element|Action failed|Could not|error:)/i.test(detail);
    emit("browser.action", {
      status: ok ? "ok" : "error", ms: Date.now() - started, error: ok ? undefined : safeDetail,
      data: {
        action: input.action, role: input.role, name: input.name, value: safeValue,
        elementId: input.elementId, ok, detail: safeDetail,
        beforeUrl: input.beforeUrl, afterUrl: this.page?.url(),
      },
    });
    return detail;
  }

  async goto(url: string): Promise<void> {
    const started = Date.now();
    const from = this.page.url();
    let error = "";
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch((e) => { error = (e as Error).message; });
    await this.settle().catch((e) => { error = [error, (e as Error).message].filter(Boolean).join("; "); });
    emit("browser.navigate", {
      status: error ? "error" : "ok", ms: Date.now() - started, error: error || undefined,
      data: { from, to: this.page.url(), requestedUrl: url },
    });
  }

  /**
   * Return to a known-good starting state. On authenticated products, navigating
   * to startUrl lands back on the LOGIN page — so re-authenticate. Use this
   * (never bare goto(startUrl)) whenever resetting between exploration episodes.
   */
  async gotoStart(): Promise<void> {
    await this.goto(this.target.startUrl);
    await this.restoreOriginStorage();
    if ((await this.page.locator('input[type="password"]').count().catch(() => 0)) > 0) {
      await this.loginIfNeeded();
    }
    /*
     * Arrive on a usable screen, not behind a cookie wall.
     *
     * Clearing here rather than after every action is the whole distinction: an
     * overlay present the moment we land was not opened by anything we did, so
     * nothing is lost by closing it — while a dialog raised BY a click is
     * frequently the point of that click and must survive.
     */
    const overlay = await this.clearBlockingOverlay();
    if (!overlay.cleared) console.warn(`[livebox] ${overlay.detail}`);
  }

  /**
   * Get a blocking overlay out of the way — cookie banners, product tours,
   * first-visit modals.
   *
   * These are not cosmetic. A modal takes the pointer, so NOTHING behind it is
   * clickable until it is gone: the run does not degrade, it stops. And the
   * dismissal must never become a journey step, because the banner that blocked
   * the recorder will not be there for a user who accepted it last week.
   *
   * DELIBERATELY NOT CALLED AFTER EVERY CLICK. A dialog opened *by* the previous
   * action is usually the point of that action — "New Rule" is supposed to open
   * a form. This runs on arrival at a screen, and as a recovery when a click is
   * intercepted by something that is not its own target.
   */
  async clearBlockingOverlay(): Promise<{ cleared: boolean; detail: string }> {
    const blocking = async (): Promise<string> =>
      (await this.page
        .evaluate(`(() => {
          var sel = '[aria-modal="true"], dialog[open], [role="alertdialog"], [role="dialog"]';
          var vw = window.innerWidth, vh = window.innerHeight;
          for (var node of document.querySelectorAll(sel)) {
            var r = node.getBoundingClientRect();
            if (r.width > 8 && r.height > 8) return (node.innerText || 'dialog').trim().slice(0, 80);
          }
          // Cookie bars and tour backdrops are often not dialogs at all: a fixed
          // element on a high layer, plus the scroll lock they set on the body.
          var locked = /hidden|clip/.test(getComputedStyle(document.body).overflow);
          for (var el of document.querySelectorAll('div,section,aside,footer')) {
            var s = getComputedStyle(el);
            if (s.position !== 'fixed' && s.position !== 'sticky') continue;
            if (s.visibility === 'hidden' || s.display === 'none' || s.pointerEvents === 'none') continue;
            if (Number(s.zIndex || 0) < 100) continue;
            var b = el.getBoundingClientRect();
            var covers = (b.width * b.height) / (vw * vh);
            if (covers > (locked ? 0.15 : 0.5)) return (el.innerText || 'overlay').trim().slice(0, 80);
          }
          return '';
        })()`)
        .catch(() => "")) as string;

    const found = await blocking();
    if (!found) return { cleared: true, detail: "no blocking overlay" };

    // 1) Escape closes most well-built dialogs and costs nothing.
    await this.page.keyboard.press("Escape").catch(() => {});
    await this.page.waitForTimeout(250);
    if (!(await blocking())) return { cleared: true, detail: "dismissed with Escape" };

    /*
     * 2) Click a control that only ever dismisses.
     *
     * Allowlisted by wording rather than by position, and the destructive check
     * runs second so a modal whose confirm button happens to read "OK, delete
     * everything" can never qualify. Consent wording ("Accept") is included for
     * mapping against a demo tenant; at runtime in a real user's session that
     * decision belongs to the user, not to us.
     */
    const DISMISS = /^(got it|ok(ay)?|close|dismiss|skip|no thanks|maybe later|later|continue|done|finish|next|accept|accept all|allow all|i agree|agree)$/i;
    const DESTRUCTIVE = /(delete|remove|cancel subscription|unsubscribe|revoke|terminate|reset|discard)/i;
    const buttons = this.page.locator('button, [role="button"], a[role="button"]');
    const n = Math.min(await buttons.count().catch(() => 0), 40);
    for (let i = 0; i < n; i++) {
      const b = buttons.nth(i);
      const label = ((await b.innerText().catch(() => "")) || (await b.getAttribute("aria-label").catch(() => "")) || "").trim();
      if (!label || !DISMISS.test(label) || DESTRUCTIVE.test(label)) continue;
      if (!(await b.isVisible().catch(() => false))) continue;
      await b.click({ timeout: 4000 }).catch(() => {});
      await this.page.waitForTimeout(250);
      if (!(await blocking())) return { cleared: true, detail: `dismissed by clicking "${label}"` };
    }

    // 3) Fail loudly. Forcing a click through the overlay would "succeed" while
    // hitting nothing, which is how an unusable journey gets recorded as fine.
    return { cleared: false, detail: `blocked by an overlay that could not be dismissed: "${found}"` };
  }

  async clickElement(id: number): Promise<string> {
    const started = Date.now();
    const beforeUrl = this.page.url();
    const identified = this.lastElements.get(id);
    const finish = (detail: string) => this.tracedAction(started, {
      action: "click", role: identified?.role || identified?.tag, name: identified?.name || identified?.text,
      elementId: id, beforeUrl,
    }, detail);
    const el = this.page.locator(`[data-aidan-id="${id}"]`).first();
    if ((await el.count()) === 0) return finish(`No element with id ${id} on the current screen.`);
    if (!(await el.isEnabled().catch(() => true))) return finish(`Action failed: element ${id} is disabled.`);
    await el.scrollIntoViewIfNeeded().catch(() => {});
    let clicked = await el.click({ timeout: 8000 }).then(() => true).catch(() => false);
    /*
     * A failed click is usually an INTERCEPTED click — something is on top.
     * This used to retry with `force: true`, which dispatches the event at the
     * coordinates regardless of what is actually there: the call reports success,
     * the overlay swallows it, and nothing happens. Clear the obstruction and try
     * honestly instead; if it still fails, say so.
     */
    if (!clicked) {
      const overlay = await this.clearBlockingOverlay();
      if (overlay.cleared && overlay.detail !== "no blocking overlay") {
        clicked = await el.click({ timeout: 8000 }).then(() => true).catch(() => false);
      } else if (!overlay.cleared) {
        return finish(`Action failed: element ${id} is ${overlay.detail}.`);
      }
    }
    if (!clicked) return finish(`Action failed: element ${id} could not be clicked.`);
    await this.settle();
    return finish(`Clicked element ${id}.`);
  }

  async typeText(id: number, text: string, submit: boolean): Promise<string> {
    const started = Date.now();
    const beforeUrl = this.page.url();
    const identified = this.lastElements.get(id);
    const finish = (detail: string) => this.tracedAction(started, {
      action: "fill", role: identified?.role || identified?.tag, name: identified?.name || identified?.placeholder,
      value: text, elementId: id, beforeUrl,
    }, detail);
    const el = this.page.locator(`[data-aidan-id="${id}"]`).first();
    if ((await el.count()) === 0) return finish(`No element with id ${id} to type into.`);
    await el.click({ timeout: 8000 }).catch(() => {});
    let filled = await el.fill(text, { timeout: 8000 }).then(() => true).catch(() => false);
    if (!filled) filled = await el.type(text, { timeout: 8000 }).then(() => true).catch(() => false);
    if (!filled) return finish(`Action failed: element ${id} did not accept text.`);
    if (submit) await this.page.keyboard.press("Enter").catch(() => {});
    await this.settle();
    return finish(`Typed "${text}" into element ${id}${submit ? " and submitted" : ""}.`);
  }

  async scroll(direction: "up" | "down"): Promise<string> {
    const started = Date.now();
    const beforeUrl = this.page.url();
    await this.page.mouse.wheel(0, direction === "down" ? 600 : -600);
    await this.page.waitForTimeout(300);
    return this.tracedAction(started, { action: "scroll", value: direction, beforeUrl }, `Scrolled ${direction}.`);
  }

  // ---- Durable, role/text-based actions (used to REPLAY recorded journeys) ----
  // Per-snapshot element ids are not stable across sessions; recorded journeys
  // must address elements the way a human describes them, so they survive
  // redesigns and re-runs.

  private locate(role: string, name: string) {
    const byRole = this.page.getByRole(role as any, { name, exact: false }).first();
    return { byRole, byText: this.page.getByText(name, { exact: false }).first(), byPlaceholder: this.page.getByPlaceholder(name, { exact: false }).first() };
  }

  /**
   * Resolve an element by role + accessible name, with fallbacks.
   *
   * Unlabelled controls (very common for <select>) have no accessible name, so
   * the snapshot falls back to a synthetic one from data-test/name/id. Those
   * cannot be found via getByRole, hence the attribute-based lookups here —
   * the recorder and the resolver must agree on what "name" means.
   */
  /**
   * How long to keep looking for a recorded control before calling it absent.
   *
   * Replay resolves by role+name against whatever is on screen the instant the
   * previous step returned, and `settle()` returns when the network quiets —
   * which on a real app is before the view has finished rendering. A control
   * that takes another second to mount was therefore reported NOT_FOUND, and a
   * journey that works when a human does it failed verification for a reason
   * that had nothing to do with the journey. Polling costs nothing when the
   * element is already there.
   */
  private static readonly RESOLVE_WAIT_MS = Number(process.env.STEP_RESOLVE_WAIT_MS ?? 3000);

  private async resolve(role: string, name: string, testId?: string) {
    const deadline = Date.now() + LiveBox.RESOLVE_WAIT_MS;
    for (;;) {
      const found = await this.resolveOnce(role, name, testId);
      if (found || Date.now() >= deadline) return found;
      await this.page.waitForTimeout(250).catch(() => {});
    }
  }

  private async resolveOnce(role: string, name: string, testId?: string) {
    /*
     * A recorded test hook wins over the label.
     *
     * The accessible name is the right thing to SHOW, and the wrong thing to
     * depend on when it carries the account's data: llmapi.ai's header renders
     * button "Default Organization", which is that tenant's org name and matches
     * nothing in a customer's account. `data-testid` is put there by the
     * product's own developers precisely so it survives copy changes,
     * localisation and redesigns.
     */
    if (testId) {
      const t = testId.replace(/"/g, '\\"');
      const byTestId = this.page.locator(`[data-testid="${t}"], [data-test="${t}"], [data-cy="${t}"], [data-qa="${t}"]`).first();
      if ((await byTestId.count().catch(() => 0)) > 0) return byTestId;
    }
    const { byRole, byText, byPlaceholder } = this.locate(role, name);
    const esc = name.replace(/"/g, '\\"');
    const byAttr = this.page.locator(
      `[data-test="${esc}"], [name="${esc}"], [id="${esc}"], [aria-label="${esc}"], [data-testid="${esc}"]`,
    ).first();
    // Native and custom dropdowns frequently expose no accessible label, while
    // their selected option is visible inside the control. Target the control
    // itself by that selected text; unlike a page-wide text fallback this can
    // never return the adjacent <label> and pretend it accepted a value.
    const byControlText = this.page.locator('select, [role="combobox"]').filter({ hasText: name }).first();
    // Text on a <label> is not the textbox it describes. Returning it made fill()
    // fail silently while the workflow log claimed success. Text fallback is
    // useful for click targets, but never for controls that must accept a value.
    const candidates = /^(textbox|combobox|switch|slider|spinbutton)$/i.test(role)
      ? [byRole, byAttr, byPlaceholder, byControlText]
      : [byRole, byAttr, byPlaceholder, byText];
    for (const cand of candidates) {
      if ((await cand.count().catch(() => 0)) > 0) return cand;
    }
    return null;
  }

  async clickByRole(role: string, name: string, testId?: string): Promise<string> {
    const started = Date.now();
    const beforeUrl = this.page.url();
    const finish = (detail: string) => this.tracedAction(started, { action: "click", role, name, beforeUrl }, detail);
    const el = await this.resolve(role, name, testId);
    if (!el) return finish(`NOT_FOUND: no ${role} named "${name}"`);
    if (!(await el.isEnabled().catch(() => true))) return finish(`error: ${role} "${name}" is disabled`);
    await el.scrollIntoViewIfNeeded().catch(() => {});
    let clicked = await el.click({ timeout: 8000 }).then(() => true).catch(() => false);
    // See clickElement: clear the obstruction rather than forcing through it.
    if (!clicked) {
      const overlay = await this.clearBlockingOverlay();
      if (overlay.cleared && overlay.detail !== "no blocking overlay") {
        clicked = await el.click({ timeout: 8000 }).then(() => true).catch(() => false);
      } else if (!overlay.cleared) {
        return finish(`error: ${role} "${name}" is ${overlay.detail}`);
      }
    }
    if (!clicked) return finish(`error: ${role} "${name}" could not be clicked`);
    await this.settle();
    return finish(`clicked ${role} "${name}"${this.takeTabNotice()}`);
  }

  async fillByRole(role: string, name: string, value: string, submit = false, testId?: string): Promise<string> {
    const started = Date.now();
    const beforeUrl = this.page.url();
    const finish = (detail: string) => this.tracedAction(started, { action: "fill", role, name, value, beforeUrl }, detail);
    const el = await this.resolve(role, name, testId);
    if (!el) return finish(`NOT_FOUND: no ${role} named "${name}"`);
    await el.click({ timeout: 8000 }).catch(() => {});
    let filled = await el.fill(value, { timeout: 8000 }).then(() => true).catch(() => false);
    if (!filled) filled = await el.type(value, { timeout: 8000 }).then(() => true).catch(() => false);
    if (!filled) return finish(`error: ${role} "${name}" did not accept text`);
    const observed = await el.inputValue().catch(() => "");
    if (observed !== value) return finish(`error: ${role} "${name}" contains "${observed}" after fill, expected "${value}"`);
    if (submit) await this.page.keyboard.press("Enter").catch(() => {});
    await this.settle();
    return finish(`filled ${role} "${name}" with "${value}"`);
  }

  /** Choose an option in a <select> — by visible label, falling back to value. */
  async selectByRole(role: string, name: string, option: string, testId?: string): Promise<string> {
    const started = Date.now();
    const beforeUrl = this.page.url();
    const finish = (detail: string) => this.tracedAction(started, { action: "select", role, name, value: option, beforeUrl }, detail);
    const el = await this.resolve(role || "combobox", name, testId);
    if (!el) return finish(`NOT_FOUND: no ${role} named "${name}"`);

    // Native <select> first — cheapest and exact.
    const ok = await el.selectOption({ label: option }, { timeout: 4000 }).then(() => true).catch(() => false);
    if (ok || (await el.selectOption(option, { timeout: 4000 }).then(() => true).catch(() => false))) {
      await this.settle();
      return finish(`selected "${option}" in ${role} "${name}"`);
    }

    // Otherwise it is a custom widget. See openCustomCombobox for why this matters.
    const custom = await this.openCustomCombobox(el, option);
    if (custom) {
      await this.settle();
      return finish(`selected "${option}" in ${role} "${name}"`);
    }
    return finish(`NOT_FOUND: option "${option}" not in ${role} "${name}"`);
  }

  /** Generic workflow primitives. They reuse the same semantic resolver as
   * recorded journeys, so less-common interactions do not create a hidden
   * product-specific selector path. */
  async pressKey(key: string): Promise<string> {
    const started = Date.now();
    const beforeUrl = this.page.url();
    await this.page.keyboard.press(key, { delay: 20 });
    await this.settle();
    return this.tracedAction(started, { action: "keypress", value: key, beforeUrl }, `pressed ${key}`);
  }

  async hoverByRole(role: string, name: string): Promise<string> {
    const started = Date.now(); const beforeUrl = this.page.url();
    const finish = (detail: string) => this.tracedAction(started, { action: "hover", role, name, beforeUrl }, detail);
    const el = await this.resolve(role, name);
    if (!el) return finish(`NOT_FOUND: no ${role} named "${name}"`);
    await el.hover({ timeout: 8000 });
    await this.page.waitForTimeout(100);
    return finish(`hovered ${role} "${name}"`);
  }

  async dragByRole(sourceRole: string, sourceName: string, targetRole: string, targetName: string): Promise<string> {
    const started = Date.now(); const beforeUrl = this.page.url();
    const finish = (detail: string) => this.tracedAction(started, { action: "drag", role: sourceRole, name: `${sourceName} → ${targetRole} "${targetName}"`, beforeUrl }, detail);
    const source = await this.resolve(sourceRole, sourceName);
    const target = await this.resolve(targetRole, targetName);
    if (!source) return finish(`NOT_FOUND: no ${sourceRole} named "${sourceName}"`);
    if (!target) return finish(`NOT_FOUND: no ${targetRole} named "${targetName}"`);
    await source.dragTo(target, { timeout: 10_000 });
    await this.settle();
    return finish(`dragged ${sourceRole} "${sourceName}" to ${targetRole} "${targetName}"`);
  }

  async uploadByRole(role: string, name: string, paths: string[]): Promise<string> {
    const started = Date.now(); const beforeUrl = this.page.url();
    const finish = (detail: string) => this.tracedAction(started, { action: "upload", role, name, value: `${paths.length} file(s)`, beforeUrl }, detail);
    const el = await this.resolve(role, name);
    if (!el) return finish(`NOT_FOUND: no ${role} named "${name}"`);
    await el.setInputFiles(paths, { timeout: 10_000 });
    await this.settle();
    return finish(`uploaded ${paths.length} file(s) through ${role} "${name}"`);
  }

  async downloadByRole(role: string, name: string): Promise<string> {
    const started = Date.now(); const beforeUrl = this.page.url();
    const finish = (detail: string) => this.tracedAction(started, { action: "download", role, name, beforeUrl }, detail);
    const el = await this.resolve(role, name);
    if (!el) return finish(`NOT_FOUND: no ${role} named "${name}"`);
    const download = await Promise.all([
      this.page.waitForEvent("download", { timeout: 15_000 }),
      el.click({ timeout: 8000 }),
    ]).then(([value]) => value);
    return finish(`downloaded "${download.suggestedFilename()}"`);
  }

  async elementVisible(role: string, name: string): Promise<boolean> {
    const el = await this.resolve(role, name);
    return !!el && (await el.isVisible().catch(() => false));
  }

  async waitForTextState(text: string, present: boolean, timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    do {
      if ((await this.hasText(text)) === present) return true;
      await this.page.waitForTimeout(100);
    } while (Date.now() < deadline);
    return false;
  }

  /**
   * Drive a dropdown that is not a <select>.
   *
   * Measured on OrangeHRM, and true of every mainstream component library (Ant,
   * MUI, Radix, PrimeVue, Headless UI): the trigger is a plain <div> that carries
   * no ARIA at all, so `selectOption` cannot touch it — and this alone cost us the
   * Leave and Recruitment journeys, two of the most demo-worthy workflows in an
   * HRIS. What IS reliably standard is the popup: options render as
   * `[role="option"]` (usually inside `[role="listbox"]`). So: click to open, wait
   * for options, click the matching one.
   *
   * Returns false rather than throwing so the caller can report a clean NOT_FOUND.
   */
  private async openCustomCombobox(trigger: any, option: string): Promise<boolean> {
    await trigger.scrollIntoViewIfNeeded().catch(() => {});
    await trigger.click({ timeout: 6000 }).catch(() => {});

    /*
     * Standard ARIA only — no product-specific class names. Anything keyed to one
     * app's CSS is a hidden per-customer integration, which is the opposite of
     * plug-and-play. `[role="option"]` is what every component library emits;
     * the class fallback is a generic pattern, not a particular vendor's.
     */
    const OPTION_SEL = '[role="option"], [role="listbox"] li, [class*="option" i]:not([class*="options" i])';
    const opts = this.page.locator(OPTION_SEL);
    // The popup is rendered asynchronously; without this the first read finds none.
    const appeared = await opts
      .first()
      .waitFor({ state: "visible", timeout: 4000 })
      .then(() => true)
      .catch(() => false);
    if (!appeared) return false;

    const wanted = option.trim().toLowerCase();
    const n = Math.min(await opts.count(), 60);
    let fallback = -1;
    for (let i = 0; i < n; i++) {
      const text = ((await opts.nth(i).innerText().catch(() => "")) || "").trim().toLowerCase();
      if (!text) continue;
      if (text === wanted) {
        await opts.nth(i).click({ timeout: 4000 }).catch(() => {});
        return true;
      }
      // Remember a partial match, but prefer an exact one — "Pending" must not win
      // over "Pending Approval" just because it was listed first.
      if (fallback < 0 && (text.includes(wanted) || wanted.includes(text))) fallback = i;
    }
    if (fallback >= 0) {
      await opts.nth(fallback).click({ timeout: 4000 }).catch(() => {});
      return true;
    }
    // Close the popup we opened, so a failed select does not leave the page in a
    // state the next step has to cope with.
    await this.page.keyboard.press("Escape").catch(() => {});
    return false;
  }

  /** Select an option using the per-snapshot element id (used while exploring). */
  async selectOptionById(id: number, option: string): Promise<string> {
    const started = Date.now(); const beforeUrl = this.page.url();
    const identified = this.lastElements.get(id);
    const finish = (detail: string) => this.tracedAction(started, {
      action: "select", role: identified?.role || identified?.tag,
      name: identified?.name || identified?.placeholder, value: option, elementId: id, beforeUrl,
    }, detail);
    const el = this.page.locator(`[data-aidan-id="${id}"]`).first();
    if ((await el.count()) === 0) return finish(`No element with id ${id}.`);
    const ok = await el.selectOption({ label: option }, { timeout: 6000 }).then(() => true).catch(() => false);
    if (!ok && !(await el.selectOption(option, { timeout: 6000 }).then(() => true).catch(() => false)))
      return finish(`Could not select "${option}".`);
    await this.settle();
    return finish(`selected "${option}"`);
  }

  /**
   * Reset to a clean DATA state, not just a clean browser.
   *
   * "Fresh browser" ≠ "clean data": carts, drafts and filters live in cookies /
   * localStorage and survive a new session, which lets a verification pass
   * without the journey having done anything. Clear them, then re-authenticate.
   */
  async resetState(): Promise<void> {
    /*
     * A browser that has only just started IS the clean state.
     *
     * start() already authenticates and navigates to startUrl, and every caller
     * then opens with resetState() — which cleared the freshly-restored session
     * and navigated to the page it was already on. Measured on llmapi.ai: 2.8s
     * per exploration job spent going from /dashboard to /dashboard, on top of
     * the 6.1s the browser took to start, for a job whose useful work was 7.2s.
     */
    if (this.pristine && this.page.url() === this.target.startUrl) return;
    this.pristine = false;
    // Tabs opened by the previous job are part of the state being reset.
    await this.closeExtraTabs();
    await this.context.clearCookies().catch(() => {});
    await this.page
      .evaluate(`(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} })()`)
      .catch(() => {});
    /*
     * ...but clearing cookies also signs us OUT, and for an SSO product there is
     * no login form to recover with — loginIfNeeded() has nothing to type. Left
     * unhandled, every verification would run as an anonymous visitor and the
     * postconditions would fail for a reason that has nothing to do with the
     * journey. So put the authenticated baseline back before navigating.
     */
    await this.reapplyAuthBaseline();
    await this.gotoStart();
  }

  /**
   * Restore the pristine signed-in state captured at sign-in time.
   *
   * The baseline is snapshotted immediately after the human authenticates, before
   * any demo activity, which is exactly what "clean data, still signed in" means.
   */
  private async reapplyAuthBaseline(): Promise<void> {
    const auth = this.target.auth;
    if (auth.mode !== "session" && auth.mode !== "profile") return;
    if (!auth.sessionState) {
      console.warn(`[livebox] ${auth.mode} auth has no captured baseline — reset will run signed out`);
      return;
    }
    let state: any;
    try {
      state = JSON.parse(auth.sessionState);
    } catch (e) {
      console.warn("[livebox] auth baseline is unreadable:", (e as Error).message);
      return;
    }
    if (Array.isArray(state.cookies) && state.cookies.length) {
      await this.context.addCookies(state.cookies).catch((e) => console.warn("[livebox] could not restore cookies:", e.message));
    }
    // localStorage can only be written from its own origin, so it is restored
    // after navigation (see gotoStart → restoreOriginStorage).
    this.pendingOriginStorage = Array.isArray(state.origins) ? state.origins : [];
  }

  /** origins from the auth baseline still waiting to be written after navigation */
  private pendingOriginStorage: { origin: string; localStorage?: { name: string; value: string }[] }[] = [];

  /**
   * Write back any localStorage the auth baseline holds for the current origin.
   * Some apps keep their access token there rather than in a cookie, so skipping
   * this would leave us cookie-authenticated but token-less.
   */
  private async restoreOriginStorage(): Promise<void> {
    if (!this.pendingOriginStorage.length) return;
    let current = "";
    try {
      current = new URL(this.page.url()).origin;
    } catch {
      return;
    }
    const match = this.pendingOriginStorage.find((o) => o.origin === current);
    if (!match?.localStorage?.length) return;
    this.pendingOriginStorage = this.pendingOriginStorage.filter((o) => o !== match);

    /*
     * The payload is inlined rather than passed as an argument: evaluate() only
     * binds arguments for a real function, and this codebase passes page scripts
     * as strings, where the argument is silently dropped. That is exactly how this
     * failed the first time — `items` was undefined, the in-page catch returned 0,
     * and the restore reported success while writing nothing.
     * It is percent-encoded rather than embedded as raw JSON because stored values
     * are arbitrary text: a quote, a backslash or a U+2028 line separator would
     * otherwise terminate the literal or break the parse. encodeURIComponent emits
     * plain ASCII containing none of those, so the expression is always well-formed
     * and no invisible character has to survive in this source file.
     */
    const payload = encodeURIComponent(JSON.stringify(match.localStorage));
    const wrote = await this.page
      .evaluate(
        `(() => {
          try {
            const items = JSON.parse(decodeURIComponent("${payload}"));
            for (const it of items) localStorage.setItem(it.name, it.value);
            return items.length;
          } catch (e) { return "error: " + e.message; }
        })()`,
      )
      .catch((e) => `error: ${e.message}`);

    if (typeof wrote === "string") {
      console.warn(`[livebox] could not restore localStorage for ${current}: ${wrote}`);
      return;
    }
    // The app already booted without these values — reload so it reads them.
    if (Number(wrote) > 0) await this.page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  }

  /**
   * Replay a recorded journey program deterministically (durable selectors).
   * This is how a VERIFIED journey is executed at demo time — no model in the
   * loop, so it is fast, cheap and reproducible. Stops at the first failure and
   * reports it, so the caller can fall back to improvising.
   */
  async runProgram(
    steps: { action: string; role?: string; name?: string; testId?: string; value?: string; submit?: boolean; url?: string; direction?: string; say?: string; optional?: boolean }[],
    /**
     * Called BEFORE each step. This is what lets Aidan narrate a journey the way
     * a person would ("now I'll open the cart…") instead of going silent for six
     * steps and then reporting. Essential once TTS is speaking the narration.
     */
    onStep?: (i: number, step: { say?: string }, total: number) => void | Promise<void>,
    /** Pause between steps so a spoken line has time to land. */
    stepDelayMs = 0,
    /**
     * Checked before every step. Returning true stops cleanly and reports the
     * index, so an interrupted walkthrough can be RESUMED from there rather than
     * restarted or abandoned.
     */
    shouldStop?: () => boolean,
    /** Resume support: begin at this index instead of 0. */
    startAt = 0,
  ): Promise<{ ok: boolean; ran: number; log: string[]; error?: string; stoppedAt?: number; interrupted?: boolean }> {
    const log: string[] = [];
    for (let i = startAt; i < steps.length; i++) {
      const s = steps[i];
      if (shouldStop?.()) return { ok: false, ran: i - startAt, log, interrupted: true, stoppedAt: i };
      if (onStep) await onStep(i, s, steps.length);
      if (shouldStop?.()) return { ok: false, ran: i - startAt, log, interrupted: true, stoppedAt: i };
      if (stepDelayMs > 0 && i > 0) await this.page.waitForTimeout(stepDelayMs).catch(() => {});
      /*
       * Gate EVERY replayed step, not just the ones an explorer proposes live.
       *
       * checkAction was called only by the explorer and the surveyor, so a step
       * became permanently trusted the moment it was written down: the verifier,
       * the minimiser and every demo replay executed stored programs without
       * consulting it. A journey recorded before a rule tightened — or one that
       * slipped through a gap in the rules, as a bare navigate once did — then
       * kept running forever. Safety belongs at the execution layer, which is
       * here.
       */
      const verdict = checkAction(
        { action: s.action, role: s.role, name: s.name, value: s.value, url: s.url },
        { originAllowlist: [this.origin()], allow: this.allowedActions },
      );
      if (!verdict.allowed) {
        const refused = `error: step ${i + 1} refused by safety policy — ${verdict.reason}`;
        log.push(`${i + 1}. ${refused}`);
        return { ok: false, ran: i - startAt, log, error: refused, stoppedAt: i };
      }
      let out = "";
      try {
        if (s.action === "click") out = await this.clickByRole(s.role || "button", s.name || "", s.testId);
        else if (s.action === "fill") out = await this.fillByRole(s.role || "textbox", s.name || "", s.value ?? "", s.submit, s.testId);
        else if (s.action === "select") out = await this.selectByRole(s.role || "combobox", s.name || "", s.value ?? "", s.testId);
        else if (s.action === "navigate" && s.url) { await this.goto(s.url); out = `opened ${s.url}`; }
        else if (s.action === "scroll") out = await this.scroll(s.direction === "up" ? "up" : "down");
        else out = `skipped unknown action ${s.action}`;
      } catch (e) {
        out = `error: ${(e as Error).message}`;
      }
      /*
       * An optional step that is not there is not a failure.
       *
       * NOT_FOUND is the expected outcome for a dialog that has already been
       * dismissed — that is the whole reason the step is marked optional. A
       * genuine `error:` (present but disabled, obscured, unclickable) is still
       * a failure, because the thing IS on screen and the journey could not get
       * past it.
       */
      if (s.optional && out.startsWith("NOT_FOUND")) {
        log.push(`${i + 1}. skipped optional step (${s.name ?? s.action} is not present on this run)`);
        continue;
      }
      log.push(`${i + 1}. ${out}`);
      if (out.startsWith("NOT_FOUND") || out.startsWith("error:")) {
        return { ok: false, ran: i - startAt, log, error: `step ${i + 1} failed: ${out}`, stoppedAt: i };
      }
    }
    return { ok: true, ran: steps.length - startAt, log };
  }

  /**
   * Ordered signature of the largest repeated list on screen. Sorting and
   * filtering change the ORDER (or membership) of items rather than adding new
   * text, so this is what makes those journeys verifiable at all.
   */
  async listSignature(): Promise<string> {
    return (await this.page
      .evaluate(`(() => {
        // Find the container with the most same-tag/class children — the "list".
        let best = { score: 0, items: [] };
        for (const parent of document.querySelectorAll('ul, ol, tbody, div, section')) {
          const kids = [...parent.children].filter(k => k.getBoundingClientRect().height > 8);
          if (kids.length < 3) continue;
          const sig = kids.map(k => k.tagName + '.' + (k.className || ''));
          const uniform = new Set(sig).size <= Math.max(2, Math.ceil(kids.length * 0.34));
          if (!uniform) continue;
          // NOTE: fromCharCode(10), not a '\\n' literal — this script lives in a TS template
          // literal where an escaped newline becomes a REAL newline and breaks the
          // injected JS (previously swallowed by .catch() as an empty list).
          const items = kids.map(k => (k.innerText || '').trim().split(String.fromCharCode(10))[0].slice(0, 40)).filter(Boolean);
          if (items.length > best.score) best = { score: items.length, items };
        }
        return best.items.join(' | ');
      })()`)
      .catch((e) => { console.warn(`  ! listSignature failed: ${(e as Error).message}`); return ""; })) as string;
  }

  /**
   * Everything the page says, INCLUDING what its iframes say.
   *
   * `document.body.innerText` stops at the iframe boundary, so any surface a
   * product embeds — a doc viewer, an editor, an embedded console, a
   * third-party widget — was invisible to every text-based check here. That is
   * worse than it sounds for this codebase specifically: proof selection and
   * postcondition verification are both differential text checks, so a journey
   * that genuinely succeeded INSIDE an iframe produced no observable evidence
   * and was recorded as broken. The agent could neither prove it nor explain
   * why.
   *
   * Cross-origin frames throw on evaluate and are skipped rather than fataled —
   * we get what the browser lets us have, which is the same-origin content that
   * belongs to the product.
   */
  private async allFramesText(): Promise<string> {
    const frames = this.page.frames();
    const parts = await Promise.all(
      frames.map((frame) =>
        frame
          .evaluate(`document.body ? document.body.innerText : ""`)
          .catch(() => "") as Promise<string>,
      ),
    );
    return parts.filter((part) => part && part.trim()).join("\n");
  }

  /** Postcondition check: is this text visible on screen? */
  async hasText(text: string): Promise<boolean> {
    const haystack = (await this.allFramesText()).toLowerCase();
    if (haystack.includes(text.toLowerCase())) return true;
    /*
     * Retry ignoring digits. On a LIVE product the counts move ("Favorite Article
     * (2196)" → "(2197)") between recording a journey and verifying it, which
     * failed journeys that were actually fine. The wording still has to match.
     */
    const loose = text.replace(/\d+/g, "").replace(/\s+/g, " ").trim().toLowerCase();
    if (loose.length < 6) return false;
    return haystack.replace(/[0-9]+/g, "").replace(/\s+/g, " ").includes(loose);
  }

  /** Full visible text — used by the Verifier and Semanticist. */
  async visibleText(limit = 2000): Promise<string> {
    return (await this.allFramesText()).slice(0, limit);
  }

  /**
   * Text belonging to TRANSIENT UI only — dialogs, menus, listboxes, tooltips.
   *
   * Exists so proof selection can refuse it. A first-visit onboarding modal is
   * genuinely new text on the destination screen, so it satisfies the
   * differential gate perfectly while proving nothing: llmapi.ai's Guardrails
   * page opened a "Read the docs / Got it / Close" tooltip, and the journey was
   * recorded as verified with the postcondition "Got it" — the label on a
   * dismiss button. Worse, that modal only appears on a FIRST visit, so the
   * journey could never replay for a returning user.
   *
   * Deliberately EXCLUDES `role="alert"` and `role="status"`. Those are live
   * regions — the confirmation toast a save produces — and are frequently the
   * only evidence an enterprise screen offers. The verifier already polls for
   * exactly that. What is disqualified here is dismissible chrome: dialogs,
   * menus, listboxes and tooltips, which describe themselves rather than any
   * outcome.
   */
  async overlayText(limit = 4000): Promise<string> {
    const t = (await this.page
      .evaluate(`(() => {
        var sel = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], [role="menu"], [role="listbox"], [role="tooltip"]';
        return [...document.querySelectorAll(sel)].map(function (n) { return n.innerText || ''; }).join(String.fromCharCode(10));
      })()`)
      .catch(() => "")) as string;
    return (t || "").slice(0, limit);
  }

  /** Language-independent form evidence: native invalidity and ARIA error semantics. */
  async validationEvidence(): Promise<string[]> {
    return (await this.page.evaluate(`(() => {
      var nodes = [...document.querySelectorAll(':invalid,[aria-invalid="true"],[role="alert"],[aria-errormessage]')];
      return [...new Set(nodes.flatMap(function (node) {
        var linked = node.getAttribute && node.getAttribute('aria-errormessage');
        var linkedText = linked ? (document.getElementById(linked)?.innerText || '') : '';
        var nativeMessage = typeof node.validationMessage === 'string' ? node.validationMessage : '';
        return [nativeMessage, linkedText, node.innerText || node.textContent || ''].map(function (v) { return String(v || '').trim(); }).filter(Boolean);
      }))].slice(0, 12);
    })()`).catch(() => [])) as string[];
  }

  // ---- Human takeover (input forwarded from the live view) ----

  /**
   * Perform the prospect's click AND observe it: what they hit, and whether
   * anything actually happened (a "dead click" is a top frustration signal).
   */
  async userClick(fx: number, fy: number): Promise<{ target: string; changed: boolean }> {
    const started = Date.now(); const beforeUrl = this.page.url();
    const x = fx * this.W;
    const y = fy * this.H;
    const target = await this.describeAt(x, y);
    const before = await this.pageSignature();
    let actionError = "";
    await this.page.mouse.click(x, y).catch((error) => { actionError = (error as Error).message; });
    if (!actionError) await this.settle().catch((error) => { actionError = (error as Error).message; });
    const after = await this.pageSignature();
    const result = { target, changed: before !== after };
    this.tracedAction(started, { action: "human_click", name: target, value: `${Math.round(x)},${Math.round(y)}`, beforeUrl },
      actionError ? `error: ${actionError}` : `clicked ${target || "screen"}; screen ${result.changed ? "changed" : "did not change"}`);
    return result;
  }

  /**
   * Which SNAPSHOT-TAGGED element is under this point?
   *
   * This is how a human's click becomes a durable step. It deliberately resolves
   * through `data-aidan-id` — the tag `snapshot()` applies — instead of deriving
   * a name from the DOM here, because the recorder and the resolver must agree on
   * what "name" means. `describeAt()` below looks similar but names
   * innerText-first, which is precisely the disagreement that has produced
   * unreplayable steps before. Do not use that one for recording.
   */
  async identifyAt(fx: number, fy: number): Promise<{ id: number; value: string } | null> {
    const x = Math.round(fx * this.W);
    const y = Math.round(fy * this.H);
    const out = (await this.page
      .evaluate(
        `(() => {
          var el = document.elementFromPoint(${x}, ${y});
          if (!el) return null;
          var n = el;
          while (n && !(n.getAttribute && n.getAttribute('data-aidan-id'))) n = n.parentElement;
          if (!n) return null;
          var v = (n.value === undefined || n.value === null) ? '' : String(n.value);
          return { id: Number(n.getAttribute('data-aidan-id')), value: v };
        })()`,
      )
      .catch((e) => {
        console.warn(`[livebox] identifyAt failed: ${(e as Error).message}`);
        return null;
      })) as { id: number; value: string } | null;
    return out && Number.isFinite(out.id) ? out : null;
  }

  /**
   * Would a durable selector find this element right now?
   *
   * Used at RECORD time, not replay time. A recorded step whose selector cannot
   * be resolved is worthless, and finding that out during verification burns a
   * full replay and then reports "this journey is broken" when in fact the
   * recording was. Checking on the spot turns that into a fixable observation.
   */
  async canResolve(role: string, name: string): Promise<boolean> {
    if (!role || !name) return false;
    const el = await this.resolve(role, name);
    if (!el) return false;
    return (await el.count().catch(() => 0)) > 0;
  }

  /**
   * MEASURED centre of a snapshot-tagged element, in the fractional coordinates
   * `userClick` expects.
   *
   * Exists so tests and scripts never guess where a control is. A guessed
   * fraction silently lands on `<body>`, the click "succeeds", nothing happens,
   * and the test then proves something entirely different from what it claims —
   * which has already cost real debugging time here more than once.
   */
  async boxOfElement(id: number): Promise<{ cx: number; cy: number } | null> {
    const r = (await this.page
      .evaluate(
        `(() => {
          var e = document.querySelector('[data-aidan-id="${id}"]');
          if (!e) return null;
          var b = e.getBoundingClientRect();
          if (!b || b.width === 0 || b.height === 0) return null;
          return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        })()`,
      )
      .catch((e) => {
        console.warn(`[livebox] boxOfElement failed: ${(e as Error).message}`);
        return null;
      })) as { x: number; y: number } | null;
    if (!r) return null;
    return { cx: r.x / this.W, cy: r.y / this.H };
  }

  /**
   * Current value of a snapshot-tagged field.
   *
   * Typed input is flushed by READING the field, never by replaying the
   * keystrokes we saw — that way backspaces, autocomplete, IME composition and
   * password-manager pastes all land correctly for free.
   */
  async valueOfElement(id: number): Promise<string> {
    return (await this.page
      .evaluate(
        `(() => { var e = document.querySelector('[data-aidan-id="${id}"]'); return (e && e.value !== undefined && e.value !== null) ? String(e.value) : ''; })()`,
      )
      .catch(() => "")) as string;
  }

  /** Semantic enrichment: what is at this point? ("button 'Export'" beats "(0.42,0.31)"). */
  async describeAt(x: number, y: number): Promise<string> {
    return (await this.page
      .evaluate(
        ([px, py]: number[]) => {
          const el = document.elementFromPoint(px, py) as HTMLElement | null;
          if (!el) return "empty space";
          const interactive = (el.closest('a,button,input,textarea,select,[role="button"],[role="link"],[role="checkbox"]') as HTMLElement) || el;
          const label =
            (interactive.innerText || "").trim().slice(0, 60) ||
            interactive.getAttribute("aria-label") ||
            interactive.getAttribute("placeholder") ||
            interactive.getAttribute("title") ||
            "";
          const tag = interactive.tagName.toLowerCase();
          const role = interactive.getAttribute("role") || "";
          return `${tag}${role ? `[${role}]` : ""}${label ? ` "${label}"` : ""}`;
        },
        [x, y],
      )
      .catch(() => "unknown")) as string;
  }

  /**
   * Cheap fingerprint of the current screen — used to detect "nothing happened".
   * Must include focus and field values: clicking an input to focus it is a
   * productive action that changes no text and no element count, and would
   * otherwise be misread as a dead click.
   */
  async pageSignature(): Promise<string> {
    return (await this.page
      .evaluate(
        `(() => {
          const a = document.activeElement;
          const focus = a ? a.tagName + (a.getAttribute('placeholder') || a.getAttribute('aria-label') || a.className || '') : 'none';
          const values = [...document.querySelectorAll('input,textarea,select')].map(e => e.value || e.checked || '').join('~');
          return [location.href, document.body.innerText.length, document.querySelectorAll('*').length, focus, values, window.scrollY].join('|');
        })()`,
      )
      .catch(() => "")) as string;
  }

  async userWheel(dy: number): Promise<void> {
    const started = Date.now(); const beforeUrl = this.page.url();
    let actionError = "";
    await this.page.mouse.wheel(0, dy).catch((error) => { actionError = (error as Error).message; });
    this.tracedAction(started, { action: "human_scroll", value: String(dy), beforeUrl }, actionError ? `error: ${actionError}` : `scrolled ${dy}px`);
  }

  async userKey(key: string, text: string, modifiers: string[] = []): Promise<void> {
    const started = Date.now(); const beforeUrl = this.page.url();
    const focused = await this.focusedDescription();
    // Chords (Cmd+A, Ctrl+V…) must be pressed as a combination, not typed.
    if (modifiers.length) {
      const combo = [...modifiers, key.length === 1 ? key.toUpperCase() : key].join("+");
      let actionError = "";
      await this.page.keyboard.press(combo).catch((error) => { actionError = (error as Error).message; });
      this.tracedAction(started, { action: "human_keypress", name: focused, value: combo, beforeUrl }, actionError ? `error: ${actionError}` : `pressed ${combo}`);
      return;
    }
    let actionError = "";
    if (text && text.length === 1) await this.page.keyboard.type(text).catch((error) => { actionError = (error as Error).message; });
    else await this.page.keyboard.press(key).catch((error) => { actionError = (error as Error).message; });
    this.tracedAction(started, { action: "human_keypress", name: focused, value: text || key, beforeUrl },
      actionError ? `error: ${actionError}` : `entered ${text || key} in ${focused || "the page"}`);
  }

  /**
   * Insert a whole string at once. Typing character-by-character over a websocket
   * is lossy and slow for anything long, and password managers paste rather than
   * type — so pasting has to be a first-class action.
   */
  async userPaste(text: string): Promise<void> {
    if (!text) return;
    const started = Date.now(); const beforeUrl = this.page.url();
    const focused = await this.focusedDescription();
    let actionError = "";
    await this.page.keyboard.insertText(text).catch((error) => { actionError = (error as Error).message; });
    this.tracedAction(started, { action: "human_paste", name: focused, value: text, beforeUrl },
      actionError ? `error: ${actionError}` : `pasted text into ${focused || "the page"}`);
  }

  // ---- Eyes ----

  /**
   * @param withScreenshot capture pixels too. Skip it when the caller will not
   * send them: the capture itself costs real time (it waits for fonts, and is
   * capped at SCREENSHOT_TIMEOUT_MS precisely because that can hang), so taking
   * one and discarding it is pure latency in a spoken conversation.
   */
  async snapshot(withScreenshot = true): Promise<PageSnapshot> {
    const started = Date.now();
    /*
     * A dead page must never look like an empty one.
     *
     * When the tab this box drives is closed, evaluate() rejects, the element
     * list degrades to [] and innerText to "" — and the result is a perfectly
     * well-formed snapshot of a blank screen. The explorer reads
     * "Controls: (none)", concludes the product offers nothing, and calls
     * give_up. That is how a single closed tab was reported as twenty-two
     * separate "no controls are available" journey failures, with the real
     * cause visible only as a browser.navigate error nobody was reading.
     *
     * Recover if another live tab exists; otherwise fail loudly. An unusable
     * browser is an infrastructure fault, not a verdict about the product.
     */
    if (this.page.isClosed()) {
      const survivor = this.context.pages().find((p) => !p.isClosed());
      if (!survivor) {
        throw new Error("browser page is closed — the session is unusable, so no screen can be read");
      }
      this.page = survivor;
      this.mainPage ??= survivor;
    }
    // Do NOT swallow this: a failing element script means the agent is blind, and a
    // silent empty list looks identical to "an empty page".
    let elementScanError = "";
    const elements = (await this.page.evaluate(tagElementsScript()).catch((e) => {
      elementScanError = String((e as Error).message).slice(0, 500);
      return [];
    })) as PageElement[];
    /*
     * The screenshot is an ENHANCEMENT; the element list is the essential part.
     * Playwright's screenshot waits for fonts, and a site with a hanging font
     * request (OrangeHRM does this) blew the 30s default and killed preflight and
     * mapping outright. Cap it, and degrade to DOM-only vision rather than failing.
     */
    /*
     * Cheap compared with pixels: text costs tokens, not the ~3.5s of extra
     * time-to-first-token an image adds, so this is always collected.
     */
    const text = ((await this.page
      .evaluate(() => (document.body ? document.body.innerText : ""))
      .catch(() => "")) as string)
      .replace(/[ \t]+/g, " ")
      .split("\n")
      .map((l) => l.trim())
      // Some apps render escaped markup as visible text (Dolibarr's dashboard
      // tiles do). It is not what the prospect reads and it crowds out what is.
      .filter((l) => l && !/^<|class="|<\/(span|div|i)>/.test(l))
      .join("\n")
      .slice(0, Number(process.env.PAGE_TEXT_LIMIT ?? 6000));

    let screenshot = "";
    let screenshotError = "";
    // Skipped entirely when the caller will not use it — capturing pixels to
    // throw them away is dead latency on every conversational turn.
    if (withScreenshot) try {
      screenshot = (
        await this.page.screenshot({ type: "png", timeout: Number(process.env.SCREENSHOT_TIMEOUT_MS ?? 8000), animations: "disabled", caret: "hide" })
      ).toString("base64");
    } catch (e) {
      screenshotError = String((e as Error).message).slice(0, 500);
    }
    this.lastElements = new Map(elements.map((element) => [element.id, element]));
    const result = { url: this.page.url(), title: await this.page.title().catch(() => ""), elements, text, screenshot };
    emit("browser.snapshot", { status: "ok", ms: Date.now() - started, data: {
      url: result.url, title: result.title, textCharCount: text.length,
      screenshotBytes: Math.floor(screenshot.length * 3 / 4),
      elementCount: elements.length,
      partialErrors: [
        elementScanError ? `element identification failed: ${elementScanError}` : undefined,
        screenshotError ? `screenshot unavailable: ${screenshotError}` : undefined,
      ].filter(Boolean),
      elements: elements.map((element) => ({
        id: element.id, control: `${element.role || element.tag} "${element.name || element.placeholder || element.text}"`,
        role: element.role || element.tag, name: element.name || element.placeholder || element.text,
        href: element.href || undefined,
      })),
    } });
    return result;
  }

  /**
   * Wait for the page to be USABLE, not merely loaded.
   *
   * `domcontentloaded` fires before a client-rendered app has painted anything, so
   * a React/Vue SPA looks like an empty page with zero controls — preflight
   * reported "reachable, 0 controls" and mapping would have catalogued nothing.
   * Poll for real interactive content instead, with a cap so a genuinely blank
   * page doesn't hang us.
   */
  private async settle(): Promise<void> {
    // Every navigation and every action funnels through here, so this is the one
    // place that reliably means "the box is no longer in its as-started state".
    this.pristine = false;
    await this.page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
    await this.page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
    /*
     * Wait for the control count to STOP MOVING, not merely to become non-zero.
     *
     * "Non-zero" is satisfied by the app shell, which on an SPA is already
     * painted before any route content exists. Measured on llmapi.ai's Guardrails
     * page: the explorer snapshotted 31 controls 113ms after the click and called
     * done(); the verifier saw 39 five seconds later — the search box, three
     * filter comboboxes, the rules table and its toggles had not rendered yet. So
     * a journey called "Examine the Guardrails settings" examined none of them,
     * and the only text new enough to serve as proof came from an onboarding
     * modal. Stability is the property that actually means "the page is ready".
     */
    const deadline = Date.now() + Number(process.env.CONTENT_WAIT_MS ?? 12000);
    const stableMs = Number(process.env.CONTENT_STABLE_MS ?? 900);
    const pollMs = 250;
    const count = async () =>
      Number(
        await this.page
          .evaluate(`document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="switch"]').length`)
          .catch(() => 0),
      );
    let last = -1;
    let stableFor = 0;
    while (Date.now() < deadline) {
      const now = await count();
      stableFor = now === last ? stableFor + pollMs : 0;
      last = now;
      // Non-zero AND unchanged for a beat: the route has finished rendering.
      if (now > 0 && stableFor >= stableMs) return;
      await this.page.waitForTimeout(pollMs);
    }
  }

  async stop(): Promise<void> {
    const started = Date.now();
    const provider = this.target.auth.mode === "profile" ? "chrome-profile" : config.liveboxProvider === "steel" ? "steel" : "local-playwright";
    if (this.streamTimer) clearInterval(this.streamTimer);
    this.streamTimer = null;
    // A persistent context owns the browser process and has no Browser handle;
    // closing the context is what releases the profile's lock file, so a later
    // run (or the desktop sign-in window) can open the same profile again.
    if (this.persistent) await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    if (this.steel && this.steelSessionId) await this.steel.sessions.release(this.steelSessionId).catch(() => {});
    this.steelSessionId = undefined;
    emit("browser.stop", { status: "ok", ms: Date.now() - started, data: { provider, sessionId: this.browserSessionId } });
    this.browserSessionId = undefined;
  }
}

/** Tags visible interactive elements with data-aidan-id and returns a compact list. */
/**
 * How many interactive elements one snapshot may report.
 *
 * Every element costs prompt tokens on every turn, so this is a real cost/latency
 * dial, not a free number — but 150 was too low for a dense enterprise app and
 * caused silent, invisible truncation. Raised, and configurable per deployment.
 */
const ELEMENT_CAP = Number(process.env.SNAPSHOT_ELEMENT_CAP ?? 320);

const tagElementsScript = () => TAG_ELEMENTS_TEMPLATE.replace("__ELEMENT_CAP__", String(ELEMENT_CAP));

const TAG_ELEMENTS_TEMPLATE = `(() => {
  // NOTE: plain 'a' (not 'a[href]'). SPAs routinely render clickable anchors with
  // no href and a JS handler — e.g. a cart icon — and 'a[href]' makes them
  // invisible to the agent, so whole journeys become unreachable.
  const sel = 'a, button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="switch"], [contenteditable="true"], [onclick], [tabindex]:not([tabindex="-1"])';
  var nodes = Array.from(document.querySelectorAll(sel));
  /*
   * DIALOG-FIRST ORDERING.
   *
   * The scan is capped, and it used to take the first N in raw DOM order. On a
   * dense enterprise page that is spent entirely on navigation and table chrome
   * before it ever reaches the thing the user just opened. Measured on HubSpot's
   * contacts list: 151 controls, cap 150 — clicking "Create new" added 5 controls
   * for the creation panel, every one of them beyond the cut. The panel opened
   * perfectly; the agent simply never saw it, and reported "no fields or save
   * control are available". Three creation journeys died on that alone.
   *
   * A modal is where the user's attention is and where the actionable controls
   * are, so its contents go first regardless of document order. Product-agnostic:
   * it keys on the ARIA dialog contract, not on any product's markup.
   */
  var MODAL_SEL = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]';
  var inModal = function (el) { return !!(el.closest && el.closest(MODAL_SEL)); };
  // Overlay controls are usable but transient, so mapping records them without
  // treating their appearance as a brand-new screen.
  var OVERLAY_SEL = MODAL_SEL + ', [role="menu"], [role="menubar"], [role="listbox"], [role="tooltip"], [role="combobox"][aria-expanded="true"]';
  var inOverlay = function (el) { return !!(el.closest && el.closest(OVERLAY_SEL)); };
  if (nodes.some(inModal)) nodes = nodes.filter(inModal).concat(nodes.filter(function (n) { return !inModal(n); }));
  const out = []; let id = 0;
  for (const el of nodes) {
    const r = el.getBoundingClientRect();
    /*
     * RENDERED, not "currently on screen". Those are different questions and
     * conflating them cost us every long form.
     *
     * The old test required the element to intersect the viewport. On Dolibarr's
     * new-customer form the page is 1122px tall in an 800px viewport, so
     * "Create third party" sits at y=1066 — below the fold, filtered out, and
     * absent from the 74 controls the agent was given. It could see the whole
     * form and had no way to submit it, reporting "no Save/Create button is
     * available". Three jobs died on that in one run.
     *
     * The restriction bought nothing anyway: clickElement and resolve already
     * call scrollIntoViewIfNeeded(), so an off-screen control is perfectly
     * actionable. What we still exclude is genuine hiding — zero size,
     * display:none, visibility:hidden, and the off-canvas negative-offset trick
     * (left:-9999px) used to hide things from sighted users.
     *
     * NOTE: this comment lives inside a template literal — no backticks here,
     * they terminate the injected script.
     */
    const offCanvas = r.right < 0 || r.bottom < 0;
    const visible = r.width > 2 && r.height > 2 && !offCanvas;
    const s = window.getComputedStyle(el);
    const explicitRole = (el.getAttribute('role') || '').toLowerCase();
    const isControl = ['input','textarea','select'].includes(el.tagName.toLowerCase()) || ['checkbox','switch','radio'].includes(explicitRole);
    if (!visible || s.visibility === 'hidden' || s.display === 'none') continue;
    if (s.opacity === '0' && !isControl) continue; // keep opacity:0 form controls (e.g. styled toggles)
    el.setAttribute('data-aidan-id', String(id));
    const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('value') || '').trim().slice(0, 120);
    const tag = el.tagName.toLowerCase();
    const t = (el.getAttribute('type') || '').toLowerCase();
    // Derive the ARIA role so journeys can be replayed by role+name later.
    let role = explicitRole;
    if (!role) {
      if (tag === 'a') role = 'link';
      else if (tag === 'button' || (tag === 'input' && ['button','submit','reset'].includes(t))) role = 'button';
      else if (tag === 'input' && t === 'checkbox') role = 'checkbox';
      else if (tag === 'input' && t === 'radio') role = 'radio';
      else if (tag === 'select') role = 'combobox';
      else if (tag === 'textarea' || (tag === 'input' && ['text','email','search','url','tel','password',''].includes(t))) role = 'textbox';
      else role = tag;
    }
    // <select>.innerText concatenates EVERY option, which makes a useless (and
    // unmatchable) accessible name. Prefer real labelling attributes for controls.
    const labelled = tag === 'select' || tag === 'input' || tag === 'textarea';
    const labelFor = (() => {
      if (!labelled) return '';
      const id = el.getAttribute('id');
      if (id) { const l = document.querySelector('label[for="' + CSS.escape(id) + '"]'); if (l) return (l.innerText || '').trim(); }
      const wrap = el.closest('label');
      return wrap ? (wrap.innerText || '').trim() : '';
    })();
    let name = (
      el.getAttribute('aria-label') ||
      labelFor ||
      (labelled ? (el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || el.getAttribute('data-test') || el.getAttribute('id') || '') : ((el.innerText || '').trim() || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('value') || ''))
    ).toString().trim().slice(0, 80);
    // Icon-only controls (cart badges, hamburgers, gear menus) have NO accessible
    // name and would otherwise show up as an unidentifiable  link "" — invisible
    // to the agent. Fall back to stable attributes so they can be addressed.
    if (!name) {
      /*
       * Icon-only controls: derive the name from the ICON, not the button.
       * The button's own class ("oxd-icon-button oxd-table-cell-action-") is a
       * styling hook shared by every icon button on the page — it identifies
       * nothing, and using it produced journeys that could never be replayed.
       * Icon fonts, by contrast, encode meaning in the glyph token
       * (bi-pencil-fill, fa-trash, mdi-delete), which is exactly the semantic
       * a person would use to describe the control.
       */
      const iconName = (() => {
        const icon = el.matches('i,svg') ? el : el.querySelector('i, svg, [class*="icon" i]');
        if (!icon) return '';
        const cls = (icon.getAttribute('class') || '') + ' ' + (icon.getAttribute('data-icon') || '');
        const token = cls.split(/\s+/)
          .map((c) => (c.match(/^(?:bi|fa[srlbd]?|mdi|icon|material-icons|glyphicon|ti|bx)[-_](.+)$/) || [])[1])
          .filter(Boolean)
          .find((t) => t && !/^(fw|lg|sm|xs|[0-9]+x)$/.test(t));
        if (token) return token.replace(/[-_]+/g, ' ').replace(/\b(fill|outline|lg|sm|alt)\b/g, '').trim();
        // Material Icons put the glyph name in the text node.
        const t = (icon.textContent || '').trim();
        return /^[a-z_]{3,30}$/.test(t) ? t.replace(/_/g, ' ') : '';
      })();
      // decode: an href tail is URL-encoded, and "Artem%20Bondar" matches nothing.
      let hrefTail = (el.getAttribute('href') || '').split(/[?#]/)[0].split('/').filter(Boolean).pop() || '';
      try { hrefTail = decodeURIComponent(hrefTail); } catch (e) {}
      hrefTail = hrefTail.replace(/[+_-]+/g, ' ').trim();
      name = (el.getAttribute('data-test') || el.getAttribute('data-testid') || iconName || el.getAttribute('id') || hrefTail || '').toString().trim().slice(0, 80);
    }
    /*
     * A test hook, if the product ships one — and never a FRAMEWORK-generated id.
     * Radix, MUI and Headless UI mint ids like "radix-:r2i:" that change on every
     * render, so recording one produces a journey that cannot replay even in the
     * same session.
     */
    var rawTestId = (el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-cy') || el.getAttribute('data-qa') || '').toString().trim();
    var generated = /^(radix|mui|headlessui|reach|chakra|aria)[-_]|^:r[0-9a-z]+:|^[0-9]+$/i;
    var testId = rawTestId && !generated.test(rawTestId) ? rawTestId.slice(0, 80) : '';
    out.push({
      id, tag, testId,
      type: (el.getAttribute('type') || el.getAttribute('role') || '').toString(),
      text, placeholder: (el.getAttribute('placeholder') || '').slice(0, 80),
      value: ('value' in el ? String(el.value || '') : '').slice(0, 80),
      href: (el.getAttribute('href') || '').slice(0, 120),
      role, name,
      discloses: el.hasAttribute('aria-haspopup') || el.hasAttribute('aria-expanded') || el.hasAttribute('aria-controls'),
      overlay: inOverlay(el),
    });
    id++; if (id > __ELEMENT_CAP__) break;
  }
  return out;
})()`;
