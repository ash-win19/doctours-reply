import { test } from "node:test";
import assert from "node:assert/strict";
import { respond, type PipelineTrace } from "../src/pipeline.ts";
import { DraftingError, tokenUsage, type CreateResponse } from "../src/model-calls.ts";
import { SetupError } from "../src/errors.ts";
import { loadSkillRegistry } from "../src/skills.ts";
import { PACKET_CONTEXT, loadContext } from "../src/patient-context.ts";
import { VALID_REPLY, firstUserText, systemText, functionCall, scriptedModel, triageDecision } from "./fakes.ts";

const noModel: CreateResponse = async () => {
  throw new Error("no model call expected");
};

function options(create: CreateResponse) {
  return { create, responderModel: "responder-model", triageModel: "triage-model", context: PACKET_CONTEXT };
}

test("card details escalate without a model call, and the digits never reach the trace", async () => {
  const { reply, trace } = await respond("Charge the deposit on my card ending in 4242 right now.", "default", options(noModel));
  assert.equal(reply.escalate, true);
  assert.equal(reply.response, "I can't take card details. I'm getting a person for you.");
  assert.equal(reply.escalationReason, "Patient shared card details");
  const pipelineTrace = trace as PipelineTrace;
  assert.equal(pipelineTrace.path, "guard-escalation");
  assert.deepEqual(pipelineTrace.guards, { cardNumberFound: true, humanRequested: false });
  assert.deepEqual(pipelineTrace.modelCalls, []);
  assert.doesNotMatch(JSON.stringify({ reply, trace }), /4242/);
});

test("an explicit request for a person escalates without a model call", async () => {
  const { reply, trace } = await respond("I demand to talk to a human", "default", options(noModel));
  assert.equal(reply.response, "I'm getting a person for you.");
  assert.equal(reply.escalationReason, "Patient asked for a person");
  assert.equal((trace as PipelineTrace).path, "guard-escalation");
});

test("negations and contextual person mentions reach triage and can receive an answer", async () => {
  for (const text of [
    "I do not want to talk to a human. What does Hakan cost?",
    "My bank representative says Klarna works in Canada. Is that right?",
  ]) {
    const model = scriptedModel([
      [functionCall("submitTriage", triageDecision({ skills: ["clinic-packages"] }))],
      [functionCall("submitReply", VALID_REPLY)],
    ]);
    const { reply, trace } = await respond(text, "default", options(model.create));
    assert.equal(reply.escalate, false, text);
    assert.equal((trace as PipelineTrace).path, "skills");
    assert.ok(firstUserText(model.requests[0]).includes(text));
    assert.deepEqual(trace.modelCalls.map((call) => call.step), ["triage", "responder"]);
  }
});

test("triage sees the message, the state card and the last four turns", async () => {
  const model = scriptedModel([[functionCall("submitTriage", triageDecision({ escalate: true }))]]);
  await respond("refund what I paid yesterday", "default", options(model.create));
  const [request] = model.requests;
  assert.equal(request.model, "triage-model");
  const text = firstUserText(request);
  assert.match(text, /Pipeline Status: PRE_CLINICAL_SENT/);
  assert.match(text, /Jordan Hale: Any update\?\nAlex: Your assessment is ready/);
  assert.match(text, /"refund what I paid yesterday"/);
});

test("when triage escalates, the Reply is the template with what we can't do", async () => {
  const model = scriptedModel([
    [
      functionCall("submitTriage", {
        escalate: true,
        escalationReason: "Patient wants a refund",
        cannotDo: "refund a payment",
        skills: [],
        intent: "refund",
      }),
    ],
  ]);
  const { reply, trace } = await respond("refund what I paid yesterday", "default", options(model.create));
  assert.equal(reply.response, "I can't refund a payment. I'm getting a person for you.");
  assert.equal(reply.escalationReason, "Patient wants a refund");
  assert.deepEqual(reply.workingMemoryUpdates, { escalationFlags: "Patient wants a refund" });
  const pipelineTrace = trace as PipelineTrace;
  assert.equal(pipelineTrace.path, "triage-escalation");
  assert.equal((pipelineTrace.triage?.output as { cannotDo: string }).cannotDo, "refund a payment");
  assert.deepEqual(pipelineTrace.modelCalls.map((call) => call.step), ["triage"]);
  assert.equal(pipelineTrace.responder, null);
});

