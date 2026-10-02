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

test("a message that doesn't escalate goes to the baseline responder", async () => {
  const model = scriptedModel([[functionCall("submitTriage", triageDecision())], [functionCall("submitReply", VALID_REPLY)]]);
  const { reply, trace } = await respond("What does Dr. Hakan Clinic cost?", "default", options(model.create));
  assert.deepEqual(reply, VALID_REPLY);
  assert.equal(model.requests[1].model, "responder-model");
  assert.match(model.requests[1].instructions as string, /^# IDENTITY/);
  const pipelineTrace = trace as PipelineTrace;
  assert.equal(pipelineTrace.path, "baseline");
  assert.deepEqual(pipelineTrace.modelCalls.map((call) => call.step), ["triage", "responder"]);
  assert.match(pipelineTrace.responder!.userMessage, /What does Dr\. Hakan Clinic cost\?/);
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
