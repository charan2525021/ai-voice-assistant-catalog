import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Resolved here rather than imported from products.ts, which would make the
 *  product registry and the knowledge store circularly dependent. */
const CONTENT_ROOT = fileURLToPath(new URL("../../content", import.meta.url));

/**
 * The language layer: verb classes and intent patterns.
 *
 * These were two blocks of hardcoded English regexes — one in `store.ts`
 * (what the user wants to DO) and one in `retrieve.ts` (what KIND of turn this
 * is). They work, and the comments around them record real collisions found the
 * hard way. But as code they have three problems:
 *
 *  1. Every new domain risks a new collision, and fixing it means editing a
 *     core module and redeploying. "sort ORDER" being read as a purchase, and
 *     ordering intent arriving as a superlative ("cheapest") rather than the
 *     verb "sort", were both found only by a failing eval.
 *  2. They are English-only, while the speech layer already synthesises Indian
 *     languages. A Hindi utterance gets NO verb signal and falls through to
 *     smalltalk — the routing quality silently collapses for that user.
 *  3. A vertical with its own vocabulary (an HRIS says "raise a request", a CRM
 *     says "log an activity") cannot teach the system its words without a code
 *     change.
 *
 * So they move to data. The defaults below are the exact patterns that were in
 * the code, so behaviour is unchanged for every existing product; a product can
 * now ADD to or REPLACE them via `content/<product>/lexicon.json`.
 */

export interface Lexicon {
  /** verb class → regex source strings (OR-ed together). */
  verbs: Record<string, string[]>;
  /** intent → regex source strings, tested in `intentOrder`. */
  intents: Record<string, string[]>;
  /** Most-specific-first evaluation order for verbs. */
  verbOrder: string[];
  /** First match wins, so order encodes precedence. */
  intentOrder: string[];
}

/**
 * English defaults — moved verbatim from store.ts / retrieve.ts. The inline
 * warnings are preserved because they are the reason each pattern is shaped the
 * way it is, and re-deriving them costs a debugging session each.
 */
export const DEFAULT_LEXICON: Lexicon = {
  verbs: {
    create: ["\\b(add|create|new|put|insert|chuck|make|start|begin|write|upload|invite|book)\\b"],
    view: ["\\b(view|see|show|open|look|inspect|read|display|browse|check|preview|details)\\b"],
    modify: ["\\b(edit|change|update|rename|mark|toggle|complete|finish|move|assign|set)\\b"],
    remove: ["\\b(remove|delete|clear|cancel|discard|empty)\\b"],
    // Ordering intent usually arrives as a SUPERLATIVE ("cheapest", "newest
    // first"), not the verb "sort" — without these cues such queries read as
    // `view` and lose to the sorting flow.
    organise: [
      // "sort" only when it means ordering. "sort out the payment" and "sort of"
      // are ordinary English that routed a PURCHASE intent to the sorting flow —
      // the same word-collision family as the "sort ORDER" bug that made
      // `transact` drop bare "order". Phrasal verbs need excluding explicitly.
      "\\bsort\\b(?!\\s+(out|of)\\b)",
      "\\b(filter|search|group|arrange|order by|cheapest|dearest|priciest|most expensive|least expensive|highest|lowest|newest|oldest|alphabetical|a to z|z to a|low to high|high to low)\\b|\\bfirst\\b",
    ],
    // NOTE: no bare "order" — it collides with "sort order" / "order by", which
    // classified the SORTING flow as a purchase and inverted its ranking.
    transact: [
      "\\b(checkout|check out|pay|payment|purchase|buy|submit|confirm)\\b|\\b(place|complete|finish|track|cancel)\\s+(the\\s+|my\\s+|your\\s+)?orders?\\b",
      "\\b(settle up|sort out (the |my )?(payment|bill|order))\\b",
    ],
  },
  verbOrder: ["transact", "organise", "remove", "modify", "create", "view"],
  intents: {
    objection: ["\\b(expensive|too much|already (use|have)|competitor|complicated|worried|concern|not sure|why not|instead of)\\b"],
    buying_signal: ["\\b(price|pricing|cost|trial|sign ?up|get started|buy|purchase|plan|how much)\\b"],
    show_me: ["\\b(show|demo|walk me|how (do|to)|can you (show|add|create|make|do)|let'?s see|take me|give me a)\\b"],
    question: ["[?]|^\\s*(what|does|do|can|is|are|will|which|when|where)\\b"],
  },
  intentOrder: ["objection", "buying_signal", "show_me", "question"],
};

export interface CompiledLexicon {
  verbs: { name: string; re: RegExp }[];
  intents: { name: string; re: RegExp }[];
}

function compile(lex: Lexicon): CompiledLexicon {
  const build = (order: string[], table: Record<string, string[]>) =>
    order
      .filter((name) => table[name]?.length)
      .map((name) => {
        try {
          return { name, re: new RegExp(table[name].join("|"), "i") };
        } catch (e) {
          // A bad product-supplied pattern must not take down retrieval for
          // everything else — drop that class and say so.
          console.warn(`  ! lexicon: invalid pattern for "${name}" — ignoring (${(e as Error).message})`);
          return null;
        }
      })
      .filter((x): x is { name: string; re: RegExp } => !!x);
  return { verbs: build(lex.verbOrder, lex.verbs), intents: build(lex.intentOrder, lex.intents) };
}

const cache = new Map<string, CompiledLexicon>();

/**
 * Load a product's lexicon, merged over the English defaults.
 *
 * MERGED, not replaced: a product overriding one verb class keeps the other
 * five, and a partial file cannot accidentally disable intent classification.
 * Setting a class to `[]` explicitly removes it.
 */
export async function loadLexicon(product: string, contentDir?: string): Promise<CompiledLexicon> {
  const hit = cache.get(product);
  if (hit) return hit;

  let lex: Lexicon = DEFAULT_LEXICON;
  const f = path.join(contentDir ?? path.join(CONTENT_ROOT, product), "lexicon.json");
  if (existsSync(f)) {
    try {
      const custom = JSON.parse(await fs.readFile(f, "utf8")) as Partial<Lexicon>;
      lex = {
        verbs: { ...DEFAULT_LEXICON.verbs, ...(custom.verbs ?? {}) },
        intents: { ...DEFAULT_LEXICON.intents, ...(custom.intents ?? {}) },
        verbOrder: custom.verbOrder ?? [...new Set([...(Object.keys(custom.verbs ?? {})), ...DEFAULT_LEXICON.verbOrder])],
        intentOrder: custom.intentOrder ?? [...new Set([...(Object.keys(custom.intents ?? {})), ...DEFAULT_LEXICON.intentOrder])],
      };
      console.log(`[brain] lexicon: loaded overrides for "${product}"`);
    } catch (e) {
      console.warn(`  ! lexicon: bad JSON in ${f} — using defaults (${(e as Error).message})`);
    }
  }
  const compiled = compile(lex);
  cache.set(product, compiled);
  return compiled;
}

/** Synchronous default, for call sites that have no product context. */
export const defaultLexicon: CompiledLexicon = compile(DEFAULT_LEXICON);

export function verbClassOf(text: string, lex: CompiledLexicon = defaultLexicon): string | null {
  const t = (text || "").toLowerCase();
  for (const { name, re } of lex.verbs) if (re.test(t)) return name;
  return null;
}

export function intentOf(text: string, lex: CompiledLexicon = defaultLexicon): string {
  const t = (text || "").toLowerCase();
  for (const { name, re } of lex.intents) if (re.test(t)) return name;
  return "smalltalk";
}
