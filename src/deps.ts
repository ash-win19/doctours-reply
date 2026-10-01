import Anthropic from "@anthropic-ai/sdk";
import { SetupError, type RunnerDeps } from "./runner.ts";

export const log = (line: string) => process.stderr.write(`${line}\n`);

// Read now so the setting is in one place. Baseline mode has no triage step, so nothing uses it yet.
export const TRIAGE_MODEL = process.env.TRIAGE_MODEL ?? "claude-haiku-4-5-20251001";

export function defaultRunnerDeps(): RunnerDeps {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new SetupError("Set ANTHROPIC_API_KEY before running");
  }
  const client = new Anthropic();
  return {
    create: async (params) => {
      try {
        return await client.messages.create(params);
      } catch (error) {
        if (
          error instanceof Anthropic.AuthenticationError ||
          error instanceof Anthropic.PermissionDeniedError ||
          error instanceof Anthropic.NotFoundError
        ) {
          throw new SetupError(`${error.constructor.name}: ${error.message}`);
        }
        throw error;
      }
    },
    responderModel: process.env.RESPONDER_MODEL ?? "claude-sonnet-5",
    traceRoot: "traces",
    log,
  };
}
