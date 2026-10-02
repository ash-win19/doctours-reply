import type {
  ResponseInputItem,
  ToolChoiceFunction,
  ToolChoiceOptions,
} from "openai/resources/responses/responses";
import {
  DraftingError,
  asDraftingError,
  functionCalls,
  parseArguments,
  parseSubmission,
  tracedCall,
  type ModelOptions,
  type Trace,
} from "./model-calls.ts";
import { buildBaselineSystemPrompt, buildBaselineUserMessage } from "./prompt.ts";
import { ReplySchema, type Reply } from "./reply.ts";
import { TOOLS, runTool, toolDefinition } from "./tools.ts";

export const MAX_TOOL_ROUNDS = 8;
// Two forced submitReply calls after the tool rounds, in case the first one fails to parse.
const MAX_MODEL_CALLS = MAX_TOOL_ROUNDS + 2;
const SUBMIT_REPLY = "submitReply";

export interface ToolCallTrace {
  name: string;
  input: unknown;
  output: unknown;
  isError: boolean;
}

export interface ResponderTrace extends Trace {
  system: string;
  userMessage: string;
  toolCalls: ToolCallTrace[];
  finalOutput: unknown;
}

const submitReplyTool = toolDefinition(
  SUBMIT_REPLY,
  "Submit the final Reply to the patient's message. Call this exactly once, after any lookups, to finish the turn.",
  ReplySchema,
);

export async function respondBaseline(
  humanMessage: string,
  options: ModelOptions,
): Promise<{ reply: Reply; trace: ResponderTrace }> {
  const system = buildBaselineSystemPrompt();
  const userMessage = buildBaselineUserMessage(humanMessage);
  const trace: ResponderTrace = { system, userMessage, modelCalls: [], toolCalls: [], finalOutput: null };
  try {
    return { reply: await submitReplyLoop(trace, options), trace };
  } catch (error) {
    throw asDraftingError(error, trace);
  }
}

// Runs tools until the model submits a Reply that matches the schema.
async function submitReplyLoop(trace: ResponderTrace, { create, model }: ModelOptions): Promise<Reply> {
  const input: ResponseInputItem[] = [{ role: "user", content: trace.userMessage }];
  for (let call = 0; call < MAX_MODEL_CALLS; call++) {
    const toolChoice: ToolChoiceOptions | ToolChoiceFunction =
      call < MAX_TOOL_ROUNDS ? "required" : { type: "function", name: SUBMIT_REPLY };
    const response = await tracedCall(
      create,
      {
        model,
        instructions: trace.system,
        input,
        tools: [...TOOLS, submitReplyTool],
        tool_choice: toolChoice,
        // Reasoning counts against this budget, so it leaves room for both.
        max_output_tokens: 16000,
      },
      trace.modelCalls,
      "responder",
    );

    const calls = functionCalls(response);
    if (calls.length === 0) {
      const reason = response.incomplete_details?.reason ?? response.status ?? "unknown";
      throw new DraftingError(`Model stopped without calling a tool (${reason})`, trace);
    }
    // Reasoning models need their reasoning items back alongside the calls they made.
    input.push(...(response.output as ResponseInputItem[]));

    for (const functionCall of calls) {
      const { name } = functionCall;
      let output: string;
      if (name === SUBMIT_REPLY) {
        const submission = parseSubmission(functionCall, ReplySchema, "The Reply");
        trace.finalOutput = submission.raw;
        if (submission.ok) return { ...submission.value, templateId: null };
        output = submission.feedback;
      } else {
        const args = parseArguments(functionCall.arguments);
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

  throw new DraftingError(`Model did not submit a valid Reply within ${MAX_MODEL_CALLS} calls`, trace);
}
