import { asDraftingError, type ModelOptions } from "./model-calls.ts";
import { buildBaselineSystemPrompt, buildBaselineUserMessage } from "./prompt.ts";
import type { Reply } from "./reply.ts";
import { runToolLoop, type ResponderTrace } from "./tool-loop.ts";
import { TOOLS, runTool } from "./tools.ts";

// The packet's original prompt with all 14 packet functions: the "before" every later change is measured against.
export async function respondBaseline(
  humanMessage: string,
  options: ModelOptions,
): Promise<{ reply: Reply; trace: ResponderTrace }> {
  const system = buildBaselineSystemPrompt();
  const userMessage = buildBaselineUserMessage(humanMessage);
  const trace: ResponderTrace = { system, userMessage, modelCalls: [], toolCalls: [], finalOutput: null };
  try {
    const reply = await runToolLoop(
      { trace, tools: () => TOOLS, callTool: runTool, onSubmit: (submitted) => ({ ...submitted, templateId: null }) },
      options,
    );
    return { reply, trace };
  } catch (error) {
    throw asDraftingError(error, trace);
  }
}
