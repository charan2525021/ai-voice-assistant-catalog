import Anthropic from "@anthropic-ai/sdk";
import { normalizeToolHistory, type NeutralMessage } from "./history.js";
import { SentenceStream } from "./sentences.js";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Ask OpenAI-compatible providers to enforce the supplied JSON schema. */
  strict?: boolean;
}
export interface NeutralToolCall { id: string; name: string; args: unknown; }
export interface ModelResult { texts: string[]; toolCalls: NeutralToolCall[]; done: boolean; }
export interface ModelStepOptions {
  signal?: AbortSignal;
  onSentence?: (sentence: string) => void;
  /** Require the provider to return a tool call instead of ordinary text. */
  toolChoice?: "auto" | "required";
}
export interface ModelClient { label: string; step(system: string, messages: NeutralMessage[], tools: ToolDefinition[], options?: ModelStepOptions): Promise<ModelResult>; }

export type ModelClientConfig =
  | { provider: "anthropic"; apiKey: string; model: string; maxTokens: number; timeoutMs: number; retries: number }
  | { provider: "openai_compatible"; apiKey: string; baseUrl: string; model: string; maxTokens: number; timeoutMs: number; retries: number; reasoningEffort?: string; vision?: boolean };

export interface ModelClientEvent {
  status: "ok" | "error";
  provider: ModelClientConfig["provider"];
  model: string;
  durationMs: number;
  inputCharacters: number;
  outputCharacters: number;
  toolNames: string[];
  error?: string;
}

export function makeModelClient(config: ModelClientConfig, report?: (event: ModelClientEvent) => void): ModelClient {
  const inner: ModelClient = config.provider === "anthropic" ? new AnthropicModelClient(config) : new OpenAiCompatibleModelClient(config);
  return {
    label: inner.label,
    async step(system, messages, tools, options) {
      const started = Date.now();
      const inputCharacters = system.length + messages.reduce((sum, message) => sum + message.blocks.reduce((n, block) => n + ("text" in block && block.text ? block.text.length : 0), 0), 0);
      try {
        const result = await inner.step(system, messages, tools, options);
        report?.({ status: "ok", provider: config.provider, model: config.model, durationMs: Date.now() - started, inputCharacters, outputCharacters: result.texts.join(" ").length, toolNames: result.toolCalls.map((tool) => tool.name) });
        return result;
      } catch (error) {
        report?.({ status: "error", provider: config.provider, model: config.model, durationMs: Date.now() - started, inputCharacters, outputCharacters: 0, toolNames: [], error: (error as Error).message });
        throw error;
      }
    },
  };
}

class AnthropicModelClient implements ModelClient {
  readonly label: string;
  private readonly client: Anthropic;
  constructor(private readonly config: Extract<ModelClientConfig, { provider: "anthropic" }>) {
    this.label = `anthropic:${config.model}`;
    this.client = new Anthropic({ apiKey: config.apiKey, timeout: config.timeoutMs, maxRetries: config.retries });
  }
  async step(system: string, messages: NeutralMessage[], tools: ToolDefinition[], options?: ModelStepOptions): Promise<ModelResult> {
    const response = await this.client.messages.create({
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      system,
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters as Anthropic.Tool.InputSchema })),
      ...(options?.toolChoice === "required" ? { tool_choice: { type: "any" as const } } : {}),
      messages: normalizeToolHistory(messages).map(toAnthropic),
    }, { signal: options?.signal });
    const texts: string[] = [];
    const toolCalls: NeutralToolCall[] = [];
    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) texts.push(block.text.trim());
      else if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, args: block.input });
    }
    if (options?.onSentence) for (const text of texts) options.onSentence(text);
    return { texts, toolCalls, done: response.stop_reason !== "tool_use" };
  }
}

function toAnthropic(message: NeutralMessage): Anthropic.MessageParam {
  const content: Anthropic.ContentBlockParam[] = [];
  for (const block of message.blocks) {
    if (block.type === "text") content.push({ type: "text", text: block.text });
    else if (block.type === "image") { if (block.b64png) content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: block.b64png } }); }
    else if (block.type === "tool_call") content.push({ type: "tool_use", id: block.id, name: block.name, input: block.args });
    else {
      const inner: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [{ type: "text", text: block.text }];
      if (block.imageB64png) inner.push({ type: "image", source: { type: "base64", media_type: "image/png", data: block.imageB64png } });
      content.push({ type: "tool_result", tool_use_id: block.id, content: inner });
    }
  }
  return { role: message.role, content };
}

