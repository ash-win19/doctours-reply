import { createHash } from "node:crypto";
import type { ResponseInputItem } from "openai/resources/responses/responses";

export interface PromptCachePlan {
  key: string;
  blocks: { section: string; text: string; cache: boolean }[];
}

// Keep the existing text and order. Three explicit endpoints leave room for OpenAI's implicit endpoint.
export function responderCachePlan(core: string, status: string, skillText: string[], chatId: string): PromptCachePlan {
  const contextStart = core.indexOf("\n\n# CONTEXT\n");
  const blocks = contextStart < 0
    ? [{ section: "core", text: core, cache: true }]
    : [
      { section: "core rules", text: core.slice(0, contextStart), cache: true },
      { section: "Patient context", text: core.slice(contextStart + 2), cache: true },
    ];
  blocks.push({ section: "Pipeline Status", text: status, cache: true });
  blocks.push(...skillText.map((text) => ({ section: "skill", text, cache: false })));
  return {
    // Separate cache accounting by Patient without putting a raw chat id in the key.
    key: `doctours:reply:${createHash("sha256").update(chatId).digest("hex").slice(0, 32)}`,
    blocks,
  };
}

export function cachedDeveloperMessage(plan: PromptCachePlan): ResponseInputItem {
  return {
    role: "developer",
    content: plan.blocks.map(({ text, cache }, index) => ({
      type: "input_text",
      text: `${index ? "\n\n" : ""}${text}`,
      ...(cache ? { prompt_cache_breakpoint: { mode: "explicit" as const } } : {}),
    })),
  };
}
