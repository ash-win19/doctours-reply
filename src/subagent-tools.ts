import type { FunctionTool } from "openai/resources/responses/responses";
import { z } from "zod";
import { askCallHistory, type CallHistoryRecord, type CallHistoryTrace } from "./call-history.ts";
import type { ModelOptions } from "./model-calls.ts";
import { toolDefinition, type SubagentToolName } from "./tools.ts";

// What a subagent tool did for one message: the answer for the responder, or null when it failed.
export interface SubagentRun {
  answer: string | null;
  trace: CallHistoryTrace;
}

export type SubagentRecord = CallHistoryRecord;

export interface SubagentContext {
  SUPABASE_CHAT_ID: string;
}

interface SubagentTool<Input> {
  definition: FunctionTool;
  input: z.ZodType<Input>;
  run: (input: Input, options: ModelOptions, context: SubagentContext) => Promise<SubagentRun>;
}

function subagentTool<Input>(name: string, description: string, input: z.ZodType<Input>, run: SubagentTool<Input>["run"]) {
  return { definition: toolDefinition(name, description, input), input, run } as SubagentTool<unknown>;
}

// Tools the skill responder runs itself, each a separate model call. Skills list them by name like packet tools.
export const SUBAGENT_TOOLS: Record<SubagentToolName, SubagentTool<unknown>> = {
  askCallHistory: subagentTool(
    "askCallHistory",
    "Ask a question about the patient's past calls with Doctours, such as the Consultation. A separate reader checks the full call summaries and transcripts and returns a short answer.",
    z.object({ question: z.string() }),
    ({ question }, options, context) => askCallHistory(question, options, { chatId: context.SUPABASE_CHAT_ID }),
  ),
};

export function isSubagentTool(name: string): name is SubagentToolName {
  return name in SUBAGENT_TOOLS;
}
