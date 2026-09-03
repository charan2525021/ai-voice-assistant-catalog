import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { record, estTokens, costOf, type CallPurpose } from "./telemetry.js";
import { emit } from "./events.js";
import { assertWithinBudget, charge } from "./budget.js";
import { SentenceStream } from "./sentences.js";

/**
 * Model adapter — the ONLY place that talks to a model.
 *
 * Everything else (agent, observer, planner, explorer, semanticist) speaks the
 * neutral `NMessage`/`NBlock` shape below, so the whole system runs unchanged on
 * Claude, on any OpenAI-compatible gateway, or on a local Ollama model. Add a
 * provider here and nothing upstream changes.
 *
 * Three behaviours worth knowing before editing this file:
 *
 * 1. `makeBrain(purpose)` wraps every call in telemetry, which is how per-subsystem
 *    cost is attributed (see telemetry.ts and GET /api/telemetry). Always pass a
 *    purpose; "other" makes cost reports useless.
 *
 * 2. **`reasoning_effort: "none"` is mandatory on the llmapi gateway whenever
 *    function tools are sent** — otherwise it returns HTTP 400
 *    ("Function tools with reasoning_effort are not supported"). Configurable via
 *    MODEL_REASONING_EFFORT for gateways that differ.
 *
 * 3. **Retryability must inspect the response BODY, not just the status.** This
 *    gateway reports transient upstream outages as HTTP *400*
 *    (`provider_error: temporarily unavailable`). Deciding on status alone
 *    treated a temporary blip as a permanent client error and aborted whole
 *    exploration runs (minutes of work) on a single hiccup.
 *
 * Images: pruning callers must REPLACE stale image blocks with text, never blank
 * the base64 — an empty string produces `data:image/png;base64,` and a 400
 * `invalid_base64`. That bug shipped twice; see HANDOFF.md §7.
 */

/** Provider-neutral conversation model so the agent loop works with any model. */
export type NBlock =
  | { type: "text"; text: string }
  | { type: "image"; b64png: string }
  | { type: "tool_call"; id: string; name: string; args: any }
  | { type: "tool_result"; id: string; text: string; imageB64png?: string };

export interface NMessage {
  role: "user" | "assistant";
  blocks: NBlock[];
}

/**
 * Return a provider-safe transcript without mutating the live session history.
 *
 * Tool exchanges are atomic: an assistant tool call is immediately followed by
 * one user message containing exactly one result for every call, in call order.
 * Interrupted calls get a deterministic synthetic result, orphan results are
 * discarded, and ordinary user text is kept as the following message. This
 * prevents one interrupted action from poisoning every later model request.
 */
export function normalizeToolHistory(messages: NMessage[]): NMessage[] {
  const out: NMessage[] = [];
  let pending: { id: string; name: string; args: any }[] = [];

  const closePending = (available: NBlock[] = []) => {
    if (!pending.length) return;
    const results = new Map(
      available.filter((b): b is Extract<NBlock, { type: "tool_result" }> => b.type === "tool_result").map((b) => [b.id, b]),
    );
    out.push({
      role: "user",
      blocks: pending.map((call) => {
        const result = results.get(call.id);
        return result ? { ...result } : { type: "tool_result", id: call.id, text: "This action did not complete." };
      }),
    });
    pending = [];
  };

  for (const message of messages) {
    const ordinary = message.blocks.filter((b) => b.type !== "tool_result").map((b) => ({ ...b })) as NBlock[];
    const results = message.blocks.filter((b) => b.type === "tool_result");

    if (message.role === "assistant") {
      closePending();
      if (!ordinary.length) continue;
      out.push({ role: "assistant", blocks: ordinary });
      pending = ordinary
        .filter((b): b is Extract<NBlock, { type: "tool_call" }> => b.type === "tool_call")
        .map((b) => ({ id: b.id, name: b.name, args: b.args }));
      continue;
    }

    closePending(results);
    // Results with no pending assistant call are orphans and are intentionally
    // dropped. Any real prospect text remains a distinct, correctly ordered turn.
    if (ordinary.length) out.push({ role: "user", blocks: ordinary });
  }
  closePending();
  return out;
}

