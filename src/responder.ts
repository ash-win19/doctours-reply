import {
  FunctionCallingConfigMode,
  type Content,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type GenerateContentResponseUsageMetadata,
  type Part,
} from "@google/genai";
import { z } from "zod";
import { buildBaselineSystemPrompt, buildBaselineUserMessage } from "./prompt.ts";
import { ReplySchema, type Reply } from "./reply.ts";
import { TOOLS, runTool, toolDefinition } from "./tools.ts";

export const MAX_TOOL_ROUNDS = 8;
// Two forced submitReply calls after the tool rounds, in case the first one fails to parse.
const MAX_MODEL_CALLS = MAX_TOOL_ROUNDS + 2;
const SUBMIT_REPLY = "submitReply";

export type GenerateContent = (params: GenerateContentParameters) => Promise<GenerateContentResponse>;

export interface ResponderOptions {
  generate: GenerateContent;
  model: string;
}

export interface ModelCallTrace {
  model: string;
  finishReason: string | null;
  usage: GenerateContentResponseUsageMetadata | null;
  latencyMs: number;
}

export interface ToolCallTrace {
  name: string;
  input: unknown;
  output: unknown;
  isError: boolean;
}

export interface ResponderTrace {
  system: string;
  userMessage: string;
  modelCalls: ModelCallTrace[];
  toolCalls: ToolCallTrace[];
  finalOutput: unknown;
}

// Carries the partial trace so a failed message's model and tool calls still get written.
export class ResponderError extends Error {
  constructor(
    message: string,
    readonly trace: ResponderTrace,
  ) {
    super(message);
  }
}

const submitReplyTool = toolDefinition(
  SUBMIT_REPLY,
  "Submit the final Reply to the patient's message. Call this exactly once, after any lookups, to finish the turn.",
  ReplySchema,
);

export async function respondBaseline(
  humanMessage: string,
  { generate, model }: ResponderOptions,
): Promise<{ reply: Reply; trace: ResponderTrace }> {
  const system = buildBaselineSystemPrompt();
  const userMessage = buildBaselineUserMessage(humanMessage);
  const trace: ResponderTrace = { system, userMessage, modelCalls: [], toolCalls: [], finalOutput: null };
  const contents: Content[] = [{ role: "user", parts: [{ text: userMessage }] }];

  for (let call = 0; call < MAX_MODEL_CALLS; call++) {
    const forceSubmit = call >= MAX_TOOL_ROUNDS;
    const started = performance.now();
    const response = await generate({
      model,
      contents,
      config: {
        systemInstruction: system,
        // Gemini counts thinking against this budget, so it leaves room for both.
        maxOutputTokens: 8192,
        tools: [{ functionDeclarations: [...TOOLS, submitReplyTool] }],
        toolConfig: {
          functionCallingConfig: forceSubmit
            ? { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: [SUBMIT_REPLY] }
            : { mode: FunctionCallingConfigMode.ANY },
        },
      },
    });
    const candidate = response.candidates?.[0];
    trace.modelCalls.push({
      model: response.modelVersion ?? model,
      finishReason: candidate?.finishReason ?? null,
      usage: response.usageMetadata ?? null,
      latencyMs: Math.round(performance.now() - started),
    });

    const modelTurn = candidate?.content;
    const functionCalls = (modelTurn?.parts ?? []).flatMap((part) => part.functionCall ?? []);
    if (!modelTurn || functionCalls.length === 0) {
      throw new ResponderError(
        `Model stopped without calling a tool (finish reason: ${candidate?.finishReason ?? "none"})`,
        trace,
      );
    }
    // The model's turn goes back unchanged so its thought signatures carry over.
    contents.push(modelTurn);

    const results: Part[] = [];
    for (const functionCall of functionCalls) {
      const name = functionCall.name ?? "";
      const args = functionCall.args ?? {};
      let response: Record<string, unknown>;
      if (name === SUBMIT_REPLY) {
        trace.finalOutput = args;
        const parsed = ReplySchema.safeParse(args);
        if (parsed.success) {
          return { reply: { ...parsed.data, templateId: null }, trace };
        }
        response = {
          error: `The Reply does not match the schema. Fix it and call ${SUBMIT_REPLY} again.\n${z.prettifyError(parsed.error)}`,
        };
      } else {
        const toolResult = runTool(name, args);
        trace.toolCalls.push({ name, input: args, output: toolResult.output, isError: toolResult.isError });
        response = toolResult.isError ? { error: toolResult.output } : { output: toolResult.output };
      }
      results.push({ functionResponse: { id: functionCall.id, name, response } });
    }
    contents.push({ role: "user", parts: results });
  }

  throw new ResponderError(`Model did not submit a valid Reply within ${MAX_MODEL_CALLS} calls`, trace);
}
