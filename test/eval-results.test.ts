import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEvalArgs } from "../src/eval.ts";
import { loadScorecard, saveScorecard } from "../src/eval/results.ts";
import type { Scorecard } from "../src/eval/scorecard.ts";

const card: Scorecard = {
  runId: "2026-10-02T10-00-00.000Z",
  mode: "baseline",
  model: "fake-model",
  cases: [],
  groups: {},
  totals: { cases: 0, passed: 0, passRate: 0, inputTokens: 0, outputTokens: 0, medianLatencyMs: 0 },
};

test("saves a scorecard under its run id and loads it back by name or path", () => {
  const dir = mkdtempSync(join(tmpdir(), "results-"));
  const path = saveScorecard(card, dir);
  assert.equal(path, join(dir, "2026-10-02T10-00-00.000Z.json"));
  assert.deepEqual(loadScorecard("2026-10-02T10-00-00.000Z", dir), card);
  assert.deepEqual(loadScorecard(path, dir), card);
});

test("loading a run that doesn't exist names where it looked", () => {
  const dir = mkdtempSync(join(tmpdir(), "results-"));
  assert.throws(() => loadScorecard("nope", dir), /No results file "nope"/);
});

test("loading a file that isn't a scorecard fails clearly", () => {
  const dir = mkdtempSync(join(tmpdir(), "results-"));
  writeFileSync(join(dir, "bad.json"), JSON.stringify({ hello: "world" }));
  assert.throws(() => loadScorecard("bad", dir), /not an eval results file/);
});

test("parses a run: mode defaults to default, case files can be picked", () => {
  assert.deepEqual(parseEvalArgs([]), { kind: "run", mode: "default", caseFiles: [] });
  assert.deepEqual(parseEvalArgs(["--mode", "baseline", "--cases", "packet-check", "--cases", "more"]), {
    kind: "run",
    mode: "baseline",
    caseFiles: ["packet-check", "more"],
  });
});

test("parses a comparison of two runs", () => {
  assert.deepEqual(parseEvalArgs(["--compare", "runA", "runB"]), { kind: "compare", before: "runA", after: "runB" });
  assert.throws(() => parseEvalArgs(["--compare", "runA"]), /--compare takes two runs/);
});

test("rejects an unknown mode", () => {
  assert.throws(() => parseEvalArgs(["--mode", "fancy"]), /mode/);
});
