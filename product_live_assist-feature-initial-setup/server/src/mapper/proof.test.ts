import { validateProof, proofCandidates, type ProofContext } from "./proof.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
};

// The OrangeHRM defect, reproduced exactly.
const ohrm: ProofContext = {
  before: "PIM\nEmployee List\nAdd Employee\nFirst Name\nMiddle Name\nLast Name",
  after: "PIM\nAva Marie Johnson\nPersonal Details\nEmployee Id 0512",
  typedValues: ["Ava", "Marie", "Johnson"],
};
const composed = validateProof("Ava Johnson", ohrm);
check("rejects a proof composed from typed values", !composed.ok);
check("explains the composition", /assembled from values you typed/.test(composed.reason ?? ""), composed.reason);
check("offers the real observed string", (composed.candidates ?? []).some((c) => c.includes("Ava Marie Johnson")), JSON.stringify(composed.candidates));
check("accepts the text actually rendered", validateProof("Ava Marie Johnson", ohrm).ok);

// Differential still enforced.
check("rejects text already visible before", !validateProof("Employee List", ohrm).ok);

// Empty state.
const search: ProofContext = { before: "Search\nName", after: "Search\nName\nNo Records Found" };
check("rejects empty-state proof", !validateProof("No Records Found", search).ok);

// REGRESSION: a count reaching zero is a genuine result, not an empty state.
const todo: ProofContext = { before: "1 item left\nbuy milk", after: "0 items left\nbuy milk" };
check("accepts '0 items left' (count as result)", validateProof("0 items left", todo).ok, JSON.stringify(validateProof("0 items left", todo)));

// Invented text.
check("rejects text never on the page", !validateProof("Order completed successfully", ohrm).ok);

// Numbers only.
const n: ProofContext = { before: "a", after: "a\n12345" };
check("rejects digits-only proof", !validateProof("12345", n).ok);

// Digit-insensitive containment (live counts move).
const counts: ProofContext = { before: "Articles", after: "Articles\nFavorite Article (2197)" };
check("tolerates a moved count", validateProof("Favorite Article (2196)", counts).ok, JSON.stringify(validateProof("Favorite Article (2196)", counts)));

// Ranking: short unique non-numeric new line should outrank a long paragraph.
const rank: ProofContext = {
  before: "Cart",
  after: "Cart\nThank you for your order\nYour order has been dispatched and you will receive a confirmation email shortly containing tracking details and delivery estimates",
};
const cands = proofCandidates(rank);
check("ranks the short confirmation first", cands[0] === "Thank you for your order", JSON.stringify(cands[0]));

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
