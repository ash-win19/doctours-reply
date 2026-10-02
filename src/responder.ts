import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseFunctionToolCall,
  ResponseInputItem,
  ResponseUsage,
  ToolChoiceFunction,
  ToolChoiceOptions,
} from "openai/resources/responses/responses";
import { z } from "zod";
import { buildBaselineSystemPrompt, buildBaselineUserMessage } from "./prompt.ts";
import { ReplySchema, type Reply } from "./reply.ts";
import { TOOLS, runTool, toolDefinition } from "./tools.ts";

export const MAX_TOOL_ROUNDS = 8;
// Two forced submitReply calls after the tool rounds, in case the first one fails to parse.
const MAX_MODEL_CALLS = MAX_TOOL_ROUNDS + 2;
const SUBMIT_REPLY = "submitReply";

export type CreateResponse = (params: ResponseCreateParamsNonStreaming) => Promise<Response>;

export interface ResponderOptions {
  create: CreateResponse;
  model: string;
}

export interface ModelCallTrace {
  model: string;
  status: Response["status"] | null;
  usage: ResponseUsage | null;
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

// OpenAI's output_tokens already include reasoning tokens.
export function tokenUsage(trace: ResponderTrace | null): { inputTokens: number; outputTokens: number } {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const { usage } of trace?.modelCalls ?? []) {
    inputTokens += usage?.input_tokens ?? 0;
    outputTokens += usage?.output_tokens ?? 0;
  }
  return { inputTokens, outputTokens };
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

type ParsedArguments = { ok: true; value: unknown } | { ok: false; error: string };

function parseArguments(raw: string): ParsedArguments {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, error: `Tool arguments are not valid JSON: ${raw}` };
  }
}

export async function respondBaseline(
  humanMessage: string,
  { create, model }: ResponderOptions,
): Promise<{ reply: Reply; trace: ResponderTrace }> {
  const system = buildBaselineSystemPrompt();
  const userMessage = buildBaselineUserMessage(humanMessage);
  const trace: ResponderTrace = { system, userMessage, modelCalls: [], toolCalls: [], finalOutput: null };
  const input: ResponseInputItem[] = [{ role: "user", content: userMessage }];

  for (let call = 0; call < MAX_MODEL_CALLS; call++) {
    const toolChoice: ToolChoiceOptions | ToolChoiceFunction =
      call < MAX_TOOL_ROUNDS ? "required" : { type: "function", name: SUBMIT_REPLY };
    const started = performance.now();
    const response = await create({
      model,
      instructions: system,
      input,
      tools: [...TOOLS, submitReplyTool],
      tool_choice: toolChoice,
      // Reasoning counts against this budget, so it leaves room for both.
      max_output_tokens: 16000,
    });
    trace.modelCalls.push({
      model: response.model,
      status: response.status ?? null,
      usage: response.usage ?? null,
      latencyMs: Math.round(performance.now() - started),
    });

    const functionCalls = response.output.filter(
      (item): item is ResponseFunctionToolCall => item.type === "function_call",
    );
    if (functionCalls.length === 0) {
      const reason = response.incomplete_details?.reason ?? response.status ?? "unknown";
      throw new ResponderError(`Model stopped without calling a tool (${reason})`, trace);
    }
    // Reasoning models need their reasoning items back alongside the calls they made.
    input.push(...(response.output as ResponseInputItem[]));

    for (const functionCall of functionCalls) {
      const { name } = functionCall;
      const args = parseArguments(functionCall.arguments);
      let output: string;
      if (name === SUBMIT_REPLY) {
        trace.finalOutput = args.ok ? args.value : functionCall.arguments;
        const parsed = args.ok ? ReplySchema.safeParse(args.value) : null;
        if (parsed?.success) {
          return { reply: { ...parsed.data, templateId: null }, trace };
        }
        const problem = parsed ? z.prettifyError(parsed.error) : (args as { error: string }).error;
        output = `The Reply does not match the schema. Fix it and call ${SUBMIT_REPLY} again.\n${problem}`;
      } else {
        const toolResult = args.ok ? runTool(name, args.value) : ({ isError: true, output: args.error } as const);
        trace.toolCalls.push({
          name,
          input: args.ok ? args.value : functionCall.arguments,
          output: toolResult.output,
          isError: toolResult.isError,
        });
        output = typeof toolResult.output === "string" ? toolResult.output : JSON.stringify(toolResult.output);
      }
      input.push({ type: "function_call_output", call_id: functionCall.call_id, output });
    }
  }

  throw new ResponderError(`Model did not submit a valid Reply within ${MAX_MODEL_CALLS} calls`, trace);
}
