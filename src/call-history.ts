import type { ResponseInputItem } from "openai/resources/responses/responses";
import { z } from "zod";
import {
  DraftingError,
  asDraftingError,
  functionCalls,
  parseSubmission,
  tracedCall,
  type ModelOptions,
  type Trace,
} from "./model-calls.ts";
import { buildCallHistorySystemPrompt, buildCallHistoryUserMessage } from "./prompt.ts";
import { runTool, toolDefinition } from "./tools.ts";

export const ASK_CALL_HISTORY = "askCallHistory";

export const AskCallHistoryInput = z.object({ question: z.string() });

// The responder sees only this tool. The transcripts stay with the subagent.
export const askCallHistoryTool = toolDefinition(
  ASK_CALL_HISTORY,
  "Ask a question about the patient's past calls with Doctours. A separate reader checks the full call summaries and transcripts and returns a short answer.",
  AskCallHistoryInput,
);

const CallHistoryAnswerSchema = z.object({ answer: z.string(), callIds: z.array(z.string()) });

export interface CallHistoryTrace extends Trace {
  subagent: "callHistory";
  question: string;
  output: unknown;
}

const SUBMIT_ANSWER = "submitAnswer";
// One retry when the answer doesn't parse.
const MAX_ATTEMPTS = 2;
const MAX_SENTENCES = 3;

const submitAnswerTool = toolDefinition(SUBMIT_ANSWER, "Submit the answer about the patient's calls.", CallHistoryAnswerSchema);

// Keeps the first sentences of an answer, each ending in ".", "?" or "!".
export function firstSentences(text: string, max: number): string {
  const sentences = text.trim().match(/[^.?!]+[.?!]+|[^.?!]+$/g) ?? [];
  return sentences.slice(0, max).join("").trim();
}

// A separate small-model call over the full call records, so transcripts never enter the responder's context.
export async function askCallHistory(
  question: string,
  options: ModelOptions,
  { chatId }: { chatId: string },
): Promise<{ answer: string; callIds: string[]; trace: CallHistoryTrace }> {
  const callRecords = runTool("getFullCallsTool", { chatId }).output;
  const trace: CallHistoryTrace = { subagent: "callHistory", question, output: null, modelCalls: [] };
  try {
    const { answer, callIds } = await submitAnswerLoop(buildCallHistoryUserMessage(question, callRecords), trace, options);
    return { answer: firstSentences(answer, MAX_SENTENCES), callIds, trace };
  } catch (error) {
    throw asDraftingError(error, trace);
  }
}

async function submitAnswerLoop(
  userMessage: string,
  trace: CallHistoryTrace,
  { create, model }: ModelOptions,
): Promise<z.infer<typeof CallHistoryAnswerSchema>> {
  const conversation: ResponseInputItem[] = [{ role: "user", content: userMessage }];
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const response = await tracedCall(
      create,
      {
        model,
        instructions: buildCallHistorySystemPrompt(),
        input: conversation,
        tools: [submitAnswerTool],
        tool_choice: { type: "function", name: SUBMIT_ANSWER },
        max_output_tokens: 4000,
      },
      trace.modelCalls,
      "callHistory",
    );
    const call = functionCalls(response).find(({ name }) => name === SUBMIT_ANSWER);
    if (!call) throw new DraftingError("Call history stopped without an answer", trace);
    conversation.push(...(response.output as ResponseInputItem[]));
    const submission = parseSubmission(call, CallHistoryAnswerSchema, "The answer");
    trace.output = submission.raw;
    if (submission.ok) return submission.value;
    conversation.push({ type: "function_call_output", call_id: call.call_id, output: submission.feedback });
  }
  throw new DraftingError(`Call history did not return a valid answer in ${MAX_ATTEMPTS} attempts`, trace);
}
