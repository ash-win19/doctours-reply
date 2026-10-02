import { asDraftingError, type ModelOptions } from "./model-calls.ts";
import { buildBaselineSystemPrompt, buildBaselineUserMessage } from "./prompt.ts";
import type { Reply } from "./reply.ts";
import { runToolLoop, type ResponderTrace, type SubmitOutcome } from "./tool-loop.ts";
import { TOOLS, runTool } from "./tools.ts";
import { collectEvidence, emptyEvidence, emptyValidationTrace, validatingSubmit } from "./validator.ts";

// The packet's original prompt with all 14 packet functions: the "before" every later change is measured against.
// The default mode's fallback passes `validation` so its Replies are validated too. Baseline mode passes none and
// stays untouched.
export async function respondBaseline(
  humanMessage: string,
  options: ModelOptions,
  validation?: { inputCardDigits: string[] },
): Promise<{ reply: Reply; trace: ResponderTrace }> {
  const system = buildBaselineSystemPrompt();
  const userMessage = buildBaselineUserMessage(humanMessage);
  const trace: ResponderTrace = { system, userMessage, modelCalls: [], toolCalls: [], finalOutput: null };
  const evidence = validation ? emptyEvidence(validation.inputCardDigits) : null;
  let submit = (reply: Reply): SubmitOutcome => ({ reply });
  if (evidence) {
    trace.validation = emptyValidationTrace();
    submit = validatingSubmit(evidence, trace.validation);
  }
  try {
    const reply = await runToolLoop(
      {
        trace,
        tools: () => TOOLS,
        callTool: (name, input) => {
          const run = runTool(name, input);
          if (evidence && !run.isError) collectEvidence(evidence, run.output);
          return run;
        },
        onSubmit: (submitted) => submit({ ...submitted, templateId: null }),
      },
      options,
    );
    return { reply, trace };
  } catch (error) {
    throw asDraftingError(error, trace);
  }
}