/** Keep recent history without ever cutting an assistant/tool-result pair in half. */
export function pruneNeutralHistory(messages: NMessage[], maxMessages: number): NMessage[] {
  const normalized = normalizeToolHistory(messages);
  if (normalized.length <= maxMessages) return normalized;
  const groups: NMessage[][] = [];
  for (let i = 0; i < normalized.length; i++) {
    const current = normalized[i];
    const callsTool = current.role === "assistant" && current.blocks.some((b) => b.type === "tool_call");
    const nextIsResults = normalized[i + 1]?.blocks.length > 0
      && normalized[i + 1].blocks.every((b) => b.type === "tool_result");
    if (callsTool && nextIsResults) groups.push([current, normalized[++i]]);
    else groups.push([current]);
  }
  const kept: NMessage[][] = [];
  let count = 0;
  for (let i = groups.length - 1; i >= 0; i--) {
    if (kept.length && count + groups[i].length > maxMessages) break;
    kept.unshift(groups[i]);
    count += groups[i].length;
  }
  return kept.flat();
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: any; // JSON schema
}

export interface NeutralToolCall {
  id: string;
  name: string;
  args: any;
}

export interface BrainResult {
  texts: string[];
  toolCalls: NeutralToolCall[];
  done: boolean;
}

/** Optional per-call behaviour. */
export interface StepOptions {
  /** Cancels model generation when a newer user turn supersedes this one. */
  signal?: AbortSignal;
  /**
   * Called with each COMPLETE sentence as the model writes it.
   *
   * Supplying this switches the call to server-sent events, which is the whole
   * point: without it the agent waits for the entire reply before a single word
   * can be synthesised — measured at 5.6s of silence on a live demo. With it,
   * speech starts on the first sentence while the rest is still generating.
   * Providers that cannot stream simply deliver every sentence at the end, so
   * callers need no fallback path.
   */
  onSentence?: (sentence: string) => void;
}

export interface Brain {
  label: string;
  step(system: string, messages: NMessage[], tools: ToolDef[], opts?: StepOptions): Promise<BrainResult>;
}

/** Tag calls so cost can be attributed per subsystem (agent vs observer vs mapper). */
export function makeBrain(purpose: CallPurpose = "other"): Brain {
  const inner = config.modelProvider === "openai" ? new OpenAICompatBrain() : new AnthropicBrain();
  return {
    label: inner.label,
    async step(system, messages, tools, opts) {
      const started = Date.now();
      const images = messages.reduce(
        (n, m) => n + m.blocks.filter((b) => b.type === "image" || (b.type === "tool_result" && b.imageB64png)).length,
        0,
      );
      const promptMessages = messages.map((message) => ({
        role: message.role,
        blocks: message.blocks.map((block) => {
          if (block.type === "image") return { type: "image", imageBytes: Math.floor((block.b64png?.length ?? 0) * 3 / 4) };
          if (block.type === "tool_result") return {
            type: block.type, id: block.id, text: block.text,
            screenshotBytes: Math.floor((block.imageB64png?.length ?? 0) * 3 / 4),
          };
          return block;
        }),
      }));
      const inChars =
        system.length +
        messages.reduce(
          (n, m) => n + m.blocks.reduce((k, b) => k + ("text" in b && b.text ? b.text.length : 0), 0),
          0,
        );
      // Refuse before spending, not after — charging first would let every ceiling
      // be exceeded by one unbounded call.
      await assertWithinBudget();
      const inTokens = estTokens("x".repeat(inChars));
      /*
       * Every model call is recorded here, success or failure. The failure case
       * used to fall straight through the `record` call, so a run that was failing
       * every request still reported a clean, cheap-looking telemetry summary —
       * error rate was structurally invisible.
       */
      try {
        const res = await inner.step(system, messages, tools, opts);
        const ms = Date.now() - started;
        const outTokens = estTokens(res.texts.join(" ") + JSON.stringify(res.toolCalls));
        record({ purpose, ms, inTokens, outTokens, images });
        charge(costOf(inTokens, outTokens, images));
        emit("model.call", {
          status: "ok",
          ms,
          data: {
            purpose,
            model: inner.label,
            inTokens,
            outTokens,
            images,
            systemChars: system.length,
            messageCount: messages.length,
            imageCount: images,
            costUsd: costOf(inTokens, outTokens, images),
            toolCalls: res.toolCalls.map((t) => t.name),
            finished: res.done,
          },
        });
        emit("model.prompt", {
          status: "ok", ms,
          data: {
            purpose, model: inner.label, systemPrompt: system, messages: promptMessages,
            tools,
            rawResponseText: res.texts.join(" "),
            responseTextBlocks: res.texts,
            responseToolCalls: res.toolCalls,
          },
        });
        return res;
      } catch (e) {
        const ms = Date.now() - started;
        record({ purpose, ms, inTokens, outTokens: 0, images });
        charge(costOf(inTokens, 0, images)); // a failed call still costs input tokens
        emit("model.call", {
          status: "error",
          ms,
          error: (e as Error).message,
          data: {
            purpose, model: inner.label, inTokens, images, systemChars: system.length,
            messageCount: messages.length, imageCount: images, costUsd: costOf(inTokens, 0, images),
          },
        });
        emit("model.prompt", {
          status: "error", ms, error: (e as Error).message,
          data: { purpose, model: inner.label, systemPrompt: system, messages: promptMessages, tools, rawResponseText: "", responseTextBlocks: [], responseToolCalls: [] },
        });
        throw e;
      }
    },
  };
}

