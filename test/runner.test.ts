import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { runMessages, MAX_CONCURRENCY, SetupError } from "../src/runner.ts";
import { ReplySchema } from "../src/reply.ts";
import type { CreateMessage } from "../src/responder.ts";
import { VALID_REPLY, message, toolUse } from "./fakes.ts";

function incomingText(params: Anthropic.MessageCreateParamsNonStreaming): string {
  return (params.messages[0].content as string).split("\n")[1];
}

// Answers each message by echoing its text back, after a delay that varies by message.
function echoModel(delayMs: (text: string) => number) {
  let inFlight = 0;
  let peak = 0;
  const create: CreateMessage = async (params) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    const text = incomingText(params);
    await new Promise((resolve) => setTimeout(resolve, delayMs(text)));
    inFlight -= 1;
    return message([toolUse("submitReply", { ...VALID_REPLY, response: text })]);
  };
  return { create, peak: () => peak };
}

function setup() {
  const traceRoot = mkdtempSync(join(tmpdir(), "traces-"));
  return { traceRoot, log: () => {} };
}

const inputs = Array.from({ length: 10 }, (_, index) => ({ id: `m${index}`, text: `message ${index}` }));

test("returns one Reply per message, in input order", async () => {
  const model = echoModel((text) => 50 - Number(text.match(/\d+/)![0]) * 4);
  const replies = await runMessages(inputs, "baseline", { ...setup(), create: model.create, responderModel: "fake" });
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
  await runMessages(inputs.slice(0, 2), "baseline", { ...deps, create: model.create, responderModel: "fake" });
  const [runId] = readdirSync(deps.traceRoot);
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
  const create: CreateMessage = async () => {
    throw new Error("API down");
  };
  const replies = await runMessages(inputs.slice(0, 1), "baseline", { ...deps, create, responderModel: "fake" });
  assert.equal(replies.length, 1);
  assert.ok(ReplySchema.safeParse(replies[0]).success);
  assert.equal(replies[0].escalate, true);
  assert.equal(replies[0].templateId, null);
  const [runId] = readdirSync(deps.traceRoot);
  const trace = JSON.parse(readFileSync(join(deps.traceRoot, runId, "m0.json"), "utf8"));
  assert.match(trace.error, /API down/);
});

test("a setup error fails the whole run instead of escalating", async () => {
  const create: CreateMessage = async () => {
    throw new SetupError("ANTHROPIC_API_KEY is invalid");
  };
  await assert.rejects(
    runMessages(inputs.slice(0, 2), "baseline", { ...setup(), create, responderModel: "fake" }),
    /ANTHROPIC_API_KEY/,
  );
});

test("after a setup error no new messages start", async () => {
  let calls = 0;
  const create: CreateMessage = async () => {
    calls += 1;
    if (calls === 1) throw new SetupError("bad key");
    await new Promise((resolve) => setTimeout(resolve, 10));
    return message([toolUse("submitReply", VALID_REPLY)]);
  };
  await assert.rejects(runMessages(inputs, "baseline", { ...setup(), create, responderModel: "fake" }), /bad key/);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(calls, MAX_CONCURRENCY);
});

test("a failed message's trace keeps its model calls", async () => {
  const deps = setup();
  const create: CreateMessage = async () => message([{ type: "text", text: "no tools", citations: null } as Anthropic.TextBlock]);
  await runMessages(inputs.slice(0, 1), "baseline", { ...deps, create, responderModel: "fake" });
  const [runId] = readdirSync(deps.traceRoot);
  const trace = JSON.parse(readFileSync(join(deps.traceRoot, runId, "m0.json"), "utf8"));
  assert.equal(trace.modelCalls.length, 1);
  assert.match(trace.error, /without calling a tool/);
});
