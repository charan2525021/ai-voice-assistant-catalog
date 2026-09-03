import { canonicalizeJson, type JsonValue, type ToolDefinition } from "@sable/sdk-contracts";
import { SableSdkError, throwIfAborted } from "./errors.js";
import { isRecord } from "./utils.js";

export interface ToolExecutionContext {
  signal: AbortSignal;
  journeyId: string;
  stepId: string;
}

export interface RegisteredTool {
  definition: ToolDefinition;
  execute(input: JsonValue, context: ToolExecutionContext): Promise<JsonValue> | JsonValue;
  check?(operation: string, input: JsonValue | undefined, context: ToolExecutionContext): Promise<boolean> | boolean;
}

export interface ToolResult {
  ok: boolean;
  output?: JsonValue;
  detail: string;
}

function toolName(definition: ToolDefinition): string {
  return String((definition as unknown as Record<string, unknown>).name ?? "");
}

function schemaAccepts(schema: unknown, value: unknown): boolean {
  if (!isRecord(schema)) return false;
  if (schema.kind === "sable.journey_input_schema") {
    if (!isRecord(value) || !isRecord(schema.properties)) return false;
    const properties = schema.properties;
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
    if (required.some((key) => !(key in value))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some((key) => !(key in properties))) return false;
    return Object.entries(value).every(([key, item]) => {
      const property = properties[key];
      if (!isRecord(property)) return false;
      if (property.type === "json") return true;
      if (property.type === "string") {
        if (typeof item !== "string") return false;
        if (typeof property.minimumLength === "number" && item.length < property.minimumLength) return false;
        if (typeof property.maximumLength === "number" && item.length > property.maximumLength) return false;
        if (typeof property.pattern === "string") {
          try { if (!new RegExp(property.pattern).test(item)) return false; } catch { return false; }
        }
        return true;
      }
      if (property.type === "number") return typeof item === "number" && Number.isFinite(item)
        && (typeof property.minimum !== "number" || item >= property.minimum)
        && (typeof property.maximum !== "number" || item <= property.maximum);
      if (property.type === "boolean") return typeof item === "boolean";
      if (property.type === "enum") return Array.isArray(property.enum)
        && property.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(item));
      return false;
    });
  }
  const type = schema.type;
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) return false;
  if (type === "object") {
    if (!isRecord(value)) return false;
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
    if (required.some((key) => !(key in value))) return false;
    const properties = isRecord(schema.properties) ? schema.properties : {};
    if (schema.additionalProperties === false && Object.keys(value).some((key) => !(key in properties))) return false;
    return Object.entries(value).every(([key, item]) => properties[key] === undefined || schemaAccepts(properties[key], item));
  }
  if (type === "array") return Array.isArray(value) && (!schema.items || value.every((item) => schemaAccepts(schema.items, item)));
  if (type === "string") return typeof value === "string"
    && (typeof schema.minLength !== "number" || value.length >= schema.minLength)
    && (typeof schema.maxLength !== "number" || value.length <= schema.maxLength)
    && (typeof schema.pattern !== "string" || (() => { try { return new RegExp(schema.pattern).test(value); } catch { return false; } })());
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "null") return value === null;
  return type === undefined;
}

function combinedSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; clear(): void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", onAbort, { once: true });
  const timer = globalThis.setTimeout(() => controller.abort("tool timed out"), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => {
      globalThis.clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

/** Registry contains client-authored functions; catalogs may reference names but can never supply code. */
export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinition>();
  private readonly implementations = new Map<string, RegisteredTool>();

  constructor(definitions: ToolDefinition[] = []) {
    for (const definition of definitions) {
      const name = toolName(definition);
      if (name) this.definitions.set(name, definition);
    }
  }

  register(tool: RegisteredTool): () => void {
    const name = toolName(tool.definition);
    if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/.test(name)) throw new Error("registered tool needs a valid stable name");
    const catalogDefinition = this.definitions.get(name);
    if (!catalogDefinition) throw new SableSdkError("TOOL_NOT_FOUND", `Tool ${name} is not declared by the signed catalog`);
    if (canonicalizeJson(catalogDefinition) !== canonicalizeJson(tool.definition)) {
      throw new SableSdkError("POLICY_BLOCKED", `Registered definition for ${name} does not exactly match the signed catalog`);
    }
    if (this.implementations.has(name)) throw new Error(`tool ${name} is already registered`);
    this.implementations.set(name, tool);
    return () => {
      if (this.implementations.get(name) === tool) this.implementations.delete(name);
    };
  }

  has(name: string): boolean {
    return this.implementations.has(name);
  }

  definition(name: string): ToolDefinition | undefined {
    return this.definitions.get(name);
  }

  async execute(name: string, input: JsonValue, context: Omit<ToolExecutionContext, "signal">, signal?: AbortSignal): Promise<ToolResult> {
    throwIfAborted(signal);
    const registered = this.implementations.get(name);
    const definition = this.definitions.get(name);
    if (!registered || !definition) throw new SableSdkError("TOOL_NOT_FOUND", `Required client tool ${name} is not registered`);
    const schema = (definition as unknown as Record<string, unknown>).inputSchema;
    if (!schemaAccepts(schema, input)) throw new SableSdkError("TOOL_INVALID_INPUT", `Input for tool ${name} did not match its signed schema`);
    const requestedTimeout = (definition as unknown as Record<string, unknown>).timeoutMs;
    const timeout = typeof requestedTimeout === "number" ? Math.max(1, Math.min(requestedTimeout, 120_000)) : 30_000;
    const scoped = combinedSignal(signal, timeout);
    try {
      const output = await registered.execute(input, { ...context, signal: scoped.signal });
      throwIfAborted(scoped.signal);
      return { ok: true, output, detail: `tool ${name} completed` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, detail: `tool ${name} failed: ${message}` };
    } finally {
      scoped.clear();
    }
  }

  async check(name: string, operation: string, input: JsonValue | undefined, context: Omit<ToolExecutionContext, "signal">, signal?: AbortSignal): Promise<boolean> {
    const registered = this.implementations.get(name);
    if (!registered?.check) return false;
    const scoped = combinedSignal(signal, 10_000);
    try {
      return await registered.check(operation, input, { ...context, signal: scoped.signal });
    } finally {
      scoped.clear();
    }
  }
}
