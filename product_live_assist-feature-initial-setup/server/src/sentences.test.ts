import { SentenceStream, splitSentences } from "./sentences.js";
let pass = 0, fail = 0;
const ck = (n: string, c: boolean, d = "") => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${d}`)); };

// Streams arrive in arbitrary token boundaries.
const s = new SentenceStream();
const got: string[] = [];
for (const d of ["For a services ", "business, Dolibarr can manage customers", " and invoices. ", "Want me to show you? ", "Sure"]) got.push(...s.push(d));
got.push(...s.flush());
ck("splits a stream into sentences", got.length === 3, JSON.stringify(got));
ck("first sentence is complete", got[0] === "For a services business, Dolibarr can manage customers and invoices.", got[0]);
ck("keeps the trailing fragment", got[2] === "Sure", got[2]);

// REGRESSION: decimals must not split — "$29.99" became "twenty-nine dot" before.
ck("does not split decimals", splitSentences("The plan costs $29.99 per user each month.").length === 1,
   JSON.stringify(splitSentences("The plan costs $29.99 per user each month.")));

// Abbreviations.
ck("does not split on abbreviations", splitSentences("Contact Dr. Sharma about the invoice today.").length === 1,
   JSON.stringify(splitSentences("Contact Dr. Sharma about the invoice today.")));
ck("handles e.g.", splitSentences("Use a module, e.g. invoicing, to bill customers monthly.").length === 1);

// Short fragments merge rather than becoming their own clip.
ck("merges very short leading fragments", splitSentences("Hi. Let me show you how invoicing works here.").length === 1,
   JSON.stringify(splitSentences("Hi. Let me show you how invoicing works here.")));

// Questions and newlines end sentences.
ck("splits on question marks", splitSentences("Shall we start with invoicing? I can open it now.").length === 2);
ck("splits on newlines", splitSentences("First we create the customer\nThen we raise the invoice for them").length === 2);

// Nothing is ever lost.
const long = "Dolibarr manages customers and suppliers. It raises proposals and orders. It issues invoices and records payments.";
ck("loses no text", splitSentences(long).join(" ") === long, splitSentences(long).join(" "));

// Decimals split across delta boundaries — a real failure: "17.4 million" was
// spoken as "seventeen." then "4 million tokens used."
const dec = new SentenceStream();
const decOut: string[] = [];
for (const d of ["You have used 17.", "4 million tokens this month. ", "Want the breakdown? "]) {
  for (const piece of dec.push(d)) decOut.push(piece);
}
for (const piece of dec.flush()) decOut.push(piece);
ck("does not split a decimal at a delta boundary", decOut.every((o) => !/\b17\.$/.test(o.trim())), decOut.join(" | "));
ck("keeps the decimal intact", decOut.some((o) => /17\.4 million/.test(o)), decOut.join(" | "));

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
