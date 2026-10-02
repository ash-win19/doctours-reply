import OpenAI from "openai";
import { SetupError } from "./errors.ts";
import type { RunnerDeps } from "./runner.ts";

export const log = (line: string) => process.stderr.write(`${line}\n`);

// Errors every message would hit the same way, so the run stops instead of escalating each one.
const SETUP_ERROR_STATUSES = new Set([400, 401, 403, 404]);

export function toSetupError(error: unknown): SetupError | null {
  if (!(error instanceof OpenAI.APIError)) return null;
  // A 429 with insufficient_quota means the account is out of credit. Retrying can't fix that.
  if (SETUP_ERROR_STATUSES.has(error.status) || error.code === "insufficient_quota") {
    return new SetupError(`OpenAI ${error.status}: ${error.message}`);
  }
  return null;
}

export function defaultRunnerDeps(): RunnerDeps {
  if (!process.env.OPENAI_API_KEY) {
    throw new SetupError("Set OPENAI_API_KEY before running");
  }
  // The SDK retries rate limits, server errors and network errors with exponential backoff and honors
  // retry-after. A hung call gives up after 3 minutes, so a stuck message escalates instead of stalling the run.
  const client = new OpenAI({ maxRetries: 3, timeout: 180_000 });
  return {
    create: async (params) => {
      try {
        return await client.responses.create(params);
      } catch (error) {
        throw toSetupError(error) ?? error;
      }
    },
    responderModel: process.env.RESPONDER_MODEL ?? "gpt-6.1-sol",
    triageModel: process.env.TRIAGE_MODEL ?? "gpt-6-luna",
    traceRoot: "traces",
    log,
  };
}
