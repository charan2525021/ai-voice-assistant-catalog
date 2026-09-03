import { config } from "../config.js";
/** Does the gateway actually stream? Measure time-to-first-token vs completion. */
const t0 = Date.now();
const res = await fetch(`${config.openai.baseUrl.replace(/\/$/, "")}/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${config.openai.apiKey}` },
  body: JSON.stringify({
    model: config.openai.model,
    messages: [{ role: "system", content: "You are a concise product guide." },
               { role: "user", content: "In three sentences, what can an ERP do for a services business?" }],
    reasoning_effort: config.openai.reasoningEffort,
    stream: true,
  }),
});
console.log(`model: ${config.openai.model}  |  http ${res.status}  |  headers in ${Date.now() - t0}ms`);
const rd = res.body!.getReader(); const dec = new TextDecoder();
let first = 0, events = 0, chars = 0, buf = "";
for (;;) {
  const { done, value } = await rd.read(); if (done) break;
  buf += dec.decode(value, { stream: true });
  let nl: number;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line.startsWith("data:")) continue;
    const p = line.slice(5).trim(); if (p === "[DONE]") continue;
    try {
      const d = JSON.parse(p).choices?.[0]?.delta?.content;
      if (d) { events++; chars += d.length; if (!first) { first = Date.now() - t0; console.log(`  FIRST TOKEN at ${first}ms: ${JSON.stringify(d)}`); } }
    } catch {}
  }
}
console.log(`  ${events} delta events, ${chars} chars, complete at ${Date.now() - t0}ms`);
console.log(events > 3 ? "  ✓ genuinely streaming" : "  ✗ NOT streaming — arrives as one blob");
process.exit(0);
