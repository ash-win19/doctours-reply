import { test } from "node:test";
import assert from "node:assert/strict";
import { askCallHistory } from "../src/call-history.ts";
import { DraftingError, type CreateResponse } from "../src/model-calls.ts";
import { SetupError } from "../src/errors.ts";
import { firstUserText, functionCall, scriptedModel, toolNames } from "./fakes.ts";

const CALL_ID = "66666666-6666-4666-8666-666666666666";
const ANSWER = { answer: "You said your hair is 4C.", callIds: [CALL_ID] };
const options = (create: CreateResponse) => ({ create, model: "triage-model" });

test("answers from the full call records with a forced submitAnswer call", async () => {
  const model = scriptedModel([[functionCall("submitAnswer", ANSWER)]]);
  const { answer, callIds } = await askCallHistory("did I mention my hair type on the call?", options(model.create), {
    chatId: "chat-1",
  });
  assert.equal(answer, "You said your hair is 4C.");
  assert.deepEqual(callIds, [CALL_ID]);
  const [request] = model.requests;
  assert.equal(request.model, "triage-model");
  assert.deepEqual(request.tool_choice, { type: "function", name: "submitAnswer" });
  assert.deepEqual(toolNames(request), ["submitAnswer"]);
  assert.match(request.instructions as string, /only the call records/);
  const text = firstUserText(request);
  assert.match(text, /did I mention my hair type on the call\?/);
  assert.match(text, /Thanks for hopping on/);
  assert.match(text, /Free consultation\. Jordan wants a hairline procedure/);
});

test("the answer is at most three sentences", async () => {
  const long = { answer: "One. Two? Three! Four. Five.", callIds: [CALL_ID] };
  const model = scriptedModel([[functionCall("submitAnswer", long)]]);
  const { answer } = await askCallHistory("what did we talk about?", options(model.create), { chatId: "chat-1" });
  assert.equal(answer, "One. Two? Three!");
});

test("the subagent's model call is traced under its own step", async () => {
  const model = scriptedModel([[functionCall("submitAnswer", ANSWER)]]);
  const { trace } = await askCallHistory("what did we talk about?", options(model.create), { chatId: "chat-1" });
  assert.equal(trace.subagent, "callHistory");
  assert.equal(trace.question, "what did we talk about?");
  assert.deepEqual(trace.output, ANSWER);
  assert.deepEqual(trace.modelCalls.map((call) => call.step), ["callHistory"]);
});

test("an invalid answer goes back once, then fails as a DraftingError with the trace", async () => {
  const bad = [functionCall("submitAnswer", { answer: 42 })];
  const model = scriptedModel([bad, bad]);
  await assert.rejects(askCallHistory("what did we talk about?", options(model.create), { chatId: "chat-1" }), (error: unknown) => {
    assert.ok(error instanceof DraftingError);
    assert.equal(error.trace.modelCalls.length, 2);
    return true;
  });
});

test("a setup error stops the run", async () => {
  const create: CreateResponse = async () => {
    throw new SetupError("bad key");
  };
  await assert.rejects(askCallHistory("what did we talk about?", options(create), { chatId: "chat-1" }), SetupError);
});
