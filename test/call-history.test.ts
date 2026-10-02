import { test } from "node:test";
import assert from "node:assert/strict";
import { askCallHistory } from "../src/call-history.ts";
import type { CreateResponse } from "../src/model-calls.ts";
import { SetupError } from "../src/errors.ts";
import { SUBAGENT_TOOLS } from "../src/subagent-tools.ts";
import { firstUserText, functionCall, scriptedModel, toolNames } from "./fakes.ts";

const CALL_ID = "66666666-6666-4666-8666-666666666666";
const ANSWER = { answer: "You said your hair is 4C.", callIds: [CALL_ID] };
const options = (create: CreateResponse) => ({ create, model: "triage-model" });

test("answers from the full call records with a forced submitAnswer call", async () => {
  const model = scriptedModel([[functionCall("submitAnswer", ANSWER)]]);
  const { answer } = await askCallHistory("did I mention my hair type on the call?", options(model.create), {
    SUPABASE_CHAT_ID: "chat-1",
  });
  assert.equal(answer, "You said your hair is 4C.");
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

test("the reader fetches the swapped Patient's calls, using their chat id and tool overrides", async () => {
  const model = scriptedModel([[functionCall("submitAnswer", { answer: "The calls don't cover that.", callIds: [] })]]);
  const noCalls = { SUPABASE_CHAT_ID: "chat-2", toolOverrides: { getFullCallsTool: { calls: [], count: 0, chatId: "{{input.chatId}}" } } };
  await askCallHistory("what did we talk about?", options(model.create), noCalls);
  const text = firstUserText(model.requests[0]);
  assert.match(text, /"count":0/);
  assert.match(text, /"chatId":"chat-2"/);
  assert.doesNotMatch(text, /Thanks for hopping on/);
});

test("a reader answer over three sentences is retried rather than truncated", async () => {
  const long = { answer: "Dr. Hakan came up. The Sapphire package was $3.2k. You asked about 4C hair. Then flights.", callIds: [CALL_ID] };
  const short = { ...long, answer: "Dr. Hakan came up. The Sapphire package was $3.2k. You asked about 4C hair and flights." };
  const model = scriptedModel([[functionCall("submitAnswer", long)], [functionCall("submitAnswer", short)]]);
  const { answer } = await askCallHistory("what did we talk about?", options(model.create), { SUPABASE_CHAT_ID: "chat-1" });
  assert.equal(answer, short.answer);
  assert.equal(model.requests.length, 2);
  const [request] = model.requests;
  assert.match(request.instructions as string, /at most 3 short sentences/);
  assert.match(JSON.stringify(request.tools), /At most 3 short sentences/);
});

test("a reader that still exceeds three sentences returns a failure with both calls recorded", async () => {
  const long = functionCall("submitAnswer", { answer: "One. Two. Three. Four.", callIds: [CALL_ID] });
  const model = scriptedModel([[long], [long]]);
  const { answer, trace } = await askCallHistory("what did we talk about?", options(model.create), { SUPABASE_CHAT_ID: "chat-1" });
  assert.equal(answer, null);
  assert.equal(trace.modelCalls.length, 2);
  assert.match(trace.error!, /valid submission/);
});

test("the call reader never receives card digits from tool records", async () => {
  const model = scriptedModel([[functionCall("submitAnswer", ANSWER)]]);
  await askCallHistory("what did we talk about?", options(model.create), {
    SUPABASE_CHAT_ID: "chat-1",
    toolOverrides: { getFullCallsTool: { transcript: "card 4111 1111 1111 1112" } },
  });
  assert.ok(!JSON.stringify(model.requests).includes("4111"));
});

test("card numbers in the answer are redacted before the responder or the trace sees them", async () => {
  const model = scriptedModel([[functionCall("submitAnswer", { answer: "You read out 4111 1111 1111 1111.", callIds: [CALL_ID] })]]);
  const { answer, trace } = await askCallHistory("what card did I give?", options(model.create), { SUPABASE_CHAT_ID: "chat-1" });
  assert.equal(answer, "You read out [card number].");
  assert.doesNotMatch(JSON.stringify(trace), /4111/);
});

test("returns its trace record: question, answer, call ids, usage, latency and model calls", async () => {
  const model = scriptedModel([[functionCall("submitAnswer", ANSWER)]]);
  const { trace } = await askCallHistory("what did we talk about?", options(model.create), { SUPABASE_CHAT_ID: "chat-1" });
  const { modelCalls, latencyMs, ...record } = trace;
  assert.deepEqual(record, {
    subagent: "callHistory",
    question: "what did we talk about?",
    answer: "You said your hair is 4C.",
    callIds: [CALL_ID],
    usage: { inputTokens: 100, outputTokens: 50 },
    error: null,
  });
  assert.equal(typeof latencyMs, "number");
  assert.deepEqual(modelCalls.map((call) => call.step), ["callHistory"]);
});

test("an invalid answer goes back once, then the run returns no answer with the error and usage recorded", async () => {
  const bad = [functionCall("submitAnswer", { answer: 42 })];
  const model = scriptedModel([bad, bad]);
  const { answer, trace } = await askCallHistory("what did we talk about?", options(model.create), { SUPABASE_CHAT_ID: "chat-1" });
  assert.equal(answer, null);
  assert.equal(trace.answer, null);
  assert.match(trace.error!, /submitAnswer/);
  assert.deepEqual(trace.usage, { inputTokens: 200, outputTokens: 100 });
  assert.equal(trace.modelCalls.length, 2);
});

test("a setup error stops the run", async () => {
  const create: CreateResponse = async () => {
    throw new SetupError("bad key");
  };
  await assert.rejects(askCallHistory("what did we talk about?", options(create), { SUPABASE_CHAT_ID: "chat-1" }), SetupError);
});

test("askCallHistory is registered as a subagent tool with a question input", () => {
  const tool = SUBAGENT_TOOLS.askCallHistory;
  assert.equal(tool.definition.name, "askCallHistory");
  assert.equal(tool.input.safeParse({ question: "what did we talk about?" }).success, true);
  assert.equal(tool.input.safeParse({}).success, false);
});
