import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SetupError } from "./errors.ts";
import { DRAFTING_FAILED, escalationReply } from "./escalation.ts";
import { redactCardNumbers } from "./guards.ts";
import type { PatientContext } from "./patient-context.ts";
import { respond, type Mode } from "./pipeline.ts";
import type { Reply } from "./reply.ts";
import { DraftingError, type CreateResponse, type Trace } from "./model-calls.ts";

export const MAX_CONCURRENCY = 4;

export interface HumanMessage {
  id: string;
  text: string;
}

// A message to run, with the Patient it is from.
export interface RunMessage extends HumanMessage {
  context: PatientContext;
}

export interface RunnerDeps {
  create: CreateResponse;
  responderModel: string;
  triageModel: string;
  promptCache?: boolean;
  traceRoot: string;
  log: (line: string) => void;
}

function traceFileNames(messages: HumanMessage[]): string[] {
  const used = new Set<string>();
  return messages.map(({ id }) => {
    // Bound the name for filesystem limits; reserve case-insensitively for macOS/Windows too.
    const base = id.replace(/[^\w.-]/g, "_").slice(0, 160) || "message";
    let file = `${base}.json`;
    let suffix = 2;
    while (used.has(file.toLowerCase())) file = `${base}-${suffix++}.json`;
    used.add(file.toLowerCase());
    return file;
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

export async function runMessages(messages: RunMessage[], mode: Mode, deps: RunnerDeps): Promise<RunOutput> {
  // An ISO timestamp with ":" swapped for "-" so it works as a directory name everywhere.
  const runId = new Date().toISOString().replaceAll(":", "-");
  const traceDir = join(deps.traceRoot, runId);
  mkdirSync(traceDir, { recursive: true });
  const fileNames = traceFileNames(messages);
  const results: MessageResult[] = new Array(messages.length);
  let setupFailed = false;

  async function runOne(index: number): Promise<void> {
    const { context, ...input } = messages[index];
    const started = performance.now();
    let reply: Reply;
    let trace: Trace | null = null;
    let error: string | null = null;
    try {
      ({ reply, trace } = await respond(input.text, mode, { ...deps, context }));
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
