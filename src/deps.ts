import Groq from "groq-sdk";
import { SetupError, type RunnerDeps } from "./runner.ts";

export const log = (line: string) => process.stderr.write(`${line}\n`);

// Read now so the setting is in one place. Baseline mode has no triage step, so nothing uses it yet.
export const TRIAGE_MODEL = process.env.TRIAGE_MODEL ?? "openai/gpt-oss-20b";

export function defaultRunnerDeps(): RunnerDeps {
  if (!process.env.GROQ_API_KEY) {
    throw new SetupError("Set GROQ_API_KEY before running");
  }
  const client = new Groq();
  return {
    create: async (params) => {
      try {
        return await client.chat.completions.create(params);
      } catch (error) {
        if (
          error instanceof Groq.AuthenticationError ||
          error instanceof Groq.PermissionDeniedError ||
          error instanceof Groq.NotFoundError
        ) {
          throw new SetupError(`${error.constructor.name}: ${error.message}`);
        }
        throw error;
      }
    },
    responderModel: process.env.RESPONDER_MODEL ?? "openai/gpt-oss-120b",
    traceRoot: "traces",
    log,
  };
}
