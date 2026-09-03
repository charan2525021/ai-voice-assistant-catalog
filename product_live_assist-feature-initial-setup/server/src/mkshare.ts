import { getProduct, saveProduct } from "./products.js";
import { randomBytes } from "node:crypto";
const rec = (await getProduct(process.argv[2]))!;
if (!rec.share?.token) { rec.share = { token: randomBytes(18).toString("base64url"), createdAt: new Date().toISOString() }; await saveProduct(rec); }
console.log(rec.share!.token);
process.exit(0);
