import { test } from "node:test";
import assert from "node:assert/strict";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import { respondWithSkills, type SkillResponderTrace } from "../src/skill-responder.ts";
import { DraftingError } from "../src/model-calls.ts";
import { loadSkillRegistry, statusModule } from "../src/skills.ts";
import { escalationReply } from "../src/escalation.ts";
import { PACKET_CONTEXT as context } from "../src/patient-context.ts";
import { getPatientImages } from "../src/packet-tools.ts";
import {
  VALID_REPLY,
  firstUserText, systemText,
  functionCall,
  functionOutputs,
  inputItems,
  scriptedModel,
  toolNames,
  type FakeFunctionCall,
} from "./fakes.ts";

const registry = loadSkillRegistry();
const HEVA = "11111111-1111-4111-8111-111111111111";

function run(chosen: string[], turns: FakeFunctionCall[][], message = "I'm leaning toward Heva") {
  const model = scriptedModel(turns);
  const status = statusModule(context.PIPELINE_STATUS);
  const result = respondWithSkills(message, { registry, chosen, patient: context, status }, { create: model.create, model: "responder-model" });
  return { model, result };
}

function lastOutput(request: ResponseCreateParamsNonStreaming): string {
  return functionOutputs(request).at(-1)!.output as string;
}

test("the system prompt is the core, the Pipeline Status module, then the chosen skills with what they require", async () => {
  const { model, result } = run(["decision-funnel"], [[functionCall("submitReply", VALID_REPLY)]]);
  await result;
  const system = systemText(model.requests[0]);
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
  assert.deepEqual(trace.skills, { chosen: ["clinic-packages"], loaded: ["payments"], resolved: ["clinic-packages"] });
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
      [functionCall("loadSkill", { id: "ghost" })],
      [functionCall("loadSkill", { id: "payments" })],
      [functionCall("submitReply", VALID_REPLY)],
    ],
  );
  const { trace } = await result;
  assert.match(lastOutput(model.requests[1]), /No skill named ghost/);
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

test("a fabricated payment link never ships, and its removal asks for a repair", async () => {
  const fabricated = { ...VALID_REPLY, response: "Pay the Silver deposit using the link below.\nhttps://www.doctours.com/payment/silver" };
  const { model, result } = run(["decision-funnel"], [[functionCall("submitReply", fabricated)], [functionCall("submitReply", fabricated)]]);
  const { reply, trace } = await result;
  assert.equal(reply.response, "Pay the Silver deposit using the link below.");
  assert.deepEqual(trace.validation.runs[0].fixes, ["removed https://www.doctours.com/payment/silver, which no tool returned, and its line"]);
  assert.match(
    (inputItems(model.requests[1]).at(-1) as { content: string }).content,
    /Removed https:\/\/www\.doctours\.com\/payment\/silver: no tool returned it this turn\. If the Patient needs it, call the tool that returns it\./,
  );
  assert.equal(trace.validation.repairRan, true);
});

test("the repair turn can call the tool that returns a link, so the link ships", async () => {
  const assessmentUrl = "https://www.doctours.com/assessment/c3d4e5f6-3333-4333-8333-333333333333";
  const copied = { ...VALID_REPLY, response: `You can book from your assessment using the link below.\n${assessmentUrl}` };
  const { result } = run(
    ["decision-funnel"],
    [
      [functionCall("submitReply", copied)],
      [functionCall("getLatestAssessmentTool", {})],
      [functionCall("submitReply", copied)],
    ],
  );
  const { reply, trace } = await result;
  assert.equal(reply.response, copied.response);
  assert.equal(trace.validation.shipped, "repaired");
});

