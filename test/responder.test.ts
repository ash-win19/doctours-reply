import { test } from "node:test";
import assert from "node:assert/strict";
import type { ResponseCreateParamsNonStreaming, ResponseInputItem } from "openai/resources/responses/responses";
import { respondBaseline } from "../src/responder.ts";
import { MAX_TOOL_ROUNDS, type ResponderTrace } from "../src/tool-loop.ts";
import { DraftingError, tokenUsage } from "../src/model-calls.ts";
import { VALID_REPLY, scriptedModel, functionCall, toolNames } from "./fakes.ts";

const options = { model: "fake-model" };

function inputItems(request: ResponseCreateParamsNonStreaming): ResponseInputItem[] {
  return request.input as ResponseInputItem[];
}

function functionOutputs(request: ResponseCreateParamsNonStreaming) {
  return inputItems(request).filter(
    (item): item is ResponseInputItem.FunctionCallOutput => "type" in item && item.type === "function_call_output",
  );
}

test("returns the Reply the model submits", async () => {
  const model = scriptedModel([[functionCall("submitReply", VALID_REPLY)]]);
  const { reply } = await respondBaseline("Is the consultation free?", { ...options, create: model.create });
  assert.deepEqual(reply, VALID_REPLY);
});

test("sends the filled system prompt, the user message and every tool", async () => {
  const model = scriptedModel([[functionCall("submitReply", VALID_REPLY)]]);
  await respondBaseline("Is the consultation free?", { ...options, create: model.create });
  const [request] = model.requests;
  assert.equal(request.model, "fake-model");
  assert.match(request.instructions as string, /^# IDENTITY/);
  const [user] = inputItems(request);
  assert.ok("role" in user && user.role === "user");
  assert.match((user as { content: string }).content, /"Is the consultation free\?"/);
  assert.equal(toolNames(request).length, 15);
  assert.ok(toolNames(request).includes("submitReply"));
  assert.equal(request.tool_choice, "required");
});

test("runs tools and feeds results back until the Reply is submitted", async () => {
  const model = scriptedModel([
    [functionCall("getClinicPackagesTool", { clinicName: "Dr. Hakan Clinic" })],
    [functionCall("submitReply", VALID_REPLY)],
  ]);
  const { reply, trace } = await respondBaseline("What does Dr. Hakan Clinic cost?", {
    ...options,
    create: model.create,
  });
  assert.deepEqual(reply, VALID_REPLY);
  const call = inputItems(model.requests[1]).find((item) => "type" in item && item.type === "function_call") as {
    call_id: string;
  };
  const [result] = functionOutputs(model.requests[1]);
  assert.equal(result.call_id, call.call_id);
  assert.match(result.output as string, /Sapphire/);
  assert.equal(trace.toolCalls.length, 1);
  assert.equal(trace.toolCalls[0].name, "getClinicPackagesTool");
  assert.match(JSON.stringify(trace.toolCalls[0].output), /Sapphire/);
});

test("sends the model's output back whole, reasoning items included", async () => {
  const model = scriptedModel([[functionCall("getAllClinicsTool", {})], [functionCall("submitReply", VALID_REPLY)]]);
  await respondBaseline("hi", { ...options, create: model.create });
  const types = inputItems(model.requests[1]).map((item) => ("type" in item ? item.type : "message"));
  assert.deepEqual(types, ["message", "reasoning", "function_call", "function_call_output"]);
});

test("always sets templateId to null", async () => {
  const model = scriptedModel([[functionCall("submitReply", { ...VALID_REPLY, templateId: "tpl_1" })]]);
  const { reply } = await respondBaseline("hi", { ...options, create: model.create });
  assert.equal(reply.templateId, null);
});

test("an invalid Reply goes back to the model as an error", async () => {
  const model = scriptedModel([
    [functionCall("submitReply", { ...VALID_REPLY, escalate: "no" })],
    [functionCall("submitReply", VALID_REPLY)],
  ]);
  const { reply } = await respondBaseline("hi", { ...options, create: model.create });
  assert.deepEqual(reply, VALID_REPLY);
  const [result] = functionOutputs(model.requests[1]);
  assert.match(result.output as string, /does not match the schema/);
});

test("tool arguments that are not JSON go back to the model as an error", async () => {
  const model = scriptedModel([
    [{ name: "getClinicPackagesTool", arguments: "{clinicName: Heva" }],
    [functionCall("submitReply", VALID_REPLY)],
  ]);
  const { trace } = await respondBaseline("hi", { ...options, create: model.create });
  const [result] = functionOutputs(model.requests[1]);
  assert.match(result.output as string, /not valid JSON/);
  assert.equal(trace.toolCalls[0].isError, true);
});

test(`forces submitReply after ${MAX_TOOL_ROUNDS} tool rounds`, async () => {
  const lookups = Array.from({ length: MAX_TOOL_ROUNDS }, () => [functionCall("getAllClinicsTool", {})]);
  const model = scriptedModel([...lookups, [functionCall("submitReply", VALID_REPLY)]]);
  await respondBaseline("hi", { ...options, create: model.create });
  assert.deepEqual(model.requests.at(-1)!.tool_choice, { type: "function", name: "submitReply" });
  assert.equal(model.requests.at(-2)!.tool_choice, "required");
});

test("throws with the partial trace when the model never submits a valid Reply", async () => {
  const lookups = Array.from({ length: 20 }, () => [functionCall("getAllClinicsTool", {})]);
  const model = scriptedModel(lookups);
  await assert.rejects(respondBaseline("hi", { ...options, create: model.create }), (error: unknown) => {
    assert.ok(error instanceof DraftingError);
    assert.match(error.message, /submit/i);
    assert.equal(error.trace.modelCalls.length, 10);
    assert.equal((error.trace as ResponderTrace).toolCalls.length, 10);
    return true;
  });
});

test("traces usage and latency for every model call", async () => {
  const model = scriptedModel([[functionCall("getAllClinicsTool", {})], [functionCall("submitReply", VALID_REPLY)]]);
  const { trace } = await respondBaseline("hi", { ...options, create: model.create });
  assert.equal(trace.modelCalls.length, 2);
  for (const call of trace.modelCalls) {
    assert.equal(call.step, "responder");
    assert.equal(call.model, "fake-model");
    assert.equal(call.usage?.input_tokens, 100);
    assert.equal(call.usage?.input_tokens_details.cached_tokens, 80);
    assert.equal(call.usage?.output_tokens_details.reasoning_tokens, 30);
    assert.equal(typeof call.latencyMs, "number");
  }
  assert.deepEqual(trace.finalOutput, VALID_REPLY);
});

test("totals tokens across a trace; output already includes reasoning", async () => {
  const model = scriptedModel([[functionCall("getAllClinicsTool", {})], [functionCall("submitReply", VALID_REPLY)]]);
  const { trace } = await respondBaseline("hi", { ...options, create: model.create });
  assert.deepEqual(tokenUsage(trace), { inputTokens: 200, outputTokens: 100 });
  assert.deepEqual(tokenUsage(null), { inputTokens: 0, outputTokens: 0 });
});
