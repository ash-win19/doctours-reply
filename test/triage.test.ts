import { test } from "node:test";
import assert from "node:assert/strict";
import type { ResponseCreateParamsNonStreaming, ResponseInputItem } from "openai/resources/responses/responses";
import { triage, type TriageInput } from "../src/triage.ts";
import { ResponderError } from "../src/responder.ts";
import { functionCall, scriptedModel } from "./fakes.ts";

const DECISION = {
  escalate: true,
  escalationReason: "Patient asked for a refund",
  cannotDo: "refund a payment",
  skills: [],
  intent: "refund a payment",
};

const input: TriageInput = {
  message: "refund what I paid yesterday",
  stateCard: "Pipeline Status: PRE_CLINICAL_SENT",
  recentTurns: ["Jordan Hale: Got it", "Alex: Did any clinic catch your eye?"],
  skillIndex: [],
};

function userText(request: ResponseCreateParamsNonStreaming): string {
  const [user] = request.input as ResponseInputItem[];
  return (user as { content: string }).content;
}

test("returns the decision the model submits", async () => {
  const model = scriptedModel([[functionCall("submitTriage", DECISION)]]);
  const { decision } = await triage(input, { create: model.create, model: "triage-model" });
  assert.deepEqual(decision, DECISION);
});

test("sends the policy, skill index, state card, recent turns and message, and forces submitTriage", async () => {
  const model = scriptedModel([[functionCall("submitTriage", DECISION)]]);
  await triage(
    { ...input, skillIndex: [{ id: "payments", description: "Paying the Deposit, Financing and insurance." }] },
    { create: model.create, model: "triage-model" },
  );
  const [request] = model.requests;
  assert.equal(request.model, "triage-model");
  assert.match(request.instructions as string, /# Escalation policy/);
  assert.match(request.instructions as string, /- payments: Paying the Deposit, Financing and insurance\./);
  assert.deepEqual(request.tool_choice, { type: "function", name: "submitTriage" });
  assert.deepEqual(
    (request.tools ?? []).map((tool) => (tool.type === "function" ? tool.name : tool.type)),
    ["submitTriage"],
  );
  const text = userText(request);
  assert.match(text, /# State card\nPipeline Status: PRE_CLINICAL_SENT/);
  assert.match(text, /Jordan Hale: Got it\nAlex: Did any clinic catch your eye\?/);
  assert.match(text, /# Incoming message\n"refund what I paid yesterday"/);
});

test("an empty skill index says there are no skills yet", async () => {
  const model = scriptedModel([[functionCall("submitTriage", DECISION)]]);
  await triage(input, { create: model.create, model: "triage-model" });
  assert.match(model.requests[0].instructions as string, /# Skill index\n\nNo skills yet\./);
});

test("an invalid decision goes back to the model once", async () => {
  const model = scriptedModel([
    [functionCall("submitTriage", { ...DECISION, escalate: "yes" })],
    [functionCall("submitTriage", DECISION)],
  ]);
  const { decision, trace } = await triage(input, { create: model.create, model: "triage-model" });
  assert.deepEqual(decision, DECISION);
  assert.equal(trace.modelCalls.length, 2);
  const outputs = (model.requests[1].input as ResponseInputItem[]).filter(
    (item) => "type" in item && item.type === "function_call_output",
  );
  assert.match((outputs[0] as { output: string }).output, /does not match/);
});

test("a second invalid decision fails with the partial trace", async () => {
  const bad = [functionCall("submitTriage", { escalate: "yes" })];
  const model = scriptedModel([bad, bad]);
  await assert.rejects(triage(input, { create: model.create, model: "triage-model" }), (error: unknown) => {
    assert.ok(error instanceof ResponderError);
    assert.equal(error.trace.modelCalls.length, 2);
    return true;
  });
});

test("traces the triage input, output and model calls", async () => {
  const model = scriptedModel([[functionCall("submitTriage", DECISION)]]);
  const { trace } = await triage(input, { create: model.create, model: "triage-model" });
  assert.match(trace.system, /# Escalation policy/);
  assert.match(trace.userMessage, /refund what I paid yesterday/);
  assert.deepEqual(trace.output, DECISION);
  assert.equal(trace.modelCalls[0].step, "triage");
  assert.equal(trace.modelCalls[0].usage?.input_tokens, 100);
});
