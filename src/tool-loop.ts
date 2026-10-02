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
// A repair turn may look something up before it submits again. Its last call is forced to submitReply.
const REPAIR_CALLS = 3;
const SUBMIT_REPLY = "submitReply";

export interface ResponderTrace extends Trace {
  system: string;
  userMessage: string;
  toolCalls: ToolCallTrace[];
  finalOutput: unknown;
}

// What one tool call did: an output to send back to the model, or a finished Reply that ends the turn.
export type ToolOutcome = ToolRun | { reply: Reply };

// What happens to a submitted Reply: it ships, or the model gets one repair turn with the `repair` message, and
// `bestSoFar` ships if the repair never comes back as a valid Reply.
export type SubmitOutcome = { reply: Reply } | { repair: string; bestSoFar: Reply };

export interface ToolLoop {
  trace: ResponderTrace;
  // The tools offered on each call. submitReply is always added.
  tools: () => FunctionTool[];
  callTool: (name: string, input: unknown) => ToolOutcome | Promise<ToolOutcome>;
  // Takes a submitted Reply, which already has templateId set to null, and may ask for one repair turn.
  onSubmit: (reply: Reply) => SubmitOutcome;
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
  // Calls from this one on are forced to submitReply, and the loop stops before callLimit.
  let forceSubmitFrom = MAX_TOOL_ROUNDS;
  let callLimit = MAX_MODEL_CALLS;
  // Once a repair turn is asked for, the Reply that ships if the repair never lands.
  let bestSoFar: Reply | null = null;
  for (let call = 0; call < callLimit; call++) {
    const toolChoice: ToolChoiceOptions | ToolChoiceFunction =
      call < forceSubmitFrom ? "required" : { type: "function", name: SUBMIT_REPLY };
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
      if (bestSoFar) return bestSoFar;
      const reason = response.incomplete_details?.reason ?? response.status ?? "unknown";
      throw new DraftingError(`Model stopped without calling a tool (${reason})`, trace);
    }
    // Reasoning models need their reasoning items back alongside the calls they made.
    input.push(...(response.output as ResponseInputItem[]));

    // Set when a submitReply in this response asked for a repair. Later submits in the same response don't count.
    let repairRequest: string | null = null;
    for (const functionCall of calls) {
      const { name } = functionCall;
      let output: string;
      if (name === SUBMIT_REPLY && repairRequest) {
        output = "Not sent. Fix the problems listed below, then call submitReply once.";
      } else if (name === SUBMIT_REPLY) {
        const submission = parseSubmission(functionCall, ReplySchema, "The Reply");
        trace.finalOutput = submission.raw;
        if (!submission.ok && bestSoFar) return bestSoFar;
        if (!submission.ok) {
          output = submission.feedback;
        } else {
          // Code owns templateId on every submitted Reply.
          const outcome = loop.onSubmit({ ...submission.value, templateId: null });
          if ("reply" in outcome) return outcome.reply;
          bestSoFar = outcome.bestSoFar;
          repairRequest = outcome.repair;
          callLimit = call + 1 + REPAIR_CALLS;
          forceSubmitFrom = callLimit - 1;
          output = "Not sent. Fix the problems listed below, then call submitReply once.";
        }
      } else {
        const args = parseArguments(functionCall.arguments);
        const outcome: ToolOutcome = args.ok ? await loop.callTool(name, args.value) : { isError: true, output: args.error };
        const traced = "reply" in outcome ? { isError: false, output: outcome.reply } : outcome;
        trace.toolCalls.push({ name, input: args.ok ? args.value : functionCall.arguments, ...traced });
        if ("reply" in outcome) return outcome.reply;
        output = typeof outcome.output === "string" ? outcome.output : JSON.stringify(outcome.output);
      }
      input.push({ type: "function_call_output", call_id: functionCall.call_id, output });
    }
    if (repairRequest) input.push({ role: "user", content: repairRequest });
  }

  if (bestSoFar) return bestSoFar;
  throw new DraftingError(`Model did not submit a valid Reply within ${MAX_MODEL_CALLS} calls`, trace);
}
