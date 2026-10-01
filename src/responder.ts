import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { buildBaselineSystemPrompt, buildBaselineUserMessage } from "./prompt.ts";
import { ReplySchema, type Reply } from "./reply.ts";
import { TOOLS, runTool, toolDefinition } from "./tools.ts";

export const MAX_TOOL_ROUNDS = 8;
// Two forced submitReply calls after the tool rounds, in case the first one fails to parse.
const MAX_MODEL_CALLS = MAX_TOOL_ROUNDS + 2;
const SUBMIT_REPLY = "submitReply";

export type CreateMessage = (
  params: Anthropic.MessageCreateParamsNonStreaming,
) => Promise<Anthropic.Message>;

export interface ResponderOptions {
  create: CreateMessage;
  model: string;
}

export interface ModelCallTrace {
  model: string;
  stopReason: Anthropic.StopReason | null;
  usage: Anthropic.Usage;
  latencyMs: number;
}

export interface ToolCallTrace {
  name: string;
  input: unknown;
  output: unknown;
  isError: boolean;
}

export interface ResponderTrace {
  system: string;
  userMessage: string;
  modelCalls: ModelCallTrace[];
  toolCalls: ToolCallTrace[];
  finalOutput: unknown;
}

// Carries the partial trace so a failed message's model and tool calls still get written.
export class ResponderError extends Error {
  constructor(
    message: string,
    readonly trace: ResponderTrace,
  ) {
    super(message);
  }
}

const submitReplyTool = toolDefinition(
  SUBMIT_REPLY,
  "Submit the final Reply to the patient's message. Call this exactly once, after any lookups, to finish the turn.",
  ReplySchema,
);

export async function respondBaseline(
  humanMessage: string,
  { create, model }: ResponderOptions,
): Promise<{ reply: Reply; trace: ResponderTrace }> {
  const system = buildBaselineSystemPrompt();
  const userMessage = buildBaselineUserMessage(humanMessage);
  const trace: ResponderTrace = { system, userMessage, modelCalls: [], toolCalls: [], finalOutput: null };
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userMessage }];

  for (let call = 0; call < MAX_MODEL_CALLS; call++) {
    const toolChoice: Anthropic.ToolChoice =
      call < MAX_TOOL_ROUNDS ? { type: "any" } : { type: "tool", name: SUBMIT_REPLY };
    const started = performance.now();
    const response = await create({
      model,
      max_tokens: 16000,
      // Forced tool choice needs thinking off.
      thinking: { type: "disabled" },
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      tools: [...TOOLS, submitReplyTool],
      tool_choice: toolChoice,
      messages,
    });
    trace.modelCalls.push({
      model: response.model,
      stopReason: response.stop_reason,
      usage: response.usage,
      latencyMs: Math.round(performance.now() - started),
    });
    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      if (toolUse.name === SUBMIT_REPLY) {
        trace.finalOutput = toolUse.input;
        const parsed = ReplySchema.safeParse(toolUse.input);
        if (parsed.success) {
          return { reply: { ...parsed.data, templateId: null }, trace };
        }
        results.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          is_error: true,
          content: `The Reply does not match the schema. Fix it and call ${SUBMIT_REPLY} again.\n${z.prettifyError(parsed.error)}`,
        });
        continue;
      }
      const toolResult = runTool(toolUse.name, toolUse.input);
      trace.toolCalls.push({ name: toolUse.name, input: toolUse.input, output: toolResult.output, isError: toolResult.isError });
      results.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        is_error: toolResult.isError || undefined,
        content: typeof toolResult.output === "string" ? toolResult.output : JSON.stringify(toolResult.output),
      });
    }
    if (results.length === 0) {
      throw new ResponderError(`Model stopped without calling a tool (stop reason: ${response.stop_reason})`, trace);
    }
    messages.push({ role: "user", content: results });
  }

  throw new ResponderError(`Model did not submit a valid Reply within ${MAX_MODEL_CALLS} calls`, trace);
}
