import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { parseMessages } from "../src/cli.ts";
import { loadCases, scoreCase } from "../src/eval/cases.ts";
import { checkReply } from "../src/eval/checks.ts";
import { skillsRun, type PipelineTrace } from "../src/pipeline.ts";
import { ReplySchema, type Reply } from "../src/reply.ts";

// Exercise the documented CLI as a separate process, then save reviewable evidence.
const { values } = parseArgs({ options: { offline: { type: "boolean", default: false }, out: { type: "string" } } });
const offline = values.offline;
// Capture provenance before this command creates its own published artifacts.
const git = (args: string[]) => spawnSync("git", args, { encoding: "utf8" });
const revision = git(["rev-parse", "HEAD"]);
const status = git(["status", "--porcelain"]);
const inputPath = offline ? "examples/offline-escalations.json" : "examples/packet-messages.json";
const input = parseMessages(readFileSync(inputPath, "utf8"));
const result = spawnSync(process.execPath, ["--env-file-if-exists=.env", "--import", "tsx", "src/cli.ts", inputPath], {
  encoding: "utf8",
  maxBuffer: 8 * 1024 * 1024,
  env: offline ? { ...process.env, OPENAI_API_KEY: "offline-guard-only", OPENAI_BASE_URL: "http://127.0.0.1:1" } : process.env,
});
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.error?.message || "CLI failed\n");
  process.exit(1);
}
const replies = ReplySchema.array().parse(JSON.parse(result.stdout));
if (replies.length !== input.length) throw new Error("CLI returned the wrong number of Replies");
const traceDir = result.stderr.match(/Wrote traces to (.+)/)?.[1];
if (!traceDir) throw new Error("CLI did not report its trace directory");
type SavedTrace = PipelineTrace & { input: { id: string }; reply: Reply; error: string | null };
const traces = readdirSync(traceDir).map((file): SavedTrace => JSON.parse(readFileSync(join(traceDir, file), "utf8")));
if (traces.length !== input.length) throw new Error("CLI did not write one trace per message");
const cases = offline ? [] : loadCases(["packet-check"]);
const checks = replies.map((reply, index) => {
  const trace = traces.find((trace) => trace.input.id === input[index].id);
  if (!trace) throw new Error(`Missing trace for ${input[index].id}`);
  if (JSON.stringify(trace.reply) !== JSON.stringify(reply)) throw new Error(`Reply order does not match input ${input[index].id}`);
  const outcome = offline
    ? { passed: checkReply(reply).ok && reply.escalate && trace.modelCalls.length === 0 && !trace.error,
        checks: [{ name: "output contract", ...checkReply(reply) }] }
    : scoreCase(cases[index], reply, { toolCalls: trace.toolCalls ?? [], skills: skillsRun(trace), mode: "default" });
  return { id: input[index].id, ...outcome, passed: outcome.passed && trace.error === null };
});
const dir = values.out ?? join("evals/published", `${new Date().toISOString().replaceAll(":", "-")}-${offline ? "offline" : "live"}-demo`);
mkdirSync(dir, { recursive: true });
const save = (name: string, value: unknown) => writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
save("input.json", input);
save("output.json", replies);
save("trace-summary.json", traces.map((trace) => ({
  id: trace.input.id, path: trace.path, skills: skillsRun(trace),
  tools: trace.toolCalls?.map(({ name, isError }) => ({ name, isError })) ?? [],
  modelCalls: trace.modelCalls.map(({ model, step, usage, latencyMs }) => ({ model, step, usage, latencyMs })),
  validation: trace.responder?.validation ?? null,
})));
save("manifest.json", {
  kind: offline ? "offline guard smoke test; no model quality or savings measured" : "live packet CLI demo",
  command: `npm run demo${offline ? " -- --offline" : ""}`,
  cliCommand: `npm run --silent respond -- ${inputPath}`,
  commit: revision.status === 0 ? revision.stdout.trim() : null,
  dirty: status.status === 0 ? status.stdout.trim().length > 0 : null,
  node: process.version, createdAt: new Date().toISOString(), traceDir,
  passed: checks.every(({ passed }) => passed), checks,
});
process.stderr.write(`Saved ${offline ? "offline" : "live"} demo to ${dir}\n`);
process.exitCode = checks.every(({ passed }) => passed) ? 0 : 1;
