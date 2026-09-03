import type { ValidationIssue, ValidationResult } from "./common.js";
import { ContractValidationError } from "./common.js";
import {
  CONTRACT_LIMITS,
  SDK_CATALOG_SCHEMA_VERSION,
  SDK_OBSERVATION_SCHEMA_VERSION,
  SDK_PROTOCOL_VERSION,
  SDK_TELEMETRY_SCHEMA_VERSION,
  SDK_TOKEN_MAX_LIFETIME_SECONDS,
  SDK_TOKEN_SCHEMA_VERSION,
  SDK_WORKFLOW_SCHEMA_VERSION,
} from "./constants.js";
import type {
  CatalogControl,
  CatalogScreen,
  JourneyDefinition,
  PrivacyPolicy,
  SdkCatalog,
  SignedCatalogEnvelope,
  TelemetryPolicy,
  ToolDefinition,
} from "./catalog.js";
import type { SdkIdentityClaims, SdkSessionClaims, SdkSocketTicketClaims } from "./identity.js";
import type { SdkBootstrapRequest, SdkBootstrapResponse, SdkClientMessage, SdkServerCommand } from "./protocol.js";
import type { SdkTelemetryBatch } from "./telemetry.js";
import type {
  JourneyInputSchema,
  LocatorCandidate,
  ScreenObservation,
  StepCompatibility,
  TemplateValue,
  WorkflowAssertion,
  WorkflowDefinition,
  WorkflowStep,
  WorkflowTarget,
} from "./workflow.js";

type RecordValue = Record<string, unknown>;

class Checker {
  readonly issues: ValidationIssue[] = [];

  issue(path: string, message: string): void {
    this.issues.push({ path, message });
  }

  object(value: unknown, path: string): RecordValue | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      this.issue(path, "must be an object");
      return undefined;
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      this.issue(path, "must be a plain JSON object");
      return undefined;
    }
    return value as RecordValue;
  }

  array(value: unknown, path: string, maximum = Number.MAX_SAFE_INTEGER): unknown[] | undefined {
    if (!Array.isArray(value)) {
      this.issue(path, "must be an array");
      return undefined;
    }
    if (value.length > maximum) this.issue(path, `must contain at most ${maximum} items`);
    return value;
  }

  string(value: unknown, path: string, options: { nonEmpty?: boolean; maximum?: number } = {}): value is string {
    if (typeof value !== "string") {
      this.issue(path, "must be a string");
      return false;
    }
    if (options.nonEmpty && !value.trim()) this.issue(path, "must not be empty");
    if (value.length > (options.maximum ?? CONTRACT_LIMITS.stringChars)) {
      this.issue(path, `must contain at most ${options.maximum ?? CONTRACT_LIMITS.stringChars} characters`);
    }
    return true;
  }

  boolean(value: unknown, path: string): value is boolean {
    if (typeof value !== "boolean") {
      this.issue(path, "must be a boolean");
      return false;
    }
    return true;
  }

  number(value: unknown, path: string, options: { integer?: boolean; minimum?: number; maximum?: number } = {}): value is number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      this.issue(path, "must be a finite number");
      return false;
    }
    if (options.integer && !Number.isInteger(value)) this.issue(path, "must be an integer");
    if (options.minimum !== undefined && value < options.minimum) this.issue(path, `must be at least ${options.minimum}`);
    if (options.maximum !== undefined && value > options.maximum) this.issue(path, `must be at most ${options.maximum}`);
    return true;
  }

  literal<T extends string | number | boolean>(value: unknown, expected: T, path: string): value is T {
    if (value !== expected) {
      this.issue(path, `must equal ${JSON.stringify(expected)}`);
      return false;
    }
    return true;
  }

  oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): value is T {
    if (typeof value !== "string" || !allowed.includes(value as T)) {
      this.issue(path, `must be one of ${allowed.join(", ")}`);
      return false;
    }
    return true;
  }

  stringArray(value: unknown, path: string, maximum = 10_000): string[] | undefined {
    const values = this.array(value, path, maximum);
    if (!values) return undefined;
    for (let i = 0; i < values.length; i++) this.string(values[i], `${path}[${i}]`, { nonEmpty: true });
    return values.filter((item): item is string => typeof item === "string");
  }

  isoDate(value: unknown, path: string): value is string {
    if (!this.string(value, path, { nonEmpty: true, maximum: 64 })) return false;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
      this.issue(path, "must be an ISO-8601 UTC timestamp");
      return false;
    }
    return true;
  }

  id(value: unknown, path: string): value is string {
    return this.string(value, path, { nonEmpty: true, maximum: 256 });
  }

  onlyKeys(object: RecordValue, allowed: readonly string[], path: string): void {
    const accepted = new Set(allowed);
    for (const key of Object.keys(object)) {
      if (!accepted.has(key)) this.issue(`${path}.${key}`, "is not allowed by this schema version");
    }
  }
}

function result<T>(checker: Checker, value: unknown): ValidationResult<T> {
  return checker.issues.length
    ? { ok: false, issues: checker.issues }
    : { ok: true, value: value as T, issues: [] };
}

function assertResult<T>(name: string, validation: ValidationResult<T>): T {
  if (!validation.ok) throw new ContractValidationError(name, validation.issues);
  return validation.value;
}

function optionalString(checker: Checker, object: RecordValue, key: string, path: string, maximum?: number): void {
  if (object[key] !== undefined) checker.string(object[key], `${path}.${key}`, { nonEmpty: true, ...(maximum === undefined ? {} : { maximum }) });
}

function optionalBoolean(checker: Checker, object: RecordValue, key: string, path: string): void {
  if (object[key] !== undefined) checker.boolean(object[key], `${path}.${key}`);
}

function optionalNumber(checker: Checker, object: RecordValue, key: string, path: string, minimum?: number, maximum?: number): void {
  if (object[key] !== undefined) checker.number(object[key], `${path}.${key}`, {
    ...(minimum === undefined ? {} : { minimum }),
    ...(maximum === undefined ? {} : { maximum }),
  });
}

function checkSemver(checker: Checker, value: unknown, path: string): void {
  if (!checker.string(value, path, { nonEmpty: true, maximum: 64 })) return;
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value)) {
    checker.issue(path, "must be a semantic version");
  }
}

function checkJson(checker: Checker, value: unknown, path: string, depth = 0): void {
  if (depth > CONTRACT_LIMITS.workflowDepth) {
    checker.issue(path, `must not exceed ${CONTRACT_LIMITS.workflowDepth} levels`);
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) checker.issue(path, "must be a finite JSON number");
    return;
  }
  if (typeof value === "string") {
    checker.string(value, path);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 10_000) checker.issue(path, "must contain at most 10000 items");
    value.forEach((item, index) => checkJson(checker, item, `${path}[${index}]`, depth + 1));
    return;
  }
  const object = checker.object(value, path);
  if (!object) return;
  const keys = Object.keys(object);
  if (keys.length > 10_000) checker.issue(path, "must contain at most 10000 properties");
  for (const [key, item] of Object.entries(object)) {
    if (!key || key.length > 256) checker.issue(`${path}.${key}`, "property name must contain 1 to 256 characters");
    checkJson(checker, item, `${path}.${key}`, depth + 1);
  }
}

const RISKS = ["read", "reversible_write", "external_side_effect", "destructive"] as const;
const COMPATIBILITY = [
  "SDK_DIRECT",
  "SDK_RESUMABLE_NAVIGATION",
  "NEEDS_STABLE_MARKER",
  "NEEDS_REGISTERED_TOOL",
  "NEEDS_USER_GESTURE",
  "NEEDS_FRAME_BRIDGE",
  "EXTENSION_ONLY",
  "HUMAN_ONLY",
  "UNSUPPORTED",
] as const;

function checkCompatibility(checker: Checker, value: unknown, path: string, expectedStepId?: string): void {
  const object = checker.object(value, path);
  if (!object) return;
  checker.literal(object.kind, "sable.step_compatibility", `${path}.kind`);
  checker.id(object.stepId, `${path}.stepId`);
  if (expectedStepId && object.stepId !== expectedStepId) checker.issue(`${path}.stepId`, `must equal owning step id ${expectedStepId}`);
  checker.oneOf(object.classification, COMPATIBILITY, `${path}.classification`);
  checker.string(object.reason, `${path}.reason`, { nonEmpty: true, maximum: 2_000 });
  if (object.requirements !== undefined) checker.stringArray(object.requirements, `${path}.requirements`, 100);
  if (object.verifiedAt !== undefined) checker.isoDate(object.verifiedAt, `${path}.verifiedAt`);
  optionalString(checker, object, "verifiedSdkVersion", path, 64);
  if (object.verifiedSdkArtifactSha256 !== undefined) {
    if (!checker.string(object.verifiedSdkArtifactSha256, `${path}.verifiedSdkArtifactSha256`, { nonEmpty: true, maximum: 64 }) || !/^[a-f0-9]{64}$/i.test(String(object.verifiedSdkArtifactSha256))) {
      checker.issue(`${path}.verifiedSdkArtifactSha256`, "must be a SHA-256 hex digest");
    }
  }
  optionalString(checker, object, "verifiedApplicationBuild", path, 256);
}

function checkLocator(checker: Checker, value: unknown, path: string): void {
  const object = checker.object(value, path);
  if (!object) return;
  const kind = object.kind;
  checker.oneOf(kind, ["agent_id", "aria_role_name", "label", "test_id", "text", "relationship", "css_fallback"], `${path}.kind`);
  checker.number(object.rank, `${path}.rank`, { integer: true, minimum: 1, maximum: 1_000 });
  optionalNumber(checker, object, "confidence", path, 0, 1);
  optionalBoolean(checker, object, "exact", path);
  if (kind === "agent_id" || kind === "test_id") checker.string(object.value, `${path}.value`, { nonEmpty: true, maximum: 512 });
  else if (kind === "aria_role_name") {
    checker.string(object.role, `${path}.role`, { nonEmpty: true, maximum: 128 });
    checker.string(object.name, `${path}.name`, { nonEmpty: true, maximum: 1_000 });
  } else if (kind === "label" || kind === "text") checker.string(object.text, `${path}.text`, { nonEmpty: true, maximum: 2_000 });
  else if (kind === "relationship") {
    checker.id(object.withinControlId, `${path}.withinControlId`);
    optionalString(checker, object, "role", path, 128);
    optionalString(checker, object, "name", path, 1_000);
    if (object.role === undefined && object.name === undefined) checker.issue(path, "relationship locator needs role or name");
  } else if (kind === "css_fallback") checker.string(object.selector, `${path}.selector`, { nonEmpty: true, maximum: 2_000 });
}

function checkTarget(checker: Checker, value: unknown, path: string): void {
  const object = checker.object(value, path);
  if (!object) return;
  checker.id(object.controlId, `${path}.controlId`);
  optionalString(checker, object, "screenId", path, 256);
  if (object.locators !== undefined) {
    const locators = checker.array(object.locators, `${path}.locators`, CONTRACT_LIMITS.locatorsPerControl);
    locators?.forEach((locator, index) => checkLocator(checker, locator, `${path}.locators[${index}]`));
  }
}

function checkTemplate(checker: Checker, value: unknown, path: string, inputNames?: Set<string>, depth = 0): void {
  if (depth > CONTRACT_LIMITS.workflowDepth) {
    checker.issue(path, `must not exceed ${CONTRACT_LIMITS.workflowDepth} levels`);
    return;
  }
  const object = checker.object(value, path);
  if (!object) return;
  const kind = object.kind;
  checker.oneOf(kind, ["literal", "input_ref", "object", "array"], `${path}.kind`);
  if (kind === "literal") checkJson(checker, object.value, `${path}.value`);
  else if (kind === "input_ref") {
    if (checker.id(object.name, `${path}.name`) && inputNames && !inputNames.has(object.name as string)) {
      checker.issue(`${path}.name`, `references undefined journey input ${String(object.name)}`);
    }
    if (object.fallback !== undefined) checkJson(checker, object.fallback, `${path}.fallback`);
    if (object.transforms !== undefined) {
      const transforms = checker.array(object.transforms, `${path}.transforms`, 10);
      transforms?.forEach((transform, index) => checker.oneOf(transform, ["trim", "lowercase", "uppercase", "stringify"], `${path}.transforms[${index}]`));
    }
  } else if (kind === "object") {
    const properties = checker.object(object.properties, `${path}.properties`);
    if (properties) Object.entries(properties).forEach(([key, item]) => checkTemplate(checker, item, `${path}.properties.${key}`, inputNames, depth + 1));
  } else if (kind === "array") {
    const items = checker.array(object.items, `${path}.items`, 1_000);
    items?.forEach((item, index) => checkTemplate(checker, item, `${path}.items[${index}]`, inputNames, depth + 1));
  }
}

function checkAssertion(checker: Checker, value: unknown, path: string, inputNames?: Set<string>): void {
  const object = checker.object(value, path);
  if (!object) return;
  const kind = object.kind;
  checker.oneOf(kind, ["text_visible", "text_absent", "url_matches", "control_visible", "control_enabled", "screen_matches", "screen_changed", "list_changed", "tool_check"], `${path}.kind`);
  if (kind === "text_visible" || kind === "text_absent") checker.string(object.text, `${path}.text`, { nonEmpty: true, maximum: 5_000 });
  else if (kind === "url_matches") checker.string(object.pattern, `${path}.pattern`, { nonEmpty: true, maximum: 2_000 });
  else if (kind === "control_visible" || kind === "control_enabled") checkTarget(checker, object.target, `${path}.target`);
  else if (kind === "screen_matches") {
    checker.id(object.screenId, `${path}.screenId`);
    optionalNumber(checker, object, "minimumConfidence", path, 0, 1);
  } else if (kind === "screen_changed") optionalString(checker, object, "fromFingerprint", path, 512);
  else if (kind === "list_changed") optionalString(checker, object, "fromSignature", path, 512);
  else if (kind === "tool_check") {
    checker.id(object.toolName, `${path}.toolName`);
    checker.id(object.operation, `${path}.operation`);
    if (object.input !== undefined) checkTemplate(checker, object.input, `${path}.input`, inputNames);
  }
}

