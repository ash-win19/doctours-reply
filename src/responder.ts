import { asDraftingError, type ModelOptions } from "./model-calls.ts";
import type { PatientContext } from "./patient-context.ts";
import { buildBaselineSystemPrompt, buildBaselineUserMessage } from "./prompt.ts";
import type { Reply } from "./reply.ts";
import { runToolLoop, type ResponderTrace } from "./tool-loop.ts";
import { TOOLS, runTool } from "./tools.ts";

// The packet's original prompt with all 14 packet functions: the "before" every later change is measured against.
export async function respondBaseline(
  humanMessage: string,
  options: ModelOptions,
  context: PatientContext,
): Promise<{ reply: Reply; trace: ResponderTrace }> {
  const system = buildBaselineSystemPrompt(context);
  const userMessage = buildBaselineUserMessage(humanMessage, context);
  const trace: ResponderTrace = { system, userMessage, modelCalls: [], toolCalls: [], finalOutput: null };
  try {
    const reply = await runToolLoop(
      {
        trace,
        tools: () => TOOLS,
        callTool: (name, input) => runTool(name, input, context),
        onSubmit: (submitted) => ({ ...submitted, templateId: null }),
      },
      options,
    );
    return { reply, trace };
  } catch (error) {
    throw asDraftingError(error, trace);
  }
}
