import type { JsonValue, JourneyInputSchema, TemplateTransform, TemplateValue } from "@sable/sdk-contracts";

export interface InputValidationResult {
  ok: boolean;
  values: Record<string, JsonValue>;
  errors: string[];
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 20) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 10_000 && value.every((item) => isJsonValue(item, depth + 1));
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length <= 10_000 && entries.every(([key, item]) => key.length <= 256 && isJsonValue(item, depth + 1));
}

export function validateJourneyInputs(schema: JourneyInputSchema, supplied: Record<string, unknown>): InputValidationResult {
  const errors: string[] = [];
  const values: Record<string, JsonValue> = {};
  const propertyNames = new Set(Object.keys(schema.properties));
  for (const key of Object.keys(supplied)) {
    if (!propertyNames.has(key)) errors.push(`unexpected input ${key}`);
  }
  for (const required of schema.required) {
    if (supplied[required] === undefined && schema.properties[required]?.default === undefined) errors.push(`missing required input ${required}`);
  }
  for (const [name, property] of Object.entries(schema.properties)) {
    const candidate = supplied[name] ?? property.default;
    if (candidate === undefined) continue;
    if (!isJsonValue(candidate)) {
      errors.push(`input ${name} is not a JSON value`);
      continue;
    }
    let typeMatches = false;
    if (property.type === "string") typeMatches = typeof candidate === "string";
    else if (property.type === "number") typeMatches = typeof candidate === "number" && Number.isFinite(candidate);
    else if (property.type === "boolean") typeMatches = typeof candidate === "boolean";
    else if (property.type === "enum") typeMatches = property.enum?.some((entry) => JSON.stringify(entry) === JSON.stringify(candidate)) ?? false;
    else typeMatches = true;
    if (!typeMatches) {
      errors.push(`input ${name} must be ${property.type}`);
      continue;
    }
    if (typeof candidate === "number") {
      if (property.minimum !== undefined && candidate < property.minimum) errors.push(`input ${name} must be at least ${property.minimum}`);
      if (property.maximum !== undefined && candidate > property.maximum) errors.push(`input ${name} must be at most ${property.maximum}`);
    }
    if (typeof candidate === "string") {
      if (property.minimumLength !== undefined && candidate.length < property.minimumLength) errors.push(`input ${name} must contain at least ${property.minimumLength} characters`);
      if (property.maximumLength !== undefined && candidate.length > property.maximumLength) errors.push(`input ${name} must contain at most ${property.maximumLength} characters`);
      if (property.pattern !== undefined) {
        try {
          if (!new RegExp(property.pattern).test(candidate)) errors.push(`input ${name} does not match its required pattern`);
        } catch {
          errors.push(`input ${name} has an invalid configured pattern`);
        }
      }
    }
    values[name] = candidate;
  }
  return { ok: errors.length === 0, values, errors };
}

function applyTransform(value: JsonValue, transform: TemplateTransform): JsonValue {
  if (transform === "stringify") return typeof value === "string" ? value : JSON.stringify(value);
  if (typeof value !== "string") throw new Error(`${transform} requires a string input`);
  if (transform === "trim") return value.trim();
  if (transform === "lowercase") return value.toLowerCase();
  return value.toUpperCase();
}

export function resolveTemplate(template: TemplateValue, inputs: Readonly<Record<string, JsonValue>>, depth = 0): JsonValue {
  if (depth > 20) throw new Error("template exceeds the 20-level resolution limit");
  if (template.kind === "literal") return template.value;
  if (template.kind === "input_ref") {
    const raw = inputs[template.name] ?? template.fallback;
    if (raw === undefined) throw new Error(`missing workflow input ${template.name}`);
    return (template.transforms ?? []).reduce<JsonValue>((value, transform) => applyTransform(value, transform), raw);
  }
  if (template.kind === "array") return template.items.map((item) => resolveTemplate(item, inputs, depth + 1));
  const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const [key, item] of Object.entries(template.properties)) result[key] = resolveTemplate(item, inputs, depth + 1);
  return result;
}
