import OpenAI from "openai";
import { SetupError, type RunnerDeps } from "./runner.ts";

export const log = (line: string) => process.stderr.write(`${line}\n`);

// Read now so the setting is in one place. Baseline mode has no triage step, so nothing uses it yet.
export const TRIAGE_MODEL = process.env.TRIAGE_MODEL ?? "gpt-6-luna";

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
  // The SDK retries rate limits and server errors with backoff and honors retry-after.
  const client = new OpenAI({ maxRetries: 6 });
  return {
    create: async (params) => {
      try {
        return await client.responses.create(params);
      } catch (error) {
        throw toSetupError(error) ?? error;
      }
    },
    responderModel: process.env.RESPONDER_MODEL ?? "gpt-6.1-sol",
    traceRoot: "traces",
    log,
  };
}