function checkInputSchema(checker: Checker, value: unknown, path: string): Set<string> {
  const names = new Set<string>();
  const object = checker.object(value, path);
  if (!object) return names;
  checker.literal(object.kind, "sable.journey_input_schema", `${path}.kind`);
  checker.literal(object.additionalProperties, false, `${path}.additionalProperties`);
  const properties = checker.object(object.properties, `${path}.properties`);
  if (properties) {
    for (const [name, rawProperty] of Object.entries(properties)) {
      names.add(name);
      if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(name)) checker.issue(`${path}.properties.${name}`, "input name must begin with a letter and contain only letters, numbers, dot, underscore, or hyphen");
      const property = checker.object(rawProperty, `${path}.properties.${name}`);
      if (!property) continue;
      checker.oneOf(property.type, ["string", "number", "boolean", "enum", "json"], `${path}.properties.${name}.type`);
      optionalString(checker, property, "description", `${path}.properties.${name}`, 2_000);
      optionalBoolean(checker, property, "secret", `${path}.properties.${name}`);
      optionalNumber(checker, property, "minimum", `${path}.properties.${name}`);
      optionalNumber(checker, property, "maximum", `${path}.properties.${name}`);
      optionalNumber(checker, property, "minimumLength", `${path}.properties.${name}`, 0, 100_000);
      optionalNumber(checker, property, "maximumLength", `${path}.properties.${name}`, 0, 100_000);
      optionalString(checker, property, "pattern", `${path}.properties.${name}`, 2_000);
      if (typeof property.minimum === "number" && typeof property.maximum === "number" && property.minimum > property.maximum) checker.issue(`${path}.properties.${name}`, "minimum must not exceed maximum");
      if (typeof property.minimumLength === "number" && typeof property.maximumLength === "number" && property.minimumLength > property.maximumLength) checker.issue(`${path}.properties.${name}`, "minimumLength must not exceed maximumLength");
      if (typeof property.pattern === "string") {
        try { new RegExp(property.pattern); } catch { checker.issue(`${path}.properties.${name}.pattern`, "must be a valid regular expression"); }
      }
      if (property.enum !== undefined) {
        const choices = checker.array(property.enum, `${path}.properties.${name}.enum`, 1_000);
        choices?.forEach((choice, index) => checkJson(checker, choice, `${path}.properties.${name}.enum[${index}]`));
        if (choices?.length === 0) checker.issue(`${path}.properties.${name}.enum`, "must not be empty");
        if (property.type !== "enum") checker.issue(`${path}.properties.${name}.enum`, "is allowed only for enum inputs");
      } else if (property.type === "enum") checker.issue(`${path}.properties.${name}.enum`, "is required for enum inputs");
      if (property.default !== undefined) {
        checkJson(checker, property.default, `${path}.properties.${name}.default`);
        const defaultMatches = property.type === "json"
          || (property.type === "string" && typeof property.default === "string")
          || (property.type === "number" && typeof property.default === "number" && Number.isFinite(property.default))
          || (property.type === "boolean" && typeof property.default === "boolean")
          || (property.type === "enum" && Array.isArray(property.enum) && property.enum.some((choice) => JSON.stringify(choice) === JSON.stringify(property.default)));
        if (!defaultMatches) checker.issue(`${path}.properties.${name}.default`, `must match input type ${String(property.type)}`);
      }
    }
  }
  const required = checker.stringArray(object.required, `${path}.required`, 1_000);
  required?.forEach((name, index) => {
    if (!names.has(name)) checker.issue(`${path}.required[${index}]`, `references undefined input ${name}`);
    if (required.indexOf(name) !== index) checker.issue(`${path}.required[${index}]`, `duplicates required input ${name}`);
  });
  return names;
}

interface WorkflowCheckContext {
  inputNames?: Set<string>;
  stepIds: Set<string>;
  compatibilityByStep: Map<string, string>;
  stepCount: number;
}

function checkSteps(checker: Checker, value: unknown, path: string, context: WorkflowCheckContext, depth: number): void {
  if (depth > CONTRACT_LIMITS.workflowDepth) {
    checker.issue(path, `must not exceed ${CONTRACT_LIMITS.workflowDepth} nested levels`);
    return;
  }
  const steps = checker.array(value, path, CONTRACT_LIMITS.workflowSteps);
  if (!steps) return;
  for (let index = 0; index < steps.length; index++) {
    const at = `${path}[${index}]`;
    const step = checker.object(steps[index], at);
    if (!step) continue;
    context.stepCount++;
    if (context.stepCount > CONTRACT_LIMITS.workflowSteps) checker.issue(at, `workflow must execute at most ${CONTRACT_LIMITS.workflowSteps} structural steps`);
    const id = checker.id(step.id, `${at}.id`) ? (step.id as string) : "";
    if (id && context.stepIds.has(id)) checker.issue(`${at}.id`, `duplicates step id ${id}`);
    if (id) context.stepIds.add(id);
    const kind = step.kind;
    checker.oneOf(kind, ["action", "assert", "approval", "branch", "loop"], `${at}.kind`);
    optionalString(checker, step, "narration", at, 5_000);
    optionalString(checker, step, "narrationAudioAssetId", at, 256);
    optionalNumber(checker, step, "timeoutMs", at, 1, 120_000);
    if (step.risk !== undefined) checker.oneOf(step.risk, RISKS, `${at}.risk`);
    optionalBoolean(checker, step, "optional", at);
    checkCompatibility(checker, step.compatibility, `${at}.compatibility`, id || undefined);
    const classification = step.compatibility && typeof step.compatibility === "object" ? (step.compatibility as RecordValue).classification : undefined;
    if (classification === "SDK_RESUMABLE_NAVIGATION" && !(kind === "action" && step.action === "navigate")) {
      checker.issue(`${at}.compatibility.classification`, "is allowed only on navigate actions");
    }
    if (id && step.compatibility && typeof step.compatibility === "object" && typeof (step.compatibility as RecordValue).classification === "string") {
      context.compatibilityByStep.set(id, (step.compatibility as RecordValue).classification as string);
    }

    if (kind === "action") {
      const action = step.action;
      checker.oneOf(action, ["navigate", "click", "fill", "select", "scroll", "keypress", "hover", "drag", "wait", "tool_call"], `${at}.action`);
      if (action === "navigate") {
        checkTemplate(checker, step.url, `${at}.url`, context.inputNames);
        if (step.continuity !== undefined) {
          const continuity = checker.object(step.continuity, `${at}.continuity`);
          if (continuity) {
            checker.literal(continuity.kind, "sable.cross_page_continuity", `${at}.continuity.kind`);
            const screens = checker.stringArray(continuity.expectedScreenIds, `${at}.continuity.expectedScreenIds`, 20);
            if (screens?.length === 0) checker.issue(`${at}.continuity.expectedScreenIds`, "must not be empty");
            const origins = checker.stringArray(continuity.destinationOrigins, `${at}.continuity.destinationOrigins`, 20);
            if (origins?.length === 0) checker.issue(`${at}.continuity.destinationOrigins`, "must not be empty");
            origins?.forEach((origin, originIndex) => {
              try { if (new URL(origin).origin !== origin) checker.issue(`${at}.continuity.destinationOrigins[${originIndex}]`, "must be an exact http(s) origin"); }
              catch { checker.issue(`${at}.continuity.destinationOrigins[${originIndex}]`, "must be an exact http(s) origin"); }
            });
          }
        }
        if (step.compatibility && typeof step.compatibility === "object" && (step.compatibility as RecordValue).classification === "SDK_RESUMABLE_NAVIGATION" && step.continuity === undefined) {
          checker.issue(`${at}.continuity`, "is required for SDK_RESUMABLE_NAVIGATION");
        }
        if (step.continuity !== undefined && classification !== "SDK_RESUMABLE_NAVIGATION") checker.issue(`${at}.compatibility.classification`, "must be SDK_RESUMABLE_NAVIGATION when continuity metadata is present");
      }
      else if (action === "click" || action === "hover") checkTarget(checker, step.target, `${at}.target`);
      else if (action === "fill" || action === "select") {
        checkTarget(checker, step.target, `${at}.target`);
        checkTemplate(checker, step.value, `${at}.value`, context.inputNames);
        if (action === "fill") optionalBoolean(checker, step, "submit", at);
      } else if (action === "scroll") {
        checker.oneOf(step.direction, ["up", "down"], `${at}.direction`);
        optionalNumber(checker, step, "amount", at, 1, 100_000);
        if (step.target !== undefined) checkTarget(checker, step.target, `${at}.target`);
      } else if (action === "keypress") {
        checker.string(step.key, `${at}.key`, { nonEmpty: true, maximum: 128 });
        if (step.target !== undefined) checkTarget(checker, step.target, `${at}.target`);
      } else if (action === "drag") {
        checkTarget(checker, step.source, `${at}.source`);
        checkTarget(checker, step.target, `${at}.target`);
      } else if (action === "wait") {
        optionalNumber(checker, step, "milliseconds", at, 1, 120_000);
        if (step.until !== undefined) checkAssertion(checker, step.until, `${at}.until`, context.inputNames);
        if (step.milliseconds === undefined && step.until === undefined) checker.issue(at, "wait action needs milliseconds or until");
      } else if (action === "tool_call") {
        checker.id(step.toolName, `${at}.toolName`);
        checkTemplate(checker, step.input, `${at}.input`, context.inputNames);
      }
    } else if (kind === "assert") checkAssertion(checker, step.assertion, `${at}.assertion`, context.inputNames);
    else if (kind === "approval") {
      checker.string(step.reason, `${at}.reason`, { nonEmpty: true, maximum: 5_000 });
      checkSteps(checker, step.then, `${at}.then`, context, depth + 1);
    } else if (kind === "branch") {
      checkAssertion(checker, step.condition, `${at}.condition`, context.inputNames);
      checkSteps(checker, step.then, `${at}.then`, context, depth + 1);
      if (step.otherwise !== undefined) checkSteps(checker, step.otherwise, `${at}.otherwise`, context, depth + 1);
    } else if (kind === "loop") {
      checkAssertion(checker, step.until, `${at}.until`, context.inputNames);
      checker.number(step.maxIterations, `${at}.maxIterations`, { integer: true, minimum: 1, maximum: 20 });
      checkSteps(checker, step.steps, `${at}.steps`, context, depth + 1);
    }
  }
}

function checkWorkflow(checker: Checker, value: unknown, path: string, inputNames?: Set<string>): WorkflowCheckContext {
  const context: WorkflowCheckContext = {
    ...(inputNames ? { inputNames } : {}),
    stepIds: new Set<string>(),
    compatibilityByStep: new Map<string, string>(),
    stepCount: 0,
  };
  const object = checker.object(value, path);
  if (!object) return context;
  checker.literal(object.kind, "sable.workflow", `${path}.kind`);
  checker.literal(object.schemaVersion, SDK_WORKFLOW_SCHEMA_VERSION, `${path}.schemaVersion`);
  checker.id(object.id, `${path}.id`);
  checker.number(object.version, `${path}.version`, { integer: true, minimum: 1 });
  checker.string(object.name, `${path}.name`, { nonEmpty: true, maximum: 1_000 });
  optionalString(checker, object, "description", path, 5_000);
  if (object.behavior !== undefined) {
    const behavior = checker.object(object.behavior, `${path}.behavior`);
    if (behavior) {
      checker.oneOf(behavior.kind, ["navigation", "reversible_change", "form_submission", "external_side_effect", "destructive", "unknown"], `${path}.behavior.kind`);
      checker.string(behavior.summary, `${path}.behavior.summary`, { nonEmpty: true, maximum: 5_000 });
    }
  }
  if (object.startUrl !== undefined) checkTemplate(checker, object.startUrl, `${path}.startUrl`, inputNames);
  checker.oneOf(object.risk, RISKS, `${path}.risk`);
  const preconditions = checker.array(object.preconditions, `${path}.preconditions`, 100);
  preconditions?.forEach((assertion, index) => checkAssertion(checker, assertion, `${path}.preconditions[${index}]`, inputNames));
  checkSteps(checker, object.steps, `${path}.steps`, context, 0);
  if (Array.isArray(object.steps) && object.steps.length === 0) checker.issue(`${path}.steps`, "must not be empty");
  const postconditions = checker.array(object.postconditions, `${path}.postconditions`, 100);
  postconditions?.forEach((assertion, index) => checkAssertion(checker, assertion, `${path}.postconditions[${index}]`, inputNames));
  return context;
}

export function validateWorkflowDefinition(value: unknown): ValidationResult<WorkflowDefinition> {
  const checker = new Checker();
  checkWorkflow(checker, value, "$workflow");
  return result(checker, value);
}

export function assertValidWorkflowDefinition(value: unknown): WorkflowDefinition {
  return assertResult("WorkflowDefinition", validateWorkflowDefinition(value));
}

function checkScreenObservation(checker: Checker, value: unknown, path: string): void {
  const object = checker.object(value, path);
  if (!object) return;
  checker.literal(object.kind, "sable.screen_observation", `${path}.kind`);
  checker.literal(object.schemaVersion, SDK_OBSERVATION_SCHEMA_VERSION, `${path}.schemaVersion`);
  checker.id(object.observationId, `${path}.observationId`);
  checker.number(object.version, `${path}.version`, { integer: true, minimum: 0 });
  checker.isoDate(object.capturedAt, `${path}.capturedAt`);
  checker.string(object.url, `${path}.url`, { nonEmpty: true, maximum: 10_000 });
  checker.string(object.origin, `${path}.origin`, { nonEmpty: true, maximum: 2_000 });
  checker.string(object.title, `${path}.title`, { maximum: 5_000 });
  checker.string(object.fingerprint, `${path}.fingerprint`, { nonEmpty: true, maximum: 512 });
  optionalString(checker, object, "visibleText", path, CONTRACT_LIMITS.stringChars);
  optionalString(checker, object, "matchedScreenId", path, 256);
  optionalNumber(checker, object, "matchConfidence", path, 0, 1);
  const elements = checker.array(object.elements, `${path}.elements`, CONTRACT_LIMITS.observedElements);
  elements?.forEach((rawElement, index) => {
    const at = `${path}.elements[${index}]`;
    const element = checker.object(rawElement, at);
    if (!element) return;
    checker.id(element.id, `${at}.id`);
    checker.string(element.role, `${at}.role`, { nonEmpty: true, maximum: 128 });
    checker.string(element.name, `${at}.name`, { maximum: 2_000 });
    checker.boolean(element.visible, `${at}.visible`);
    checker.boolean(element.enabled, `${at}.enabled`);
    optionalString(checker, element, "value", at, 5_000);
    optionalBoolean(checker, element, "checked", at);
    optionalBoolean(checker, element, "selected", at);
    optionalString(checker, element, "controlId", at, 256);
    if (element.privacyTags !== undefined) checker.stringArray(element.privacyTags, `${at}.privacyTags`, 100);
  });
}

export function validateScreenObservation(value: unknown): ValidationResult<ScreenObservation> {
  const checker = new Checker();
  checkScreenObservation(checker, value, "$observation");
  return result(checker, value);
}

export function assertValidScreenObservation(value: unknown): ScreenObservation {
  return assertResult("ScreenObservation", validateScreenObservation(value));
}

