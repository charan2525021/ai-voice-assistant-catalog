/** Where does the captured session actually land, and is it authenticated? */
import { getProduct } from "./products.js";
import { LiveBox } from "./livebox.js";
const rec = (await getProduct(process.argv[2]))!;
const box = new LiveBox({ startUrl: rec.startUrl, auth: rec.auth, allowActions: [] });
await box.start();
for (const path of process.argv.slice(3)) {
  await box.goto(path).catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));
  const s = await box.snapshot(false);
  const signals = /sign in|log in|login|get started free|start free/i.test(s.text) ? "LOGGED-OUT markers" : "no logged-out markers";
  const acct = /dashboard|api key|usage|billing|credits|logout|log out|sign out|account/i.test(s.text) ? "ACCOUNT markers" : "no account markers";
  console.log(`\n  ${path}`);
  console.log(`    → ${box.currentUrl()}`);
  console.log(`    title: ${s.title.slice(0, 70)}`);
  console.log(`    ${signals} | ${acct} | ${s.elements.length} controls`);
}
await box.stop();
process.exit(0);
