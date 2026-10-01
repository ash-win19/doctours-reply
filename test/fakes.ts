import type Groq from "groq-sdk";
import type { CreateCompletion, CompletionParams } from "../src/responder.ts";
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

export interface FakeToolCall {
  name: string;
  arguments: string;
}

export function toolCall(name: string, input: unknown): FakeToolCall {
  return { name, arguments: JSON.stringify(input) };
}

// Builds the completion a model returns when it calls the given tools, or answers in text when there are none.
export function completion(calls: FakeToolCall[], text: string | null = null): Groq.Chat.ChatCompletion {
  nextId += 1;
  return {
    id: `chatcmpl_${nextId}`,
    object: "chat.completion",
    created: 0,
    model: "fake-model",
    choices: [
      {
        index: 0,
        finish_reason: calls.length ? "tool_calls" : "stop",
        logprobs: null,
        message: {
          role: "assistant",
          content: text,
          reasoning: "thinking it over",
          tool_calls: calls.map((call) => ({
            id: `call_${++nextId}`,
            type: "function" as const,
            function: { name: call.name, arguments: call.arguments },
          })),
        },
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 80 },
      total_time: 0.2,
    },
  } as Groq.Chat.ChatCompletion;
}

// Replays the given turns in order and records every request it receives.
export function scriptedModel(turns: FakeToolCall[][]) {
  const requests: CompletionParams[] = [];
  const create: CreateCompletion = async (params) => {
    requests.push(structuredClone(params));
    const turn = turns[requests.length - 1];
    if (!turn) throw new Error("Scripted model ran out of turns");
    return completion(turn);
  };
  return { create, requests };
}