function checkScreen(checker: Checker, value: unknown, path: string): void {
  const object = checker.object(value, path);
  if (!object) return;
  checker.literal(object.kind, "sable.catalog.screen", `${path}.kind`);
  checker.id(object.id, `${path}.id`);
  checker.string(object.name, `${path}.name`, { nonEmpty: true, maximum: 1_000 });
  if (object.roles !== undefined) checker.stringArray(object.roles, `${path}.roles`, 1_000);
  if (object.privacyTags !== undefined) checker.stringArray(object.privacyTags, `${path}.privacyTags`, 100);
  const variants = checker.array(object.variants, `${path}.variants`, 100);
  if (variants?.length === 0) checker.issue(`${path}.variants`, "must not be empty");
  variants?.forEach((rawVariant, index) => {
    const at = `${path}.variants[${index}]`;
    const variant = checker.object(rawVariant, at);
    if (!variant) return;
    checker.id(variant.id, `${at}.id`);
    optionalString(checker, variant, "locale", at, 64);
    if (variant.viewport !== undefined) {
      const viewport = checker.object(variant.viewport, `${at}.viewport`);
      if (viewport) {
        optionalNumber(checker, viewport, "minimumWidth", `${at}.viewport`, 1, 100_000);
        optionalNumber(checker, viewport, "maximumWidth", `${at}.viewport`, 1, 100_000);
        if (typeof viewport.minimumWidth === "number" && typeof viewport.maximumWidth === "number" && viewport.minimumWidth > viewport.maximumWidth) {
          checker.issue(`${at}.viewport`, "minimumWidth must not exceed maximumWidth");
        }
      }
    }
    checker.number(variant.minimumConfidence, `${at}.minimumConfidence`, { minimum: 0, maximum: 1 });
    const anchors = checker.array(variant.anchors, `${at}.anchors`, 100);
    // Empty anchors explicitly represent an unresolved training screen. They
    // are never sufficient for an SDK_DIRECT screen assertion.
    anchors?.forEach((rawAnchor, anchorIndex) => {
      const anchorAt = `${at}.anchors[${anchorIndex}]`;
      const anchor = checker.object(rawAnchor, anchorAt);
      if (!anchor) return;
      checker.oneOf(anchor.kind, ["route", "title", "text", "control", "dom_marker"], `${anchorAt}.kind`);
      checker.number(anchor.weight, `${anchorAt}.weight`, { minimum: 0, maximum: 100 });
      if (anchor.kind === "route") checker.string(anchor.pattern, `${anchorAt}.pattern`, { nonEmpty: true, maximum: 2_000 });
      else if (anchor.kind === "title" || anchor.kind === "text") checker.string(anchor.text, `${anchorAt}.text`, { nonEmpty: true, maximum: 5_000 });
      else if (anchor.kind === "control") checker.id(anchor.controlId, `${anchorAt}.controlId`);
      else if (anchor.kind === "dom_marker") {
        checker.string(anchor.attribute, `${anchorAt}.attribute`, { nonEmpty: true, maximum: 256 });
        checker.string(anchor.value, `${anchorAt}.value`, { nonEmpty: true, maximum: 2_000 });
      }
    });
  });
}

function checkControl(checker: Checker, value: unknown, path: string): void {
  const object = checker.object(value, path);
  if (!object) return;
  checker.literal(object.kind, "sable.catalog.control", `${path}.kind`);
  checker.id(object.id, `${path}.id`);
  checker.id(object.screenId, `${path}.screenId`);
  checker.string(object.name, `${path}.name`, { nonEmpty: true, maximum: 1_000 });
  checker.oneOf(object.risk, RISKS, `${path}.risk`);
  const locators = checker.array(object.locators, `${path}.locators`, CONTRACT_LIMITS.locatorsPerControl);
  // Empty locators let staging and production catalogs carry a blocked/manual
  // handoff. SDK_DIRECT steps are checked separately and cannot use them.
  const ranks = new Set<number>();
  locators?.forEach((locator, index) => {
    checkLocator(checker, locator, `${path}.locators[${index}]`);
    if (locator && typeof locator === "object" && typeof (locator as RecordValue).rank === "number") {
      const rank = (locator as RecordValue).rank as number;
      if (ranks.has(rank)) checker.issue(`${path}.locators[${index}].rank`, `duplicates locator rank ${rank}`);
      ranks.add(rank);
    }
  });
  if (object.frame !== undefined) {
    const frame = checker.object(object.frame, `${path}.frame`);
    if (frame) {
      checker.oneOf(frame.kind, ["same_origin", "bridge_required"], `${path}.frame.kind`);
      optionalString(checker, frame, "name", `${path}.frame`, 512);
    }
  }
  if (object.shadow !== undefined) {
    const shadow = checker.object(object.shadow, `${path}.shadow`);
    if (shadow) {
      checker.oneOf(shadow.kind, ["open", "closed"], `${path}.shadow.kind`);
      optionalString(checker, shadow, "hostControlId", `${path}.shadow`, 256);
    }
  }
  if (object.privacyTags !== undefined) checker.stringArray(object.privacyTags, `${path}.privacyTags`, 100);
}

function checkPrivacyPolicy(checker: Checker, value: unknown, path: string): void {
  const object = checker.object(value, path);
  if (!object) return;
  checker.literal(object.kind, "sable.catalog.privacy_policy", `${path}.kind`);
  checker.literal(object.schemaVersion, SDK_CATALOG_SCHEMA_VERSION, `${path}.schemaVersion`);
  checker.oneOf(object.defaultTextTreatment, ["allow", "redact"], `${path}.defaultTextTreatment`);
  checker.oneOf(object.screenshots, ["disabled", "consent_required", "enabled"], `${path}.screenshots`);
  checker.stringArray(object.excludedRoutes, `${path}.excludedRoutes`, 1_000);
  checker.number(object.maximumVisibleTextChars, `${path}.maximumVisibleTextChars`, { integer: true, minimum: 0, maximum: CONTRACT_LIMITS.stringChars });
  checker.boolean(object.allowElementValues, `${path}.allowElementValues`);
  const rules = checker.array(object.rules, `${path}.rules`, 10_000);
  rules?.forEach((rawRule, index) => {
    const at = `${path}.rules[${index}]`;
    const rule = checker.object(rawRule, at);
    if (!rule) return;
    checker.oneOf(rule.kind, ["selector", "input_type", "attribute", "text_pattern"], `${at}.kind`);
    checker.oneOf(rule.action, rule.kind === "text_pattern" ? ["redact"] : ["exclude", "redact"], `${at}.action`);
    optionalString(checker, rule, "replacement", at, 256);
    if (rule.kind === "selector") checker.string(rule.selector, `${at}.selector`, { nonEmpty: true, maximum: 2_000 });
    else if (rule.kind === "input_type") checker.string(rule.inputType, `${at}.inputType`, { nonEmpty: true, maximum: 128 });
    else if (rule.kind === "attribute") {
      checker.string(rule.attribute, `${at}.attribute`, { nonEmpty: true, maximum: 256 });
      optionalString(checker, rule, "value", at, 2_000);
    } else if (rule.kind === "text_pattern") {
      checker.string(rule.pattern, `${at}.pattern`, { nonEmpty: true, maximum: 2_000 });
      optionalString(checker, rule, "flags", at, 16);
      if (typeof rule.flags === "string" && (!/^[dgimsuvy]*$/.test(rule.flags) || new Set(rule.flags).size !== rule.flags.length)) {
        checker.issue(`${at}.flags`, "must contain unique JavaScript regular-expression flags");
      }
      if (typeof rule.pattern === "string") {
        try {
          // Compilation catches malformed patterns. Runtime privacy engines must
          // additionally use bounded input and execution time.
          new RegExp(rule.pattern as string, typeof rule.flags === "string" ? rule.flags : undefined);
        } catch {
          checker.issue(`${at}.pattern`, "must be a valid regular expression");
        }
      }
    }
  });
}

function checkTelemetryPolicy(checker: Checker, value: unknown, path: string): void {
  const object = checker.object(value, path);
  if (!object) return;
  checker.literal(object.kind, "sable.catalog.telemetry_policy", `${path}.kind`);
  checker.literal(object.schemaVersion, SDK_CATALOG_SCHEMA_VERSION, `${path}.schemaVersion`);
  checker.boolean(object.enabled, `${path}.enabled`);
  checker.number(object.sampleRate, `${path}.sampleRate`, { minimum: 0, maximum: 1 });
  const eventTypes = ["session.started", "session.stopped", "catalog.loaded", "screen.matched", "element.resolved", "action.completed", "journey.started", "journey.completed", "journey.failed", "approval.requested", "approval.resolved", "privacy.redacted", "transport.state", "sdk.error"] as const;
  const allowedEvents = checker.array(object.allowedEvents, `${path}.allowedEvents`, eventTypes.length);
  allowedEvents?.forEach((event, index) => checker.oneOf(event, eventTypes, `${path}.allowedEvents[${index}]`));
  checker.number(object.batchMaximumEvents, `${path}.batchMaximumEvents`, { integer: true, minimum: 1, maximum: CONTRACT_LIMITS.telemetryEventsPerBatch });
  checker.number(object.flushIntervalMs, `${path}.flushIntervalMs`, { integer: true, minimum: 100, maximum: 300_000 });
  checker.literal(object.includeVisibleText, false, `${path}.includeVisibleText`);
  checker.literal(object.includeElementValues, false, `${path}.includeElementValues`);
}

function checkTool(checker: Checker, value: unknown, path: string): void {
  const object = checker.object(value, path);
  if (!object) return;
  checker.literal(object.kind, "sable.catalog.tool", `${path}.kind`);
  checker.literal(object.schemaVersion, SDK_CATALOG_SCHEMA_VERSION, `${path}.schemaVersion`);
  checker.id(object.name, `${path}.name`);
  checker.string(object.description, `${path}.description`, { nonEmpty: true, maximum: 5_000 });
  checkInputSchema(checker, object.inputSchema, `${path}.inputSchema`);
  if (object.outputSchema !== undefined) checkJson(checker, object.outputSchema, `${path}.outputSchema`);
  checker.oneOf(object.risk, RISKS, `${path}.risk`);
  checker.oneOf(object.confirmation, ["never", "policy", "always"], `${path}.confirmation`);
  if ((object.risk === "external_side_effect" || object.risk === "destructive") && object.confirmation !== "always") {
    checker.issue(`${path}.confirmation`, `${String(object.risk)} tools must always require confirmation`);
  }
  checker.oneOf(object.availability, ["optional", "required"], `${path}.availability`);
  checker.number(object.timeoutMs, `${path}.timeoutMs`, { integer: true, minimum: 1, maximum: 120_000 });
  if (object.verification !== undefined) {
    const checks = checker.array(object.verification, `${path}.verification`, 100);
    checks?.forEach((check, index) => checkAssertion(checker, check, `${path}.verification[${index}]`));
  }
}

function checkJourney(checker: Checker, value: unknown, path: string): WorkflowCheckContext | undefined {
  const object = checker.object(value, path);
  if (!object) return undefined;
  checker.literal(object.kind, "sable.catalog.journey", `${path}.kind`);
  checker.id(object.id, `${path}.id`);
  checker.number(object.version, `${path}.version`, { integer: true, minimum: 1 });
  checker.string(object.name, `${path}.name`, { nonEmpty: true, maximum: 1_000 });
  optionalString(checker, object, "description", path, 5_000);
  const intents = checker.stringArray(object.intents, `${path}.intents`, 1_000);
  if (intents?.length === 0) checker.issue(`${path}.intents`, "must not be empty");
  const roles = checker.stringArray(object.roles, `${path}.roles`, 1_000);
  if (roles?.length === 0) checker.issue(`${path}.roles`, "must not be empty");
  checker.oneOf(object.risk, RISKS, `${path}.risk`);
  const inputNames = checkInputSchema(checker, object.inputSchema, `${path}.inputSchema`);
  const workflowContext = checkWorkflow(checker, object.workflow, `${path}.workflow`, inputNames);
  const compatibility = checker.array(object.compatibility, `${path}.compatibility`, CONTRACT_LIMITS.workflowSteps);
  const compatibilityIds = new Set<string>();
  compatibility?.forEach((entry, index) => {
    const at = `${path}.compatibility[${index}]`;
    checkCompatibility(checker, entry, at);
    if (entry && typeof entry === "object" && typeof (entry as RecordValue).stepId === "string") {
      const id = (entry as RecordValue).stepId as string;
      if (compatibilityIds.has(id)) checker.issue(`${at}.stepId`, `duplicates compatibility entry for ${id}`);
      compatibilityIds.add(id);
      const expectedClass = workflowContext.compatibilityByStep.get(id);
      if (expectedClass && (entry as RecordValue).classification !== expectedClass) {
        checker.issue(`${at}.classification`, `must equal the workflow step classification ${expectedClass}`);
      }
      if ((entry as RecordValue).classification === "SDK_RESUMABLE_NAVIGATION" && object.risk !== "read") {
        checker.issue(`${at}.classification`, "is allowed only in a read-risk journey");
      }
    }
  });
  for (const stepId of workflowContext.stepIds) {
    if (!compatibilityIds.has(stepId)) checker.issue(`${path}.compatibility`, `is missing step ${stepId}`);
  }
  checker.oneOf(object.state, ["draft", "verified", "approved", "retired"], `${path}.state`);
  optionalBoolean(checker, object, "demoSafe", path);
  optionalNumber(checker, object, "reliability", path, 0, 1);
  if (object.sourceCitations !== undefined) {
    const citations = checker.array(object.sourceCitations, `${path}.sourceCitations`, 1_000);
    citations?.forEach((rawCitation, index) => {
      const at = `${path}.sourceCitations[${index}]`;
      const citation = checker.object(rawCitation, at);
      if (!citation) return;
      checker.oneOf(citation.kind, ["document", "exploration", "human"], `${at}.kind`);
      checker.id(citation.sourceId, `${at}.sourceId`);
      optionalString(checker, citation, "title", at, 2_000);
      optionalString(checker, citation, "section", at, 2_000);
      optionalString(checker, citation, "chunkId", at, 256);
    });
  }
  if (object.manualHandoff !== undefined) {
    const handoff = checker.object(object.manualHandoff, `${path}.manualHandoff`);
    if (handoff) {
      checker.string(handoff.reason, `${path}.manualHandoff.reason`, { nonEmpty: true, maximum: 5_000 });
      checker.stringArray(handoff.instructions, `${path}.manualHandoff.instructions`, 100);
    }
  }
  return workflowContext;
}

function checkCaptureKey(checker: Checker, value: unknown, path: string): void {
  if (!checker.string(value, path, { nonEmpty: true, maximum: 128 })) return;
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(value)) {
    checker.issue(path, "must start with a letter and contain only letters, numbers, dot, underscore, or hyphen");
  }
}

function checkDemoUtterance(checker: Checker, value: unknown, path: string): void {
  const object = checker.object(value, path);
  if (!object) return;
  checker.onlyKeys(object, ["text", "audioAssetId"], path);
  checker.string(object.text, `${path}.text`, { nonEmpty: true, maximum: 5_000 });
  optionalString(checker, object, "audioAssetId", path, 256);
}

