import type { ResponseInputItem } from "openai/resources/responses/responses";
import { z } from "zod";
import { buildTriageSystemPrompt, buildTriageUserMessage, type SkillSummary } from "./prompt.ts";
import {
  ResponderError,
  functionCalls,
  parseArguments,
  tracedCall,
  type CreateResponse,
  type Trace,
} from "./responder.ts";
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
  { create, model }: { create: CreateResponse; model: string },
): Promise<{ decision: TriageDecision; trace: TriageTrace }> {
  const system = buildTriageSystemPrompt(input.skillIndex);
  const userMessage = buildTriageUserMessage(input);
  const trace: TriageTrace = { system, userMessage, output: null, modelCalls: [] };
  const conversation: ResponseInputItem[] = [{ role: "user", content: userMessage }];

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const response = await tracedCall(
      create,
      {
        model,
        instructions: system,
        input: conversation,
        tools: [submitTriageTool],
        tool_choice: { type: "function", name: SUBMIT_TRIAGE },
        max_output_tokens: 4000,
      },
      trace.modelCalls,
      "triage",
    );
    const call = functionCalls(response).find(({ name }) => name === SUBMIT_TRIAGE);
    if (!call) throw new ResponderError("Triage stopped without a decision", trace);
    conversation.push(...(response.output as ResponseInputItem[]));
    const args = parseArguments(call.arguments);
    trace.output = args.ok ? args.value : call.arguments;
    const parsed = args.ok ? TriageDecisionSchema.safeParse(args.value) : null;
    if (parsed?.success) return { decision: parsed.data, trace };
    const problem = parsed ? z.prettifyError(parsed.error) : (args as { error: string }).error;
    conversation.push({
      type: "function_call_output",
      call_id: call.call_id,
      output: `The decision does not match the schema. Fix it and call ${SUBMIT_TRIAGE} again.\n${problem}`,
    });
  }
  throw new ResponderError(`Triage did not return a valid decision in ${MAX_ATTEMPTS} attempts`, trace);
}
