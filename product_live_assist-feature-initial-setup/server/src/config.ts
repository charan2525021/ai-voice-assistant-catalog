import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// Load aidan/.env regardless of the working directory the server is started from.
loadEnv({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });
loadEnv(); // also pick up a server/.env if present

/**
 * Which product Aidan is demoing. Everything product-specific lives in
 * aidan/content/<PRODUCT>/ — code stays generic. Switch products with one
 * env var (PRODUCT), or point CONTENT_DIR at any folder.
 */
const CONTENT_ROOT = fileURLToPath(new URL("../../content", import.meta.url));
const productName = (process.env.PRODUCT ?? "").trim();
const contentDir = (process.env.CONTENT_DIR ?? (productName ? path.join(CONTENT_ROOT, productName) : "")).trim();

/** product.json in the content folder supplies defaults; .env always wins. */
function productManifest(): { name?: string; startUrl?: string; allowActions?: string[]; assistantName?: string } {
  if (!contentDir) return {};
  const file = path.join(contentDir, "product.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}
const manifest = productManifest();

/** Central config, read from the root .env (see ../../.env.example). */
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name} (see aidan/.env.example)`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 8787),

  // --- Brain (the reasoning model) ---
  // "anthropic" = Claude (best; needs ANTHROPIC_API_KEY)
  // "openai"    = any OpenAI-compatible endpoint, incl. a LOCAL Ollama model (zero cloud)
  modelProvider: (process.env.MODEL_PROVIDER ?? "anthropic") as "anthropic" | "openai",
  anthropic: {
    apiKey: () => required("ANTHROPIC_API_KEY"),
    model: process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8",
  },
  openai: {
    // Accepts OPENAI_* or the aliases LLM_BASE_URL / GROQ_API_KEY.
    baseUrl: (process.env.OPENAI_BASE_URL ?? process.env.LLM_BASE_URL ?? "http://localhost:11434/v1").trim(),
    apiKey: (process.env.OPENAI_API_KEY ?? process.env.GROQ_API_KEY ?? "ollama").trim(),
    model: (process.env.OPENAI_MODEL ?? "qwen2.5vl").trim(),
    vision: (process.env.MODEL_VISION ?? "true") !== "false", // send screenshots to the model
    reasoningEffort: (process.env.MODEL_REASONING_EFFORT ?? "none").trim(), // some endpoints need "none" to allow tools
    // Replies are two short sentences, but a tool-calling turn needs headroom.
    maxTokens: Number(process.env.MODEL_MAX_TOKENS ?? 1024),
  },

  // --- LiveBox (the cloud/local browser) ---
  // "local" = self-hosted Playwright Chromium (open source, zero config, default)
  // "steel" = managed Steel cloud browser (needs STEEL_API_KEY)
  liveboxProvider: (process.env.LIVEBOX_PROVIDER ?? "local") as "local" | "steel",
  steelApiKey: () => required("STEEL_API_KEY"),

  // --- Which product's Brain content to load (aidan/content/<PRODUCT>/) ---
  product: productName || "default",
  contentDir,
  /** Sandbox-safe mutations this product explicitly permits (e.g. ["checkout"]). Human decision, never agent self-authorised. */
  allowActions: manifest.allowActions ?? [],

  // --- Target product to demo. Precedence: .env > content/<PRODUCT>/product.json > fallback. ---
  /*
   * The name the prospect hears. Configurable rather than written into the
   * prompts and the page, so rebranding is one setting and not a hunt through
   * every user-facing string.
   */
  assistantName: process.env.ASSISTANT_NAME ?? manifest.assistantName ?? "Tia",

  demo: {
    name: process.env.DEMO_NAME ?? manifest.name ?? "the product",
    startUrl: process.env.DEMO_START_URL ?? manifest.startUrl ?? "https://demo.playwright.dev/todomvc",
    authMode: (process.env.DEMO_AUTH_MODE ?? "none") as "none" | "login" | "shared_link",
    username: process.env.DEMO_USERNAME ?? "",
    password: process.env.DEMO_PASSWORD ?? "",
  },

  viewport: { width: 1280, height: 800 },

  /** Is a reasoning model available? (Anthropic needs a key; openai/Ollama assumed reachable.) */
  modelReady(): boolean {
    return (process.env.MODEL_PROVIDER ?? "anthropic") === "openai" || !!process.env.ANTHROPIC_API_KEY;
  },
};
