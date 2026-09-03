import { UNIQUE_TOKEN, collapse, expand, expandProgram, hasUnique, newRunTag } from "./unique.js";
let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = "") => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${d}`)); };

const tag = newRunTag();
check("tag is short and form-safe", /^[a-z2-9]{5}$/.test(tag), tag);
check("tag avoids ambiguous chars", !/[ilo01]/.test(tag), tag);

check("expand substitutes", expand("Acme {{unique}}", "k7q2m") === "Acme k7q2m");
check("expand handles repeats", expand("{{unique}}-{{unique}}", "ab") === "ab-ab");
check("expand leaves plain text alone", expand("Acme Corp", "ab") === "Acme Corp");
check("collapse is the inverse", collapse("Acme k7q2m", "k7q2m") === "Acme {{unique}}");
check("round-trips", collapse(expand("REF-{{unique}}", tag), tag) === "REF-{{unique}}");
check("hasUnique detects", hasUnique("Acme {{unique}}") && !hasUnique("Acme"));

// Only `value` is templated — names/urls address existing UI.
const prog = [
  { action: "navigate", url: "https://x/{{unique}}" },
  { action: "fill", role: "textbox", name: "Name {{unique}}", value: "Acme {{unique}}" },
  { action: "click", role: "button", name: "Save" },
];
const out = expandProgram(prog as any, "zz9");
check("expands step values", (out[1] as any).value === "Acme zz9");
check("does NOT touch selector names", (out[1] as any).name === "Name {{unique}}", (out[1] as any).name);
check("does NOT touch urls", (out[0] as any).url === "https://x/{{unique}}");
check("leaves valueless steps intact", (out[2] as any).value === undefined);

// Two runs must differ, which is the entire point.
const tags = new Set(Array.from({ length: 200 }, () => newRunTag()));
check("tags are effectively unique across runs", tags.size > 190, `${tags.size}/200 distinct`);

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
