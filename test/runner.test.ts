import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResponseCreateParamsNonStreaming, ResponseInputItem } from "openai/resources/responses/responses";
import { runMessages, MAX_CONCURRENCY } from "../src/runner.ts";
import { SetupError } from "../src/errors.ts";
import { loadContext } from "../src/patient-context.ts";
import { ReplySchema } from "../src/reply.ts";
import type { CreateResponse } from "../src/model-calls.ts";
import { VALID_REPLY, modelResponse, functionCall, firstUserText, toolNames, triageDecision } from "./fakes.ts";

// The baseline user message carries the incoming text on its second line.
function incomingText(params: ResponseCreateParamsNonStreaming): string {
  return firstUserText(params).split("\n")[1];
}

// Answers each message by echoing its text back, after a delay that varies by message.
function echoModel(delayMs: (text: string) => number) {
  let inFlight = 0;
  let peak = 0;
  const create: CreateResponse = async (params) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    const text = incomingText(params);
    await new Promise((resolve) => setTimeout(resolve, delayMs(text)));
    inFlight -= 1;
    return modelResponse([functionCall("submitReply", { ...VALID_REPLY, response: text })]);
  };
  return { create, peak: () => peak };
}

function setup() {
  const traceRoot = mkdtempSync(join(tmpdir(), "traces-"));
  return { traceRoot, log: () => {}, triageModel: "fake-triage" };
}

const inputs = Array.from({ length: 10 }, (_, index) => ({ id: `m${index}`, text: `message ${index}` }));

test("returns one Reply per message, in input order", async () => {
  const model = echoModel((text) => 50 - Number(text.match(/\d+/)![0]) * 4);
  const { results } = await runMessages(inputs, "baseline", { ...setup(), create: model.create, responderModel: "fake" });
  const replies = results.map((result) => result.reply);
  assert.deepEqual(
    replies.map((reply) => reply.response),
    inputs.map((input) => `"${input.text}"`),
  );
});

test(`runs at most ${MAX_CONCURRENCY} messages at once`, async () => {
  const model = echoModel(() => 10);
  await runMessages(inputs, "baseline", { ...setup(), create: model.create, responderModel: "fake" });
  assert.equal(model.peak(), MAX_CONCURRENCY);
});

test("writes one trace file per message", async () => {
  const deps = setup();
  const model = echoModel(() => 1);
  const output = await runMessages(inputs.slice(0, 2), "baseline", { ...deps, create: model.create, responderModel: "fake" });
  const [runId] = readdirSync(deps.traceRoot);
  assert.equal(output.runId, runId);
  assert.deepEqual(output.results[0].input, inputs[0]);
  assert.equal(output.results[0].trace!.modelCalls.length, 1);
  assert.equal(output.results[0].error, null);
  assert.equal(typeof output.results[0].wallTimeMs, "number");
  assert.match(runId, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/);
  const files = readdirSync(join(deps.traceRoot, runId)).sort();
  assert.deepEqual(files, ["m0.json", "m1.json"]);
  const trace = JSON.parse(readFileSync(join(deps.traceRoot, runId, "m0.json"), "utf8"));
  assert.deepEqual(trace.input, inputs[0]);
  assert.equal(trace.mode, "baseline");
  assert.equal(trace.modelCalls.length, 1);
  assert.equal(typeof trace.wallTimeMs, "number");
  assert.equal(trace.reply.response, '"message 0"');
});

test("message ids become safe, unique trace file names", async () => {
  const deps = setup();
  const model = echoModel(() => 1);
  const odd = [
    { id: "../escape", text: "a" },
    { id: "same", text: "b" },
    { id: "same", text: "c" },
  ];
  await runMessages(odd, "baseline", { ...deps, create: model.create, responderModel: "fake" });
  const [runId] = readdirSync(deps.traceRoot);
  assert.deepEqual(readdirSync(join(deps.traceRoot, runId)).sort(), [".._escape.json", "same-2.json", "same.json"]);
});

test("a message that fails still gets a schema-valid escalation Reply", async () => {
  const deps = setup();
  const create: CreateResponse = async () => {
    throw new Error("API down");
  };
  const { results } = await runMessages(inputs.slice(0, 1), "baseline", { ...deps, create, responderModel: "fake" });
  const replies = results.map((result) => result.reply);
  assert.match(results[0].error!, /API down/);
  assert.equal(replies.length, 1);
  assert.ok(ReplySchema.safeParse(replies[0]).success);
  assert.equal(replies[0].escalate, true);
  assert.equal(replies[0].response, "I'm getting a person for you.");
  assert.equal(replies[0].escalationReason, "Could not draft a reply");
  assert.equal(replies[0].templateId, null);
  const [runId] = readdirSync(deps.traceRoot);
  const trace = JSON.parse(readFileSync(join(deps.traceRoot, runId, "m0.json"), "utf8"));
  assert.match(trace.error, /API down/);
});

