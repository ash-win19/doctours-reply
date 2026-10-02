import { z } from "zod";
import { DraftingError, asDraftingError, forcedSubmit, tokenUsage, type ModelOptions, type Trace } from "./model-calls.ts";
import { redactCardNumbers } from "./guards.ts";
import { buildCallHistorySystemPrompt, buildCallHistoryUserMessage } from "./prompt.ts";
import { runTool, toolDefinition } from "./tools.ts";

const CallHistoryAnswerSchema = z.object({
  answer: z
    .string()
    .describe("At most 3 short sentences answering the question, or that the calls don't cover it."),
  callIds: z.array(z.string()).describe("The ids of the calls the answer came from."),
});

const submitAnswerTool = toolDefinition(
  "submitAnswer",
  "Submit the answer about the patient's calls.",
  CallHistoryAnswerSchema,
);

// What one call-history question did. It goes on the responder's trace under subagents.
export interface CallHistoryRecord {
  subagent: "callHistory";
  question: string;
  // Null when the subagent couldn't answer, with the reason in error.
  answer: string | null;
  callIds: string[];
  usage: { inputTokens: number; outputTokens: number };
  latencyMs: number;
  error: string | null;
}

export type CallHistoryTrace = CallHistoryRecord & Trace;

// A separate small-model call over the full call records, so transcripts never enter the responder's context.
// Setup errors stop the run. Any other failure comes back as a null answer with the error recorded.
export async function askCallHistory(
  question: string,
  options: ModelOptions,
  { chatId }: { chatId: string },
): Promise<{ answer: string | null; trace: CallHistoryTrace }> {
  const started = performance.now();
  const trace: CallHistoryTrace = {
    subagent: "callHistory",
    question,
    answer: null,
    callIds: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    latencyMs: 0,
    error: null,
    modelCalls: [],
  };
  try {
    const callRecords = runTool("getFullCallsTool", { chatId }).output;
    const submitted = await forcedSubmit(
      {
        trace,
        step: "callHistory",
        system: buildCallHistorySystemPrompt(),
        userMessage: buildCallHistoryUserMessage(question, callRecords),
        tool: submitAnswerTool,
        schema: CallHistoryAnswerSchema,
        what: "The answer",
      },
      options,
    );
    // Call records aren't redacted the way Patient messages are, so card digits are stripped here too.
    trace.answer = redactCardNumbers(submitted.answer).text;
    trace.callIds = submitted.callIds;
  } catch (error) {
    const failure = asDraftingError(error, trace);
    if (!(failure instanceof DraftingError)) throw failure;
    trace.error = failure.message;
  }
  trace.usage = tokenUsage(trace);
  trace.latencyMs = Math.round(performance.now() - started);
  return { answer: trace.answer, trace };
}
