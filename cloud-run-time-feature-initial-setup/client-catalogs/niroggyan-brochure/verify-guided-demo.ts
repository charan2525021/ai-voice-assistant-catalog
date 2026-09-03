/**
 * Independent verification for the brochure guided-demo test catalog.
 * Generate it first with `npm run niroggyan:guided-demo:generate`.
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertValidSignedCatalogEnvelope, canonicalizeJson, type SignedCatalogEnvelope } from "@sable/sdk-contracts";
import { DeterministicDemoDirector } from "../../src/demo-director.js";
import { retrieveDemoSalesPlays } from "../../src/demo-sales-play-retriever.js";
import type { DemoInterruptionPlan } from "../../src/demo-interruption-planner.js";
import { createFileStores } from "../../src/stores/file.js";
import { NIROGGYAN_CLIENT_ROUTER_TOOL_NAME } from "./client-router-tool.js";

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = resolve(here, "../../data/niroggyan-brochure-guided-demo-runtime.generated.json");
const artifactDir = resolve(here, "guided-demo-test");
const config = JSON.parse(await readFile(resolve(artifactDir, "runtime-config.generated.json"), "utf8")) as {
  apiBaseUrl: string;
  installationId: string;
  origin: string;
  catalogTrustKeys: Array<{ keyId: string; algorithm: "ES256"; jwk: JsonWebKey }>;
};
const recordingManifest = JSON.parse(await readFile(resolve(artifactDir, "recording-manifest.source.json"), "utf8")) as {
  status: string;
  utterances: Array<{ audioAssetId: string | null }>;
};

const VERSION = "niroggyan-brochure-v2-test";
const INSTALLATION = "niroggyan-brochure-guided-demo-test-installation";
const ORIGIN = "https://www.brochure.niroggyan.com";
const EXPECTED_DEMO_SAFE = new Set([
  "show-brochure-overview",
  "open-viz-app-from-user-journey",
  "open-engagement-from-user-journey",
  "run-sample-roi-calculation",
  "reveal-testimonial-statistics",
  "show-smart-reporting-overview",
  "preview-whatsapp-chatbot-safely",
  "preview-demo-scheduling-safely",
]);

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
const check = (name: string, ok: boolean, detail?: string) => results.push({ name, ok, ...(detail ? { detail } : {}) });
const stores = await createFileStores(dbPath);
const installation = await stores.installations.get(INSTALLATION);
check("separate guided-demo test installation loads", !!installation);
check("guided demo is enabled only by installation entitlement", installation?.guidedDemo?.enabled === true);
check("installation pins the v2 test catalog", installation?.activeCatalogVersionId === VERSION);
check("installation allows only the canonical brochure origin", JSON.stringify(installation?.allowedOrigins) === JSON.stringify([ORIGIN]));
check("installation uses the public brochure role", JSON.stringify(installation?.allowedRoles) === JSON.stringify(["public"]));
check("public runtime config matches the test installation", config.installationId === INSTALLATION && config.origin === ORIGIN);
check("prepared API URL is localhost or HTTPS tunnel safe", config.apiBaseUrl.startsWith("http://localhost:") || config.apiBaseUrl.startsWith("https://"));

const envelope = installation ? await stores.catalogs.get(VERSION, installation) : undefined;
check("signed v2 test catalog loads", !!envelope);
if (envelope) {
  try { assertValidSignedCatalogEnvelope(envelope); check("signed catalog passes independent schema validation", true); }
  catch (error) { check("signed catalog passes independent schema validation", false, String(error)); }
  const canonical = canonicalizeJson(envelope.payload);
  const digest = createHash("sha256").update(canonical).digest("base64url");
  check("catalog digest matches canonical payload", digest === envelope.digest.value);
  const trustKey = config.catalogTrustKeys.find((candidate) => candidate.keyId === envelope.signature.keyId);
  check("runtime config contains the catalog trust key", !!trustKey);
  if (trustKey) {
    const publicKey = createPublicKey({ key: trustKey.jwk, format: "jwk" });
    check("ES256 signature verifies", verify("sha256", Buffer.from(canonical), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(envelope.signature.value, "base64url")));
  }
  const profile = envelope.payload.demoProfile;
  check("signed demo profile exists", !!profile);
  check("profile has exactly two generic questions", profile?.intake.genericQuestionIds.length === 2);
  check("profile has lab and hospital persona playlists", !!profile?.playlistModuleIdsByPersonaId.diagnostic_lab && !!profile?.playlistModuleIdsByPersonaId.hospital);
  check("profile exposes eight bounded modules", profile?.modules.length === 8, `modules=${profile?.modules.length ?? 0}`);
  check("signed catalog contains brochure sales knowledge", (envelope.payload.salesPlays?.length ?? 0) >= 10, `plays=${envelope.payload.salesPlays?.length ?? 0}`);
  const routerTool = envelope.payload.tools.find((tool) => tool.name === NIROGGYAN_CLIENT_ROUTER_TOOL_NAME);
  check("signed catalog declares the bounded brochure SPA router", routerTool?.risk === "read" && routerTool.confirmation === "never" && routerTool.availability === "required");
  const actualDemoSafe = new Set(envelope.payload.journeys.filter((journey) => journey.demoSafe === true).map((journey) => journey.id));
  check("demo-safe set exactly matches the reviewed stable-state set", actualDemoSafe.size === EXPECTED_DEMO_SAFE.size && [...actualDemoSafe].every((id) => EXPECTED_DEMO_SAFE.has(id)));
  check("every module references an approved demo-safe journey", profile?.modules.every((module) => {
    const journey = envelope.payload.journeys.find((candidate) => candidate.id === module.journeyId);
    return journey?.state === "approved" && journey.demoSafe === true;
  }) === true);
  check("external and ambiguous journeys cannot enter guided playback", envelope.payload.journeys.filter((journey) => journey.state !== "approved").every((journey) => journey.demoSafe !== true && !profile?.modules.some((module) => module.journeyId === journey.id)));
  const demoModules = profile?.modules ?? [];
  check("every demo module establishes its own starting screen", demoModules.every((module) => {
    const definition = envelope.payload.journeys.find((journey) => journey.id === module.journeyId);
    const first = definition?.workflow.steps[0];
    return definition?.workflow.preconditions.length === 0
      && definition.workflow.startUrl === undefined
      && first?.kind === "action"
      && first.action === "tool_call"
      && first.toolName === NIROGGYAN_CLIENT_ROUTER_TOOL_NAME;
  }));

  if (profile) {
    const director = new DeterministicDemoDirector(envelope as SignedCatalogEnvelope, "public");
    let lab = director.start().state;
    lab = director.captureIntake(lab, "I run a diagnostic laboratory").state;
    lab = director.captureIntake(lab, "Show reporting, engagement, and ROI").state;
    lab = director.captureIntake(lab, "About 12000 reports each month").state;
    check("first answer deterministically selects diagnostic-lab persona", lab.personaId === "diagnostic_lab");
    check("lab playlist includes preview and ROI but not booking", JSON.stringify(lab.playlistModuleIds) === JSON.stringify(["overview", "smart-reporting", "engagement", "whatsapp-preview", "roi-scenario", "customer-proof"]));
    check("lab lead answers are captured without a qualification result", lab.answers["lead.labMonthlyVolume"] === "About 12000 reports each month" && !("qualification" in lab.answers));
    check("first lab module resolves to an executable journey", director.activeJourney(lab)?.journey.id === "show-brochure-overview");

    let hospital = director.start().state;
    hospital = director.captureIntake(hospital, "We are a hospital group").state;
    hospital = director.captureIntake(hospital, "Show reporting and integrations").state;
    hospital = director.captureIntake(hospital, "Our HIS and EHR matter most").state;
    check("hospital answer selects hospital playlist", hospital.personaId === "hospital" && hospital.playlistModuleIds.includes("viz-app") && !hospital.playlistModuleIds.includes("roi-scenario"));

    let fallback = director.start().state;
    fallback = director.captureIntake(fallback, "I am exploring for a consulting team").state;
    fallback = director.captureIntake(fallback, "Give me an overview").state;
    check("unknown persona uses the signed default playlist", fallback.personaId === undefined && JSON.stringify(fallback.playlistModuleIds) === JSON.stringify(profile.defaultPlaylistModuleIds));

    const roiPlan: DemoInterruptionPlan = { intent: "product_question", responseMode: "answer", playbackDirective: "resume_after_answer", needsFreshObservation: false, needsKnowledge: true, policyAdjustments: [] };
    const roiGrounding = retrieveDemoSalesPlays(roiPlan, { catalog: envelope, demo: lab, requestText: "How does the retention ROI calculator work?" });
    check("ROI interruption retrieves bounded signed brochure plays", roiGrounding.playMode === "retrieve" && roiGrounding.selectedPlayIds.includes("play-roi-model") && roiGrounding.selectedPlayIds.length <= 3, roiGrounding.selectedPlayIds.join(", "));
  }
}

check("recording manifest uses signed text fallback without fake audio hashes", recordingManifest.status === "signed_text_fallback_ready" && recordingManifest.utterances.every((utterance) => utterance.audioAssetId === null));
await stores.close();

const failed = results.filter((result) => !result.ok);
for (const result of results) console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name}${result.detail ? `  (${result.detail})` : ""}`);
console.log(`\n${results.length - failed.length}/${results.length} guided-demo catalog checks passed.`);
if (failed.length) process.exitCode = 1;