test("a second submitReply in the same response doesn't count as the repair", async () => {
  const invented = { ...VALID_REPLY, response: "Silver is $2,999." };
  const alsoInvented = { ...VALID_REPLY, response: "Silver is $2,998." };
  const repaired = { ...VALID_REPLY, response: "Silver is $3,000." };
  const { model, result } = run(
    ["clinic-packages"],
    [
      [functionCall("getClinicPackagesTool", { clinicName: "Heva" })],
      [functionCall("submitReply", invented), functionCall("submitReply", alsoInvented)],
      [functionCall("submitReply", repaired)],
    ],
  );
  const { reply, trace } = await result;
  assert.equal(reply.response, "Silver is $3,000.");
  assert.equal(trace.validation.runs.length, 2);
  const outputs = functionOutputs(model.requests[2]).slice(-2).map((output) => output.output as string);
  assert.ok(outputs.every((output) => /not sent/i.test(output)), String(outputs));
  assert.match((inputItems(model.requests[2]).at(-1) as { content: string }).content, /\$2,999/);
});

test("a link a tool returned this turn ships", async () => {
  const url = "https://www.doctours.com/payment/44444444-4444-4444-8444-444444444441";
  const { result } = run(
    ["decision-funnel"],
    [
      [functionCall("getPaymentLinkTool", { type: "payment", clinicPackageId: "44444444-4444-4444-8444-444444444441" })],
      [functionCall("submitReply", { ...VALID_REPLY, response: `Here's your Silver payment link.\n${url}` })],
    ],
  );
  const { reply } = await result;
  assert.equal(reply.response, `Here's your Silver payment link.\n${url}`);
});

test("a failing check gets one repair turn that lists the failures, and the repaired Reply ships", async () => {
  const invented = { ...VALID_REPLY, response: "Silver is $2,999." };
  const repaired = { ...VALID_REPLY, response: "Silver is $3,000." };
  const { model, result } = run(
    ["clinic-packages"],
    [
      [functionCall("getClinicPackagesTool", { clinicName: "Heva" })],
      [functionCall("submitReply", invented)],
      [functionCall("submitReply", repaired)],
    ],
  );
  const { reply, trace } = await result;
  assert.equal(reply.response, "Silver is $3,000.");
  const repairTurn = inputItems(model.requests[2]).at(-1) as { role: string; content: string };
  assert.equal(repairTurn.role, "user");
  assert.match(repairTurn.content, /\$2,999 isn't in this turn's tool results/);
  assert.equal(model.requests[2].tool_choice, "required");
  assert.equal(trace.validation.repairRan, true);
  assert.equal(trace.validation.shipped, "repaired");
  assert.deepEqual(
    trace.validation.runs.map((run) => run.checks.filter((check) => !check.ok).map((check) => check.name)),
    [["amounts"], []],
  );
});

test("after the repair, the version with fewer failures ships, and there is never a second repair", async () => {
  const oneFailure = { ...VALID_REPLY, response: "Silver is $2,999." };
  const twoFailures = { ...VALID_REPLY, response: "Silver is $2,999. I'll get back to you on Gold." };
  const { model, result } = run([], [[functionCall("submitReply", oneFailure)], [functionCall("submitReply", twoFailures)]]);
  const { reply, trace } = await result;
  assert.equal(reply.response, "Silver is $2,999.");
  assert.equal(trace.validation.shipped, "first");
  assert.equal(model.requests.length, 2);
});

test("a repair that doesn't come back as a valid Reply ships the first version", async () => {
  const invented = { ...VALID_REPLY, response: "Silver is $2,999." };
  const { result } = run([], [[functionCall("submitReply", invented)], [functionCall("submitReply", { response: 42 })]]);
  const { reply } = await result;
  assert.equal(reply.response, "Silver is $2,999.");
});

test("repeated invalid attachments never ship, even when both drafts violate the limit", async () => {
  const images = getPatientImages({});
  const urls = Object.values(images.angles).flatMap((angle) => angle.urls).slice(0, 4);
  assert.equal(urls.length, 4);
  const draft = { ...VALID_REPLY, response: "Here are your photos.", attachmentUrls: ["https://made.up/photo.jpg", ...urls] };
  const { result } = run(["intake-photos"], [
    [functionCall("getPatientImagesTool", {})],
    [functionCall("submitReply", draft)],
    [functionCall("submitReply", draft)],
  ]);
  const { reply, trace } = await result;
  assert.deepEqual(reply.attachmentUrls, urls.slice(0, 3));
  assert.equal(trace.validation.repairRan, true);
  assert.equal(trace.validation.runs.length, 2);
});