function checkDemoAudioAsset(checker: Checker, value: unknown, path: string): void {
  const object = checker.object(value, path);
  if (!object) return;
  checker.onlyKeys(object, ["id", "mime", "sha256", "durationMs"], path);
  checker.id(object.id, `${path}.id`);
  checker.oneOf(object.mime, ["audio/mpeg", "audio/wav"], `${path}.mime`);
  if (checker.string(object.sha256, `${path}.sha256`, { nonEmpty: true, maximum: 64 }) && !/^[a-f0-9]{64}$/.test(object.sha256)) {
    checker.issue(`${path}.sha256`, "must be a lowercase 64-character SHA-256 hex digest");
  }
  if (object.durationMs !== undefined) checker.number(object.durationMs, `${path}.durationMs`, { integer: true, minimum: 1, maximum: 3_600_000 });
}

function checkDemoQuestion(checker: Checker, value: unknown, path: string): void {
  const object = checker.object(value, path);
  if (!object) return;
  checker.onlyKeys(object, ["id", "captureKey", "prompt"], path);
  checker.id(object.id, `${path}.id`);
  checkCaptureKey(checker, object.captureKey, `${path}.captureKey`);
  checkDemoUtterance(checker, object.prompt, `${path}.prompt`);
}

function checkDemoPersona(checker: Checker, value: unknown, path: string): void {
  const object = checker.object(value, path);
  if (!object) return;
  checker.onlyKeys(object, ["id", "name", "description", "classifierSignals"], path);
  checker.id(object.id, `${path}.id`);
  checker.string(object.name, `${path}.name`, { nonEmpty: true, maximum: 1_000 });
  checker.string(object.description, `${path}.description`, { nonEmpty: true, maximum: 5_000 });
  if (object.classifierSignals !== undefined) checker.stringArray(object.classifierSignals, `${path}.classifierSignals`, 100);
}

function checkDemoModule(checker: Checker, value: unknown, path: string): void {
  const object = checker.object(value, path);
  if (!object) return;
  checker.onlyKeys(object, ["id", "name", "journeyId", "introduction", "completion", "failureMessage"], path);
  checker.id(object.id, `${path}.id`);
  checker.string(object.name, `${path}.name`, { nonEmpty: true, maximum: 1_000 });
  checker.id(object.journeyId, `${path}.journeyId`);
  checkDemoUtterance(checker, object.introduction, `${path}.introduction`);
  checkDemoUtterance(checker, object.completion, `${path}.completion`);
  checkDemoUtterance(checker, object.failureMessage, `${path}.failureMessage`);
}

function checkStringArrayRecord(checker: Checker, value: unknown, path: string): RecordValue | undefined {
  const object = checker.object(value, path);
  if (!object) return undefined;
  if (Object.keys(object).length > CONTRACT_LIMITS.demoPersonas) {
    checker.issue(path, `must contain at most ${CONTRACT_LIMITS.demoPersonas} properties`);
  }
  Object.entries(object).forEach(([key, item]) => {
    if (!key || key.length > 256) checker.issue(`${path}.${key}`, "property name must contain 1 to 256 characters");
    const values = checker.stringArray(item, `${path}.${key}`, CONTRACT_LIMITS.demoModules);
    values?.forEach((entry, index) => {
      if (values.indexOf(entry) !== index) checker.issue(`${path}.${key}[${index}]`, `duplicates ${entry}`);
    });
  });
  return object;
}

function checkDemoProfile(checker: Checker, value: unknown, path: string): void {
  const object = checker.object(value, path);
  if (!object) return;
  checker.onlyKeys(object, ["id", "version", "greeting", "questions", "intake", "personas", "modules", "defaultPlaylistModuleIds", "playlistModuleIdsByPersonaId", "closing"], path);
  checker.id(object.id, `${path}.id`);
  checker.number(object.version, `${path}.version`, { integer: true, minimum: 1 });
  checkDemoUtterance(checker, object.greeting, `${path}.greeting`);
  const questions = checker.array(object.questions, `${path}.questions`, CONTRACT_LIMITS.demoQuestions);
  questions?.forEach((question, index) => checkDemoQuestion(checker, question, `${path}.questions[${index}]`));
  const intake = checker.object(object.intake, `${path}.intake`);
  if (intake) {
    checker.onlyKeys(intake, ["genericQuestionIds", "personaQuestionByPersonaId"], `${path}.intake`);
    const genericQuestionIds = checker.stringArray(intake.genericQuestionIds, `${path}.intake.genericQuestionIds`, 2);
    if (genericQuestionIds?.length !== 2) checker.issue(`${path}.intake.genericQuestionIds`, "must contain exactly two question ids");
    if (genericQuestionIds?.length === 2 && genericQuestionIds[0] === genericQuestionIds[1]) checker.issue(`${path}.intake.genericQuestionIds[1]`, "must identify a different question");
    const personaQuestions = checker.object(intake.personaQuestionByPersonaId, `${path}.intake.personaQuestionByPersonaId`);
    if (personaQuestions) {
      if (Object.keys(personaQuestions).length > CONTRACT_LIMITS.demoPersonas) checker.issue(`${path}.intake.personaQuestionByPersonaId`, `must contain at most ${CONTRACT_LIMITS.demoPersonas} properties`);
      Object.entries(personaQuestions).forEach(([personaId, questionId]) => {
        if (!personaId || personaId.length > 256) checker.issue(`${path}.intake.personaQuestionByPersonaId.${personaId}`, "persona id must contain 1 to 256 characters");
        checker.id(questionId, `${path}.intake.personaQuestionByPersonaId.${personaId}`);
      });
    }
  }
  const personas = checker.array(object.personas, `${path}.personas`, CONTRACT_LIMITS.demoPersonas);
  personas?.forEach((persona, index) => checkDemoPersona(checker, persona, `${path}.personas[${index}]`));
  const modules = checker.array(object.modules, `${path}.modules`, CONTRACT_LIMITS.demoModules);
  modules?.forEach((module, index) => checkDemoModule(checker, module, `${path}.modules[${index}]`));
  const defaultPlaylist = checker.stringArray(object.defaultPlaylistModuleIds, `${path}.defaultPlaylistModuleIds`, CONTRACT_LIMITS.demoModules);
  defaultPlaylist?.forEach((moduleId, index) => {
    if (defaultPlaylist.indexOf(moduleId) !== index) checker.issue(`${path}.defaultPlaylistModuleIds[${index}]`, `duplicates ${moduleId}`);
  });
  checkStringArrayRecord(checker, object.playlistModuleIdsByPersonaId, `${path}.playlistModuleIdsByPersonaId`);
  checkDemoUtterance(checker, object.closing, `${path}.closing`);
}

const SALES_PLAY_KINDS = ["product_answer", "value_proposition", "objection_response", "proof", "positioning", "discovery_question", "next_best_action"] as const;

function checkSalesPlay(checker: Checker, value: unknown, path: string): void {
  const object = checker.object(value, path);
  if (!object) return;
  checker.onlyKeys(object, ["id", "kind", "title", "content", "personaIds", "capabilityIds", "journeyIds", "signalPhrases", "captureKey", "suggestedJourneyId", "requiresConfirmation"], path);
  checker.id(object.id, `${path}.id`);
  checker.oneOf(object.kind, SALES_PLAY_KINDS, `${path}.kind`);
  checker.string(object.title, `${path}.title`, { nonEmpty: true, maximum: 1_000 });
  checker.string(object.content, `${path}.content`, { nonEmpty: true, maximum: 10_000 });
  checker.stringArray(object.personaIds, `${path}.personaIds`, CONTRACT_LIMITS.demoPersonas);
  checker.stringArray(object.capabilityIds, `${path}.capabilityIds`, 1_000);
  checker.stringArray(object.journeyIds, `${path}.journeyIds`, CONTRACT_LIMITS.journeys);
  checker.stringArray(object.signalPhrases, `${path}.signalPhrases`, 1_000);
  if (object.captureKey !== undefined) checkCaptureKey(checker, object.captureKey, `${path}.captureKey`);
  optionalString(checker, object, "suggestedJourneyId", path, 256);
  if (object.requiresConfirmation !== undefined) checker.literal(object.requiresConfirmation, true, `${path}.requiresConfirmation`);
  if (object.kind === "discovery_question" && object.captureKey === undefined) checker.issue(`${path}.captureKey`, "is required for discovery_question knowledge");
  if (object.kind !== "discovery_question" && object.captureKey !== undefined) checker.issue(`${path}.captureKey`, "is allowed only for discovery_question knowledge");
  if (object.kind === "next_best_action" && object.suggestedJourneyId !== undefined && object.requiresConfirmation !== true) {
    checker.issue(`${path}.requiresConfirmation`, "must equal true when a next_best_action suggests a journey");
  }
  if (object.kind !== "next_best_action" && object.suggestedJourneyId !== undefined) checker.issue(`${path}.suggestedJourneyId`, "is allowed only for next_best_action knowledge");
  if (object.kind !== "next_best_action" && object.requiresConfirmation !== undefined) checker.issue(`${path}.requiresConfirmation`, "is allowed only for next_best_action knowledge");
}

function collectNamedStringReferences(value: unknown, key: string, output: string[]): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectNamedStringReferences(item, key, output));
    return;
  }
  const object = value as RecordValue;
  if (typeof object[key] === "string") output.push(object[key] as string);
  Object.values(object).forEach((item) => collectNamedStringReferences(item, key, output));
}

function collectTargetReferences(value: unknown, controls: Set<string>, screens: Set<string>, tools: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectTargetReferences(item, controls, screens, tools));
    return;
  }
  const object = value as RecordValue;
  if (typeof object.controlId === "string") controls.add(object.controlId);
  if (typeof object.screenId === "string") screens.add(object.screenId);
  if (typeof object.toolName === "string") tools.add(object.toolName);
  Object.values(object).forEach((item) => collectTargetReferences(item, controls, screens, tools));
}

function checkDirectAssertionTargets(
  checker: Checker,
  assertion: unknown,
  path: string,
  locatorCounts: Map<string, number>,
  anchorCounts: Map<string, number>,
): void {
  if (!assertion || typeof assertion !== "object" || Array.isArray(assertion)) return;
  const record = assertion as RecordValue;
  if (record.kind === "control_visible" || record.kind === "control_enabled") {
    checkDirectTarget(checker, record.target, `${path}.target`, locatorCounts);
  } else if (record.kind === "screen_matches" && typeof record.screenId === "string" && (anchorCounts.get(record.screenId) ?? 0) === 0) {
    checker.issue(`${path}.screenId`, `SDK_DIRECT assertion references unresolved screen ${record.screenId}`);
  }
}

function checkDirectTarget(checker: Checker, target: unknown, path: string, locatorCounts: Map<string, number>): void {
  if (!target || typeof target !== "object" || Array.isArray(target)) return;
  const record = target as RecordValue;
  if (typeof record.controlId !== "string") return;
  const inlineCount = Array.isArray(record.locators) ? record.locators.length : 0;
  if ((locatorCounts.get(record.controlId) ?? 0) === 0 && inlineCount === 0) {
    checker.issue(path, `SDK_DIRECT step targets unresolved control ${record.controlId}`);
  }
}

function checkDirectWorkflowSteps(
  checker: Checker,
  steps: unknown,
  path: string,
  locatorCounts: Map<string, number>,
  anchorCounts: Map<string, number>,
): void {
  if (!Array.isArray(steps)) return;
  steps.forEach((rawStep, index) => {
    if (!rawStep || typeof rawStep !== "object" || Array.isArray(rawStep)) return;
    const at = `${path}[${index}]`;
    const step = rawStep as RecordValue;
    const compatibility = step.compatibility && typeof step.compatibility === "object" ? step.compatibility as RecordValue : undefined;
    if (compatibility?.classification === "SDK_DIRECT") {
      if (step.kind === "action") {
        if (["click", "fill", "select", "hover"].includes(String(step.action))) checkDirectTarget(checker, step.target, `${at}.target`, locatorCounts);
        else if (step.action === "drag") {
          checkDirectTarget(checker, step.source, `${at}.source`, locatorCounts);
          checkDirectTarget(checker, step.target, `${at}.target`, locatorCounts);
        } else if (step.action === "wait" && step.until !== undefined) checkDirectAssertionTargets(checker, step.until, `${at}.until`, locatorCounts, anchorCounts);
      } else if (step.kind === "assert") checkDirectAssertionTargets(checker, step.assertion, `${at}.assertion`, locatorCounts, anchorCounts);
      else if (step.kind === "branch") checkDirectAssertionTargets(checker, step.condition, `${at}.condition`, locatorCounts, anchorCounts);
      else if (step.kind === "loop") checkDirectAssertionTargets(checker, step.until, `${at}.until`, locatorCounts, anchorCounts);
    }
    if (step.kind === "approval") checkDirectWorkflowSteps(checker, step.then, `${at}.then`, locatorCounts, anchorCounts);
    else if (step.kind === "branch") {
      checkDirectWorkflowSteps(checker, step.then, `${at}.then`, locatorCounts, anchorCounts);
      checkDirectWorkflowSteps(checker, step.otherwise, `${at}.otherwise`, locatorCounts, anchorCounts);
    } else if (step.kind === "loop") checkDirectWorkflowSteps(checker, step.steps, `${at}.steps`, locatorCounts, anchorCounts);
  });
}

function checkToolStepSafety(
  checker: Checker,
  steps: unknown,
  path: string,
  workflowRisk: unknown,
  toolRisks: Map<string, string>,
): void {
  if (!Array.isArray(steps)) return;
  const riskRank = (risk: unknown) => RISKS.indexOf(risk as (typeof RISKS)[number]);
  steps.forEach((rawStep, index) => {
    if (!rawStep || typeof rawStep !== "object" || Array.isArray(rawStep)) return;
    const at = `${path}[${index}]`;
    const step = rawStep as RecordValue;
    if (step.kind === "action" && step.action === "tool_call" && typeof step.toolName === "string") {
      const requiredRisk = toolRisks.get(step.toolName);
      const effectiveRisk = Math.max(riskRank(workflowRisk), riskRank(step.risk ?? "read"));
      const classification = step.compatibility && typeof step.compatibility === "object" ? (step.compatibility as RecordValue).classification : undefined;
      if (classification === "SDK_DIRECT") checker.issue(`${at}.compatibility.classification`, "tool_call cannot be classified SDK_DIRECT");
      if (classification === "NEEDS_REGISTERED_TOOL" && requiredRisk && effectiveRisk < riskRank(requiredRisk)) {
        checker.issue(`${at}.risk`, `must be at least the registered tool risk ${requiredRisk}`);
      }
    }
    if (step.kind === "approval") checkToolStepSafety(checker, step.then, `${at}.then`, workflowRisk, toolRisks);
    else if (step.kind === "branch") {
      checkToolStepSafety(checker, step.then, `${at}.then`, workflowRisk, toolRisks);
      checkToolStepSafety(checker, step.otherwise, `${at}.otherwise`, workflowRisk, toolRisks);
    } else if (step.kind === "loop") checkToolStepSafety(checker, step.steps, `${at}.steps`, workflowRisk, toolRisks);
  });
}

