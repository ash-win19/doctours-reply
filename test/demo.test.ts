import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("offline demo exercises the real CLI and saves ordered outputs with zero model calls", () => {
  const dir = mkdtempSync(join(tmpdir(), "doctours-demo-"));
  const run = spawnSync(process.execPath, ["--import", "tsx", "scripts/demo.ts", "--offline", "--out", dir], {
    encoding: "utf8", timeout: 30000,
    env: { ...process.env, OPENAI_API_KEY: "", OPENAI_BASE_URL: "http://127.0.0.1:1" },
  });
  assert.equal(run.status, 0, run.stderr);
  const read = (name: string) => JSON.parse(readFileSync(join(dir, name), "utf8"));
  assert.deepEqual(read("input.json").map((input: { id: string }) => input.id), ["human", "card"]);
  const output = read("output.json");
  assert.equal(output.length, 2);
  assert.equal(output[0].escalationReason, "Patient asked for a person");
  assert.equal(output[1].escalationReason, "Patient shared card details");
  assert.ok(output.every((reply: { response: string; escalate: boolean }) => reply.escalate && reply.response === "I'm getting a person for you."));
  assert.equal(read("manifest.json").passed, true);
  assert.ok(read("trace-summary.json").every((trace: { modelCalls: unknown[] }) => trace.modelCalls.length === 0));
});
