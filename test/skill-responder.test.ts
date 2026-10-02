import { test } from "node:test";
import assert from "node:assert/strict";
import type { ResponseCreateParamsNonStreaming, ResponseInputItem } from "openai/resources/responses/responses";
import { respondWithSkills } from "../src/skill-responder.ts";
import { loadSkillRegistry, statusModule } from "../src/skills.ts";
import { escalationReply } from "../src/escalation.ts";
import { PACKET_CONTEXT as context } from "../src/patient-context.ts";
import { VALID_REPLY, firstUserText, functionCall, scriptedModel, toolNames, type FakeFunctionCall } from "./fakes.ts";

const registry = loadSkillRegistry();
const HEVA = "11111111-1111-4111-8111-111111111111";

function run(chosen: string[], turns: FakeFunctionCall[][], message = "I'm leaning toward Heva") {
  const model = scriptedModel(turns);
  const status = statusModule(context.PIPELINE_STATUS);
  const result = respondWithSkills(message, { registry, chosen, patient: context, status }, { create: model.create, model: "responder-model" });
  return { model, result };
}

function lastOutput(request: ResponseCreateParamsNonStreaming): string {
  const outputs = (request.input as ResponseInputItem[]).filter(
    (item): item is ResponseInputItem.FunctionCallOutput => "type" in item && item.type === "function_call_output",
  );
  return outputs.at(-1)!.output as string;
}

test("the system prompt is the core, the Pipeline Status module, then the chosen skills with what they require", async () => {
  const { model, result } = run(["decision-funnel"], [[functionCall("submitReply", VALID_REPLY)]]);
  await result;
  const system = model.requests[0].instructions as string;
  const order = ["# IDENTITY", "# PIPELINE STATUS: PRE_CLINICAL_SENT", "# SKILL: clinic-packages", "# SKILL: decision-funnel"].map(
    (heading) => system.indexOf(heading),
  );
  assert.ok(order.every((position, index) => position >= 0 && (index === 0 || position > order[index - 1])), String(order));
  assert.doesNotMatch(system, /# SKILL: payments/);
  assert.match(firstUserText(model.requests[0]), /"I'm leaning toward Heva"/);
});

test("the responder sees only the loaded skills' tools, plus loadSkill, escalate and submitReply", async () => {
  const { model, result } = run(["decision-funnel"], [[functionCall("submitReply", VALID_REPLY)]]);
  await result;
  assert.deepEqual(toolNames(model.requests[0]).sort(), [
    "escalate",
    "getAllClinicsTool",
    "getClinicDoctorsTool",
    "getClinicPackagesTool",
    "getLatestAssessmentTool",
    "getPatientContextTool",
    "getPaymentLinkTool",
    "getSavedClinicsTool",
    "issuePromoCodeTool",
    "loadSkill",
    "submitReply",
    "updateUserClinicPreferencesTool",
  ]);
});

test("with no skills chosen, only loadSkill, escalate and submitReply are offered", async () => {
  const { model, result } = run([], [[functionCall("submitReply", VALID_REPLY)]]);
  await result;
  assert.deepEqual(toolNames(model.requests[0]).sort(), ["escalate", "loadSkill", "submitReply"]);
});

test("loadSkill returns the skill's text and adds its tools to the next request", async () => {
  const { model, result } = run(
    ["clinic-packages"],
    [[functionCall("loadSkill", { id: "payments" })], [functionCall("submitReply", VALID_REPLY)]],
  );
  const { trace } = await result;
  assert.match(lastOutput(model.requests[1]), /# SKILL: payments\n[\s\S]*FINANCING GEOGRAPHY/);
  assert.ok(!toolNames(model.requests[0]).includes("issuePromoCodeTool"));
  assert.ok(toolNames(model.requests[1]).includes("issuePromoCodeTool"));
  assert.deepEqual(trace.skills, { chosen: ["clinic-packages"], loaded: ["payments"] });
});

test("loadSkill brings in what the skill requires, and nothing already loaded", async () => {
  const { model, result } = run([], [[functionCall("loadSkill", { id: "decision-funnel" })], [functionCall("submitReply", VALID_REPLY)]]);
  const { trace } = await result;
  const output = lastOutput(model.requests[1]);
  assert.ok(output.indexOf("# SKILL: clinic-packages") < output.indexOf("# SKILL: decision-funnel"));
  assert.deepEqual(trace.skills.loaded, ["clinic-packages", "decision-funnel"]);
});

test("loadSkill for an unknown or loaded skill says so", async () => {
  const { model, result } = run(
    ["payments"],
    [
      [functionCall("loadSkill", { id: "travel" })],
      [functionCall("loadSkill", { id: "payments" })],
      [functionCall("submitReply", VALID_REPLY)],
    ],
  );
  const { trace } = await result;
  assert.match(lastOutput(model.requests[1]), /No skill named travel/);
  assert.match(lastOutput(model.requests[2]), /already loaded/);
  assert.equal(trace.toolCalls[0].isError, true);
});

test("escalate mid-turn returns the Escalation template Reply", async () => {
  const { result } = run(["payments"], [[functionCall("escalate", { reason: "Patient wants a refund", cannotDo: "refund a payment" })]]);
  const { reply, trace } = await result;
  assert.deepEqual(reply, escalationReply("Patient wants a refund", "refund a payment"));
  assert.equal(trace.toolCalls[0].name, "escalate");
});

test("code owns templateId, escalate and escalationReason on a submitted Reply", async () => {
  const { result } = run(
    [],
    [[functionCall("submitReply", { ...VALID_REPLY, templateId: "tpl", escalate: true, escalationReason: "why" })]],
  );
  const { reply } = await result;
  assert.equal(reply.templateId, null);
  assert.equal(reply.escalate, false);
  assert.equal(reply.escalationReason, null);
});

test("write tools run and are traced with their arguments and results", async () => {
  const { result } = run(
    ["decision-funnel"],
    [
      [functionCall("updateUserClinicPreferencesTool", { clinicSelection: { selectedClinicId: HEVA } })],
      [functionCall("submitReply", VALID_REPLY)],
    ],
  );
  const { trace } = await result;
  assert.equal(trace.toolCalls[0].name, "updateUserClinicPreferencesTool");
  assert.deepEqual(trace.toolCalls[0].input, { clinicSelection: { selectedClinicId: HEVA } });
  assert.equal((trace.toolCalls[0].output as { updated: boolean }).updated, true);
});

test("a tool outside the loaded skills is refused, and working memory is never a tool", async () => {
  const { model, result } = run(
    ["clinic-packages"],
    [
      [functionCall("getPatientImagesTool", {})],
      [functionCall("updateWorkingMemory", { memory: {} })],
      [functionCall("submitReply", VALID_REPLY)],
    ],
  );
  const { trace } = await result;
  assert.match(lastOutput(model.requests[1]), /getPatientImagesTool isn't available/);
  assert.match(lastOutput(model.requests[2]), /updateWorkingMemory isn't available/);
  assert.deepEqual(trace.toolCalls.map((call) => call.isError), [true, true]);
  for (const request of model.requests) assert.ok(!toolNames(request).includes("updateWorkingMemory"));
});
