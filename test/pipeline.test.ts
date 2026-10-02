import { test } from "node:test";
import assert from "node:assert/strict";
import { respond, type PipelineTrace } from "../src/pipeline.ts";
import { DraftingError, type CreateResponse } from "../src/model-calls.ts";
import { SetupError } from "../src/errors.ts";
import { VALID_REPLY, firstUserText, functionCall, scriptedModel, triageDecision } from "./fakes.ts";

const noModel: CreateResponse = async () => {
  throw new Error("no model call expected");
};

function options(create: CreateResponse) {
  return { create, responderModel: "responder-model", triageModel: "triage-model" };
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
  const instructions = model.requests[0].instructions as string;
  for (const id of ["clinic-packages", "decision-funnel", "payments"]) assert.match(instructions, new RegExp(`- ${id}: `));
});

test("a message that doesn't escalate is answered with the skills triage chose", async () => {
  const model = scriptedModel([
    [functionCall("submitTriage", triageDecision({ skills: ["clinic-packages"] }))],
    [functionCall("submitReply", VALID_REPLY)],
  ]);
  const { reply, trace } = await respond("What does Dr. Hakan Clinic cost?", "default", options(model.create));
  assert.deepEqual(reply, VALID_REPLY);
  assert.equal(model.requests[1].model, "responder-model");
  const system = model.requests[1].instructions as string;
  assert.match(system, /# PIPELINE STATUS: PRE_CLINICAL_SENT/);
  assert.match(system, /# SKILL: clinic-packages/);
  const pipelineTrace = trace as PipelineTrace;
  assert.equal(pipelineTrace.path, "skills");
  assert.equal(pipelineTrace.fallback, null);
  assert.deepEqual(pipelineTrace.modelCalls.map((call) => call.step), ["triage", "responder"]);
  const responder = pipelineTrace.responder!;
  assert.ok("skills" in responder);
  assert.deepEqual(responder.skills, { chosen: ["clinic-packages"], loaded: [] });
});

test("with no skills chosen, the responder runs on the core and the Pipeline Status module", async () => {
  const model = scriptedModel([[functionCall("submitTriage", triageDecision())], [functionCall("submitReply", VALID_REPLY)]]);
  const { trace } = await respond("thanks!", "default", options(model.create));
  const system = model.requests[1].instructions as string;
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
  assert.match(model.requests[1].instructions as string, /^# IDENTITY\nYou are a patient concierge/);
  const pipelineTrace = trace as PipelineTrace;
  assert.equal(pipelineTrace.path, "baseline");
  assert.equal(pipelineTrace.fallback, "baseline");
  assert.match(pipelineTrace.fallbackReason!, /other/);
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
  assert.match(model.requests[0].instructions as string, /^# IDENTITY/);
});
