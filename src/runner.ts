import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Reply } from "./reply.ts";
import { ResponderError, respondBaseline, type GenerateContent, type ResponderTrace } from "./responder.ts";

export const MAX_CONCURRENCY = 4;

export const MODES = ["baseline"] as const;
export type Mode = (typeof MODES)[number];

export function parseMode(value: string | undefined): Mode {
  if (!MODES.includes(value as Mode)) {
    throw new Error(`--mode must be one of: ${MODES.join(", ")}`);
  }
  return value as Mode;
}

export interface HumanMessage {
  id: string;
  text: string;
}

export interface RunnerDeps {
  generate: GenerateContent;
  responderModel: string;
  traceRoot: string;
  log: (line: string) => void;
}

// A problem with the setup, such as a missing key or unknown model, that every message would hit.
export class SetupError extends Error {}

// Every message still gets exactly one Reply when drafting fails, so a person takes over.
const DRAFTING_FAILED_REPLY: Reply = {
  response: "I can't answer this one myself. I'm getting a person for you.",
  escalate: true,
  escalationReason: "Failed to draft a reply",
  templateId: null,
  intent: "escalate after drafting failure",
  shouldFollowUp: false,
  followUpTiming: null,
  attachmentUrls: null,
  highEngagement: false,
  workingMemoryUpdates: null,
};

function traceFileNames(messages: HumanMessage[]): string[] {
  const used = new Map<string, number>();
  return messages.map(({ id }) => {
    const base = id.replace(/[^\w.-]/g, "_") || "message";
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    return `${count === 1 ? base : `${base}-${count}`}.json`;
  });
}

export async function runMessages(messages: HumanMessage[], mode: Mode, deps: RunnerDeps): Promise<Reply[]> {
  // An ISO timestamp with ":" swapped for "-" so it works as a directory name everywhere.
  const runId = new Date().toISOString().replaceAll(":", "-");
  const traceDir = join(deps.traceRoot, runId);
  mkdirSync(traceDir, { recursive: true });
  const fileNames = traceFileNames(messages);
  const replies: Reply[] = new Array(messages.length);
  let setupFailed = false;

  async function runOne(index: number): Promise<void> {
    const input = messages[index];
    const started = performance.now();
    let reply: Reply;
    let trace: ResponderTrace | null = null;
    let error: string | null = null;
    try {
      ({ reply, trace } = await respondBaseline(input.text, { generate: deps.generate, model: deps.responderModel }));
    } catch (caught) {
      if (caught instanceof SetupError) {
        setupFailed = true;
        throw caught;
      }
      if (caught instanceof ResponderError) trace = caught.trace;
      error = caught instanceof Error ? caught.message : String(caught);
      reply = DRAFTING_FAILED_REPLY;
    }
    const wallTimeMs = Math.round(performance.now() - started);
    replies[index] = reply;
    writeFileSync(
      join(traceDir, fileNames[index]),
      JSON.stringify({ input, mode, ...trace, reply, error, wallTimeMs }, null, 2),
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
  return replies;
}
