/** Is this product's captured session still signed in? Sessions expire mid-day. */
import { getProduct } from "./products.js";
import { preflight } from "./onboarding.js";
const id = process.argv[2] ?? "dolibarr";
const rec = await getProduct(id);
if (!rec) { console.log(`unknown product "${id}"`); process.exit(1); }
const r = await preflight(rec);
console.log(`${r.ok ? "✓ signed in" : "✗ NOT signed in"} — ${r.message}`);
process.exit(r.ok ? 0 : 1);