export function validateSdkCatalog(value: unknown): ValidationResult<SdkCatalog> {
  const checker = new Checker();
  const object = checker.object(value, "$catalog");
  if (!object) return result(checker, value);
  checker.literal(object.kind, "sable.sdk_catalog", "$catalog.kind");
  checker.literal(object.schemaVersion, SDK_CATALOG_SCHEMA_VERSION, "$catalog.schemaVersion");
  const manifest = checker.object(object.manifest, "$catalog.manifest");
  if (manifest) {
    checker.literal(manifest.kind, "sable.catalog.manifest", "$catalog.manifest.kind");
    checker.literal(manifest.schemaVersion, SDK_CATALOG_SCHEMA_VERSION, "$catalog.manifest.schemaVersion");
    checker.literal(manifest.protocolVersion, SDK_PROTOCOL_VERSION, "$catalog.manifest.protocolVersion");
    ["catalogId", "catalogVersionId", "organizationId", "productId", "environmentId", "roleProfileId"].forEach((key) => checker.id(manifest[key], `$catalog.manifest.${key}`));
    checker.number(manifest.version, "$catalog.manifest.version", { integer: true, minimum: 1 });
    checker.oneOf(manifest.channel, ["draft", "staging", "production"], "$catalog.manifest.channel");
    checker.isoDate(manifest.issuedAt, "$catalog.manifest.issuedAt");
    if (manifest.expiresAt !== undefined) checker.isoDate(manifest.expiresAt, "$catalog.manifest.expiresAt");
    const supportedSdk = checker.object(manifest.supportedSdk, "$catalog.manifest.supportedSdk");
    if (supportedSdk) {
      checkSemver(checker, supportedSdk.minimum, "$catalog.manifest.supportedSdk.minimum");
      if (supportedSdk.maximum !== undefined) checkSemver(checker, supportedSdk.maximum, "$catalog.manifest.supportedSdk.maximum");
    }
    if (manifest.applicationBuildHints !== undefined) checker.stringArray(manifest.applicationBuildHints, "$catalog.manifest.applicationBuildHints", 1_000);
    optionalString(checker, manifest, "publishedBy", "$catalog.manifest", 256);
  }

  const screens = checker.array(object.screens, "$catalog.screens", CONTRACT_LIMITS.screens) ?? [];
  const controls = checker.array(object.controls, "$catalog.controls", CONTRACT_LIMITS.controls) ?? [];
  const journeys = checker.array(object.journeys, "$catalog.journeys", CONTRACT_LIMITS.journeys) ?? [];
  const demoAudioAssets = object.demoAudioAssets === undefined ? [] : checker.array(object.demoAudioAssets, "$catalog.demoAudioAssets", CONTRACT_LIMITS.demoAudioAssets) ?? [];
  const salesPlays = object.salesPlays === undefined ? [] : checker.array(object.salesPlays, "$catalog.salesPlays", CONTRACT_LIMITS.salesPlays) ?? [];
  const tools = checker.array(object.tools, "$catalog.tools", CONTRACT_LIMITS.tools) ?? [];
  const screenIds = new Set<string>();
  const controlIds = new Set<string>();
  const journeyIds = new Set<string>();
  const journeysById = new Map<string, RecordValue>();
  const toolNames = new Set<string>();
  const toolRisks = new Map<string, string>();
  const anchorCounts = new Map<string, number>();
  const locatorCounts = new Map<string, number>();
  screens.forEach((screen, index) => {
    checkScreen(checker, screen, `$catalog.screens[${index}]`);
    if (screen && typeof screen === "object" && typeof (screen as RecordValue).id === "string") {
      const id = (screen as RecordValue).id as string;
      if (screenIds.has(id)) checker.issue(`$catalog.screens[${index}].id`, `duplicates screen ${id}`);
      screenIds.add(id);
      const variants = (screen as RecordValue).variants;
      anchorCounts.set(id, Array.isArray(variants) ? variants.reduce((count, variant) => {
        if (!variant || typeof variant !== "object" || !Array.isArray((variant as RecordValue).anchors)) return count;
        return count + ((variant as RecordValue).anchors as unknown[]).length;
      }, 0) : 0);
    }
  });
  controls.forEach((control, index) => {
    checkControl(checker, control, `$catalog.controls[${index}]`);
    if (control && typeof control === "object") {
      const record = control as RecordValue;
      if (typeof record.id === "string") {
        if (controlIds.has(record.id)) checker.issue(`$catalog.controls[${index}].id`, `duplicates control ${record.id}`);
        controlIds.add(record.id);
        locatorCounts.set(record.id, Array.isArray(record.locators) ? record.locators.length : 0);
      }
      if (typeof record.screenId === "string" && !screenIds.has(record.screenId)) checker.issue(`$catalog.controls[${index}].screenId`, `references missing screen ${record.screenId}`);
    }
  });
  screens.forEach((screen, screenIndex) => {
    if (!screen || typeof screen !== "object") return;
    const variants = (screen as RecordValue).variants;
    if (!Array.isArray(variants)) return;
    variants.forEach((variant, variantIndex) => {
      if (!variant || typeof variant !== "object" || !Array.isArray((variant as RecordValue).anchors)) return;
      ((variant as RecordValue).anchors as unknown[]).forEach((anchor, anchorIndex) => {
        if (!anchor || typeof anchor !== "object") return;
        const record = anchor as RecordValue;
        if (record.kind === "control" && typeof record.controlId === "string" && !controlIds.has(record.controlId)) {
          checker.issue(`$catalog.screens[${screenIndex}].variants[${variantIndex}].anchors[${anchorIndex}].controlId`, `references missing control ${record.controlId}`);
        }
      });
    });
  });
  controls.forEach((control, controlIndex) => {
    if (!control || typeof control !== "object") return;
    const record = control as RecordValue;
    const shadow = record.shadow;
    if (shadow && typeof shadow === "object") {
      const hostControlId = (shadow as RecordValue).hostControlId;
      if (typeof hostControlId === "string" && !controlIds.has(hostControlId)) {
        checker.issue(`$catalog.controls[${controlIndex}].shadow.hostControlId`, `references missing control ${hostControlId}`);
      }
    }
    if (!Array.isArray(record.locators)) return;
    record.locators.forEach((locator, locatorIndex) => {
      if (!locator || typeof locator !== "object") return;
      const locatorRecord = locator as RecordValue;
      if (locatorRecord.kind === "relationship" && typeof locatorRecord.withinControlId === "string" && !controlIds.has(locatorRecord.withinControlId)) {
        checker.issue(`$catalog.controls[${controlIndex}].locators[${locatorIndex}].withinControlId`, `references missing control ${locatorRecord.withinControlId}`);
      }
    });
  });
  tools.forEach((tool, index) => {
    checkTool(checker, tool, `$catalog.tools[${index}]`);
    if (tool && typeof tool === "object" && typeof (tool as RecordValue).name === "string") {
      const name = (tool as RecordValue).name as string;
      if (toolNames.has(name)) checker.issue(`$catalog.tools[${index}].name`, `duplicates tool ${name}`);
      toolNames.add(name);
      const risk = (tool as RecordValue).risk;
      if (typeof risk === "string") toolRisks.set(name, risk);
    }
  });
  journeys.forEach((journey, index) => {
    checkJourney(checker, journey, `$catalog.journeys[${index}]`);
    if (!journey || typeof journey !== "object") return;
    const record = journey as RecordValue;
    if (typeof record.id === "string") {
      if (journeyIds.has(record.id)) checker.issue(`$catalog.journeys[${index}].id`, `duplicates journey ${record.id}`);
      journeyIds.add(record.id);
      journeysById.set(record.id, record);
    }
    if (manifest?.channel === "production" && record.state !== "approved" && (record.state !== "verified" || !record.manualHandoff)) {
      checker.issue(`$catalog.journeys[${index}].state`, "must be approved or verified with a manual handoff in a production catalog");
    }
    if (manifest && Array.isArray(record.roles) && !record.roles.includes(manifest.roleProfileId) && !record.roles.includes("*")) {
      checker.issue(`$catalog.journeys[${index}].roles`, `must include scoped role ${String(manifest.roleProfileId)}`);
    }
    const referencedControls = new Set<string>();
    const referencedScreens = new Set<string>();
    const referencedTools = new Set<string>();
    collectTargetReferences(record.workflow, referencedControls, referencedScreens, referencedTools);
    referencedControls.forEach((id) => { if (!controlIds.has(id)) checker.issue(`$catalog.journeys[${index}].workflow`, `references missing control ${id}`); });
    referencedScreens.forEach((id) => { if (!screenIds.has(id)) checker.issue(`$catalog.journeys[${index}].workflow`, `references missing screen ${id}`); });
    referencedTools.forEach((name) => { if (!toolNames.has(name)) checker.issue(`$catalog.journeys[${index}].workflow`, `references missing tool ${name}`); });
    if (record.workflow && typeof record.workflow === "object") {
      const workflowRecord = record.workflow as RecordValue;
      const preconditions = workflowRecord.preconditions;
      if (Array.isArray(preconditions)) preconditions.forEach((assertion, assertionIndex) => checkDirectAssertionTargets(checker, assertion, `$catalog.journeys[${index}].workflow.preconditions[${assertionIndex}]`, locatorCounts, anchorCounts));
      checkDirectWorkflowSteps(checker, workflowRecord.steps, `$catalog.journeys[${index}].workflow.steps`, locatorCounts, anchorCounts);
      checkToolStepSafety(checker, workflowRecord.steps, `$catalog.journeys[${index}].workflow.steps`, workflowRecord.risk, toolRisks);
      const postconditions = workflowRecord.postconditions;
      if (Array.isArray(postconditions)) postconditions.forEach((assertion, assertionIndex) => checkDirectAssertionTargets(checker, assertion, `$catalog.journeys[${index}].workflow.postconditions[${assertionIndex}]`, locatorCounts, anchorCounts));
    }
  });

  const audioAssetIds = new Set<string>();
  demoAudioAssets.forEach((asset, index) => {
    checkDemoAudioAsset(checker, asset, `$catalog.demoAudioAssets[${index}]`);
    if (!asset || typeof asset !== "object" || typeof (asset as RecordValue).id !== "string") return;
    const id = (asset as RecordValue).id as string;
    if (audioAssetIds.has(id)) checker.issue(`$catalog.demoAudioAssets[${index}].id`, `duplicates audio asset ${id}`);
    audioAssetIds.add(id);
  });

  const personaIds = new Set<string>();
  const questionIds = new Set<string>();
  const moduleIds = new Set<string>();
  if (object.demoProfile !== undefined) {
    checkDemoProfile(checker, object.demoProfile, "$catalog.demoProfile");
    const profile = object.demoProfile && typeof object.demoProfile === "object" && !Array.isArray(object.demoProfile)
      ? object.demoProfile as RecordValue
      : undefined;
    if (profile) {
      const captureKeys = new Set<string>();
      if (Array.isArray(profile.questions)) profile.questions.forEach((rawQuestion, index) => {
        if (!rawQuestion || typeof rawQuestion !== "object" || Array.isArray(rawQuestion)) return;
        const question = rawQuestion as RecordValue;
        if (typeof question.id === "string") {
          if (questionIds.has(question.id)) checker.issue(`$catalog.demoProfile.questions[${index}].id`, `duplicates question ${question.id}`);
          questionIds.add(question.id);
        }
        if (typeof question.captureKey === "string") {
          if (captureKeys.has(question.captureKey)) checker.issue(`$catalog.demoProfile.questions[${index}].captureKey`, `duplicates capture key ${question.captureKey}`);
          captureKeys.add(question.captureKey);
        }
      });
      if (Array.isArray(profile.personas)) profile.personas.forEach((rawPersona, index) => {
        if (!rawPersona || typeof rawPersona !== "object" || Array.isArray(rawPersona)) return;
        const id = (rawPersona as RecordValue).id;
        if (typeof id !== "string") return;
        if (personaIds.has(id)) checker.issue(`$catalog.demoProfile.personas[${index}].id`, `duplicates persona ${id}`);
        personaIds.add(id);
      });
      if (Array.isArray(profile.modules)) profile.modules.forEach((rawModule, index) => {
        if (!rawModule || typeof rawModule !== "object" || Array.isArray(rawModule)) return;
        const module = rawModule as RecordValue;
        if (typeof module.id === "string") {
          if (moduleIds.has(module.id)) checker.issue(`$catalog.demoProfile.modules[${index}].id`, `duplicates module ${module.id}`);
          moduleIds.add(module.id);
        }
        if (typeof module.journeyId === "string") {
          const journey = journeysById.get(module.journeyId);
          if (!journey) checker.issue(`$catalog.demoProfile.modules[${index}].journeyId`, `references missing journey ${module.journeyId}`);
          else {
            if (journey.state !== "approved") checker.issue(`$catalog.demoProfile.modules[${index}].journeyId`, `journey ${module.journeyId} must be approved for demo playback`);
            if (journey.demoSafe !== true) checker.issue(`$catalog.demoProfile.modules[${index}].journeyId`, `journey ${module.journeyId} must declare demoSafe true`);
          }
        }
      });
      const intake = profile.intake && typeof profile.intake === "object" && !Array.isArray(profile.intake) ? profile.intake as RecordValue : undefined;
      if (intake && Array.isArray(intake.genericQuestionIds)) intake.genericQuestionIds.forEach((questionId, index) => {
        if (typeof questionId === "string" && !questionIds.has(questionId)) checker.issue(`$catalog.demoProfile.intake.genericQuestionIds[${index}]`, `references missing question ${questionId}`);
      });
      const personaQuestionMap = intake?.personaQuestionByPersonaId && typeof intake.personaQuestionByPersonaId === "object" && !Array.isArray(intake.personaQuestionByPersonaId)
        ? intake.personaQuestionByPersonaId as RecordValue
        : undefined;
      if (personaQuestionMap) Object.entries(personaQuestionMap).forEach(([personaId, questionId]) => {
        if (!personaIds.has(personaId)) checker.issue(`$catalog.demoProfile.intake.personaQuestionByPersonaId.${personaId}`, `references missing persona ${personaId}`);
        if (typeof questionId === "string" && !questionIds.has(questionId)) checker.issue(`$catalog.demoProfile.intake.personaQuestionByPersonaId.${personaId}`, `references missing question ${questionId}`);
      });
      if (Array.isArray(profile.defaultPlaylistModuleIds)) profile.defaultPlaylistModuleIds.forEach((moduleId, index) => {
        if (typeof moduleId === "string" && !moduleIds.has(moduleId)) checker.issue(`$catalog.demoProfile.defaultPlaylistModuleIds[${index}]`, `references missing module ${moduleId}`);
      });
      const playlists = profile.playlistModuleIdsByPersonaId && typeof profile.playlistModuleIdsByPersonaId === "object" && !Array.isArray(profile.playlistModuleIdsByPersonaId)
        ? profile.playlistModuleIdsByPersonaId as RecordValue
        : undefined;
      if (playlists) Object.entries(playlists).forEach(([personaId, rawModuleIds]) => {
        if (!personaIds.has(personaId)) checker.issue(`$catalog.demoProfile.playlistModuleIdsByPersonaId.${personaId}`, `references missing persona ${personaId}`);
        if (Array.isArray(rawModuleIds)) rawModuleIds.forEach((moduleId, index) => {
          if (typeof moduleId === "string" && !moduleIds.has(moduleId)) checker.issue(`$catalog.demoProfile.playlistModuleIdsByPersonaId.${personaId}[${index}]`, `references missing module ${moduleId}`);
        });
      });
    }
  }

  const narrationAudioReferences: string[] = [];
  collectNamedStringReferences(journeys, "narrationAudioAssetId", narrationAudioReferences);
  narrationAudioReferences.forEach((id) => {
    if (!audioAssetIds.has(id)) checker.issue("$catalog.journeys", `references missing narration audio asset ${id}`);
  });
  const demoAudioReferences: string[] = [];
  collectNamedStringReferences(object.demoProfile, "audioAssetId", demoAudioReferences);
  demoAudioReferences.forEach((id) => {
    if (!audioAssetIds.has(id)) checker.issue("$catalog.demoProfile", `references missing audio asset ${id}`);
  });

  const salesPlayIds = new Set<string>();
  salesPlays.forEach((rawPlay, index) => {
    const path = `$catalog.salesPlays[${index}]`;
    checkSalesPlay(checker, rawPlay, path);
    if (!rawPlay || typeof rawPlay !== "object" || Array.isArray(rawPlay)) return;
    const play = rawPlay as RecordValue;
    if (typeof play.id === "string") {
      if (salesPlayIds.has(play.id)) checker.issue(`${path}.id`, `duplicates sales play ${play.id}`);
      salesPlayIds.add(play.id);
    }
    const checkUniqueReferences = (key: "personaIds" | "capabilityIds" | "journeyIds" | "signalPhrases"): void => {
      if (!Array.isArray(play[key])) return;
      (play[key] as unknown[]).forEach((item, itemIndex, values) => {
        if (typeof item === "string" && values.indexOf(item) !== itemIndex) checker.issue(`${path}.${key}[${itemIndex}]`, `duplicates ${item}`);
      });
    };
    checkUniqueReferences("personaIds");
    checkUniqueReferences("capabilityIds");
    checkUniqueReferences("journeyIds");
    checkUniqueReferences("signalPhrases");
    if (Array.isArray(play.personaIds)) play.personaIds.forEach((personaId, personaIndex) => {
      if (typeof personaId === "string" && !personaIds.has(personaId)) checker.issue(`${path}.personaIds[${personaIndex}]`, `references missing persona ${personaId}`);
    });
    if (Array.isArray(play.journeyIds)) play.journeyIds.forEach((journeyId, journeyIndex) => {
      if (typeof journeyId === "string" && !journeyIds.has(journeyId)) checker.issue(`${path}.journeyIds[${journeyIndex}]`, `references missing journey ${journeyId}`);
    });
    if (typeof play.suggestedJourneyId === "string") {
      if (!journeyIds.has(play.suggestedJourneyId)) checker.issue(`${path}.suggestedJourneyId`, `references missing journey ${play.suggestedJourneyId}`);
      if (!Array.isArray(play.journeyIds) || !play.journeyIds.includes(play.suggestedJourneyId)) checker.issue(`${path}.suggestedJourneyId`, "must also be included in journeyIds");
    }
  });
  checkPrivacyPolicy(checker, object.privacyPolicy, "$catalog.privacyPolicy");
  checkTelemetryPolicy(checker, object.telemetryPolicy, "$catalog.telemetryPolicy");
  return result(checker, value);
}

