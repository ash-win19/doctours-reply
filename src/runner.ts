import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SetupError } from "./errors.ts";
import { DRAFTING_FAILED, escalationReply } from "./escalation.ts";
import { redactCardNumbers } from "./guards.ts";
import { respond, type Mode } from "./pipeline.ts";
import type { Reply } from "./reply.ts";
import { DraftingError, type CreateResponse, type Trace } from "./model-calls.ts";

export const MAX_CONCURRENCY = 4;

export interface HumanMessage {
  id: string;
  text: string;
}

export interface RunnerDeps {
  create: CreateResponse;
  responderModel: string;
  triageModel: string;
  traceRoot: string;
  log: (line: string) => void;
}

function traceFileNames(messages: HumanMessage[]): string[] {
  const used = new Map<string, number>();
  return messages.map(({ id }) => {
    const base = id.replace(/[^\w.-]/g, "_") || "message";
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    return `${count === 1 ? base : `${base}-${count}`}.json`;
  });
}

export interface MessageResult {
  input: HumanMessage;
  reply: Reply;
  trace: Trace | null;
  error: string | null;
  wallTimeMs: number;
}

export interface RunOutput {
  runId: string;
  results: MessageResult[];
}

export async function runMessages(messages: HumanMessage[], mode: Mode, deps: RunnerDeps): Promise<RunOutput> {
  // An ISO timestamp with ":" swapped for "-" so it works as a directory name everywhere.
  const runId = new Date().toISOString().replaceAll(":", "-");
  const traceDir = join(deps.traceRoot, runId);
  mkdirSync(traceDir, { recursive: true });
  const fileNames = traceFileNames(messages);
  const results: MessageResult[] = new Array(messages.length);
  let setupFailed = false;

  async function runOne(index: number): Promise<void> {
    const input = messages[index];
    const started = performance.now();
    let reply: Reply;
    let trace: Trace | null = null;
    let error: string | null = null;
    try {
      ({ reply, trace } = await respond(input.text, mode, deps));
    } catch (caught) {
      if (caught instanceof SetupError) {
        setupFailed = true;
        throw caught;
      }
      if (caught instanceof DraftingError) trace = caught.trace;
      error = caught instanceof Error ? caught.message : String(caught);
      // Every message still gets exactly one Reply when drafting fails, so a person takes over.
      reply = escalationReply(DRAFTING_FAILED, null);
    }
    const wallTimeMs = Math.round(performance.now() - started);
    results[index] = { input, reply, trace, error, wallTimeMs };
    // The trace file's input never holds card digits. Baseline mode still sends the raw text to the model.
    const tracedInput = { ...input, text: redactCardNumbers(input.text).text };
    writeFileSync(
      join(traceDir, fileNames[index]),
      JSON.stringify({ input: tracedInput, mode, ...trace, reply, error, wallTimeMs }, null, 2),
    );
    deps.log(
      `${error ? "FAILED" : "ok"} ${input.id} in ${wallTimeMs}ms${error ? `: ${error}` : ""}${reply.escalate ? " (escalated)" : ""}`,
    );
  }

  let next = 0;
  async function worker(): Promise<void> {
    while (next < messages.length && !setupFailed) {
      await runOne(next++);
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, messages.length) }, worker));

  deps.log(`Wrote traces to ${traceDir}`);
  return { runId, results };
}
