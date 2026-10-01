import { ApiError, GoogleGenAI } from "@google/genai";
import { SetupError, type RunnerDeps } from "./runner.ts";

export const log = (line: string) => process.stderr.write(`${line}\n`);

// Read now so the setting is in one place. Baseline mode has no triage step, so nothing uses it yet.
export const TRIAGE_MODEL = process.env.TRIAGE_MODEL ?? "gemini-3.5-flash-lite";

// Errors every message would hit the same way, so the run stops instead of escalating each one.
// Gemini answers a bad API key with 400.
const SETUP_ERROR_STATUSES = new Set([400, 401, 403, 404]);

export function toSetupError(error: unknown): SetupError | null {
  if (error instanceof ApiError && SETUP_ERROR_STATUSES.has(error.status)) {
    return new SetupError(`Gemini ${error.status}: ${error.message}`);
  }
  return null;
}

export function defaultRunnerDeps(): RunnerDeps {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new SetupError("Set GEMINI_API_KEY before running");
  }
  // The free tier has low per-minute limits and four messages run at once, so 429s are expected.
  // The SDK retries them with exponential backoff, up to a minute between attempts.
  const client = new GoogleGenAI({ apiKey, httpOptions: { retryOptions: { attempts: 8 } } });
  return {
    generate: async (params) => {
      try {
        return await client.models.generateContent(params);
      } catch (error) {
        throw toSetupError(error) ?? error;
      }
    },
    responderModel: process.env.RESPONDER_MODEL ?? "gemini-3.8-flash",
    traceRoot: "traces",
    log,
  };
}
