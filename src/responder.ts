import { asDraftingError, type ModelOptions } from "./model-calls.ts";
import { buildBaselineSystemPrompt, buildBaselineUserMessage } from "./prompt.ts";
import type { Reply } from "./reply.ts";
import { runToolLoop, type ResponderTrace, type SubmitOutcome } from "./tool-loop.ts";
import { TOOLS } from "./tools.ts";
import {
  emptyEvidence,
  emptyValidationTrace,
  runToolForEvidence,
  validatingSubmit,
  type ValidationTrace,
} from "./validator.ts";

export interface BaselineTrace extends ResponderTrace {
  // Set when the default mode's fallback validates the Reply.
  validation?: ValidationTrace;
}

export interface BaselineValidation {
  // Card digit runs the guards found in the Patient's raw message.
  inputCardDigits: string[];
}

// The packet's original prompt with all 14 packet functions: the "before" every later change is measured against.
// The default mode's fallback passes `validation` so its Replies are validated too. Baseline mode passes none and
// stays untouched.
export async function respondBaseline(
  humanMessage: string,
  options: ModelOptions,
  validation?: BaselineValidation,
): Promise<{ reply: Reply; trace: BaselineTrace }> {
  const system = buildBaselineSystemPrompt();
  const userMessage = buildBaselineUserMessage(humanMessage);
  const trace: BaselineTrace = { system, userMessage, modelCalls: [], toolCalls: [], finalOutput: null };
  const evidence = validation ? emptyEvidence(validation.inputCardDigits) : null;
  let onSubmit = (reply: Reply): SubmitOutcome => ({ reply });
  if (evidence) {
    trace.validation = emptyValidationTrace();
    onSubmit = validatingSubmit(evidence, trace.validation);
  }
  try {
    const reply = await runToolLoop(
      { trace, tools: () => TOOLS, callTool: (name, input) => runToolForEvidence(name, input, evidence), onSubmit },
      options,
    );
    return { reply, trace };
  } catch (error) {
    throw asDraftingError(error, trace);
  }
}
