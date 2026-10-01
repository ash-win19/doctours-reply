import { GenerateContentResponse, type GenerateContentParameters } from "@google/genai";
import type { GenerateContent } from "../src/responder.ts";
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
  args: Record<string, unknown>;
}

export function functionCall(name: string, args: object): FakeFunctionCall {
  return { name, args: args as Record<string, unknown> };
}

// Builds the response a model returns when it calls the given functions, or answers in text when there are none.
export function generation(calls: FakeFunctionCall[], text?: string): GenerateContentResponse {
  const response = new GenerateContentResponse();
  response.modelVersion = "fake-model";
  response.candidates = [
    {
      finishReason: "STOP" as never,
      content: {
        role: "model",
        parts: [
          ...(text ? [{ text }] : []),
          ...calls.map((call, index) => ({
            functionCall: { id: `call_${++nextId}`, name: call.name, args: call.args },
            ...(index === 0 ? { thoughtSignature: "signature" } : {}),
          })),
        ],
      },
    },
  ];
  response.usageMetadata = {
    promptTokenCount: 100,
    candidatesTokenCount: 20,
    cachedContentTokenCount: 80,
    thoughtsTokenCount: 30,
    totalTokenCount: 150,
  };
  return response;
}

// Replays the given turns in order and records every request it receives.
export function scriptedModel(turns: FakeFunctionCall[][]) {
  const requests: GenerateContentParameters[] = [];
  const generate: GenerateContent = async (params) => {
    requests.push(structuredClone(params));
    const turn = turns[requests.length - 1];
    if (!turn) throw new Error("Scripted model ran out of turns");
    return generation(turn);
  };
  return { generate, requests };
}
