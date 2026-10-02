import { z } from "zod";
import { DraftingError, asDraftingError, forcedSubmit, tokenUsage, type ModelOptions, type Trace } from "./model-calls.ts";
import { redactCardData, redactCardNumbers } from "./guards.ts";
import { buildCallHistorySystemPrompt, buildCallHistoryUserMessage } from "./prompt.ts";
import type { PatientContext } from "./patient-context.ts";
import { runTool, toolDefinition } from "./tools.ts";

// What the reader needs from the Patient context: whose calls to fetch, and any fixed tool results.
export type CallHistoryContext = Pick<PatientContext, "SUPABASE_CHAT_ID" | "toolOverrides">;

// Count sentence endings without splitting decimal prices, links, or common titles such as Dr. Hakan.
function answerSentences(answer: string): number {
  return answer
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/\b(?:Dr|Mr|Mrs|Ms|Prof)\./g, "title")
    .split(/[.!?]+(?:\s+|$)/)
    .filter((part) => part.trim().length > 0).length;
}

const CallHistoryAnswerSchema = z.object({
  answer: z
    .string()
    .min(1)
    .refine((answer) => answerSentences(answer) <= 3, "Use at most 3 sentences. Combine the relevant facts into a shorter answer.")
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
  context: CallHistoryContext,
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
    const callRecords = redactCardData(runTool("getFullCallsTool", { chatId: context.SUPABASE_CHAT_ID }, context).output);
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
