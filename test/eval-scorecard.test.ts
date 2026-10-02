import { test } from "node:test";
import assert from "node:assert/strict";
import type { EvalCase } from "../src/eval/cases.ts";
import { buildScorecard, compareScorecards, formatScorecard, median } from "../src/eval/scorecard.ts";
import type { MessageResult, RunOutput } from "../src/runner.ts";
import type { ModelCallTrace } from "../src/model-calls.ts";
import type { ResponderTrace } from "../src/tool-loop.ts";
import { VALID_REPLY } from "./fakes.ts";
import type { Reply } from "../src/reply.ts";

const cases: EvalCase[] = [
  {
    id: "consultation",
    group: "consultation",
    rule: "free consultation",
    text: "Is the consultation free?",
    expect: { escalate: false, includes: ["free"] },
  },
  {
    id: "demand-human",
    group: "escalation",
    rule: "asks for a person",
    text: "I demand to talk to a human",
    expect: { escalate: true },
  },
  {
    id: "charge-card",
    group: "escalation",
    rule: "charging a card",
    text: "Charge my card",
    expect: { escalate: true },
  },
];

// OpenAI's output_tokens already include reasoning, so the fake folds them in.
function modelCall(prompt: number, output: number, reasoning: number): ModelCallTrace {
  return {
    step: "responder",
    model: "fake-model",
    status: "completed",
    latencyMs: 10,
    usage: {
      input_tokens: prompt,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: output + reasoning,
      output_tokens_details: { reasoning_tokens: reasoning },
      total_tokens: prompt + output + reasoning,
    },
  };
}

function trace(calls: ModelCallTrace[]): ResponderTrace {
  return { system: "", userMessage: "", modelCalls: calls, toolCalls: [], finalOutput: null };
}

function result(evalCase: EvalCase, reply: Reply, wallTimeMs: number, calls: ModelCallTrace[], error: string | null = null): MessageResult {
  return { input: { id: evalCase.id, text: evalCase.text }, reply, trace: trace(calls), error, wallTimeMs };
}

const failedReply: Reply = { ...VALID_REPLY, response: "I'm getting a person for you.", escalate: true };

const run: RunOutput = {
  runId: "2026-10-02T10-00-00.000Z",
  results: [
    result(cases[0], { ...VALID_REPLY, response: "Yes, it's free." }, 3000, [modelCall(1000, 50, 200), modelCall(1100, 40, 0)]),
    result(cases[1], { ...VALID_REPLY, escalate: true, response: "Getting a person." }, 1000, [modelCall(900, 30, 10)]),
    result(cases[2], { ...VALID_REPLY, escalate: false, response: "I can't do that." }, 2000, [modelCall(950, 20, 5)]),
  ],
};

const card = buildScorecard({ cases, run, mode: "baseline", model: "fake-model" });

test("median of an odd and an even list", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), 0);
});

test("scores each case and records what it needs for comparison", () => {
  assert.equal(card.runId, run.runId);
  assert.equal(card.mode, "baseline");
  assert.deepEqual(
    card.cases.map((outcome) => [outcome.id, outcome.passed]),
    [
      ["consultation", true],
      ["demand-human", true],
      ["charge-card", false],
    ],
  );
  assert.equal(card.cases[0].inputTokens, 2100);
  assert.equal(card.cases[0].outputTokens, 290);
  assert.equal(card.cases[2].checks.find((check) => check.name === "escalate")!.detail, "expected escalate true, got false");
});

test("totals pass rate, tokens and median latency per message", () => {
  assert.deepEqual(card.totals, {
    cases: 3,
    passed: 2,
    passRate: 2 / 3,
    inputTokens: 3950,
    outputTokens: 355,
    medianLatencyMs: 2000,
  });
});

test("pass rate per group", () => {
  assert.deepEqual(card.groups, {
    consultation: { cases: 1, passed: 1, passRate: 1 },
    escalation: { cases: 2, passed: 1, passRate: 0.5 },
  });
});

test("a message the model never finished fails even if its checks would pass", () => {
  const failedRun: RunOutput = {
    runId: "r",
    results: [result(cases[1], failedReply, 500, [], "OpenAI 500: server error")],
  };
  const failedCard = buildScorecard({ cases: [cases[1]], run: failedRun, mode: "baseline", model: "fake-model" });
  const [outcome] = failedCard.cases;
  assert.equal(outcome.passed, false);
  assert.deepEqual(outcome.checks[0], { name: "drafted", ok: false, detail: "OpenAI 500: server error" });
});

test("the printed scorecard shows each case, its failing check and the totals", () => {
  const text = formatScorecard(card);
  assert.match(text, /PASS\s+consultation\s+consultation/);
  assert.match(text, /FAIL\s+escalation\s+charge-card\s+escalate: expected escalate true, got false/);
  assert.match(text, /escalation\s+1\/2\s+50%/);
  assert.match(text, /Total\s+2\/3\s+67%/);
  assert.match(text, /Input tokens\s+3,950/);
  assert.match(text, /Output tokens\s+355/);
  assert.match(text, /Median latency\s+2\.0s/);
});

test("compare shows both runs side by side and the cases that flipped", () => {
  const after = buildScorecard({
    cases,
    mode: "skills",
    model: "fake-model",
    run: {
      runId: "2026-10-02T11-00-00.000Z",
      results: [
        result(cases[0], { ...VALID_REPLY, response: "No." }, 1000, [modelCall(400, 20, 0)]),
        run.results[1],
        result(cases[2], { ...VALID_REPLY, escalate: true, response: "Getting a person." }, 1000, [modelCall(400, 20, 0)]),
      ],
    },
  });
  const text = compareScorecards(card, after);
  assert.match(text, /baseline .*2026-10-02T10-00-00\.000Z/);
  assert.match(text, /skills .*2026-10-02T11-00-00\.000Z/);
  assert.match(text, /escalation\s+50%\s+100%/);
  assert.match(text, /Input tokens\s+3,950\s+1,700/);
  assert.match(text, /Fixed\s+charge-card/);
  assert.match(text, /Broke\s+consultation/);
});