export function assertValidSdkCatalog(value: unknown): SdkCatalog {
  return assertResult("SdkCatalog", validateSdkCatalog(value));
}

function checkDigest(checker: Checker, value: unknown, path: string): void {
  const digest = checker.object(value, path);
  if (!digest) return;
  checker.literal(digest.algorithm, "SHA-256", `${path}.algorithm`);
  checker.literal(digest.encoding, "base64url", `${path}.encoding`);
  if (checker.string(digest.value, `${path}.value`, { nonEmpty: true, maximum: 128 }) && !/^[A-Za-z0-9_-]{43}$/.test(digest.value as string)) {
    checker.issue(`${path}.value`, "must be an unpadded base64url SHA-256 digest");
  }
}

export function validateSignedCatalogEnvelope(value: unknown): ValidationResult<SignedCatalogEnvelope> {
  const checker = new Checker();
  const object = checker.object(value, "$envelope");
  if (!object) return result(checker, value);
  checker.literal(object.kind, "sable.signed_catalog", "$envelope.kind");
  checker.literal(object.schemaVersion, SDK_CATALOG_SCHEMA_VERSION, "$envelope.schemaVersion");
  const catalogValidation = validateSdkCatalog(object.payload);
  if (!catalogValidation.ok) catalogValidation.issues.forEach((issue) => checker.issue(`$envelope.payload${issue.path.slice("$catalog".length)}`, issue.message));
  checkDigest(checker, object.digest, "$envelope.digest");
  const signature = checker.object(object.signature, "$envelope.signature");
  if (signature) {
    checker.literal(signature.kind, "sable.catalog_signature", "$envelope.signature.kind");
    checker.oneOf(signature.algorithm, ["ES256", "Ed25519"], "$envelope.signature.algorithm");
    checker.id(signature.keyId, "$envelope.signature.keyId");
    checker.literal(signature.encoding, "base64url", "$envelope.signature.encoding");
    if (checker.string(signature.value, "$envelope.signature.value", { nonEmpty: true, maximum: 1_000 }) && !/^[A-Za-z0-9_-]+$/.test(signature.value as string)) {
      checker.issue("$envelope.signature.value", "must contain unpadded base64url signature bytes");
    } else if (typeof signature.value === "string" && signature.value.length !== 86) {
      checker.issue("$envelope.signature.value", "must contain a 64-byte raw ES256 or Ed25519 signature");
    }
    checker.isoDate(signature.signedAt, "$envelope.signature.signedAt");
  }
  return result(checker, value);
}

export function assertValidSignedCatalogEnvelope(value: unknown): SignedCatalogEnvelope {
  return assertResult("SignedCatalogEnvelope", validateSignedCatalogEnvelope(value));
}

