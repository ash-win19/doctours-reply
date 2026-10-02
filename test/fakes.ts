import type { Response, ResponseCreateParamsNonStreaming, ResponseInputItem } from "openai/resources/responses/responses";
import type { CreateResponse } from "../src/model-calls.ts";
import type { Reply } from "../src/reply.ts";
import type { TriageDecision } from "../src/triage.ts";

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

// A triage decision that lets the message through to the responder.
export function triageDecision(overrides: Partial<TriageDecision> = {}): TriageDecision {
  return { escalate: false, escalationReason: null, cannotDo: null, skills: [], intent: "ask a question", ...overrides };
}

// The text of the first user message in a request.
export function firstUserText(request: ResponseCreateParamsNonStreaming): string {
  const user = (request.input as ResponseInputItem[]).find((item) => "role" in item && item.role === "user");
  return (user as { content: string }).content;
}

export function systemText(request: ResponseCreateParamsNonStreaming): string {
  if (request.instructions) return request.instructions;
  return (request.input as ResponseInputItem[]).flatMap((item) =>
    "role" in item && item.role === "developer" && "content" in item
      ? typeof item.content === "string" ? [item.content] : item.content.flatMap((part) => "text" in part ? [part.text] : [])
      : [],
  ).join("");
}

// Every input item a request sent: messages, reasoning, function calls and their outputs.
export function inputItems(request: ResponseCreateParamsNonStreaming): ResponseInputItem[] {
  return request.input as ResponseInputItem[];
}

// The outputs a request sent back for earlier function calls, in order.
export function functionOutputs(request: ResponseCreateParamsNonStreaming): ResponseInputItem.FunctionCallOutput[] {
  return inputItems(request).filter(
    (item): item is ResponseInputItem.FunctionCallOutput => "type" in item && item.type === "function_call_output",
  );
}

// The names of the function tools a request offered.
export function toolNames(request: ResponseCreateParamsNonStreaming): string[] {
  return (request.tools ?? []).flatMap((tool) => (tool.type === "function" ? [tool.name] : []));
}

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
