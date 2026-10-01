import type Anthropic from "@anthropic-ai/sdk";
import type { CreateMessage } from "../src/responder.ts";
import type { Reply } from "../src/reply.ts";

export const VALID_REPLY: Reply = {
  response: "Yes. The consultation is a free phone call.",
  escalate: false,
  escalationReason: null,
  templateId: null,
  intent: "answer consultation question",
  shouldFollowUp: false,
  followUpTiming: null,
  attachmentUrls: null,
  highEngagement: false,
  workingMemoryUpdates: null,
};

let nextId = 0;

export function toolUse(name: string, input: unknown): Anthropic.ToolUseBlock {
  nextId += 1;
  return { type: "tool_use", id: `toolu_${nextId}`, name, input, caller: { type: "direct" } } as Anthropic.ToolUseBlock;
}

export function message(content: Anthropic.ContentBlock[]): Anthropic.Message {
  return {
    id: `msg_${++nextId}`,
    type: "message",
    role: "assistant",
    model: "fake-model",
    content,
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 80,
    },
  } as Anthropic.Message;
}

// Replays the given turns in order and records every request it receives.
export function scriptedModel(turns: Anthropic.ContentBlock[][]) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const create: CreateMessage = async (params) => {
    requests.push(structuredClone(params));
    const turn = turns[requests.length - 1];
    if (!turn) throw new Error("Scripted model ran out of turns");
    return message(turn);
  };
  return { create, requests };
}