test("a setup error fails the whole run instead of escalating", async () => {
  const create: CreateResponse = async () => {
    throw new SetupError("OPENAI_API_KEY is invalid");
  };
  await assert.rejects(
    runMessages(inputs.slice(0, 2), "baseline", { ...setup(), create, responderModel: "fake" }),
    /OPENAI_API_KEY/,
  );
});

test("after a setup error no new messages start", async () => {
  let calls = 0;
  const create: CreateResponse = async () => {
    calls += 1;
    if (calls === 1) throw new SetupError("bad key");
    await new Promise((resolve) => setTimeout(resolve, 10));
    return modelResponse([functionCall("submitReply", VALID_REPLY)]);
  };
  await assert.rejects(runMessages(inputs, "baseline", { ...setup(), create, responderModel: "fake" }), /bad key/);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(calls, MAX_CONCURRENCY);
});

test("a failed message's trace keeps its model calls", async () => {
  const deps = setup();
  const create: CreateResponse = async () => modelResponse([], "no tools");
  await runMessages(inputs.slice(0, 1), "baseline", { ...deps, create, responderModel: "fake" });
  const [runId] = readdirSync(deps.traceRoot);
  const trace = JSON.parse(readFileSync(join(deps.traceRoot, runId, "m0.json"), "utf8"));
  assert.equal(trace.modelCalls.length, 1);
  assert.match(trace.error, /without calling a tool/);
});

// Triage lets every message through, then the responder echoes the message text back.
const passThroughModel: CreateResponse = async (params) => {
  if (toolNames(params).includes("submitTriage")) return modelResponse([functionCall("submitTriage", triageDecision())]);
  return modelResponse([functionCall("submitReply", { ...VALID_REPLY, response: incomingText(params) })]);
};

test("default mode runs guards and triage before the responder", async () => {
  const deps = setup();
  const messages = [
    { id: "price", text: "What does Heva cost?" },
    { id: "human", text: "I demand to talk to a human" },
  ];
  const { results } = await runMessages(messages, "default", { ...deps, create: passThroughModel, responderModel: "fake" });
  assert.equal(results[0].reply.response, '"What does Heva cost?"');
  assert.equal(results[1].reply.response, "I'm getting a person for you.");
  const [runId] = readdirSync(deps.traceRoot);
  const trace = JSON.parse(readFileSync(join(deps.traceRoot, runId, "price.json"), "utf8"));
  assert.equal(trace.mode, "default");
  assert.equal(trace.path, "skills");
  assert.deepEqual(trace.modelCalls.map((call: { step: string }) => call.step), ["triage", "responder"]);
});

test("card numbers never reach a trace file", async () => {
  const deps = setup();
  const card = [{ id: "card", text: "Put it on 4111 1111 1111 1111 please" }];
  const { results } = await runMessages(card, "default", { ...deps, create: passThroughModel, responderModel: "fake" });
  assert.equal(results[0].reply.escalate, true);
  const [runId] = readdirSync(deps.traceRoot);
  const raw = readFileSync(join(deps.traceRoot, runId, "card.json"), "utf8");
  assert.doesNotMatch(raw, /4111/);
  assert.equal(JSON.parse(raw).input.text, "Put it on [card number] please");
});

test("each message can carry its own Patient context", async () => {
  const deps = setup();
  const lead = loadContext("evals/contexts/lead.json");
  const messages = [
    { id: "packet", text: "What does Heva cost?" },
    { id: "lead", text: "What does Heva cost?", context: lead },
  ];
  const { results } = await runMessages(messages, "default", { ...deps, create: passThroughModel, responderModel: "fake" });
  assert.deepEqual(results[1].input, { id: "lead", text: "What does Heva cost?" });
  const [runId] = readdirSync(deps.traceRoot);
  const triageCard = (id: string) => JSON.parse(readFileSync(join(deps.traceRoot, runId, `${id}.json`), "utf8")).triage.userMessage;
  assert.match(triageCard("packet"), /Pipeline Status: PRE_CLINICAL_SENT/);
  assert.match(triageCard("lead"), /Pipeline Status: LEAD/);
});
