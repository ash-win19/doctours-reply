import { readFileSync } from "node:fs";
import * as context from "./context.ts";
import { buildStateCard, type StateCardContext } from "./state-card.ts";
import { CLINIC_PAGE_TEMPLATE, MAX_ATTACHMENTS, STATIC_URLS } from "./validator.ts";

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

export interface SkillSummary {
  id: string;
  description: string;
}

function skillList(skillIndex: SkillSummary[]): string {
  return skillIndex.length ? skillIndex.map(({ id, description }) => `- ${id}: ${description}`).join("\n") : "No skills yet.";
}

export function buildTriageSystemPrompt(skillIndex: SkillSummary[]): string {
  return fill(readPrompt("triage/system.md"), {
    ESCALATION_POLICY: readPrompt("triage/escalation-policy.md"),
    SKILL_INDEX: skillList(skillIndex),
  });
}

export function buildTriageUserMessage(input: { message: string; stateCard: string; recentTurns: string[] }): string {
  return fill(readPrompt("triage/user.md"), {
    STATE_CARD: input.stateCard,
    RECENT_TURNS: input.recentTurns.length ? input.recentTurns.join("\n") : "No messages yet.",
    MESSAGE: input.message,
  });
}

export interface CoreContext extends StateCardContext {
  COORDINATOR_DISPLAY_NAME: string;
  CLINIC_FLAGS: string;
  RECENT_CALLS: string;
  WORKING_MEMORY: string;
  CHAT_LIST: string;
  SENDER_DISPLAY_NAME: string;
}

// The rules every message needs, plus the Patient's state card, working memory and chat history.
export function buildCorePrompt(patient: CoreContext, skillIndex: SkillSummary[]): string {
  return fill(readPrompt("core.md"), {
    COORDINATOR_DISPLAY_NAME: patient.COORDINATOR_DISPLAY_NAME,
    SKILL_INDEX: skillList(skillIndex),
    // The validator enforces the same allowlist, so both come from its constants.
    STATIC_URLS: STATIC_URLS.map(({ url, use }) => `${url} (${use})`).join(", "),
    CLINIC_PAGE: CLINIC_PAGE_TEMPLATE,
    MAX_ATTACHMENTS: String(MAX_ATTACHMENTS),
    STATE_CARD: buildStateCard(patient),
    CLINIC_FLAGS: patient.CLINIC_FLAGS,
    RECENT_CALLS: patient.RECENT_CALLS,
    WORKING_MEMORY: patient.WORKING_MEMORY,
    CHAT_LIST: patient.CHAT_LIST,
  });
}

type SkillText = { id: string; text: string; overrides: string[] };

// A loaded skill under its own heading, with the rules it beats, as it appears in the system prompt or a loadSkill result.
export function formatSkill({ id, text, overrides }: SkillText): string {
  return [`# SKILL: ${id}`, ...(overrides.length ? [`Overrides: ${overrides.join("; ")}`] : []), text].join("\n");
}

// Core first, then the Pipeline Status module, then each loaded skill.
export function buildResponderSystemPrompt({
  core,
  status,
  skills,
}: {
  core: string;
  status: string | null;
  skills: SkillText[];
}): string {
  return [core, ...(status ? [status] : []), ...skills.map(formatSkill)].join("\n\n");
}

export function buildResponderUserMessage(message: string, patient: Pick<CoreContext, "SENDER_DISPLAY_NAME">): string {
  return fill(readPrompt("responder/user.md"), { MESSAGE: message, SENDER_DISPLAY_NAME: patient.SENDER_DISPLAY_NAME });
}
