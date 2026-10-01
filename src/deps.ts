import { ApiError, GoogleGenAI } from "@google/genai";
import { createRateLimiter, realClock, withRetries } from "./rate-limit.ts";
import { SetupError, type RunnerDeps } from "./runner.ts";

export const log = (line: string) => process.stderr.write(`${line}\n`);

// Read now so the setting is in one place. Baseline mode has no triage step, so nothing uses it yet.
export const TRIAGE_MODEL = process.env.TRIAGE_MODEL ?? "gemini-3.5-flash-lite";

// Gemini's free tier allowed 5 requests per minute per model when this was written.
const DEFAULT_REQUESTS_PER_MINUTE = 5;
const ATTEMPTS = 8;

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
  const requestsPerMinute = Number(process.env.REQUESTS_PER_MINUTE ?? DEFAULT_REQUESTS_PER_MINUTE);
  if (!Number.isInteger(requestsPerMinute) || requestsPerMinute < 1) {
    throw new SetupError("REQUESTS_PER_MINUTE must be a whole number of at least 1");
  }
  // Retries are ours, so they go through the same pacing as first attempts.
  const client = new GoogleGenAI({ apiKey, httpOptions: { retryOptions: { attempts: 1 } } });
  const acquire = createRateLimiter(requestsPerMinute, realClock);
  return {
    generate: (params) =>
      withRetries(
        async () => {
          await acquire();
          try {
            return await client.models.generateContent(params);
          } catch (error) {
            throw toSetupError(error) ?? error;
          }
        },
        { ...realClock, attempts: ATTEMPTS, log },
      ),
    responderModel: process.env.RESPONDER_MODEL ?? "gemini-3.5-flash-lite",
    traceRoot: "traces",
    log,
  };
}