class OpenAiCompatibleModelClient implements ModelClient {
  readonly label: string;
  constructor(private readonly config: Extract<ModelClientConfig, { provider: "openai_compatible" }>) {
    this.label = `openai:${config.model} @ ${config.baseUrl}`;
  }
  async step(system: string, messages: NeutralMessage[], tools: ToolDefinition[], options?: ModelStepOptions): Promise<ModelResult> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: [{ role: "system", content: system }, ...toOpenAiMessages(messages, this.config.vision ?? false)],
      tools: tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          ...(tool.strict === true ? { strict: true } : {}),
        },
      })),
      ...(options?.toolChoice === "required" ? { tool_choice: "required" } : {}),
      max_tokens: this.config.maxTokens,
      stream: !!options?.onSentence,
      ...(this.config.reasoningEffort ? { reasoning_effort: this.config.reasoningEffort } : {}),
    };
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;
    let response: Response | undefined;
    let parsed: ModelResult | undefined;
    let lastError = "";
    for (let attempt = 0; attempt <= this.config.retries; attempt++) {
      try {
        const timeout = AbortSignal.timeout(this.config.timeoutMs);
        const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
        response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.config.apiKey}` }, body: JSON.stringify(body), signal });
        if (response.ok && body.stream) {
          parsed = await readSse(response, options!.onSentence!);
          if (parsed.texts.length || parsed.toolCalls.length) break;
          lastError = "model returned an empty stream";
        } else if (response.ok) {
          const data = await response.json() as { choices?: Array<{ finish_reason?: string; message?: { content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }> };
          const message = data.choices?.[0]?.message ?? {};
          const texts = message.content ? [String(message.content).trim()].filter(Boolean) : [];
          const toolCalls = (message.tool_calls ?? []).map((call) => ({ id: call.id ?? Math.random().toString(36).slice(2), name: call.function?.name ?? "", args: safeParse(call.function?.arguments) })).filter((call) => call.name);
          if (texts.length || toolCalls.length) { parsed = { texts, toolCalls, done: (data.choices?.[0]?.finish_reason ?? "stop") !== "tool_calls" }; break; }
          lastError = "model returned an empty completion (no text, no tool call)";
        } else {
          const status = response.status;
          const responseText = await response.text();
          lastError = status === 429 || status >= 500
            ? `Reasoning provider is temporarily unavailable (HTTP ${status})`
            : `Model endpoint ${status}: ${responseText}`;
          if (/reasoning_effort/i.test(lastError) && body.reasoning_effort !== undefined) { delete body.reasoning_effort; continue; }
          const transient = status === 429 || status >= 500 || /temporarily unavailable|provider_error|overloaded|try again/i.test(responseText);
          if (status < 500 && status !== 429 && !transient) throw new Error(lastError);
        }
      } catch (error) {
        lastError = (error as Error).message;
        if (options?.signal?.aborted) throw error;
        if (/Model endpoint 4/.test(lastError) && !/temporarily unavailable|provider_error|overloaded/i.test(lastError)) throw error;
      }
      if (attempt < this.config.retries) await new Promise((resolve) => setTimeout(resolve, 800 * 2 ** attempt));
    }
    if (parsed) return parsed;
    throw new Error(lastError || "model request failed");
  }
}

function toOpenAi(message: NeutralMessage, vision: boolean): unknown[] {
  const out: unknown[] = [];
  const userParts: unknown[] = [];
  const toolCalls: unknown[] = [];
  const trailingImages: unknown[] = [];
  let assistantText = "";
  for (const block of message.blocks) {
    if (block.type === "text") {
      if (message.role === "assistant") assistantText += `${block.text}\n`;
      else userParts.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      if (vision && block.b64png) userParts.push({ type: "image_url", image_url: { url: `data:image/png;base64,${block.b64png}` } });
    } else if (block.type === "tool_call") toolCalls.push({ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.args ?? {}) } });
    else {
      out.push({ role: "tool", tool_call_id: block.id, content: block.text });
      if (block.imageB64png && vision) trailingImages.push({ type: "image_url", image_url: { url: `data:image/png;base64,${block.imageB64png}` } });
    }
  }
  if (message.role === "assistant" && (assistantText.trim() || toolCalls.length)) out.push({ role: "assistant", content: assistantText.trim() || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
  if (message.role === "user" && userParts.length) out.push({ role: "user", content: userParts });
  if (trailingImages.length) out.push({ role: "user", content: [{ type: "text", text: "Updated screen:" }, ...trailingImages] });
  return out;
}

export function toOpenAiMessages(messages: NeutralMessage[], vision = false): unknown[] {
  return normalizeToolHistory(messages).flatMap((message) => toOpenAi(message, vision));
}

function safeParse(value: unknown): unknown {
  try { return typeof value === "string" ? JSON.parse(value) : (value ?? {}); }
  catch { return {}; }
}

export async function readSse(response: Response, onSentence: (sentence: string) => void): Promise<ModelResult> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("streaming response had no body");
  const decoder = new TextDecoder();
  const sentences = new SentenceStream();
  const emitted: string[] = [];
  const partials = new Map<number, { id: string; name: string; args: string }>();
  let finish = "stop";
  let buffer = "";
  let streamError = "";
  const handle = (payload: string) => {
    if (payload === "[DONE]") return;
    let event: { error?: { message?: string } | string; choices?: Array<{ finish_reason?: string; delta?: { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }> };
    try { event = JSON.parse(payload); } catch { return; }
    if (event.error) { streamError = typeof event.error === "string" ? event.error : String(event.error.message ?? event.error); return; }
    const choice = event.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finish = choice.finish_reason;
    const delta = choice.delta ?? {};
    if (delta.content) for (const sentence of sentences.push(delta.content)) { emitted.push(sentence); onSentence(sentence); }
    for (const tool of delta.tool_calls ?? []) {
      const index = Number(tool.index ?? 0);
      const current = partials.get(index) ?? { id: "", name: "", args: "" };
      if (tool.id) current.id = tool.id;
      if (tool.function?.name) current.name = tool.function.name;
      if (tool.function?.arguments) current.args += tool.function.arguments;
      partials.set(index, current);
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.startsWith("data:")) handle(line.slice(5).trim());
    }
  }
  for (const sentence of sentences.flush()) { emitted.push(sentence); onSentence(sentence); }
  const toolCalls = [...partials.values()].filter((tool) => tool.name).map((tool) => ({ id: tool.id || Math.random().toString(36).slice(2), name: tool.name, args: safeParse(tool.args) }));
  if (streamError && !emitted.length && !toolCalls.length) throw new Error(`Model stream error: ${streamError}`);
  return { texts: emitted, toolCalls, done: finish !== "tool_calls" };
}
