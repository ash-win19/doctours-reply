import type { ResponseInputItem } from "openai/resources/responses/responses";
import { z } from "zod";
import { buildTriageSystemPrompt, buildTriageUserMessage, type SkillSummary } from "./prompt.ts";
import {
  DraftingError,
  asDraftingError,
  functionCalls,
  parseSubmission,
  tracedCall,
  type ModelOptions,
  type Trace,
} from "./model-calls.ts";
import { toolDefinition } from "./tools.ts";

export const TriageDecisionSchema = z.object({
  escalate: z.boolean(),
  escalationReason: z.string().nullable(),
  cannotDo: z.string().nullable(),
  skills: z.array(z.string()),
  intent: z.string(),
});

export type TriageDecision = z.infer<typeof TriageDecisionSchema>;

export interface TriageInput {
  // Already redacted, so triage never sees card digits.
  message: string;
  stateCard: string;
  recentTurns: string[];
  skillIndex: SkillSummary[];
}

export interface TriageTrace extends Trace {
  system: string;
  userMessage: string;
  output: unknown;
}

const SUBMIT_TRIAGE = "submitTriage";
// One retry when the decision doesn't parse.
const MAX_ATTEMPTS = 2;

const submitTriageTool = toolDefinition(
  SUBMIT_TRIAGE,
  "Submit the triage decision for the incoming message.",
  TriageDecisionSchema,
);

// One small-model call that decides Escalation and picks skills before any Reply is drafted (ADR 0001).
export async function triage(
  input: TriageInput,
  options: ModelOptions,
): Promise<{ decision: TriageDecision; trace: TriageTrace }> {
  const system = buildTriageSystemPrompt(input.skillIndex);
  const userMessage = buildTriageUserMessage(input);
  const trace: TriageTrace = { system, userMessage, output: null, modelCalls: [] };
  try {
    return { decision: await submitTriageLoop(trace, options), trace };
  } catch (error) {
    throw asDraftingError(error, trace);
  }
}

async function submitTriageLoop(trace: TriageTrace, { create, model }: ModelOptions): Promise<TriageDecision> {
  const conversation: ResponseInputItem[] = [{ role: "user", content: trace.userMessage }];
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const response = await tracedCall(
      create,
      {
        model,
        instructions: trace.system,
        input: conversation,
        tools: [submitTriageTool],
        tool_choice: { type: "function", name: SUBMIT_TRIAGE },
        max_output_tokens: 4000,
      },
      trace.modelCalls,
      "triage",
    );
    const call = functionCalls(response).find(({ name }) => name === SUBMIT_TRIAGE);
    if (!call) throw new DraftingError("Triage stopped without a decision", trace);
    conversation.push(...(response.output as ResponseInputItem[]));
    const submission = parseSubmission(call, TriageDecisionSchema, "The decision");
    trace.output = submission.raw;
    if (submission.ok) return submission.value;
    conversation.push({ type: "function_call_output", call_id: call.call_id, output: submission.feedback });
  }
  throw new DraftingError(`Triage did not return a valid decision in ${MAX_ATTEMPTS} attempts`, trace);
}
