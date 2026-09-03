import { createHash, randomUUID } from "node:crypto";
import type { TenantContext } from "../domain/context.js";
import type { MappingJob } from "../domain/runtime.js";
import type { ProductAuth, ProductRecord } from "../products.js";
import type { MappedCatalogInput, PlatformRepositories, ProductAggregate } from "../storage/contracts.js";
import type { SecretProviderRegistry } from "../secrets/provider.js";
import { onboardProduct, preflight } from "../onboarding.js";
import { emptyGraph, type JourneyStep, type ProductGraph, type ScreenNode } from "../mapper/types.js";
import { fingerprintSnapshot } from "../runtime/screen-state.js";
import { legacyProgramToWorkflow } from "../workflow/schema.js";
import { isJourneyMachineVerified } from "../mapper/verifier.js";
import { BrainStore, type DocChunk } from "../knowledge/store.js";
import { documentJourneyPlanningEnabled, parseDocumentSections } from "../knowledge/document-structure.js";
import { extractDocumentProcedures } from "../knowledge/procedures.js";

const keyOf = (value: string) => {
  const base = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "item";
  return `${base}-${createHash("sha1").update(value).digest("hex").slice(0, 8)}`;
};

const normalizedUrl = (value: string) => {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.replace(/[?#].*$/, "").replace(/\/$/, "");
  }
};

interface MappingIdentity {
  aggregate: ProductAggregate;
  product: ProductRecord;
  roleId: string;
  roleKey: string;
}

function screenKeyFor(screens: ScreenNode[], url?: string, fingerprint?: string): string | undefined {
  const exact = fingerprint && screens.find((screen) => screen.fingerprint === fingerprint);
  if (exact) return exact.id || keyOf(exact.title);
  const normalized = url ? normalizedUrl(url) : "";
  const byUrl = normalized && screens.find((screen) => normalizedUrl(screen.url) === normalized);
  return byUrl ? byUrl.id || keyOf(byUrl.title) : undefined;
}

function controlKey(step: Pick<JourneyStep, "role" | "name">): string | undefined {
  return step.role || step.name ? keyOf(`${step.role ?? "control"}:${step.name ?? ""}`) : undefined;
}

function mappedInput(graph: ProductGraph, roleId: string, roleKey: string, mappingJobId: string): MappedCatalogInput {
  const screens = graph.screens.map((screen) => ({
    key: screen.id || keyOf(screen.title), name: screen.title, url: screen.url,
    purpose: screen.purpose, fingerprint: screen.fingerprint ?? fingerprintSnapshot({
      url: screen.url, title: screen.title, text: screen.purpose,
      elements: screen.controls.map((control, id) => ({ id, tag: "control", type: "", text: control, placeholder: "", value: "", href: "" })),
    }),
    controls: screen.controls.map((control) => {
      const match = control.match(/^([^\s]+)\s+["']([\s\S]*)["']$/);
      const parsed = { role: match?.[1], accessibleName: match?.[2] ?? control };
      return { key: keyOf(`${parsed.role ?? "control"}:${parsed.accessibleName}`), ...parsed };
    }),
  }));

  const transitions: NonNullable<MappedCatalogInput["transitions"]> = [];
  // A draft must retain every machine-verified candidate so a human can inspect
  // it. Publication remains independently gated by approval of the exact
  // revision checksum in CatalogRepository.publish().
  const journeys = graph.journeys.filter(isJourneyMachineVerified).map((journey) => {
    const baseKey = journey.id || keyOf(journey.goal);
    const journeyKey = `${baseKey}--role-${keyOf(roleKey)}`;
    for (const step of journey.steps) {
      const fromScreenKey = screenKeyFor(graph.screens, step.fromUrl ?? journey.startUrl, step.fromFingerprint);
      if (!fromScreenKey) continue;
      transitions.push({
        fromScreenKey,
        toScreenKey: screenKeyFor(graph.screens, step.toUrl, step.toFingerprint),
        controlKey: controlKey(step),
        action: { action: step.action, role: step.role, name: step.name, url: step.url },
        reliability: journey.reliability,
      });
    }
    return {
      key: journeyKey, goal: journey.goal,
      capabilityKey: keyOf(journey.capability), capabilityName: journey.capability,
      workflow: legacyProgramToWorkflow({
        id: journeyKey, name: journey.goal,
        startUrl: journey.startUrl ?? graph.startUrl, postcondition: journey.postcondition,
        program: journey.steps,
      }),
      reliability: journey.reliability, verifiedAt: journey.verifiedAt,
      evidence: {
        mapper: "generic", roleProfileId: roleId, attempts: journey.attempts,
        mappingJobId,
        proof: journey.proof ?? "text", contract: journey.evidence,
        verificationRuns: journey.verificationRuns,
        documentation: journey.documentation,
        meaning: journey.meaning,
        prerequisites: journey.preconditions, requiresJourney: journey.requiresJourney ?? [],
        screenFingerprints: [...new Set(journey.steps.flatMap((step) =>
          [step.fromFingerprint, step.toFingerprint].filter((value): value is string => !!value)))],
        screenKeys: [...new Set(journey.steps.flatMap((step) =>
          [screenKeyFor(graph.screens, step.fromUrl ?? journey.startUrl, step.fromFingerprint),
            screenKeyFor(graph.screens, step.toUrl, step.toFingerprint)]
            .filter((value): value is string => !!value)))],
      },
      depth: (journey.meaning && journey.steps.every((step) => step.say) ? 4 : 3) as 3 | 4,
      coverage: journey.coverage,
    };
  });
  return { screens, transitions, journeys };
}

/** Durable mapper orchestration. The working graph lives in job checkpoints, never in product JSON. */
export class DurableMappingPipeline {
  constructor(private readonly repositories: PlatformRepositories, private readonly secrets: SecretProviderRegistry) {}

  private async identity(ctx: TenantContext, job: MappingJob): Promise<MappingIdentity> {
    const aggregate = await this.repositories.products.get(ctx, job.productId);
    if (!aggregate) throw new Error("product not found");
    const environment = aggregate.environments.find((item) => item.id === job.environmentId);
    const roleId = String(job.cursor.roleProfileId ?? "");
    const role = aggregate.roles.find((item) => item.id === roleId && item.environmentId === environment?.id);
    if (!environment || !role) throw new Error("mapping role or environment not found");

    let auth: ProductAuth = { mode: "none" };
    if (role.credentialRefId) {
      const ref = await this.repositories.access.getCredentialRef(ctx, role.credentialRefId);
      if (!ref) throw new Error("role credential reference is missing");
      const secret = await this.secrets.resolve(ref);
      // Captured storage is portable across mapper workers. A Chrome profile is
      // machine-local and can be locked by another process, so use it only when
      // the credential has no replayable session material.
      auth = secret.sessionState || secret.sessionStorage ? { mode: "session", sessionState: secret.sessionState, sessionStorage: secret.sessionStorage }
        : secret.profileDir ? { mode: "profile", profileDir: secret.profileDir }
        : secret.username ? { mode: "login", username: secret.username, password: secret.password }
        : { mode: "none" };
    }
    return {
      aggregate, roleId: role.id, roleKey: role.key,
      product: {
        id: aggregate.product.id, organizationId: ctx.organizationId, name: aggregate.product.name,
        startUrl: environment.startUrl, auth, allowActions: [], createdAt: aggregate.product.createdAt,
      },
    };
  }

  async preflight(ctx: TenantContext, job: MappingJob, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (signal?.aborted) throw new Error("mapping interrupted");
    const identity = await this.identity(ctx, job);
    const ready = await preflight(identity.product);
    if (!ready.ok) throw new Error(ready.message);
    return { roleProfileId: identity.roleId, roleKey: identity.roleKey, ready };
  }

  async map(
    ctx: TenantContext,
    job: MappingJob,
    signal?: AbortSignal,
    checkpoint?: (cursorPatch: Record<string, unknown>) => Promise<void>,
  ): Promise<Record<string, unknown>> {
    if (signal?.aborted) throw new Error("mapping interrupted");
    const identity = await this.identity(ctx, job);
    const sourceJobId = typeof job.cursor.sourceJobId === "string" ? job.cursor.sourceJobId : undefined;
    const saved = await this.repositories.mappingJobs.getArtifact<ProductGraph>(ctx, job.id, "working-graph") ??
      (sourceJobId ? await this.repositories.mappingJobs.getArtifact<ProductGraph>(ctx, sourceJobId, "working-graph") : null) ??
      (job.cursor.mappingProgress as { graph?: ProductGraph } | undefined)?.graph;
    const initialGraph = saved ?? emptyGraph(identity.product.id, identity.product.startUrl);
    const demand = (await this.repositories.feedback.listForProduct(ctx, identity.product.id, 100))
      .filter((item) => ["unanswered_question", "friction", "journey_failure"].includes(item.kind))
      .map((item) => item.content);
    let planningKnowledge: BrainStore | undefined;
    if (documentJourneyPlanningEnabled()) {
      const stored = await this.repositories.knowledge.listForPlanning(
        ctx, identity.product.id, Number(process.env.DOC_PLANNING_CHUNK_LIMIT ?? 10000),
      );
      planningKnowledge = new BrainStore(identity.product.id);
      planningKnowledge.setDocs(stored.map((chunk): DocChunk => ({
        id: chunk.id, title: chunk.title, section: chunk.section, text: chunk.content,
        source: chunk.source,
        trust: chunk.trust === "sales_expert" ? "marketing" : chunk.trust,
        freshness: String(chunk.metadata?.sourceModifiedAt ?? new Date().toISOString()),
      })));
      const documents = new Map<string, { title: string; trust: DocChunk["trust"]; parts: string[] }>();
      for (const chunk of stored) {
        const key = `${chunk.source}\u0000${chunk.title}`;
        const document = documents.get(key) ?? {
          title: chunk.title,
          trust: chunk.trust === "sales_expert" ? "marketing" : chunk.trust,
          parts: [],
        };
        document.parts.push(chunk.content);
        documents.set(key, document);
      }
      const sections = [...documents.entries()].flatMap(([key, document]) =>
        parseDocumentSections(document.parts.join("\n\n"), {
          source: key.split("\u0000")[0], title: document.title, trust: document.trust,
        }));
      planningKnowledge.setDocumentPlanningData(sections, await extractDocumentProcedures(sections));
    }
    const outcome = await onboardProduct(identity.product, {
      durable: true,
      knowledgeStore: planningKnowledge,
      initialGraph,
      maxJobs: Number(job.cursor.maxJobs ?? process.env.MAPPING_MAX_JOBS ?? 30),
      maxScreens: Number(job.cursor.maxScreens ?? process.env.MAPPING_MAX_SCREENS ?? 50),
      demand,
      persistGraph: async (graph) => {
        const artifact = await this.repositories.mappingJobs.saveArtifact(ctx, job.id, "working-graph", graph);
        await checkpoint?.({ mappingProgress: {
          artifact: "working-graph", checksum: artifact.checksum, savedAt: new Date().toISOString(),
          screens: graph.screens.length, journeys: graph.journeys.length,
        } });
      },
      targetedJobs: Array.isArray(job.cursor.targetedJobs) ? job.cursor.targetedJobs as any : undefined,
      skipSurvey: Boolean(job.cursor.skipSurvey),
      skipExistingVerification: Boolean(job.cursor.skipExistingVerification),
      progress: async (progress) => {
        const timestamp = new Date().toISOString();
        await this.repositories.training.append(ctx, {
          id: randomUUID(), organizationId: ctx.organizationId, productId: job.productId,
          catalogVersionId: job.catalogVersionId, mappingJobId: job.id,
          eventType: `training.${progress.stage}${progress.journeyStatus ? `.${progress.journeyStatus}` : ""}`,
          actorType: "agent", actorId: "mapping-worker",
          payload: { stage: progress.stage, goal: progress.journeyGoal, currentStep: progress.currentStep,
            totalSteps: progress.totalSteps, message: progress.message, ...progress.data },
          createdAt: timestamp, updatedAt: timestamp,
        });
        await checkpoint?.({ trainingProgress: { ...progress, updatedAt: timestamp } });
      },
    });
    if (signal?.aborted) throw new Error("mapping interrupted");
    const value = mappedInput(outcome.graph, identity.roleId, identity.roleKey, job.id);
    if (!value.journeys.length) throw new Error("mapper produced no verified journeys");
    const artifact = await this.repositories.mappingJobs.saveArtifact(ctx, job.id, "mapped-catalog", value);
    return {
      artifact: "mapped-catalog", checksum: artifact.checksum,
      summary: {
        screens: value.screens.length, transitions: value.transitions?.length ?? 0,
        verifiedJourneys: value.journeys.length, roleProfileId: identity.roleId,
      },
    };
  }

  async persist(ctx: TenantContext, job: MappingJob, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (signal?.aborted) throw new Error("mapping interrupted");
    const identity = await this.identity(ctx, job);
    const output = job.cursor.map as { value?: MappedCatalogInput; artifact?: string; summary?: Record<string, unknown> } | undefined;
    const value = await this.repositories.mappingJobs.getArtifact<MappedCatalogInput>(ctx, job.id, output?.artifact ?? "mapped-catalog") ?? output?.value;
    if (!value) throw new Error("mapping output is missing from durable artifacts");
    await this.repositories.catalogs.replaceMappedCatalog(ctx, job.catalogVersionId, identity.roleId, value);
    return { ...(output?.summary ?? {}), catalogVersionId: job.catalogVersionId };
  }
}
