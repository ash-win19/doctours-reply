import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { respondBaseline, MAX_TOOL_ROUNDS } from "../src/responder.ts";
import { VALID_REPLY, scriptedModel, toolUse } from "./fakes.ts";

const options = { model: "fake-model" };

test("returns the Reply the model submits", async () => {
  const model = scriptedModel([[toolUse("submitReply", VALID_REPLY)]]);
  const { reply } = await respondBaseline("Is the consultation free?", { ...options, create: model.create });
  assert.deepEqual(reply, VALID_REPLY);
});

test("sends the filled system prompt, the user message and every tool", async () => {
  const model = scriptedModel([[toolUse("submitReply", VALID_REPLY)]]);
  await respondBaseline("Is the consultation free?", { ...options, create: model.create });
  const [request] = model.requests;
  const system = request.system as Anthropic.TextBlockParam[];
  assert.match(system[0].text, /^# IDENTITY/);
  assert.match(request.messages[0].content as string, /"Is the consultation free\?"/);
  assert.equal(request.tools?.length, 15);
  assert.ok(request.tools?.some((tool) => "name" in tool && tool.name === "submitReply"));
  assert.deepEqual(request.tool_choice, { type: "any" });
});

test("runs tools and feeds results back until the Reply is submitted", async () => {
  const model = scriptedModel([
    [toolUse("getClinicPackagesTool", { clinicName: "Dr. Hakan Clinic" })],
    [toolUse("submitReply", VALID_REPLY)],
  ]);
  const { reply, trace } = await respondBaseline("What does Dr. Hakan Clinic cost?", {
    ...options,
    create: model.create,
  });
  assert.deepEqual(reply, VALID_REPLY);
  const resultTurn = model.requests[1].messages.at(-1)!;
  const [result] = resultTurn.content as Anthropic.ToolResultBlockParam[];
  assert.equal(result.type, "tool_result");
  assert.match(result.content as string, /Sapphire/);
  assert.equal(trace.toolCalls.length, 1);
  assert.equal(trace.toolCalls[0].name, "getClinicPackagesTool");
  assert.match(JSON.stringify(trace.toolCalls[0].output), /Sapphire/);
});

test("always sets templateId to null", async () => {
  const model = scriptedModel([[toolUse("submitReply", { ...VALID_REPLY, templateId: "tpl_1" })]]);
  const { reply } = await respondBaseline("hi", { ...options, create: model.create });
  assert.equal(reply.templateId, null);
});

test("an invalid Reply goes back to the model as an error", async () => {
  const model = scriptedModel([
    [toolUse("submitReply", { ...VALID_REPLY, escalate: "no" })],
    [toolUse("submitReply", VALID_REPLY)],
  ]);
  const { reply } = await respondBaseline("hi", { ...options, create: model.create });
  assert.deepEqual(reply, VALID_REPLY);
  const [result] = model.requests[1].messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
  assert.equal(result.is_error, true);
});

test(`forces submitReply after ${MAX_TOOL_ROUNDS} tool rounds`, async () => {
  const lookups = Array.from({ length: MAX_TOOL_ROUNDS }, () => [toolUse("getAllClinicsTool", {})]);
  const model = scriptedModel([...lookups, [toolUse("submitReply", VALID_REPLY)]]);
  await respondBaseline("hi", { ...options, create: model.create });
  assert.deepEqual(model.requests.at(-1)!.tool_choice, { type: "tool", name: "submitReply" });
  assert.deepEqual(model.requests.at(-2)!.tool_choice, { type: "any" });
});

test("throws when the model never submits a valid Reply", async () => {
  const lookups = Array.from({ length: 20 }, () => [toolUse("getAllClinicsTool", {})]);
  const model = scriptedModel(lookups);
  await assert.rejects(respondBaseline("hi", { ...options, create: model.create }), /submit/i);
});

test("traces usage and latency for every model call", async () => {
  const model = scriptedModel([
    [toolUse("getAllClinicsTool", {})],
    [toolUse("submitReply", VALID_REPLY)],
  ]);
  const { trace } = await respondBaseline("hi", { ...options, create: model.create });
  assert.equal(trace.modelCalls.length, 2);
  for (const call of trace.modelCalls) {
    assert.equal(call.model, "fake-model");
    assert.equal(call.usage.input_tokens, 100);
    assert.equal(call.usage.cache_read_input_tokens, 80);
    assert.equal(typeof call.latencyMs, "number");
  }
  assert.deepEqual(trace.finalOutput, VALID_REPLY);
});