test("triage sees every skill's id and description", async () => {
  const model = scriptedModel([[functionCall("submitTriage", triageDecision({ escalate: true }))]]);
  await respond("What does Heva cost?", "default", options(model.create));
  const instructions = systemText(model.requests[0]);
  for (const { id } of loadSkillRegistry().index()) assert.match(instructions, new RegExp(`- ${id}: `));
});

test("a message that doesn't escalate is answered with the skills triage chose", async () => {
  const model = scriptedModel([
    [functionCall("submitTriage", triageDecision({ skills: ["clinic-packages"] }))],
    [functionCall("submitReply", VALID_REPLY)],
  ]);
  const { reply, trace } = await respond("What does Dr. Hakan Clinic cost?", "default", options(model.create));
  assert.deepEqual(reply, VALID_REPLY);
  assert.equal(model.requests[1].model, "responder-model");
  const system = systemText(model.requests[1]);
  assert.match(system, /# PIPELINE STATUS: PRE_CLINICAL_SENT/);
  assert.match(system, /# SKILL: clinic-packages/);
  const pipelineTrace = trace as PipelineTrace;
  assert.equal(pipelineTrace.path, "skills");
  assert.equal(pipelineTrace.fallback, null);
  assert.deepEqual(pipelineTrace.modelCalls.map((call) => call.step), ["triage", "responder"]);
  const responder = pipelineTrace.responder!;
  assert.ok("skills" in responder);
  assert.deepEqual(responder.skills, { chosen: ["clinic-packages"], loaded: [], resolved: ["clinic-packages"] });
});

test("with no skills chosen, the responder runs on the core and the Pipeline Status module", async () => {
  const model = scriptedModel([[functionCall("submitTriage", triageDecision())], [functionCall("submitReply", VALID_REPLY)]]);
  const { trace } = await respond("thanks!", "default", options(model.create));
  const system = systemText(model.requests[1]);
  assert.match(system, /# PIPELINE STATUS: PRE_CLINICAL_SENT/);
  assert.doesNotMatch(system, /# SKILL:/);
  assert.equal((trace as PipelineTrace).path, "skills");
});

test("a skill that doesn't exist yet sends the message to the baseline responder", async () => {
  const model = scriptedModel([
    [functionCall("submitTriage", triageDecision({ skills: ["clinic-packages", "other"] }))],
    [functionCall("submitReply", VALID_REPLY)],
  ]);
  const { reply, trace } = await respond("Is the consultation free?", "default", options(model.create));
  assert.deepEqual(reply, VALID_REPLY);
  assert.match(systemText(model.requests[1]), /^# IDENTITY\nYou are a patient concierge/);
  const pipelineTrace = trace as PipelineTrace;
  assert.equal(pipelineTrace.path, "baseline");
  assert.equal(pipelineTrace.fallback?.to, "baseline");
  assert.match(pipelineTrace.fallback!.reason, /other/);
});

test("tool calls sit at the top of the trace whichever responder ran", async () => {
  const model = scriptedModel([
    [functionCall("submitTriage", triageDecision({ skills: ["clinic-packages"] }))],
    [functionCall("getClinicPackagesTool", { clinicName: "Heva" })],
    [functionCall("submitReply", VALID_REPLY)],
  ]);
  const { trace } = await respond("What does Heva cost?", "default", options(model.create));
  assert.deepEqual(trace.toolCalls?.map((call) => call.name), ["getClinicPackagesTool"]);
});

test("a failed model call fails with the trace so far", async () => {
  const create: CreateResponse = async () => {
    throw new Error("API down");
  };
  await assert.rejects(respond("What does Heva cost?", "default", options(create)), (error: unknown) => {
    assert.ok(error instanceof DraftingError);
    assert.match(error.message, /API down/);
    const trace = error.trace as PipelineTrace;
    assert.deepEqual(trace.guards, { cardNumberFound: false, humanRequested: false });
    assert.equal(trace.path, "drafting-failed");
    assert.match(trace.triage!.userMessage, /"What does Heva cost\?"/);
    return true;
  });
});

test("a setup error stops the run instead of escalating", async () => {
  const create: CreateResponse = async () => {
    throw new SetupError("bad key");
  };
  await assert.rejects(respond("What does Heva cost?", "default", options(create)), SetupError);
});

test("baseline mode skips guards and triage", async () => {
  const model = scriptedModel([[functionCall("submitReply", VALID_REPLY)]]);
  const { reply } = await respond("I demand to talk to a human", "baseline", options(model.create));
  assert.deepEqual(reply, VALID_REPLY);
  assert.equal(model.requests.length, 1);
  assert.match(systemText(model.requests[0]), /^# IDENTITY/);
});

const leadPatient = loadContext("evals/contexts/lead.json");

test("a swapped context reaches triage, the core prompt, the Pipeline Status module and the tools", async () => {
  const model = scriptedModel([
    [functionCall("submitTriage", triageDecision({ skills: ["intake-photos"] }))],
    [functionCall("getPatientImagesTool", {})],
    [functionCall("submitReply", VALID_REPLY)],
  ]);
  const { trace } = await respond("done", "default", { ...options(model.create), context: leadPatient });
  assert.match(firstUserText(model.requests[0]), /Pipeline Status: LEAD/);
  assert.match(firstUserText(model.requests[0]), /Intake items: area MISSING; name MISSING; photos MISSING/);
  const system = systemText(model.requests[1]);
  assert.match(system, /# PIPELINE STATUS: LEAD/);
  assert.match(system, /## Recent conversation\nNo messages yet\./);
  assert.match(firstUserText(model.requests[1]), /Triggering sender: \+15555550199/);
  assert.equal((trace.toolCalls![0].output as { hasImages: boolean }).hasImages, false);
});

test("an unknown Pipeline Status is answered reactively with skills, not by the baseline", async () => {
  const model = scriptedModel([[functionCall("submitTriage", triageDecision())], [functionCall("submitReply", VALID_REPLY)]]);
  const { trace } = await respond("thanks", "default", {
    ...options(model.create),
    context: { ...PACKET_CONTEXT, PIPELINE_STATUS: "SOMETHING_NEW" },
  });
  assert.equal((trace as PipelineTrace).path, "skills");
  assert.match(systemText(model.requests[1]), /answer reactively/);
});

test("baseline mode fills the original prompt and tools from a swapped context", async () => {
  const model = scriptedModel([[functionCall("getPatientImagesTool", {})], [functionCall("submitReply", VALID_REPLY)]]);
  const { trace } = await respond("done", "baseline", { ...options(model.create), context: leadPatient });
  assert.ok((systemText(model.requests[0])).includes(leadPatient.PATIENT_SUMMARY));
  assert.equal((trace.toolCalls![0].output as { hasImages: boolean }).hasImages, false);
});

const FABRICATED = { ...VALID_REPLY, response: "Pay using the link below.\nhttps://www.doctours.com/payment/made-up" };

test("in the default mode, a Reply from the baseline fallback is validated too", async () => {
  const model = scriptedModel([
    [functionCall("submitTriage", triageDecision({ skills: ["other"] }))],
    [functionCall("submitReply", FABRICATED)],
    [functionCall("submitReply", FABRICATED)],
  ]);
  const { reply, trace } = await respond("How do I pay?", "default", options(model.create));
  assert.equal(reply.response, "Pay using the link below.");
  assert.equal((trace as PipelineTrace).responder!.validation!.runs.length, 2);
});

test("baseline mode stays the untouched before, with no validator", async () => {
  const model = scriptedModel([[functionCall("submitReply", FABRICATED)]]);
  const { reply, trace } = await respond("How do I pay?", "baseline", options(model.create));
  assert.equal(reply.response, FABRICATED.response);
  assert.equal((trace as { validation?: unknown }).validation, undefined);
});

test("a card-like run with an invalid checksum escalates before any model call", async () => {
  const message = "my card number is 4111 1111 1111 1112, can you check it?";
  const { reply, trace } = await respond(message, "default", options(noModel));
  assert.equal(reply.escalate, true);
  assert.equal((trace as PipelineTrace).path, "guard-escalation");
  assert.doesNotMatch(JSON.stringify({ reply, trace }), /4111|1112/);
});

test("an Escalation from the baseline fallback uses the same template and fields as triage", async () => {
  const escalation = { ...VALID_REPLY, escalate: true, escalationReason: "refund", response: "I'm getting a person for you. Silver is $9." };
  const model = scriptedModel([
    [functionCall("submitTriage", triageDecision({ skills: ["other"] }))],
    [functionCall("submitReply", escalation)],
  ]);
  const { reply, trace } = await respond("refund me", "default", options(model.create));
  assert.equal(reply.escalate, true);
  assert.equal(reply.response, "I'm getting a person for you.");
  assert.equal(reply.intent, "escalate to a person");
  assert.deepEqual(reply.workingMemoryUpdates, { escalationFlags: "refund" });
  assert.equal(model.requests.length, 2);
  assert.deepEqual((trace as PipelineTrace).responder!.validation!.runs, []);
});

test("default mode redacts historical card text and tool overrides without changing the source context", async () => {
  for (const skills of [["clinic-packages"], ["other"]]) {
    const model = scriptedModel([
      [functionCall("submitTriage", triageDecision({ skills }))],
      [functionCall("getClinicPackagesTool", { clinicId: "test-clinic" })],
      [functionCall("submitReply", VALID_REPLY)],
    ]);
    const oldText = "Earlier I sent 4111 1111 1111 1112 and card ending in 4242";
    const context = {
      ...PACKET_CONTEXT,
      CHAT_LIST: oldText,
      RECENT_MEDIA_CONVERSATION: [{ role: "user", sender: "Patient", text: oldText }],
      toolOverrides: { getClinicPackagesTool: { note: oldText } },
    };
    const { trace } = await respond("What does the package include?", "default", { ...options(model.create), context });
    assert.doesNotMatch(JSON.stringify({ trace, requests: model.requests }), /4111|1112|4242/);
    assert.match(JSON.stringify(trace), /\[card number\]/);
    assert.equal(context.CHAT_LIST, oldText);
  }
});

test("a repair can't change escalate, so the first version ships when it tries", async () => {
  const invented = { ...VALID_REPLY, response: "Silver is $9." };
  const flipped = { ...VALID_REPLY, escalate: true, escalationReason: "why", response: "I'm getting a person for you." };
  const model = scriptedModel([
    [functionCall("submitTriage", triageDecision({ skills: ["other"] }))],
    [functionCall("submitReply", invented)],
    [functionCall("submitReply", flipped)],
  ]);
  const { reply, trace } = await respond("How much?", "default", options(model.create));
  assert.equal(reply.escalate, false);
  assert.equal(reply.response, "Silver is $9.");
  assert.equal((trace as PipelineTrace).responder!.validation!.shipped, "first");
});

test("the call-history subagent runs on the triage model, nested under the message's trace", async () => {
  const model = scriptedModel([
    [functionCall("submitTriage", triageDecision({ skills: ["call-history"] }))],
    [functionCall("askCallHistory", { question: "What did we talk about on the call?" })],
    [functionCall("submitAnswer", { answer: "Your hairline and your 4C curls.", callIds: ["66666666-6666-4666-8666-666666666666"] })],
    [functionCall("submitReply", VALID_REPLY)],
  ]);
  const { trace } = await respond("what did we talk about on the call?", "default", options(model.create));
  assert.equal(model.requests[2].model, "triage-model");
  const pipelineTrace = trace as PipelineTrace;
  assert.deepEqual(pipelineTrace.modelCalls.map((call) => call.step), ["triage", "responder", "callHistory", "responder"]);
  const responder = pipelineTrace.responder!;
  assert.ok("subagents" in responder);
  assert.equal(responder.subagents[0].subagent, "callHistory");
  assert.deepEqual(tokenUsage(trace), { inputTokens: 400, outputTokens: 200 });
});