function checkOrigin(checker: Checker, value: unknown, path: string): void {
  if (!checker.string(value, path, { nonEmpty: true, maximum: 2_000 })) return;
  if (!/^https?:\/\/[^/?#]+$/i.test(value)) checker.issue(path, "must be an exact http(s) origin without a path");
}

function checkTokenBase(checker: Checker, value: unknown, path: string, typ: "sdk_identity" | "sdk_session" | "sdk_socket_ticket"): RecordValue | undefined {
  const object = checker.object(value, path);
  if (!object) return undefined;
  checker.literal(object.v, SDK_TOKEN_SCHEMA_VERSION, `${path}.v`);
  checker.literal(object.typ, typ, `${path}.typ`);
  ["jti", "installationId", "organizationId", "productId", "environmentId", "roleProfileId", "userId"].forEach((key) => checker.id(object[key], `${path}.${key}`));
  checkOrigin(checker, object.origin, `${path}.origin`);
  checker.number(object.iat, `${path}.iat`, { integer: true, minimum: 0 });
  checker.number(object.exp, `${path}.exp`, { integer: true, minimum: 1 });
  if (typeof object.iat === "number" && typeof object.exp === "number") {
    if (object.exp <= object.iat) checker.issue(`${path}.exp`, "must be later than iat");
    const maximumLifetime = SDK_TOKEN_MAX_LIFETIME_SECONDS[typ];
    if (object.exp - object.iat > maximumLifetime) checker.issue(`${path}.exp`, `lifetime must not exceed ${maximumLifetime} seconds`);
  }
  return object;
}

export function validateSdkIdentityClaims(value: unknown): ValidationResult<SdkIdentityClaims> {
  const checker = new Checker();
  checkTokenBase(checker, value, "$identityClaims", "sdk_identity");
  return result(checker, value);
}

export function assertValidSdkIdentityClaims(value: unknown): SdkIdentityClaims {
  return assertResult("SdkIdentityClaims", validateSdkIdentityClaims(value));
}

export function validateSdkSessionClaims(value: unknown): ValidationResult<SdkSessionClaims> {
  const checker = new Checker();
  const object = checkTokenBase(checker, value, "$sessionClaims", "sdk_session");
  if (object) {
    checker.id(object.sessionId, "$sessionClaims.sessionId");
    checker.id(object.catalogVersionId, "$sessionClaims.catalogVersionId");
  }
  return result(checker, value);
}

export function assertValidSdkSessionClaims(value: unknown): SdkSessionClaims {
  return assertResult("SdkSessionClaims", validateSdkSessionClaims(value));
}

export function validateSdkSocketTicketClaims(value: unknown): ValidationResult<SdkSocketTicketClaims> {
  const checker = new Checker();
  const object = checkTokenBase(checker, value, "$socketTicketClaims", "sdk_socket_ticket");
  if (object) checker.id(object.sessionId, "$socketTicketClaims.sessionId");
  return result(checker, value);
}

export function assertValidSdkSocketTicketClaims(value: unknown): SdkSocketTicketClaims {
  return assertResult("SdkSocketTicketClaims", validateSdkSocketTicketClaims(value));
}

function checkCapabilities(checker: Checker, value: unknown, path: string): void {
  const object = checker.object(value, path);
  if (!object) return;
  checker.literal(object.domObservation, true, `${path}.domObservation`);
  ["shadowDom", "sameOriginFrames", "frameBridge", "voice", "screenshots"].forEach((key) => checker.boolean(object[key], `${path}.${key}`));
  checker.stringArray(object.registeredTools, `${path}.registeredTools`, CONTRACT_LIMITS.tools);
}

export function validateSdkBootstrapRequest(value: unknown): ValidationResult<SdkBootstrapRequest> {
  const checker = new Checker();
  const object = checker.object(value, "$bootstrapRequest");
  if (!object) return result(checker, value);
  checker.literal(object.kind, "sable.sdk.bootstrap.request", "$bootstrapRequest.kind");
  checker.literal(object.schemaVersion, SDK_PROTOCOL_VERSION, "$bootstrapRequest.schemaVersion");
  checker.id(object.requestId, "$bootstrapRequest.requestId");
  checker.id(object.installationId, "$bootstrapRequest.installationId");
  checker.string(object.identityToken, "$bootstrapRequest.identityToken", { nonEmpty: true, maximum: 20_000 });
  const sdk = checker.object(object.sdk, "$bootstrapRequest.sdk");
  if (sdk) {
    checkSemver(checker, sdk.version, "$bootstrapRequest.sdk.version");
    checker.literal(sdk.protocolVersion, SDK_PROTOCOL_VERSION, "$bootstrapRequest.sdk.protocolVersion");
    checker.oneOf(sdk.distribution, ["script", "npm"], "$bootstrapRequest.sdk.distribution");
  }
  const page = checker.object(object.page, "$bootstrapRequest.page");
  if (page) {
    checkOrigin(checker, page.origin, "$bootstrapRequest.page.origin");
    checker.string(page.url, "$bootstrapRequest.page.url", { nonEmpty: true, maximum: 10_000 });
    checker.string(page.locale, "$bootstrapRequest.page.locale", { nonEmpty: true, maximum: 64 });
    optionalString(checker, page, "timezone", "$bootstrapRequest.page", 128);
    if (page.referrerOrigin !== undefined) checkOrigin(checker, page.referrerOrigin, "$bootstrapRequest.page.referrerOrigin");
  }
  checkCapabilities(checker, object.capabilities, "$bootstrapRequest.capabilities");
  return result(checker, value);
}

export function assertValidSdkBootstrapRequest(value: unknown): SdkBootstrapRequest {
  return assertResult("SdkBootstrapRequest", validateSdkBootstrapRequest(value));
}

export function validateSdkBootstrapResponse(value: unknown): ValidationResult<SdkBootstrapResponse> {
  const checker = new Checker();
  const object = checker.object(value, "$bootstrapResponse");
  if (!object) return result(checker, value);
  checker.literal(object.kind, "sable.sdk.bootstrap.response", "$bootstrapResponse.kind");
  checker.literal(object.schemaVersion, SDK_PROTOCOL_VERSION, "$bootstrapResponse.schemaVersion");
  checker.id(object.requestId, "$bootstrapResponse.requestId");
  checker.isoDate(object.serverTime, "$bootstrapResponse.serverTime");
  const session = checker.object(object.session, "$bootstrapResponse.session");
  if (session) {
    checker.literal(session.kind, "sable.sdk.session", "$bootstrapResponse.session.kind");
    checker.literal(session.schemaVersion, SDK_PROTOCOL_VERSION, "$bootstrapResponse.session.schemaVersion");
    ["sessionId", "continuityId", "installationId", "organizationId", "productId", "environmentId", "roleProfileId", "userId", "catalogVersionId"].forEach((key) => checker.id(session[key], `$bootstrapResponse.session.${key}`));
    checkOrigin(checker, session.origin, "$bootstrapResponse.session.origin");
    checker.string(session.sessionToken, "$bootstrapResponse.session.sessionToken", { nonEmpty: true, maximum: 20_000 });
    checker.isoDate(session.expiresAt, "$bootstrapResponse.session.expiresAt");
  }
  const catalog = checker.object(object.catalog, "$bootstrapResponse.catalog");
  if (catalog) {
    checker.oneOf(catalog.kind, ["inline", "remote"], "$bootstrapResponse.catalog.kind");
    if (catalog.kind === "inline") {
      const envelopeValidation = validateSignedCatalogEnvelope(catalog.envelope);
      if (!envelopeValidation.ok) envelopeValidation.issues.forEach((issue) => checker.issue(`$bootstrapResponse.catalog.envelope${issue.path.slice("$envelope".length)}`, issue.message));
    } else if (catalog.kind === "remote") {
      checker.string(catalog.url, "$bootstrapResponse.catalog.url", { nonEmpty: true, maximum: 10_000 });
      checkDigest(checker, catalog.digest, "$bootstrapResponse.catalog.digest");
      checker.id(catalog.keyId, "$bootstrapResponse.catalog.keyId");
    }
  }
  const transport = checker.object(object.transport, "$bootstrapResponse.transport");
  if (transport) {
    if (checker.string(transport.websocketUrl, "$bootstrapResponse.transport.websocketUrl", { nonEmpty: true, maximum: 10_000 }) && !/^wss?:\/\//i.test(transport.websocketUrl as string)) checker.issue("$bootstrapResponse.transport.websocketUrl", "must be a ws(s) URL");
    checker.string(transport.oneTimeTicket, "$bootstrapResponse.transport.oneTimeTicket", { nonEmpty: true, maximum: 20_000 });
    checker.isoDate(transport.expiresAt, "$bootstrapResponse.transport.expiresAt");
  }
  if (object.voiceTransport !== undefined) {
    const voice = checker.object(object.voiceTransport, "$bootstrapResponse.voiceTransport");
    if (voice) {
      if (checker.string(voice.websocketUrl, "$bootstrapResponse.voiceTransport.websocketUrl", { nonEmpty: true, maximum: 10_000 }) && !/^wss?:\/\//i.test(voice.websocketUrl as string)) checker.issue("$bootstrapResponse.voiceTransport.websocketUrl", "must be a ws(s) URL");
      checker.string(voice.oneTimeTicket, "$bootstrapResponse.voiceTransport.oneTimeTicket", { nonEmpty: true, maximum: 20_000 });
      checker.isoDate(voice.expiresAt, "$bootstrapResponse.voiceTransport.expiresAt");
      checker.string(voice.languageCode, "$bootstrapResponse.voiceTransport.languageCode", { nonEmpty: true, maximum: 32 });
      checker.literal(voice.sampleRate, 16000, "$bootstrapResponse.voiceTransport.sampleRate");
      checker.number(voice.silenceTimeoutMs, "$bootstrapResponse.voiceTransport.silenceTimeoutMs", { integer: true, minimum: 300, maximum: 3_000 });
      checker.number(voice.minimumSpeechMs, "$bootstrapResponse.voiceTransport.minimumSpeechMs", { integer: true, minimum: 100, maximum: 2_000 });
      checker.number(voice.maximumUtteranceMs, "$bootstrapResponse.voiceTransport.maximumUtteranceMs", { integer: true, minimum: 5_000, maximum: 120_000 });
      checker.number(voice.audioFrameMs, "$bootstrapResponse.voiceTransport.audioFrameMs", { integer: true, minimum: 20, maximum: 100 });
      checker.number(voice.vadThreshold, "$bootstrapResponse.voiceTransport.vadThreshold", { minimum: 0.001, maximum: 0.8 });
      checker.number(voice.audioWaitCapMs, "$bootstrapResponse.voiceTransport.audioWaitCapMs", { integer: true, minimum: 1_000, maximum: 30_000 });
      checker.boolean(voice.autoStop, "$bootstrapResponse.voiceTransport.autoStop");
      checker.boolean(voice.bargeIn, "$bootstrapResponse.voiceTransport.bargeIn");
      checker.oneOf(voice.speakMode, ["voice_turns", "all", "off"], "$bootstrapResponse.voiceTransport.speakMode");
      checker.boolean(voice.stepNarration, "$bootstrapResponse.voiceTransport.stepNarration");
    }
  }
  const killSwitch = checker.object(object.killSwitch, "$bootstrapResponse.killSwitch");
  if (killSwitch) {
    checker.boolean(killSwitch.disabled, "$bootstrapResponse.killSwitch.disabled");
    optionalString(checker, killSwitch, "reason", "$bootstrapResponse.killSwitch", 2_000);
  }
  return result(checker, value);
}

export function assertValidSdkBootstrapResponse(value: unknown): SdkBootstrapResponse {
  return assertResult("SdkBootstrapResponse", validateSdkBootstrapResponse(value));
}

function checkMessageBase(checker: Checker, object: RecordValue, path: string): void {
  checker.literal(object.schemaVersion, SDK_PROTOCOL_VERSION, `${path}.schemaVersion`);
  checker.id(object.sessionId, `${path}.sessionId`);
  checker.isoDate(object.sentAt, `${path}.sentAt`);
}

export function validateSdkClientMessage(value: unknown): ValidationResult<SdkClientMessage> {
  const checker = new Checker();
  const path = "$clientMessage";
  const object = checker.object(value, path);
  if (!object) return result(checker, value);
  checkMessageBase(checker, object, path);
  checker.id(object.messageId, `${path}.messageId`);
  const kinds = ["sable.sdk.client.ready", "sable.sdk.client.demo_control", "sable.sdk.client.restore_context", "sable.sdk.client.user_turn", "sable.sdk.client.observation", "sable.sdk.client.journey_result", "sable.sdk.client.catalog_navigation_result", "sable.sdk.client.approval_result", "sable.sdk.client.journey_progress", "sable.sdk.client.journey_narration", "sable.sdk.client.demo_narration", "sable.sdk.client.audio_playback", "sable.sdk.client.interrupt", "sable.sdk.client.pong"] as const;
  checker.oneOf(object.kind, kinds, `${path}.kind`);
  const baseKeys = ["kind", "schemaVersion", "messageId", "sessionId", "sentAt"];
  if (object.kind === "sable.sdk.client.ready") {
    checker.onlyKeys(object, [...baseKeys, "catalogVersionId", "currentUrl"], path);
    checker.id(object.catalogVersionId, `${path}.catalogVersionId`);
    checker.string(object.currentUrl, `${path}.currentUrl`, { nonEmpty: true, maximum: 10_000 });
  } else if (object.kind === "sable.sdk.client.demo_control") {
    checker.onlyKeys(object, [...baseKeys, "action"], path);
    checker.oneOf(object.action, ["start", "continue", "retry", "skip", "stop"], `${path}.action`);
  } else if (object.kind === "sable.sdk.client.restore_context") {
    checker.onlyKeys(object, [...baseKeys, "continuityId", "transcript", "journey", "catalogNavigation"], path);
    checker.id(object.continuityId, `${path}.continuityId`);
    const transcript = checker.array(object.transcript, `${path}.transcript`, 12);
    transcript?.forEach((rawMessage, index) => {
      const at = `${path}.transcript[${index}]`;
      const message = checker.object(rawMessage, at);
      if (!message) return;
      checker.onlyKeys(message, ["key", "role", "text", "createdAt"], at);
      checker.string(message.key, `${at}.key`, { nonEmpty: true, maximum: 256 });
      checker.oneOf(message.role, ["user", "assistant"], `${at}.role`);
      checker.string(message.text, `${at}.text`, { nonEmpty: true, maximum: 10_000 });
      checker.isoDate(message.createdAt, `${at}.createdAt`);
    });
    if (object.journey !== undefined) {
      const journey = checker.object(object.journey, `${path}.journey`);
      if (journey) {
        checker.onlyKeys(journey, ["journeyId", "journeyVersion", "turnId", "originalRequest", "inputs", "completedStepIds", "nextStepId", "navigationStepId", "destinationUrl", "expectedScreenIds", "stopAfterStepId"], `${path}.journey`);
        checker.id(journey.journeyId, `${path}.journey.journeyId`);
        checker.number(journey.journeyVersion, `${path}.journey.journeyVersion`, { integer: true, minimum: 1 });
        checker.id(journey.turnId, `${path}.journey.turnId`);
        checker.string(journey.originalRequest, `${path}.journey.originalRequest`, { nonEmpty: true, maximum: 10_000 });
        const inputs = checker.object(journey.inputs, `${path}.journey.inputs`);
        if (inputs) Object.entries(inputs).forEach(([key, value]) => checkJson(checker, value, `${path}.journey.inputs.${key}`));
        checker.stringArray(journey.completedStepIds, `${path}.journey.completedStepIds`, 500);
        checker.id(journey.nextStepId, `${path}.journey.nextStepId`);
        checker.id(journey.navigationStepId, `${path}.journey.navigationStepId`);
        if (journey.stopAfterStepId !== undefined) checker.id(journey.stopAfterStepId, `${path}.journey.stopAfterStepId`);
        checker.string(journey.destinationUrl, `${path}.journey.destinationUrl`, { nonEmpty: true, maximum: 10_000 });
        const screens = checker.stringArray(journey.expectedScreenIds, `${path}.journey.expectedScreenIds`, 20);
        if (screens?.length === 0) checker.issue(`${path}.journey.expectedScreenIds`, "must not be empty");
      }
    }
    if (object.catalogNavigation !== undefined) {
      const navigation = checker.object(object.catalogNavigation, `${path}.catalogNavigation`);
      if (navigation) {
        checker.onlyKeys(navigation, ["turnId", "originalRequest", "sourceScreenId", "controlId", "targetScreenId", "destinationUrl"], `${path}.catalogNavigation`);
        checker.id(navigation.turnId, `${path}.catalogNavigation.turnId`);
        checker.string(navigation.originalRequest, `${path}.catalogNavigation.originalRequest`, { nonEmpty: true, maximum: 10_000 });
        checker.id(navigation.sourceScreenId, `${path}.catalogNavigation.sourceScreenId`);
        checker.id(navigation.controlId, `${path}.catalogNavigation.controlId`);
        checker.id(navigation.targetScreenId, `${path}.catalogNavigation.targetScreenId`);
        checker.string(navigation.destinationUrl, `${path}.catalogNavigation.destinationUrl`, { nonEmpty: true, maximum: 10_000 });
      }
    }
  } else if (object.kind === "sable.sdk.client.user_turn") {
    checker.onlyKeys(object, [...baseKeys, "turnId", "text", "modality"], path);
    checker.id(object.turnId, `${path}.turnId`);
    checker.string(object.text, `${path}.text`, { nonEmpty: true, maximum: 50_000 });
    checker.oneOf(object.modality, ["text", "voice"], `${path}.modality`);
  } else if (object.kind === "sable.sdk.client.observation") {
    checker.onlyKeys(object, [...baseKeys, "observation", "reason", "replyToCommandId", "turnId"], path);
    checkScreenObservation(checker, object.observation, `${path}.observation`);
    checker.oneOf(object.reason, ["initial", "changed", "requested"], `${path}.reason`);
    optionalString(checker, object, "replyToCommandId", path, 256);
    optionalString(checker, object, "turnId", path, 256);
  } else if (object.kind === "sable.sdk.client.journey_result") {
    checker.onlyKeys(object, [...baseKeys, "commandId", "journeyId", "ok", "completedSteps", "failedStepId", "detail"], path);
    checker.id(object.commandId, `${path}.commandId`);
    checker.id(object.journeyId, `${path}.journeyId`);
    checker.boolean(object.ok, `${path}.ok`);
    checker.number(object.completedSteps, `${path}.completedSteps`, { integer: true, minimum: 0, maximum: CONTRACT_LIMITS.workflowSteps });
    optionalString(checker, object, "failedStepId", path, 256);
    optionalString(checker, object, "detail", path, 5_000);
  } else if (object.kind === "sable.sdk.client.catalog_navigation_result") {
    checker.onlyKeys(object, [...baseKeys, "commandId", "ok", "detail"], path);
    checker.id(object.commandId, `${path}.commandId`);
    checker.boolean(object.ok, `${path}.ok`);
    optionalString(checker, object, "detail", path, 5_000);
  } else if (object.kind === "sable.sdk.client.approval_result") {
    checker.onlyKeys(object, [...baseKeys, "commandId", "approved"], path);
    checker.id(object.commandId, `${path}.commandId`);
    checker.boolean(object.approved, `${path}.approved`);
  } else if (object.kind === "sable.sdk.client.journey_progress") {
    checker.onlyKeys(object, [...baseKeys, "commandId", "journeyId", "stepId", "phase", "detail"], path);
    checker.id(object.commandId, `${path}.commandId`);
    checker.id(object.journeyId, `${path}.journeyId`);
    checker.id(object.stepId, `${path}.stepId`);
    checker.oneOf(object.phase, ["started", "completed", "failed", "paused"], `${path}.phase`);
    optionalString(checker, object, "detail", path, 5_000);
  } else if (object.kind === "sable.sdk.client.journey_narration") {
    checker.onlyKeys(object, [...baseKeys, "commandId", "journeyId", "stepId", "turnId", "utteranceId"], path);
    checker.id(object.commandId, `${path}.commandId`);
    checker.id(object.journeyId, `${path}.journeyId`);
    checker.id(object.stepId, `${path}.stepId`);
    checker.id(object.turnId, `${path}.turnId`);
    checker.id(object.utteranceId, `${path}.utteranceId`);
  } else if (object.kind === "sable.sdk.client.demo_narration") {
    checker.onlyKeys(object, [...baseKeys, "cueKind", "turnId", "utteranceId", "moduleId", "questionId"], path);
    checker.oneOf(object.cueKind, ["greeting", "question", "module_introduction", "module_completion", "module_failure", "closing"], `${path}.cueKind`);
    checker.id(object.turnId, `${path}.turnId`);
    checker.id(object.utteranceId, `${path}.utteranceId`);
    optionalString(checker, object, "moduleId", path, 256);
    optionalString(checker, object, "questionId", path, 256);
  } else if (object.kind === "sable.sdk.client.audio_playback") {
    checker.onlyKeys(object, [...baseKeys, "utteranceId", "turnId", "sequence", "state", "detail"], path);
    checker.id(object.utteranceId, `${path}.utteranceId`);
    checker.id(object.turnId, `${path}.turnId`);
    checker.number(object.sequence, `${path}.sequence`, { integer: true, minimum: 0, maximum: 1_000_000 });
    checker.oneOf(object.state, ["started", "ended", "cancelled", "failed"], `${path}.state`);
    optionalString(checker, object, "detail", path, 2_000);
  } else if (object.kind === "sable.sdk.client.interrupt") {
    checker.onlyKeys(object, [...baseKeys, "reason"], path);
    checker.oneOf(object.reason, ["user", "navigation", "logout", "page_hidden"], `${path}.reason`);
  } else if (object.kind === "sable.sdk.client.pong") {
    checker.onlyKeys(object, [...baseKeys, "replyTo"], path);
    checker.id(object.replyTo, `${path}.replyTo`);
  }
  return result(checker, value);
}

export function assertValidSdkClientMessage(value: unknown): SdkClientMessage {
  return assertResult("SdkClientMessage", validateSdkClientMessage(value));
}

export function validateSdkServerCommand(value: unknown): ValidationResult<SdkServerCommand> {
  const checker = new Checker();
  const path = "$serverCommand";
  const object = checker.object(value, path);
  if (!object) return result(checker, value);
  checkMessageBase(checker, object, path);
  checker.id(object.commandId, `${path}.commandId`);
  const kinds = ["sable.sdk.server.assistant_delta", "sable.sdk.server.assistant_final", "sable.sdk.server.run_journey", "sable.sdk.server.run_catalog_navigation", "sable.sdk.server.clear_catalog_navigation", "sable.sdk.server.restore_state", "sable.sdk.server.request_observation", "sable.sdk.server.pause_journey", "sable.sdk.server.stop_journey", "sable.sdk.server.request_approval", "sable.sdk.server.catalog_updated", "sable.sdk.server.session_policy", "sable.sdk.server.demo_state", "sable.sdk.server.speak", "sable.sdk.server.ping", "sable.sdk.server.error"] as const;
  checker.oneOf(object.kind, kinds, `${path}.kind`);
  const baseKeys = ["kind", "schemaVersion", "commandId", "sessionId", "sentAt"];
  if (object.kind === "sable.sdk.server.assistant_delta" || object.kind === "sable.sdk.server.assistant_final") {
    checker.onlyKeys(object, object.kind === "sable.sdk.server.assistant_final" ? [...baseKeys, "turnId", "text", "suggestedJourneyIds"] : [...baseKeys, "turnId", "text"], path);
    checker.id(object.turnId, `${path}.turnId`);
    checker.string(object.text, `${path}.text`, { maximum: 50_000 });
    if (object.kind === "sable.sdk.server.assistant_final" && object.suggestedJourneyIds !== undefined) checker.stringArray(object.suggestedJourneyIds, `${path}.suggestedJourneyIds`, 100);
  } else if (object.kind === "sable.sdk.server.run_journey") {
    checker.onlyKeys(object, [...baseKeys, "turnId", "catalogVersionId", "journeyId", "inputs", "segment", "resume"], path);
    checker.id(object.turnId, `${path}.turnId`);
    checker.id(object.catalogVersionId, `${path}.catalogVersionId`);
    checker.id(object.journeyId, `${path}.journeyId`);
    const inputs = checker.object(object.inputs, `${path}.inputs`);
    if (inputs) {
      if (Object.keys(inputs).length > 1_000) checker.issue(`${path}.inputs`, "must contain at most 1000 properties");
      Object.entries(inputs).forEach(([key, input]) => checkJson(checker, input, `${path}.inputs.${key}`));
    }
    if (object.resume !== undefined) {
      const resume = checker.object(object.resume, `${path}.resume`);
      if (resume) {
        checker.onlyKeys(resume, ["completedStepIds", "nextStepId"], `${path}.resume`);
        checker.stringArray(resume.completedStepIds, `${path}.resume.completedStepIds`, 500);
        checker.id(resume.nextStepId, `${path}.resume.nextStepId`);
      }
    }
  } else if (object.kind === "sable.sdk.server.run_catalog_navigation") {
    checker.onlyKeys(object, [...baseKeys, "turnId", "catalogVersionId", "sourceScreenId", "controlId", "targetScreenId"], path);
    checker.id(object.turnId, `${path}.turnId`);
    checker.id(object.catalogVersionId, `${path}.catalogVersionId`);
    checker.id(object.sourceScreenId, `${path}.sourceScreenId`);
    checker.id(object.controlId, `${path}.controlId`);
    checker.id(object.targetScreenId, `${path}.targetScreenId`);
  } else if (object.kind === "sable.sdk.server.clear_catalog_navigation") {
    checker.onlyKeys(object, baseKeys, path);
  } else if (object.kind === "sable.sdk.server.restore_state") {
    checker.onlyKeys(object, [...baseKeys, "continuityId", "revision", "transcript"], path);
    checker.id(object.continuityId, `${path}.continuityId`);
    checker.number(object.revision, `${path}.revision`, { integer: true, minimum: 0 });
    const transcript = checker.array(object.transcript, `${path}.transcript`, 100);
    transcript?.forEach((rawMessage, index) => {
      const at = `${path}.transcript[${index}]`;
      const message = checker.object(rawMessage, at);
      if (!message) return;
      checker.onlyKeys(message, ["key", "role", "text", "createdAt"], at);
      checker.string(message.key, `${at}.key`, { nonEmpty: true, maximum: 256 });
      checker.oneOf(message.role, ["user", "assistant"], `${at}.role`);
      checker.string(message.text, `${at}.text`, { nonEmpty: true, maximum: 10_000 });
      checker.isoDate(message.createdAt, `${at}.createdAt`);
    });
  } else if (object.kind === "sable.sdk.server.request_observation" || object.kind === "sable.sdk.server.pause_journey" || object.kind === "sable.sdk.server.stop_journey") {
    checker.onlyKeys(object, object.kind === "sable.sdk.server.request_observation" ? [...baseKeys, "reason", "turnId"] : object.kind === "sable.sdk.server.pause_journey" ? [...baseKeys, "journeyId", "reason"] : [...baseKeys, "reason"], path);
    checker.string(object.reason, `${path}.reason`, { nonEmpty: true, maximum: 2_000 });
    if (object.kind === "sable.sdk.server.request_observation") optionalString(checker, object, "turnId", path, 256);
    if (object.kind === "sable.sdk.server.pause_journey") checker.id(object.journeyId, `${path}.journeyId`);
  }
  else if (object.kind === "sable.sdk.server.request_approval") {
    checker.onlyKeys(object, [...baseKeys, "journeyId", "stepId", "risk", "title", "description"], path);
    checker.id(object.journeyId, `${path}.journeyId`);
    checker.id(object.stepId, `${path}.stepId`);
    checker.oneOf(object.risk, RISKS, `${path}.risk`);
    checker.string(object.title, `${path}.title`, { nonEmpty: true, maximum: 1_000 });
    checker.string(object.description, `${path}.description`, { nonEmpty: true, maximum: 5_000 });
  } else if (object.kind === "sable.sdk.server.catalog_updated") {
    checker.onlyKeys(object, [...baseKeys, "catalogVersionId", "reloadRequired"], path);
    checker.id(object.catalogVersionId, `${path}.catalogVersionId`);
    checker.boolean(object.reloadRequired, `${path}.reloadRequired`);
  } else if (object.kind === "sable.sdk.server.session_policy") {
    checker.onlyKeys(object, [...baseKeys, "sdkDisabled", "reason"], path);
    checker.boolean(object.sdkDisabled, `${path}.sdkDisabled`);
    optionalString(checker, object, "reason", path, 2_000);
  } else if (object.kind === "sable.sdk.server.demo_state") {
    checker.onlyKeys(object, [...baseKeys, "phase", "activeModuleId", "activeQuestionId", "canStart", "canContinue", "canRetry", "canSkip", "canStop"], path);
    checker.oneOf(object.phase, ["idle", "intake", "playing", "pausing", "paused", "answering", "awaiting_resume", "closing", "completed", "stopped"], `${path}.phase`);
    optionalString(checker, object, "activeModuleId", path, 256);
    optionalString(checker, object, "activeQuestionId", path, 256);
    ["canStart", "canContinue", "canRetry", "canSkip", "canStop"].forEach((key) => checker.boolean(object[key], `${path}.${key}`));
  } else if (object.kind === "sable.sdk.server.speak") {
    checker.onlyKeys(object, [...baseKeys, "turnId", "text", "voice"], path);
    checker.id(object.turnId, `${path}.turnId`);
    checker.string(object.text, `${path}.text`, { nonEmpty: true, maximum: 50_000 });
    optionalString(checker, object, "voice", path, 256);
  } else if (object.kind === "sable.sdk.server.error") {
    checker.onlyKeys(object, [...baseKeys, "code", "message", "retryable"], path);
    checker.id(object.code, `${path}.code`);
    checker.string(object.message, `${path}.message`, { nonEmpty: true, maximum: 5_000 });
    checker.boolean(object.retryable, `${path}.retryable`);
  } else if (object.kind === "sable.sdk.server.ping") {
    checker.onlyKeys(object, baseKeys, path);
  }
  return result(checker, value);
}

export function assertValidSdkServerCommand(value: unknown): SdkServerCommand {
  return assertResult("SdkServerCommand", validateSdkServerCommand(value));
}

const TELEMETRY_TYPES = ["session.started", "session.stopped", "catalog.loaded", "screen.matched", "element.resolved", "action.completed", "journey.started", "journey.completed", "journey.failed", "approval.requested", "approval.resolved", "privacy.redacted", "transport.state", "sdk.error"] as const;

function checkTelemetryEvent(checker: Checker, value: unknown, path: string, expectedSessionId?: string): void {
  const event = checker.object(value, path);
  if (!event) return;
  checker.literal(event.kind, "sable.sdk.telemetry_event", `${path}.kind`);
  checker.literal(event.schemaVersion, SDK_TELEMETRY_SCHEMA_VERSION, `${path}.schemaVersion`);
  checker.id(event.eventId, `${path}.eventId`);
  checker.number(event.sequence, `${path}.sequence`, { integer: true, minimum: 0 });
  checker.id(event.sessionId, `${path}.sessionId`);
  if (expectedSessionId && event.sessionId !== expectedSessionId) checker.issue(`${path}.sessionId`, "must equal the enclosing batch sessionId");
  checker.id(event.installationId, `${path}.installationId`);
  checker.id(event.catalogVersionId, `${path}.catalogVersionId`);
  checker.isoDate(event.occurredAt, `${path}.occurredAt`);
  optionalNumber(checker, event, "durationMs", path, 0, 3_600_000);
  checker.oneOf(event.type, TELEMETRY_TYPES, `${path}.type`);
  const baseKeys = ["kind", "schemaVersion", "eventId", "sequence", "sessionId", "installationId", "catalogVersionId", "occurredAt", "durationMs", "type"];
  if (event.type === "session.started" || event.type === "session.stopped") {
    checker.onlyKeys(event, [...baseKeys, "reason"], path);
    optionalString(checker, event, "reason", path, 2_000);
  }
  else if (event.type === "catalog.loaded") {
    checker.onlyKeys(event, [...baseKeys, "source", "version"], path);
    checker.oneOf(event.source, ["network", "cache"], `${path}.source`);
    checker.number(event.version, `${path}.version`, { integer: true, minimum: 1 });
  } else if (event.type === "screen.matched") {
    checker.onlyKeys(event, [...baseKeys, "screenId", "confidence", "fingerprint"], path);
    optionalString(checker, event, "screenId", path, 256);
    checker.number(event.confidence, `${path}.confidence`, { minimum: 0, maximum: 1 });
    checker.string(event.fingerprint, `${path}.fingerprint`, { nonEmpty: true, maximum: 512 });
  } else if (event.type === "element.resolved") {
    checker.onlyKeys(event, [...baseKeys, "controlId", "locatorKind", "locatorRank", "candidateCount", "ok", "detail"], path);
    checker.id(event.controlId, `${path}.controlId`);
    optionalString(checker, event, "locatorKind", path, 128);
    optionalNumber(checker, event, "locatorRank", path, 1, 1_000);
    checker.number(event.candidateCount, `${path}.candidateCount`, { integer: true, minimum: 0, maximum: 10_000 });
    checker.boolean(event.ok, `${path}.ok`);
    optionalString(checker, event, "detail", path, 2_000);
  } else if (event.type === "action.completed") {
    checker.onlyKeys(event, [...baseKeys, "journeyId", "stepId", "action", "compatibility", "ok", "detail"], path);
    checker.id(event.journeyId, `${path}.journeyId`);
    checker.id(event.stepId, `${path}.stepId`);
    checker.id(event.action, `${path}.action`);
    checker.oneOf(event.compatibility, COMPATIBILITY, `${path}.compatibility`);
    checker.boolean(event.ok, `${path}.ok`);
    optionalString(checker, event, "detail", path, 2_000);
  } else if (event.type === "journey.started" || event.type === "journey.completed" || event.type === "journey.failed") {
    checker.onlyKeys(event, [...baseKeys, "journeyId", "completedSteps", "detail"], path);
    checker.id(event.journeyId, `${path}.journeyId`);
    optionalNumber(checker, event, "completedSteps", path, 0, HARD_SAFE_INTEGER);
    optionalString(checker, event, "detail", path, 2_000);
  } else if (event.type === "approval.requested") {
    checker.onlyKeys(event, [...baseKeys, "journeyId", "stepId", "risk"], path);
    checker.id(event.journeyId, `${path}.journeyId`);
    checker.id(event.stepId, `${path}.stepId`);
    checker.oneOf(event.risk, RISKS, `${path}.risk`);
  } else if (event.type === "approval.resolved") {
    checker.onlyKeys(event, [...baseKeys, "journeyId", "stepId", "approved"], path);
    checker.id(event.journeyId, `${path}.journeyId`);
    checker.id(event.stepId, `${path}.stepId`);
    checker.boolean(event.approved, `${path}.approved`);
  } else if (event.type === "privacy.redacted") {
    checker.onlyKeys(event, [...baseKeys, "ruleKind", "count"], path);
    checker.id(event.ruleKind, `${path}.ruleKind`);
    checker.number(event.count, `${path}.count`, { integer: true, minimum: 0, maximum: 1_000_000 });
  } else if (event.type === "transport.state") {
    checker.onlyKeys(event, [...baseKeys, "state", "detail"], path);
    checker.oneOf(event.state, ["connecting", "connected", "disconnected", "failed"], `${path}.state`);
    optionalString(checker, event, "detail", path, 2_000);
  } else if (event.type === "sdk.error") {
    checker.onlyKeys(event, [...baseKeys, "code", "message", "context"], path);
    checker.id(event.code, `${path}.code`);
    checker.string(event.message, `${path}.message`, { nonEmpty: true, maximum: 2_000 });
    if (event.context !== undefined) {
      const context = checker.object(event.context, `${path}.context`);
      if (context) {
        for (const [key, item] of Object.entries(context)) {
          if (/password|passcode|secret|token|authorization|cookie|visible.?text|element.?value/i.test(key)) checker.issue(`${path}.context.${key}`, "sensitive fields are forbidden in telemetry context");
          checkJson(checker, item, `${path}.context.${key}`);
        }
      }
    }
  }
}

const HARD_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

export function validateSdkTelemetryBatch(value: unknown): ValidationResult<SdkTelemetryBatch> {
  const checker = new Checker();
  const path = "$telemetryBatch";
  const batch = checker.object(value, path);
  if (!batch) return result(checker, value);
  checker.literal(batch.kind, "sable.sdk.telemetry_batch", `${path}.kind`);
  checker.literal(batch.schemaVersion, SDK_TELEMETRY_SCHEMA_VERSION, `${path}.schemaVersion`);
  checker.id(batch.batchId, `${path}.batchId`);
  const sessionId = checker.id(batch.sessionId, `${path}.sessionId`) ? (batch.sessionId as string) : undefined;
  checker.isoDate(batch.sentAt, `${path}.sentAt`);
  const events = checker.array(batch.events, `${path}.events`, CONTRACT_LIMITS.telemetryEventsPerBatch);
  const ids = new Set<string>();
  const sequences = new Set<number>();
  events?.forEach((event, index) => {
    const at = `${path}.events[${index}]`;
    checkTelemetryEvent(checker, event, at, sessionId);
    if (!event || typeof event !== "object") return;
    const record = event as RecordValue;
    if (typeof record.eventId === "string") {
      if (ids.has(record.eventId)) checker.issue(`${at}.eventId`, `duplicates event ${record.eventId}`);
      ids.add(record.eventId);
    }
    if (typeof record.sequence === "number") {
      if (sequences.has(record.sequence)) checker.issue(`${at}.sequence`, `duplicates sequence ${record.sequence}`);
      sequences.add(record.sequence);
    }
  });
  return result(checker, value);
}

export function assertValidSdkTelemetryBatch(value: unknown): SdkTelemetryBatch {
  return assertResult("SdkTelemetryBatch", validateSdkTelemetryBatch(value));
}
