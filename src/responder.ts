import type Groq from "groq-sdk";
import type { ChatCompletionCreateParamsNonStreaming } from "groq-sdk/resources/chat/completions";
import { z } from "zod";
import { buildBaselineSystemPrompt, buildBaselineUserMessage } from "./prompt.ts";
import { ReplySchema, type Reply } from "./reply.ts";
import { TOOLS, runTool, toolDefinition } from "./tools.ts";

export const MAX_TOOL_ROUNDS = 8;
// Two forced submitReply calls after the tool rounds, in case the first one fails to parse.
const MAX_MODEL_CALLS = MAX_TOOL_ROUNDS + 2;
const SUBMIT_REPLY = "submitReply";

export type CompletionParams = ChatCompletionCreateParamsNonStreaming;

export type CreateCompletion = (params: CompletionParams) => Promise<Groq.Chat.ChatCompletion>;

export interface ResponderOptions {
  create: CreateCompletion;
  model: string;
}

export interface ModelCallTrace {
  model: string;
  finishReason: string | null;
  reasoning: string | null;
  usage: Groq.CompletionUsage | null;
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

type ParsedArguments = { ok: true; value: unknown } | { ok: false; error: string };

function parseArguments(raw: string): ParsedArguments {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, error: `Tool arguments are not valid JSON: ${raw}` };
  }
}

export async function respondBaseline(
  humanMessage: string,
  { create, model }: ResponderOptions,
): Promise<{ reply: Reply; trace: ResponderTrace }> {
  const system = buildBaselineSystemPrompt();
  const userMessage = buildBaselineUserMessage(humanMessage);
  const trace: ResponderTrace = { system, userMessage, modelCalls: [], toolCalls: [], finalOutput: null };
  const messages: Groq.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: system },
    { role: "user", content: userMessage },
  ];

  for (let call = 0; call < MAX_MODEL_CALLS; call++) {
    const toolChoice: Groq.Chat.ChatCompletionToolChoiceOption =
      call < MAX_TOOL_ROUNDS ? "required" : { type: "function", function: { name: SUBMIT_REPLY } };
    const started = performance.now();
    const completion = await create({
      model,
      // Groq counts this budget against the tokens-per-minute limit, so keep it near what a Reply needs.
      max_completion_tokens: 4096,
      tools: [...TOOLS, submitReplyTool],
      tool_choice: toolChoice,
      messages,
    });
    const [choice] = completion.choices;
    trace.modelCalls.push({
      model: completion.model,
      finishReason: choice?.finish_reason ?? null,
      reasoning: choice?.message.reasoning ?? null,
      usage: completion.usage ?? null,
      latencyMs: Math.round(performance.now() - started),
    });

    const toolCalls = choice?.message.tool_calls ?? [];
    if (toolCalls.length === 0) {
      throw new ResponderError(
        `Model stopped without calling a tool (finish reason: ${choice?.finish_reason ?? "none"})`,
        trace,
      );
    }
    // gpt-oss reasons between tool calls, so its reasoning goes back with the calls it made.
    messages.push({
      role: "assistant",
      content: choice.message.content,
      reasoning: choice.message.reasoning,
      tool_calls: toolCalls,
    });

    for (const toolCall of toolCalls) {
      const { name } = toolCall.function;
      const args = parseArguments(toolCall.function.arguments);
      let content: string;
      if (name === SUBMIT_REPLY) {
        trace.finalOutput = args.ok ? args.value : toolCall.function.arguments;
        const parsed = args.ok ? ReplySchema.safeParse(args.value) : null;
        if (parsed?.success) {
          return { reply: { ...parsed.data, templateId: null }, trace };
        }
        const problem = parsed ? z.prettifyError(parsed.error) : (args as { error: string }).error;
        content = `The Reply does not match the schema. Fix it and call ${SUBMIT_REPLY} again.\n${problem}`;
      } else {
        const toolResult = args.ok ? runTool(name, args.value) : ({ isError: true, output: args.error } as const);
        trace.toolCalls.push({
          name,
          input: args.ok ? args.value : toolCall.function.arguments,
          output: toolResult.output,
          isError: toolResult.isError,
        });
        content = typeof toolResult.output === "string" ? toolResult.output : JSON.stringify(toolResult.output);
      }
      messages.push({ role: "tool", tool_call_id: toolCall.id, content });
    }
  }

  throw new ResponderError(`Model did not submit a valid Reply within ${MAX_MODEL_CALLS} calls`, trace);
}
