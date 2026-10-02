import type {
  FunctionTool,
  ResponseInputItem,
  ToolChoiceFunction,
  ToolChoiceOptions,
} from "openai/resources/responses/responses";
import {
  DraftingError,
  functionCalls,
  parseArguments,
  parseSubmission,
  tracedCall,
  type ModelOptions,
  type ToolCallTrace,
  type Trace,
} from "./model-calls.ts";
import { ReplySchema, type Reply } from "./reply.ts";
import { toolDefinition, type ToolRun } from "./tools.ts";

export const MAX_TOOL_ROUNDS = 8;
// Two forced submitReply calls after the tool rounds, in case the first one fails to parse.
const MAX_MODEL_CALLS = MAX_TOOL_ROUNDS + 2;
const SUBMIT_REPLY = "submitReply";

export interface ResponderTrace extends Trace {
  system: string;
  userMessage: string;
  toolCalls: ToolCallTrace[];
  finalOutput: unknown;
}

// What one tool call did: an output to send back to the model, or a finished Reply that ends the turn.
export type ToolOutcome = ToolRun | { reply: Reply };

export interface ToolLoop {
  trace: ResponderTrace;
  // The tools offered on each call. submitReply is always added.
  tools: () => FunctionTool[];
  callTool: (name: string, input: unknown) => ToolOutcome;
  // Code-owned fields on a submitted Reply, such as templateId.
  onSubmit: (reply: Reply) => Reply;
}

const submitReplyTool = toolDefinition(
  SUBMIT_REPLY,
  "Submit the final Reply to the patient's message. Call this exactly once, after any lookups, to finish the turn.",
  ReplySchema,
);

// Runs tools until the model submits a Reply that matches the schema, or a tool finishes the turn.
export async function runToolLoop(loop: ToolLoop, { create, model }: ModelOptions): Promise<Reply> {
  const { trace } = loop;
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
        tools: [...loop.tools(), submitReplyTool],
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
        if (submission.ok) return loop.onSubmit(submission.value);
        output = submission.feedback;
      } else {
        const args = parseArguments(functionCall.arguments);
        const outcome: ToolOutcome = args.ok ? loop.callTool(name, args.value) : { isError: true, output: args.error };
        const traced = "reply" in outcome ? { isError: false, output: outcome.reply } : outcome;
        trace.toolCalls.push({ name, input: args.ok ? args.value : functionCall.arguments, ...traced });
        if ("reply" in outcome) return outcome.reply;
        output = typeof outcome.output === "string" ? outcome.output : JSON.stringify(outcome.output);
      }
      input.push({ type: "function_call_output", call_id: functionCall.call_id, output });
    }
  }

  throw new DraftingError(`Model did not submit a valid Reply within ${MAX_MODEL_CALLS} calls`, trace);
}
