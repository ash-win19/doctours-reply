import { test } from "node:test";
import assert from "node:assert/strict";
import type Groq from "groq-sdk";
import { respondBaseline, MAX_TOOL_ROUNDS, ResponderError, type CompletionParams } from "../src/responder.ts";
import { VALID_REPLY, scriptedModel, toolCall } from "./fakes.ts";

const options = { model: "fake-model" };

type ToolMessage = Groq.Chat.ChatCompletionToolMessageParam;

function toolMessages(request: CompletionParams): ToolMessage[] {
  return request.messages.filter((message): message is ToolMessage => message.role === "tool");
}

test("returns the Reply the model submits", async () => {
  const model = scriptedModel([[toolCall("submitReply", VALID_REPLY)]]);
  const { reply } = await respondBaseline("Is the consultation free?", { ...options, create: model.create });
  assert.deepEqual(reply, VALID_REPLY);
});

test("sends the filled system prompt, the user message and every tool", async () => {
  const model = scriptedModel([[toolCall("submitReply", VALID_REPLY)]]);
  await respondBaseline("Is the consultation free?", { ...options, create: model.create });
  const [request] = model.requests;
  const [system, user] = request.messages;
  assert.equal(system.role, "system");
  assert.match(system.content as string, /^# IDENTITY/);
  assert.equal(user.role, "user");
  assert.match(user.content as string, /"Is the consultation free\?"/);
  assert.equal(request.model, "fake-model");
  assert.equal(request.tools?.length, 15);
  assert.ok(request.tools?.some((tool) => tool.function?.name === "submitReply"));
  assert.equal(request.tool_choice, "required");
});

test("runs tools and feeds results back until the Reply is submitted", async () => {
  const model = scriptedModel([
    [toolCall("getClinicPackagesTool", { clinicName: "Dr. Hakan Clinic" })],
    [toolCall("submitReply", VALID_REPLY)],
  ]);
  const { reply, trace } = await respondBaseline("What does Dr. Hakan Clinic cost?", {
    ...options,
    create: model.create,
  });
  assert.deepEqual(reply, VALID_REPLY);
  const [result] = toolMessages(model.requests[1]);
  const assistant = model.requests[1].messages.find((message) => message.role === "assistant")!;
  assert.equal(result.tool_call_id, (assistant as Groq.Chat.ChatCompletionAssistantMessageParam).tool_calls![0].id);
  assert.match(result.content as string, /Sapphire/);
  assert.equal(trace.toolCalls.length, 1);
  assert.equal(trace.toolCalls[0].name, "getClinicPackagesTool");
  assert.match(JSON.stringify(trace.toolCalls[0].output), /Sapphire/);
});

test("sends the model's reasoning back with its tool calls", async () => {
  const model = scriptedModel([[toolCall("getAllClinicsTool", {})], [toolCall("submitReply", VALID_REPLY)]]);
  await respondBaseline("hi", { ...options, create: model.create });
  const assistant = model.requests[1].messages.find((message) => message.role === "assistant");
  assert.equal((assistant as { reasoning?: string }).reasoning, "thinking it over");
});

test("always sets templateId to null", async () => {
  const model = scriptedModel([[toolCall("submitReply", { ...VALID_REPLY, templateId: "tpl_1" })]]);
  const { reply } = await respondBaseline("hi", { ...options, create: model.create });
  assert.equal(reply.templateId, null);
});

test("an invalid Reply goes back to the model as an error", async () => {
  const model = scriptedModel([
    [toolCall("submitReply", { ...VALID_REPLY, escalate: "no" })],
    [toolCall("submitReply", VALID_REPLY)],
  ]);
  const { reply } = await respondBaseline("hi", { ...options, create: model.create });
  assert.deepEqual(reply, VALID_REPLY);
  const [result] = toolMessages(model.requests[1]);
  assert.match(result.content as string, /does not match the schema/);
});

test("tool arguments that are not JSON go back to the model as an error", async () => {
  const model = scriptedModel([
    [{ name: "getClinicPackagesTool", arguments: "{clinicName: Heva" }],
    [toolCall("submitReply", VALID_REPLY)],
  ]);
  const { trace } = await respondBaseline("hi", { ...options, create: model.create });
  const [result] = toolMessages(model.requests[1]);
  assert.match(result.content as string, /not valid JSON/);
  assert.equal(trace.toolCalls[0].isError, true);
});

test(`forces submitReply after ${MAX_TOOL_ROUNDS} tool rounds`, async () => {
  const lookups = Array.from({ length: MAX_TOOL_ROUNDS }, () => [toolCall("getAllClinicsTool", {})]);
  const model = scriptedModel([...lookups, [toolCall("submitReply", VALID_REPLY)]]);
  await respondBaseline("hi", { ...options, create: model.create });
  assert.deepEqual(model.requests.at(-1)!.tool_choice, { type: "function", function: { name: "submitReply" } });
  assert.equal(model.requests.at(-2)!.tool_choice, "required");
});

test("throws with the partial trace when the model never submits a valid Reply", async () => {
  const lookups = Array.from({ length: 20 }, () => [toolCall("getAllClinicsTool", {})]);
  const model = scriptedModel(lookups);
  await assert.rejects(respondBaseline("hi", { ...options, create: model.create }), (error: unknown) => {
    assert.ok(error instanceof ResponderError);
    assert.match(error.message, /submit/i);
    assert.equal(error.trace.modelCalls.length, 10);
    assert.equal(error.trace.toolCalls.length, 10);
    return true;
  });
});

test("traces usage and latency for every model call", async () => {
  const model = scriptedModel([[toolCall("getAllClinicsTool", {})], [toolCall("submitReply", VALID_REPLY)]]);
  const { trace } = await respondBaseline("hi", { ...options, create: model.create });
  assert.equal(trace.modelCalls.length, 2);
  for (const call of trace.modelCalls) {
    assert.equal(call.model, "fake-model");
    assert.equal(call.usage?.prompt_tokens, 100);
    assert.equal(call.usage?.prompt_tokens_details?.cached_tokens, 80);
    assert.equal(typeof call.latencyMs, "number");
  }
  assert.equal(trace.modelCalls[0].reasoning, "thinking it over");
  assert.deepEqual(trace.finalOutput, VALID_REPLY);
});
