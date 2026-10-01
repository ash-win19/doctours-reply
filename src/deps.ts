import Groq from "groq-sdk";
import { SetupError, type RunnerDeps } from "./runner.ts";

export const log = (line: string) => process.stderr.write(`${line}\n`);

// Read now so the setting is in one place. Baseline mode has no triage step, so nothing uses it yet.
export const TRIAGE_MODEL = process.env.TRIAGE_MODEL ?? "openai/gpt-oss-20b";

// Errors every message would hit the same way, so the run stops instead of escalating each one.
// 413 means one request is bigger than the account's tokens-per-minute limit, which retrying can't fix.
const SETUP_ERROR_STATUSES = new Set([401, 403, 404, 413]);

export function toSetupError(error: unknown): SetupError | null {
  if (error instanceof Groq.APIError && error.status !== undefined && SETUP_ERROR_STATUSES.has(error.status)) {
    return new SetupError(`Groq ${error.status}: ${error.message}`);
  }
  return null;
}

export function defaultRunnerDeps(): RunnerDeps {
  if (!process.env.GROQ_API_KEY) {
    throw new SetupError("Set GROQ_API_KEY before running");
  }
  // Four messages run at once, so rate limits are expected. The SDK backs off and honors retry-after.
  const client = new Groq({ maxRetries: 6 });
  return {
    create: async (params) => {
      try {
        return await client.chat.completions.create(params);
      } catch (error) {
        throw toSetupError(error) ?? error;
      }
    },
    responderModel: process.env.RESPONDER_MODEL ?? "openai/gpt-oss-120b",
    traceRoot: "traces",
    log,
  };
}
