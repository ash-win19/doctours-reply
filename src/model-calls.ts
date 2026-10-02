import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseFunctionToolCall,
  ResponseUsage,
} from "openai/resources/responses/responses";
import { z } from "zod";
import { SetupError } from "./errors.ts";

export type CreateResponse = (params: ResponseCreateParamsNonStreaming) => Promise<Response>;

export interface ModelOptions {
  create: CreateResponse;
  model: string;
}

// The part of the work a model call belongs to.
export type Step = "triage" | "responder";

export interface ModelCallTrace {
  step: Step;
  model: string;
  status: Response["status"] | null;
  usage: ResponseUsage | null;
  latencyMs: number;
}

export interface ToolCallTrace {
  name: string;
  input: unknown;
  output: unknown;
  isError: boolean;
}

// Every trace lists its model calls, so tokens can be totalled whatever produced it, and its tool calls if it made any.
export interface Trace {
  modelCalls: ModelCallTrace[];
  toolCalls?: ToolCallTrace[];
}

// OpenAI's output_tokens already include reasoning tokens.
export function tokenUsage(trace: Trace | null): { inputTokens: number; outputTokens: number } {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const { usage } of trace?.modelCalls ?? []) {
    inputTokens += usage?.input_tokens ?? 0;
    outputTokens += usage?.output_tokens ?? 0;
  }
  return { inputTokens, outputTokens };
}

// A message that couldn't be drafted. Carries the partial trace so its model and tool calls still get written.
export class DraftingError extends Error {
  constructor(
    message: string,
    readonly trace: Trace,
  ) {
    super(message);
  }
}

// Setup errors stop the run as they are. Anything else fails only this message, keeping the trace so far.
export function asDraftingError(error: unknown, trace: Trace): Error {
  if (error instanceof SetupError || error instanceof DraftingError) return error;
  return new DraftingError(error instanceof Error ? error.message : String(error), trace);
}

// Makes one model call and records its usage and latency under the given step.
export async function tracedCall(
  create: CreateResponse,
  params: ResponseCreateParamsNonStreaming,
  modelCalls: ModelCallTrace[],
  step: Step,
): Promise<Response> {
  const started = performance.now();
  const response = await create(params);
  modelCalls.push({
    step,
    model: response.model,
    status: response.status ?? null,
    usage: response.usage ?? null,
    latencyMs: Math.round(performance.now() - started),
  });
  return response;
}

export function functionCalls(response: Response): ResponseFunctionToolCall[] {
  return response.output.filter((item): item is ResponseFunctionToolCall => item.type === "function_call");
}

type ParsedArguments = { ok: true; value: unknown } | { ok: false; error: string };

export function parseArguments(raw: string): ParsedArguments {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, error: `Tool arguments are not valid JSON: ${raw}` };
  }
}

export type Submission<T> = { ok: true; value: T; raw: unknown } | { ok: false; raw: unknown; feedback: string };

// Parses a submit call's arguments against its schema. On failure, `feedback` is what goes back to the model.
export function parseSubmission<T>(call: ResponseFunctionToolCall, schema: z.ZodType<T>, what: string): Submission<T> {
  const args = parseArguments(call.arguments);
  if (!args.ok) {
    return { ok: false, raw: call.arguments, feedback: `${what} is not valid JSON. Call ${call.name} again.\n${args.error}` };
  }
  const parsed = schema.safeParse(args.value);
  if (parsed.success) return { ok: true, value: parsed.data, raw: args.value };
  return {
    ok: false,
    raw: args.value,
    feedback: `${what} does not match the schema. Fix it and call ${call.name} again.\n${z.prettifyError(parsed.error)}`,
  };
}