// ---------------- Claude (best) ----------------

class AnthropicBrain implements Brain {
  label = `anthropic:${config.anthropic.model}`;
  private client: Anthropic | null = null;
  private getClient(): Anthropic {
    return (this.client ??= new Anthropic({ apiKey: config.anthropic.apiKey() }));
  }

  async step(system: string, messages: NMessage[], tools: ToolDef[], opts?: StepOptions): Promise<BrainResult> {
    const res = await this.getClient().messages.create({
      model: config.anthropic.model,
      max_tokens: 1200,
      system,
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      messages: normalizeToolHistory(messages).map(toAnthropic),
    }, { signal: opts?.signal });
    const texts: string[] = [];
    const toolCalls: NeutralToolCall[] = [];
    for (const b of res.content) {
      if (b.type === "text" && b.text.trim()) texts.push(b.text.trim());
      else if (b.type === "tool_use") toolCalls.push({ id: b.id, name: b.name, args: b.input });
    }
    return { texts, toolCalls, done: res.stop_reason !== "tool_use" };
  }
}

function toAnthropic(m: NMessage): Anthropic.MessageParam {
  const content: Anthropic.ContentBlockParam[] = [];
  for (const b of m.blocks) {
    if (b.type === "text") content.push({ type: "text", text: b.text });
    // Skip empty images: a screenshot may be unavailable (slow fonts), and an
    // empty base64 payload is rejected as invalid by the provider.
    else if (b.type === "image") { if (b.b64png) content.push(img(b.b64png)); }
    else if (b.type === "tool_call") content.push({ type: "tool_use", id: b.id, name: b.name, input: b.args });
    else {
      const inner: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = [{ type: "text", text: b.text }];
      if (b.imageB64png) inner.push(img(b.imageB64png));
      content.push({ type: "tool_result", tool_use_id: b.id, content: inner });
    }
  }
  return { role: m.role, content };
}

function img(b64: string): Anthropic.ImageBlockParam {
  return { type: "image", source: { type: "base64", media_type: "image/png", data: b64 } };
}

// ---------------- OpenAI-compatible (local Ollama, zero cloud) ----------------

class OpenAICompatBrain implements Brain {
  label = `openai:${config.openai.model} @ ${config.openai.baseUrl}`;

