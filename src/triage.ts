import { z } from "zod";
import { buildTriageSystemPrompt, buildTriageUserMessage, type SkillSummary } from "./prompt.ts";
import { asDraftingError, forcedSubmit, type ModelOptions, type Trace } from "./model-calls.ts";
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

const submitTriageTool = toolDefinition(
  "submitTriage",
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
    const decision = await forcedSubmit(
      {
        trace,
        step: "triage",
        system,
        userMessage,
        tool: submitTriageTool,
        schema: TriageDecisionSchema,
        what: "The decision",
        onSubmission: (raw) => (trace.output = raw),
      },
      options,
    );
    return { decision, trace };
  } catch (error) {
    throw asDraftingError(error, trace);
  }
}
