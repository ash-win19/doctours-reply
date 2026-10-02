import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseCases, scoreCase, loadCaseFiles, type EvalCase } from "../src/eval/cases.ts";
import { VALID_REPLY } from "./fakes.ts";

const baseCase: EvalCase = {
  id: "consultation",
  group: "consultation",
  rule: "Packet, Expected outputs: consultation",
  text: "Is the consultation free?",
  expect: {
    escalate: false,
    includes: ["free"],
    lastLineUrl: "https://www.doctours.com/consultation",
  },
};

test("an includes entry can be a list of alternatives", () => {
  const [parsed] = parseCases(JSON.stringify([{ ...baseCase, expect: { includes: [["free", "no cost"], "link"] } }]), "cases.json");
  assert.deepEqual(parsed.expect.includes, [["free", "no cost"], "link"]);
});

test("accepts a case with every check", () => {
  const [parsed] = parseCases(
    JSON.stringify([
      {
        ...baseCase,
        expect: {
          escalate: false,
          includes: ["a"],
          excludes: ["b"],
          lastLineUrl: "https://x.example",
          noUrl: false,
          maxSentences: 2,
          maxAttachments: 0,
          calls: [{ tool: "getPaymentLinkTool", argsInclude: ["payment"] }],
          fields: { shouldFollowUp: true, followUpTiming: ["1 month", "next month"], "workingMemoryUpdates.promisesMade": "*" },
        },
      },
    ]),
    "cases.json",
  );
  assert.equal(parsed.expect.maxSentences, 2);
});

test("a case must name its group and source rule", () => {
  const { group: _group, ...noGroup } = baseCase;
  assert.throws(() => parseCases(JSON.stringify([noGroup]), "cases.json"), /cases\.json[\s\S]*group/);
  const { rule: _rule, ...noRule } = baseCase;
  assert.throws(() => parseCases(JSON.stringify([noRule]), "cases.json"), /rule/);
});

test("rejects unknown checks so a typo can't pass silently", () => {
  const typo = { ...baseCase, expect: { escalte: true } };
  assert.throws(() => parseCases(JSON.stringify([typo]), "cases.json"), /escalte/);
});

test("rejects patient context until the runner can swap it in", () => {
  const withContext = { ...baseCase, context: { pipelineStatus: "LEAD" } };
  assert.throws(() => parseCases(JSON.stringify([withContext]), "cases.json"), /context/);
});

test("rejects duplicate case ids across files", () => {
  assert.throws(
    () =>
      loadCaseFiles([
        { path: "a.json", raw: JSON.stringify([baseCase]) },
        { path: "b.json", raw: JSON.stringify([baseCase]) },
      ]),
    /duplicate case id "consultation"/,
  );
});

test("scores every check the case asks for, and only those", () => {
  const reply = { ...VALID_REPLY, response: "Yes, it's free.\nhttps://www.doctours.com/consultation" };
  const outcome = scoreCase(baseCase, reply);
  assert.deepEqual(
    outcome.checks.map((check) => [check.name, check.ok]),
    [
      ["reply", true],
      ["escalate", true],
      ["includes", true],
      ["lastLineUrl", true],
    ],
  );
  assert.equal(outcome.passed, true);
});

test("a case fails when any check fails", () => {
  const reply = { ...VALID_REPLY, escalate: true, response: "I'm getting a person for you." };
  const outcome = scoreCase(baseCase, reply);
  assert.equal(outcome.passed, false);
  assert.deepEqual(
    outcome.checks.filter((check) => !check.ok).map((check) => check.name),
    ["escalate", "includes", "lastLineUrl"],
  );
});

test("the packet-check cases are valid", () => {
  const cases = loadCaseFiles([
    { path: "evals/cases/packet-check.json", raw: readFileSync("evals/cases/packet-check.json", "utf8") },
  ]);
  assert.deepEqual(
    cases.map((evalCase) => evalCase.id),
    ["heva-packages", "hakan-price", "consultation", "demand-human", "charge-card"],
  );
});

test("nothing outside the eval harness reads the packet-check cases", () => {
  const readers = readdirSync("src", { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".ts"))
    .filter((path) => readFileSync(join("src", path), "utf8").includes("packet-check"));
  assert.deepEqual(readers, []);
  for (const dir of ["prompts"]) {
    const files = readdirSync(dir, { recursive: true, encoding: "utf8" });
    for (const file of files.filter((path) => path.endsWith(".md"))) {
      assert.doesNotMatch(readFileSync(join(dir, file), "utf8"), /packet-check/, file);
    }
  }
});

test("a calls check is scored against the message's tool calls", () => {
  const evalCase = { ...baseCase, expect: { calls: [{ tool: "updateUserClinicPreferencesTool", argsInclude: ["heva-id"] }] } };
  const call = { name: "updateUserClinicPreferencesTool", input: { clinicSelection: { selectedClinicId: "heva-id" } }, output: {}, isError: false };
  assert.equal(scoreCase(evalCase, VALID_REPLY, [call]).passed, true);
  assert.equal(scoreCase(evalCase, VALID_REPLY, []).passed, false);
});

test("a fields check is scored against the Reply", () => {
  const evalCase = { ...baseCase, expect: { fields: { shouldFollowUp: true, followUpTiming: ["1 month"] } } };
  assert.equal(scoreCase(evalCase, { ...VALID_REPLY, shouldFollowUp: true, followUpTiming: "1 month" }).passed, true);
  assert.equal(scoreCase(evalCase, VALID_REPLY).passed, false);
});