test("an unsuccessful attachment repair can only ship the sanitized first draft", async () => {
  const draft = { ...VALID_REPLY, attachmentUrls: ["https://made.up/photo.jpg"] };
  const repairs: FakeFunctionCall[][][] = [
    [[functionCall("submitReply", { response: 42 })]],
    [[functionCall("escalate", { reason: "Cannot repair", cannotDo: null })]],
    [[]],
    Array.from({ length: 3 }, () => [functionCall("loadSkill", { id: "unknown-skill" })]),
  ];
  for (const repair of repairs) {
    const { result } = run([], [[functionCall("submitReply", draft)], ...repair]);
    const { reply } = await result;
    assert.equal(reply.attachmentUrls, null);
    assert.equal(reply.escalate, false);
  }
});

test("attachment repair can fetch evidence and return grounded photos", async () => {
  const url = getPatientImages({}).angles.front.urls[0];
  const draft = { ...VALID_REPLY, response: "Here is your photo.", attachmentUrls: [url] };
  const { result } = run(["intake-photos"], [
    [functionCall("submitReply", draft)],
    [functionCall("getPatientImagesTool", {})],
    [functionCall("submitReply", draft)],
  ]);
  const { reply, trace } = await result;
  assert.deepEqual(reply.attachmentUrls, [url]);
  assert.equal(trace.validation.shipped, "repaired");
  assert.ok(trace.validation.runs[0].fixes.some((fix) => fix.includes("attachmentUrls")));
  assert.deepEqual(trace.validation.runs[1].fixes, []);
});

test("an Escalation from the escalate tool skips the validator", async () => {
  const { result } = run(["payments"], [[functionCall("escalate", { reason: "Refund", cannotDo: "refund a payment" })]]);
  const { reply, trace } = await result;
  assert.equal(reply.response, "I can't refund a payment. I'm getting a person for you.");
  assert.deepEqual(trace.validation.runs, []);
});

test("an escalate tool call cannot change the decision during repair, even in the initial batch", async () => {
  const first = { ...VALID_REPLY, response: "Silver is $9." };
  const submit = functionCall("submitReply", first);
  const escalate = functionCall("escalate", { reason: "Cannot repair", cannotDo: null });
  for (const turns of [[[submit], [escalate]], [[submit, escalate]]]) {
    const { result } = run([], turns);
    const { reply, trace } = await result;
    assert.equal(reply.escalate, false);
    assert.equal(reply.response, first.response);
    assert.equal(trace.validation.shipped, "first");
    assert.equal(trace.toolCalls.at(-1)?.isError, true);
  }
});

const CALL_ANSWER = { answer: "You said your hair is 4C.", callIds: ["66666666-6666-4666-8666-666666666666"] };

function runWithSubagent(chosen: string[], turns: FakeFunctionCall[][]) {
  const model = scriptedModel(turns);
  const status = statusModule(context.PIPELINE_STATUS);
  const result = respondWithSkills(
    "did I mention my hair type on the call?",
    { registry, chosen, patient: context, status, subagentModel: "subagent-model" },
    { create: model.create, model: "responder-model" },
  );
  return { model, result };
}

test("askCallHistory is offered only with the call-history skill", async () => {
  const withSkill = runWithSubagent(["call-history"], [[functionCall("submitReply", VALID_REPLY)]]);
  await withSkill.result;
  assert.ok(toolNames(withSkill.model.requests[0]).includes("askCallHistory"));
  const without = runWithSubagent(["clinic-packages"], [[functionCall("submitReply", VALID_REPLY)]]);
  await without.result;
  assert.ok(!toolNames(without.model.requests[0]).includes("askCallHistory"));
});

