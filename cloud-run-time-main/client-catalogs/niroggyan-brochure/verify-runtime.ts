/**
 * Independent end-to-end verification of the emitted NirogGyan brochure
 * catalog. This intentionally loads the generated database through the real
 * file-backed stores instead of importing the generator.
 *
 * Run from sable-cloud-runtime:
 *   node --import tsx client-catalogs/niroggyan-brochure/verify-runtime.ts
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertValidSignedCatalogEnvelope,
  canonicalizeJson,
  type ScreenObservation,
  type SignedCatalogEnvelope,
} from "@sable/sdk-contracts";
import { EvidenceRouter } from "@sable/runtime-core";
import { createFileStores } from "../../src/stores/file.js";

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = resolve(here, "../../data/niroggyan-brochure-runtime.generated.json");
const configPath = resolve(here, "runtime-config.generated.json");

const ORG = "niroggyan-tenant";
const PRODUCT = "niroggyan-brochure-product";
const ROLE = "public";
const VERSION = "niroggyan-brochure-v1";
const INSTALLATION = "niroggyan-brochure-poc-installation";
const scope = { organizationId: ORG, productId: PRODUCT, roleProfileId: ROLE, catalogVersionId: VERSION };

type RuntimeConfig = {
  catalogTrustKeys: Array<{
    keyId: string;
    algorithm: "ES256";
    jwk: JsonWebKey;
  }>;
};

const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => results.push({ name, ok, detail });

const homeObservation: ScreenObservation = {
  kind: "sable.screen_observation",
  schemaVersion: 1,
  observationId: "niroggyan-verify-home",
  version: 1,
  capturedAt: "2026-08-20T00:00:00.000Z",
  url: "https://www.brochure.niroggyan.com/",
  origin: "https://www.brochure.niroggyan.com",
  title: "NirogGyan",
  fingerprint: "sha256-niroggyan-brochure-home-verification",
  visibleText: "NirogGyan unifies healthcare data through Smart Reporting and Viz App. User Journey Engagement Testimonials ROI Calculator Talk to Shweta",
  elements: [
    { id: "verify-1", role: "button", name: "Talk to Shweta", visible: true, enabled: true },
    { id: "verify-2", role: "link", name: "User Journey", visible: true, enabled: true },
    { id: "verify-3", role: "link", name: "Engagement", visible: true, enabled: true },
    { id: "verify-4", role: "link", name: "Testimonials", visible: true, enabled: true },
  ],
};

function executable(catalog: SignedCatalogEnvelope, role: string, journeyId: string | undefined) {
  if (!journeyId) return undefined;
  return catalog.payload.journeys.find((journey) =>
    journey.id === journeyId &&
    journey.state === "approved" &&
    journey.roles.includes(role) &&
    journey.compatibility.every((step) => step.classification === "SDK_DIRECT"),
  );
}

const config = JSON.parse(await readFile(configPath, "utf8")) as RuntimeConfig;
const trustKey = config.catalogTrustKeys[0];
const stores = await createFileStores(dbPath);
const installation = await stores.installations.get(INSTALLATION);
check(
  "installation loads with the exact brochure origin and public role",
  !!installation &&
    installation.allowedOrigins.length === 1 &&
    installation.allowedOrigins[0] === "https://www.brochure.niroggyan.com" &&
    installation.allowedRoles.includes(ROLE),
);
check("installation contains only a credential hash", !!installation?.credentialHash && !("credential" in (installation ?? {})));

const envelope = installation ? await stores.catalogs.get(VERSION, installation) : undefined;
check("signed catalog loads for the fixed scope", !!envelope);
if (envelope) {
  try {
    assertValidSignedCatalogEnvelope(envelope);
    check("signed envelope independently passes schema validation", true);
  } catch (error) {
    check("signed envelope independently passes schema validation", false, String(error));
  }

  const canonicalPayload = canonicalizeJson(envelope.payload);
  const digest = createHash("sha256").update(canonicalPayload).digest("base64url");
  check("RFC 8785 canonical payload digest matches", digest === envelope.digest.value, `computed=${digest}`);
  check("runtime config and envelope key identifiers match", trustKey?.keyId === envelope.signature.keyId);
  check("runtime config declares ES256", trustKey?.algorithm === "ES256");
  check("runtime config contains no private JWK material", !!trustKey?.jwk && !("d" in trustKey.jwk));
  const publicKey = createPublicKey({ key: trustKey.jwk, format: "jwk" });
  const signatureOk = verify(
    "sha256",
    Buffer.from(canonicalPayload, "utf8"),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(envelope.signature.value, "base64url"),
  );
  check("ES256 P-256 IEEE-P1363 signature verifies", signatureOk);
}

const bundle = await stores.catalogs.getBundle(scope);
check("runtime bundle loads", !!bundle);
check("runtime bundle maps all 12 discovered routes", bundle?.screens.length === 12, `screens=${bundle?.screens.length ?? 0}`);
for (const key of ["legacy-smart-reports", "legacy-vizapp-page", "legacy-analytics", "legacy-health-tools"]) {
  check(`legacy direct-only route is retained: ${key}`, !!bundle?.screens.some((screen) => screen.key === key));
}

const router = new EvidenceRouter(stores.catalogs, stores.knowledge);
{
  const evidence = await router.route(scope, {
    text: "give me a walkthrough of this brochure",
    screen: homeObservation,
    routing: { intent: "action", needsKnowledge: false, journeyId: "show-brochure-overview" },
  });
  check("walkthrough intent selects show-brochure-overview", evidence.journey?.key === "show-brochure-overview", `matched=${evidence.journey?.key}`);
  check("live observation is recognized as the home screen", evidence.matchedScreen?.key === "home", `matched=${evidence.matchedScreen?.key}`);
  check("walkthrough is executable", !!(envelope && executable(envelope, ROLE, evidence.journey?.key)));
}

{
  const hits = await stores.knowledge.search(scope, { query: "retention roi revenue calculator sample assumptions", limit: 6 });
  check("ROI assumptions are searchable", hits.some((hit) => hit.id === "kb-roi-calculator"), hits.map((hit) => hit.id).join(", "));
  const coverageHits = await stores.knowledge.search(scope, { query: "dashboard portal pricing coverage limitation", limit: 6 });
  check("scope limitations are searchable", coverageHits.some((hit) => hit.id === "kb-coverage-gap"), coverageHits.map((hit) => hit.id).join(", "));
}

if (envelope) {
  const approved = envelope.payload.journeys.filter((journey) => journey.state === "approved");
  const nonApproved = envelope.payload.journeys.filter((journey) => journey.state !== "approved");
  check(`all ${approved.length} approved journeys are SDK-direct and executable`, approved.every((journey) => !!executable(envelope, ROLE, journey.id)));
  check(`none of the ${nonApproved.length} blocked journeys is executable`, nonApproved.every((journey) => !executable(envelope, ROLE, journey.id)));
  check(
    "all external-tab journeys require a user gesture",
    nonApproved.filter((journey) => journey.id.startsWith("open-external-")).every((journey) => journey.compatibility.some((entry) => entry.classification === "NEEDS_USER_GESTURE")),
  );
}

await stores.close();

const failed = results.filter((result) => !result.ok);
for (const result of results) console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name}${result.detail ? `  (${result.detail})` : ""}`);
console.log(`\n${results.length - failed.length}/${results.length} independent runtime checks passed.`);
if (failed.length) process.exitCode = 1;
