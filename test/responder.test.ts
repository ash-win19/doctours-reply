import { test } from "node:test";
import assert from "node:assert/strict";
import { FunctionCallingConfigMode, type Content, type FunctionDeclaration, type GenerateContentParameters } from "@google/genai";
import { respondBaseline, MAX_TOOL_ROUNDS, ResponderError } from "../src/responder.ts";
import { VALID_REPLY, scriptedModel, functionCall } from "./fakes.ts";

const options = { model: "fake-model" };

function contents(request: GenerateContentParameters): Content[] {
  return request.contents as Content[];
}

function declarations(request: GenerateContentParameters): FunctionDeclaration[] {
  return request.config!.tools!.flatMap((tool) => ("functionDeclarations" in tool ? tool.functionDeclarations ?? [] : []));
}

function functionResponses(request: GenerateContentParameters) {
  return contents(request).flatMap((content) => content.parts ?? []).flatMap((part) => part.functionResponse ?? []);
}

test("returns the Reply the model submits", async () => {
  const model = scriptedModel([[functionCall("submitReply", VALID_REPLY)]]);
  const { reply } = await respondBaseline("Is the consultation free?", { ...options, generate: model.generate });
  assert.deepEqual(reply, VALID_REPLY);
});

test("sends the filled system prompt, the user message and every tool", async () => {
  const model = scriptedModel([[functionCall("submitReply", VALID_REPLY)]]);
  await respondBaseline("Is the consultation free?", { ...options, generate: model.generate });
  const [request] = model.requests;
  assert.equal(request.model, "fake-model");
  assert.match(request.config!.systemInstruction as string, /^# IDENTITY/);
  const [user] = contents(request);
  assert.equal(user.role, "user");
  assert.match(user.parts![0].text!, /"Is the consultation free\?"/);
  const names = declarations(request).map((declaration) => declaration.name);
  assert.equal(names.length, 15);
  assert.ok(names.includes("submitReply"));
  assert.deepEqual(request.config!.toolConfig, {
    functionCallingConfig: { mode: FunctionCallingConfigMode.ANY },
  });
});

test("runs tools and feeds results back until the Reply is submitted", async () => {
  const model = scriptedModel([
    [functionCall("getClinicPackagesTool", { clinicName: "Dr. Hakan Clinic" })],
    [functionCall("submitReply", VALID_REPLY)],
  ]);
  const { reply, trace } = await respondBaseline("What does Dr. Hakan Clinic cost?", {
    ...options,
    generate: model.generate,
  });
  assert.deepEqual(reply, VALID_REPLY);
  const modelTurn = contents(model.requests[1])[1];
  const call = modelTurn.parts!.find((part) => part.functionCall)!.functionCall!;
  const [result] = functionResponses(model.requests[1]);
  assert.equal(result.id, call.id);
  assert.equal(result.name, "getClinicPackagesTool");
  assert.match(JSON.stringify(result.response), /Sapphire/);
  assert.equal(trace.toolCalls.length, 1);
  assert.equal(trace.toolCalls[0].name, "getClinicPackagesTool");
  assert.match(JSON.stringify(trace.toolCalls[0].output), /Sapphire/);
});

test("sends the model's turn back unchanged, thought signatures included", async () => {
  const model = scriptedModel([[functionCall("getAllClinicsTool", {})], [functionCall("submitReply", VALID_REPLY)]]);
  await respondBaseline("hi", { ...options, generate: model.generate });
  const modelTurn = contents(model.requests[1])[1];
  assert.equal(modelTurn.role, "model");
  assert.equal(modelTurn.parts![0].thoughtSignature, "signature");
});

test("always sets templateId to null", async () => {
  const model = scriptedModel([[functionCall("submitReply", { ...VALID_REPLY, templateId: "tpl_1" })]]);
  const { reply } = await respondBaseline("hi", { ...options, generate: model.generate });
  assert.equal(reply.templateId, null);
});

test("an invalid Reply goes back to the model as an error", async () => {
  const model = scriptedModel([
    [functionCall("submitReply", { ...VALID_REPLY, escalate: "no" })],
    [functionCall("submitReply", VALID_REPLY)],
  ]);
  const { reply } = await respondBaseline("hi", { ...options, generate: model.generate });
  assert.deepEqual(reply, VALID_REPLY);
  const [result] = functionResponses(model.requests[1]);
  assert.match(JSON.stringify(result.response), /does not match the schema/);
});

test(`forces submitReply after ${MAX_TOOL_ROUNDS} tool rounds`, async () => {
  const lookups = Array.from({ length: MAX_TOOL_ROUNDS }, () => [functionCall("getAllClinicsTool", {})]);
  const model = scriptedModel([...lookups, [functionCall("submitReply", VALID_REPLY)]]);
  await respondBaseline("hi", { ...options, generate: model.generate });
  assert.deepEqual(model.requests.at(-1)!.config!.toolConfig, {
    functionCallingConfig: { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: ["submitReply"] },
  });
  assert.deepEqual(model.requests.at(-2)!.config!.toolConfig, {
    functionCallingConfig: { mode: FunctionCallingConfigMode.ANY },
  });
});

test("throws with the partial trace when the model never submits a valid Reply", async () => {
  const lookups = Array.from({ length: 20 }, () => [functionCall("getAllClinicsTool", {})]);
  const model = scriptedModel(lookups);
  await assert.rejects(respondBaseline("hi", { ...options, generate: model.generate }), (error: unknown) => {
    assert.ok(error instanceof ResponderError);
    assert.match(error.message, /submit/i);
    assert.equal(error.trace.modelCalls.length, 10);
    assert.equal(error.trace.toolCalls.length, 10);
    return true;
  });
});

test("traces usage and latency for every model call", async () => {
  const model = scriptedModel([[functionCall("getAllClinicsTool", {})], [functionCall("submitReply", VALID_REPLY)]]);
  const { trace } = await respondBaseline("hi", { ...options, generate: model.generate });
  assert.equal(trace.modelCalls.length, 2);
  for (const call of trace.modelCalls) {
    assert.equal(call.model, "fake-model");
    assert.equal(call.usage?.promptTokenCount, 100);
    assert.equal(call.usage?.cachedContentTokenCount, 80);
    assert.equal(call.usage?.thoughtsTokenCount, 30);
    assert.equal(typeof call.latencyMs, "number");
  }
  assert.deepEqual(trace.finalOutput, VALID_REPLY);
});