test("askCallHistory runs the subagent and the responder sees only its answer, never a transcript", async () => {
  const { model, result } = runWithSubagent(
    ["call-history"],
    [
      [functionCall("askCallHistory", { question: "Did they mention their hair type?" })],
      [functionCall("submitAnswer", CALL_ANSWER)],
      [functionCall("submitReply", VALID_REPLY)],
    ],
  );
  const { trace } = await result;
  assert.equal(model.requests[1].model, "subagent-model");
  assert.equal(lastOutput(model.requests[2]), "You said your hair is 4C.");
  for (const request of [model.requests[0], model.requests[2]]) {
    assert.doesNotMatch(JSON.stringify(request), /Thanks for hopping on/);
  }
  assert.deepEqual(trace.modelCalls.map((call) => call.step), ["responder", "callHistory", "responder"]);
  assert.equal(trace.subagents.length, 1);
  const [subagent] = trace.subagents;
  assert.equal(subagent.subagent, "callHistory");
  assert.equal(subagent.question, "Did they mention their hair type?");
  assert.equal(subagent.answer, "You said your hair is 4C.");
  assert.deepEqual(subagent.callIds, CALL_ANSWER.callIds);
  assert.deepEqual(subagent.usage, { inputTokens: 100, outputTokens: 50 });
  assert.equal(typeof subagent.latencyMs, "number");
});

test("loading the call-history skill mid-turn adds askCallHistory", async () => {
  const { model, result } = runWithSubagent(
    [],
    [[functionCall("loadSkill", { id: "call-history" })], [functionCall("submitReply", VALID_REPLY)]],
  );
  await result;
  assert.ok(!toolNames(model.requests[0]).includes("askCallHistory"));
  assert.ok(toolNames(model.requests[1]).includes("askCallHistory"));
});

test("a failed subagent fails the message, keeping the responder's trace and the subagent's calls", async () => {
  const bad = [functionCall("submitAnswer", { answer: 42 })];
  const { result } = runWithSubagent(
    ["call-history"],
    [[functionCall("askCallHistory", { question: "What did we talk about?" })], bad, bad],
  );
  await assert.rejects(result, (error: unknown) => {
    assert.ok(error instanceof DraftingError);
    assert.match(error.message, /askCallHistory/);
    const trace = error.trace as SkillResponderTrace;
    assert.match(trace.system, /# SKILL: call-history/);
    assert.deepEqual(trace.modelCalls.map((call) => call.step), ["responder", "callHistory", "callHistory"]);
    const [record] = trace.subagents;
    assert.equal(record.subagent, "callHistory");
    assert.equal(record.answer, null);
    assert.match(record.error!, /submitAnswer/);
    assert.deepEqual(record.usage, { inputTokens: 200, outputTokens: 100 });
    assert.equal(typeof record.latencyMs, "number");
    return true;
  });
});

test("askCallHistory without a question goes back to the responder as an error", async () => {
  const { model, result } = runWithSubagent(
    ["call-history"],
    [[functionCall("askCallHistory", {})], [functionCall("submitReply", VALID_REPLY)]],
  );
  const { trace } = await result;
  assert.match(lastOutput(model.requests[1]), /Invalid input for askCallHistory/);
  assert.equal(trace.toolCalls[0].isError, true);
  assert.deepEqual(trace.subagents, []);
});

test("an amount or URL in the call-history answer isn't evidence, so a Reply repeating it gets a repair turn", async () => {
  const answer = { answer: "We said Silver was $2,600, see https://heva.example/quote.", callIds: CALL_ANSWER.callIds };
  const repeated = { ...VALID_REPLY, response: "On the call we said Silver was $2,600." };
  const { model, result } = runWithSubagent(
    ["call-history"],
    [
      [functionCall("askCallHistory", { question: "What price did we discuss?" })],
      [functionCall("submitAnswer", answer)],
      [functionCall("submitReply", repeated)],
      [functionCall("submitReply", repeated)],
    ],
  );
  const { trace } = await result;
  assert.equal(trace.validation.repairRan, true);
  assert.match((inputItems(model.requests[3]).at(-1) as { content: string }).content, /\$2,600 isn't in this turn's tool results/);
});
