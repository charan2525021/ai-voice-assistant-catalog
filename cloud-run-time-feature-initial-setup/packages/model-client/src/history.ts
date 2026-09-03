export type NeutralBlock =
  | { type: "text"; text: string }
  | { type: "image"; b64png: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "tool_result"; id: string; text: string; imageB64png?: string };

export interface NeutralMessage {
  role: "user" | "assistant";
  blocks: NeutralBlock[];
}

export function normalizeToolHistory(messages: NeutralMessage[]): NeutralMessage[] {
  const out: NeutralMessage[] = [];
  let pending: { id: string; name: string; args: unknown }[] = [];
  const closePending = (available: NeutralBlock[] = []) => {
    if (!pending.length) return;
    const results = new Map(available.filter((block): block is Extract<NeutralBlock, { type: "tool_result" }> => block.type === "tool_result").map((block) => [block.id, block]));
    out.push({ role: "user", blocks: pending.map((call) => results.get(call.id) ?? { type: "tool_result", id: call.id, text: "This action did not complete." }) });
    pending = [];
  };
  for (const message of messages) {
    const ordinary = message.blocks.filter((block) => block.type !== "tool_result").map((block) => ({ ...block })) as NeutralBlock[];
    const results = message.blocks.filter((block) => block.type === "tool_result");
    if (message.role === "assistant") {
      closePending();
      if (!ordinary.length) continue;
      out.push({ role: "assistant", blocks: ordinary });
      pending = ordinary.filter((block): block is Extract<NeutralBlock, { type: "tool_call" }> => block.type === "tool_call").map((block) => ({ id: block.id, name: block.name, args: block.args }));
      continue;
    }
    closePending(results);
    if (ordinary.length) out.push({ role: "user", blocks: ordinary });
  }
  closePending();
  return out;
}

export function pruneNeutralHistory(messages: NeutralMessage[], maxMessages: number): NeutralMessage[] {
  const normalized = normalizeToolHistory(messages);
  if (normalized.length <= maxMessages) return normalized;
  const groups: NeutralMessage[][] = [];
  for (let i = 0; i < normalized.length; i++) {
    const current = normalized[i];
    const callsTool = current.role === "assistant" && current.blocks.some((block) => block.type === "tool_call");
    const nextIsResults = normalized[i + 1]?.blocks.length > 0 && normalized[i + 1].blocks.every((block) => block.type === "tool_result");
    if (callsTool && nextIsResults) groups.push([current, normalized[++i]]);
    else groups.push([current]);
  }
  const kept: NeutralMessage[][] = [];
  let count = 0;
  for (let i = groups.length - 1; i >= 0; i--) {
    if (kept.length && count + groups[i].length > maxMessages) break;
    kept.unshift(groups[i]);
    count += groups[i].length;
  }
  return kept.flat();
}