  async step(system: string, messages: NMessage[], tools: ToolDef[], opts?: StepOptions): Promise<BrainResult> {
    const body = {
      model: config.openai.model,
      messages: [{ role: "system", content: system }, ...toOpenAIMessages(messages)],
      tools: tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      reasoning_effort: config.openai.reasoningEffort,
      /*
       * Anthropic models REQUIRE max_tokens and reject the request without it —
       * on this gateway the rejection is a bare "The request is invalid.", which
       * gives no hint about the cause. Every Claude model therefore looked
       * unavailable when it was simply missing one field. OpenAI models ignore a
       * generous ceiling, so sending it always costs nothing.
       */
      max_tokens: config.openai.maxTokens,
      // Streaming only when someone is listening sentence by sentence; the
      // non-streaming path stays byte-identical for every other caller.
      stream: !!opts?.onSentence,
    };
    // Retry transient failures. A single network blip used to abort an entire
    // exploration run (which can be minutes of work); 4xx are not retried.
    const url = `${config.openai.baseUrl.replace(/\/$/, "")}/chat/completions`;
    let res: Response | null = null;
    let lastErr = "";
    let parsed: { texts: string[]; toolCalls: NeutralToolCall[]; done: boolean } | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${config.openai.apiKey}` },
          body: JSON.stringify(body),
          signal: opts?.signal,
        });
        if (res.ok && body.stream) {
          try {
            parsed = await readSSE(res, opts!.onSentence!);
          } catch (streamErr) {
            const msg = (streamErr as Error).message;
            throw streamErr;
          }
          if (parsed.texts.length || parsed.toolCalls.length) break;
          lastErr = "model returned an empty stream";
          console.warn(`  ! ${lastErr} — retrying (attempt ${attempt + 1}/3)`);
        } else if (res.ok) {
          const data: any = await res.json();
          const msg = data.choices?.[0]?.message ?? {};
          const texts: string[] = msg.content ? [String(msg.content).trim()].filter(Boolean) : [];
          const toolCalls: NeutralToolCall[] = (msg.tool_calls ?? []).map((c: any) => ({
            id: c.id ?? Math.random().toString(36).slice(2),
            name: c.function?.name,
            args: safeParse(c.function?.arguments),
          }));
          /*
           * An EMPTY 200 is a failure wearing a success costume.
           *
           * A response with no text and no tool call used to be handed straight
           * back, and the caller could only read that as "the model declined to
           * act". The explorer gives up on the whole job at that point, so one
           * transient blank completion permanently costs a journey — it did
           * exactly that to 2 of 6 jobs in a Dolibarr run, logging only
           * "no tool call. said: (nothing)" with no error anywhere. Retrying is
           * cheap; losing a job to a hiccup is not.
           */
          if (texts.length || toolCalls.length) {
            parsed = { texts, toolCalls, done: (data.choices?.[0]?.finish_reason ?? "stop") !== "tool_calls" };
            break;
          }
          lastErr = "model returned an empty completion (no text, no tool call)";
          console.warn(`  ! ${lastErr} — retrying (attempt ${attempt + 1}/3)`);
        } else {
          const status = res.status;
          lastErr = `Model endpoint ${status}: ${await res.text()}`;
          /*
           * Gateways disagree about REASONING EFFORT, and each disagreement is
           * fatal to the whole turn.
           *
           * gpt-5.6-luna demanded "none" before it would accept tools;
           * claude-sonnet-5 rejects "none" outright and wants low/medium/high.
           * A value that is right for one model breaks the next, so switching
           * model silently killed every turn. Reasoning effort is an optimisation
           * and tools are the product: when the endpoint objects to the field,
           * drop it and use the model's own default.
           */
          if (/reasoning_effort/i.test(lastErr) && (body as any).reasoning_effort !== undefined) {
            console.warn(`  ! "${config.openai.model}" rejected reasoning_effort — dropping it for this model`);
            delete (body as any).reasoning_effort;
            continue;
          }
          // Some gateways report a TRANSIENT upstream outage as a 400, so status
          // alone can't decide retryability — inspect the body too.
          const transient = /temporarily unavailable|provider_error|overloaded|try again/i.test(lastErr);
          if (status < 500 && status !== 429 && !transient) throw new Error(lastErr);
        }
      } catch (e) {
        lastErr = (e as Error).message;
        if (/Model endpoint 4/.test(lastErr) && !/temporarily unavailable|provider_error|overloaded/i.test(lastErr)) throw e;
        res = null;
      }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
    }
    if (parsed) return parsed;
    if (!res || !res.ok) throw new Error(lastErr || "model request failed");
    // Three empty completions in a row is a real condition, not a blip.
    throw new Error(lastErr || "model returned an empty completion three times");
  }
}

/** OpenAI tool messages can't carry images, so post-action screenshots become a follow-up user turn. */
function toOpenAI(m: NMessage): any[] {
  const out: any[] = [];
  const userParts: any[] = [];
  const toolCalls: any[] = [];
  const trailingImages: any[] = [];
  let assistantText = "";

  for (const b of m.blocks) {
    if (b.type === "text") {
      if (m.role === "assistant") assistantText += b.text + "\n";
      else userParts.push({ type: "text", text: b.text });
    } else if (b.type === "image") {
      if (config.openai.vision && b.b64png) userParts.push({ type: "image_url", image_url: { url: dataUrl(b.b64png) } });
    } else if (b.type === "tool_call") {
      toolCalls.push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.args ?? {}) } });
    } else {
      out.push({ role: "tool", tool_call_id: b.id, content: b.text });
      if (b.imageB64png && config.openai.vision) trailingImages.push({ type: "image_url", image_url: { url: dataUrl(b.imageB64png) } });
    }
  }

  if (m.role === "assistant" && (assistantText.trim() || toolCalls.length)) {
    out.push({ role: "assistant", content: assistantText.trim() || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
  }
  if (m.role === "user" && userParts.length) out.push({ role: "user", content: userParts });
  if (trailingImages.length) out.push({ role: "user", content: [{ type: "text", text: "Updated screen:" }, ...trailingImages] });
  return out;
}

/** Exported for regression tests and gateway contract validation. */
export function toOpenAIMessages(messages: NMessage[]): any[] {
  return normalizeToolHistory(messages).flatMap(toOpenAI);
}

const dataUrl = (b64: string) => `data:image/png;base64,${b64}`;
const safeParse = (s: any) => {
  try {
    return typeof s === "string" ? JSON.parse(s) : (s ?? {});
  } catch {
    return {};
  }
};

/**
 * Read a server-sent-event completion, emitting sentences as they finish.
 *
 * Two things make this fiddly and both are handled here rather than at the call
 * sites, which have no business knowing about SSE framing:
 *
 *  · Events do not align with network packets. A `data:` line can arrive split
 *    across two chunks, so a buffer is kept and only whole lines are parsed.
 *  · Tool calls stream as DELTAS indexed by position — the name arrives in one
 *    event and the arguments accumulate across many — so they are assembled by
 *    index and only parsed once the stream ends.
 */
async function readSSE(res: Response, onSentence: (s: string) => void): Promise<BrainResult> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("streaming response had no body");
  const decoder = new TextDecoder();
  const sentences = new SentenceStream();
  const emitted: string[] = [];
  /** index → partial tool call being assembled across deltas. */
  const partials = new Map<number, { id: string; name: string; args: string }>();
  let finish = "stop";
  let buf = "";
  let streamError = "";

  const handle = (payload: string) => {
    if (payload === "[DONE]") return;
    let ev: any;
    try { ev = JSON.parse(payload); } catch { return; } // a truncated frame is not fatal
    /*
     * A gateway can report a fatal error INSIDE the stream, with a 200 status.
     * That frame carries no `choices`, so it used to be skipped silently and the
     * caller saw only "empty stream" — three retries of a request that could
     * never succeed, and no sign of the actual cause anywhere in the logs.
     */
    if (ev.error) {
      streamError = String(ev.error.message ?? ev.error);
      return;
    }
    const choice = ev.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finish = choice.finish_reason;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content) {
      for (const s of sentences.push(delta.content)) {
        emitted.push(s);
        onSentence(s); // speech can begin here, long before the reply is finished
      }
    }
    for (const tc of delta.tool_calls ?? []) {
      const i = Number(tc.index ?? 0);
      const cur = partials.get(i) ?? { id: "", name: "", args: "" };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name = tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      partials.set(i, cur);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.startsWith("data:")) handle(line.slice(5).trim());
    }
  }
  for (const s of sentences.flush()) {
    emitted.push(s);
    onSentence(s);
  }

  const toolCalls: NeutralToolCall[] = [...partials.values()]
    .filter((t) => t.name)
    .map((t) => ({ id: t.id || Math.random().toString(36).slice(2), name: t.name, args: safeParse(t.args) }));
  // Say why it failed, rather than letting it look like an empty response.
  if (streamError && !emitted.length && !toolCalls.length) throw new Error(`Model stream error: ${streamError}`);
  return { texts: emitted, toolCalls, done: finish !== "tool_calls" };
}
