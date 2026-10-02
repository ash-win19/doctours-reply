import type { Response, ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import type { CreateResponse } from "../src/responder.ts";
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

export interface FakeFunctionCall {
  name: string;
  arguments: string;
}

export function functionCall(name: string, args: object): FakeFunctionCall {
  return { name, arguments: JSON.stringify(args) };
}

// Builds the Response a model returns when it calls the given functions, or answers in text when there are none.
// A reasoning item comes first, as it does for OpenAI's reasoning models.
export function modelResponse(calls: FakeFunctionCall[], text?: string): Response {
  nextId += 1;
  return {
    id: `resp_${nextId}`,
    object: "response",
    model: "fake-model",
    status: "completed",
    output: [
      { type: "reasoning", id: `rs_${nextId}`, summary: [] },
      ...(text
        ? [{ type: "message", id: `msg_${nextId}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }]
        : []),
      ...calls.map((call) => ({
        type: "function_call",
        id: `fc_${++nextId}`,
        call_id: `call_${nextId}`,
        name: call.name,
        arguments: call.arguments,
        status: "completed",
      })),
    ],
    usage: {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 80 },
      output_tokens: 50,
      output_tokens_details: { reasoning_tokens: 30 },
      total_tokens: 150,
    },
  } as unknown as Response;
}

// Replays the given turns in order and records every request it receives.
export function scriptedModel(turns: FakeFunctionCall[][]) {
  const requests: ResponseCreateParamsNonStreaming[] = [];
  const create: CreateResponse = async (params) => {
    requests.push(structuredClone(params));
    const turn = turns[requests.length - 1];
    if (!turn) throw new Error("Scripted model ran out of turns");
    return modelResponse(turn);
  };
  return { create, requests };
}
