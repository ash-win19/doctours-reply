import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { parseCliArgs, parseMessages } from "../src/cli.ts";

test("reads mode, out and the input file", () => {
  assert.deepEqual(parseCliArgs(["--mode", "baseline", "--out", "replies.json", "messages.json"]), {
    mode: "baseline",
    out: "replies.json",
    inputPath: "messages.json",
    contextPath: undefined,
  });
});

test("no file argument means stdin", () => {
  assert.deepEqual(parseCliArgs(["--mode", "baseline"]), {
    mode: "baseline",
    out: undefined,
    inputPath: undefined,
    contextPath: undefined,
  });
});

test("rejects an unknown mode", () => {
  assert.throws(() => parseCliArgs(["--mode", "fancy"]), /mode/);
});

test("the default mode is used when none is given", () => {
  assert.equal(parseCliArgs([]).mode, "default");
});

test("accepts an array of {id, text}", () => {
  assert.deepEqual(parseMessages('[{"id":"a","text":"hi"}]'), [{ id: "a", text: "hi" }]);
});

test("rejects input that is not an array of {id, text}", () => {
  assert.throws(() => parseMessages('{"id":"a"}'), /array/i);
  assert.throws(() => parseMessages('[{"id":1,"text":"hi"}]'), /id/);
  assert.throws(() => parseMessages("not json"), /JSON/);
});

test("bad input exits non-zero with nothing on stdout", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--mode", "baseline"], {
    input: "not json",
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /JSON/);
});

test("--context names a Patient context file", () => {
  assert.equal(parseCliArgs(["--context", "evals/contexts/lead.json"]).contextPath, "evals/contexts/lead.json");
});

test("a bad context file exits non-zero with nothing on stdout", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--context", "evals/contexts/missing.json"], {
    input: '[{"id":"a","text":"hi"}]',
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /missing\.json/);
});
