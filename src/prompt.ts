import { readFileSync } from "node:fs";
import * as context from "./context.ts";

const PROMPTS_DIR = new URL("../prompts/", import.meta.url);

function readPrompt(path: string): string {
  return readFileSync(new URL(path, PROMPTS_DIR), "utf8").trimEnd();
}

function fill(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (placeholder, name: string) => {
    if (!(name in values)) {
      throw new Error(`No value for placeholder ${placeholder}`);
    }
    const value = values[name];
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

// The packet's Flow: each {{NAME}} in the system prompt takes the constant of the same name.
export function buildBaselineSystemPrompt(): string {
  return fill(readPrompt("baseline/system.md"), context);
}

export function buildBaselineUserMessage(humanMessage: string): string {
  return fill(readPrompt("baseline/user.md"), {
    HUMAN_MESSAGE: humanMessage,
    RECENT_CONVERSATION_SUMMARY: context.RECENT_CONVERSATION_SUMMARY,
  });
}
