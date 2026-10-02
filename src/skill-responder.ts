import { z } from "zod";
import { ASK_CALL_HISTORY, AskCallHistoryInput, askCallHistory, askCallHistoryTool } from "./call-history.ts";
import { SetupError } from "./errors.ts";
import { escalationReply } from "./escalation.ts";
import { DraftingError, asDraftingError, tokenUsage, type ModelOptions } from "./model-calls.ts";
import {
  buildCorePrompt,
  buildResponderSystemPrompt,
  buildResponderUserMessage,
  formatSkill,
  type CoreContext,
} from "./prompt.ts";
import type { Reply } from "./reply.ts";
import type { Skill, SkillRegistry } from "./skills.ts";
import { runToolLoop, type ResponderTrace, type ToolOutcome } from "./tool-loop.ts";
import { runTool, toolDefinition, toolsNamed } from "./tools.ts";

// One subagent call made for this message. Its model calls are also in modelCalls, under their own step.
export interface SubagentRecord {
  subagent: "callHistory";
  question: string;
  answer: string;
  callIds: string[];
  usage: { inputTokens: number; outputTokens: number };
  latencyMs: number;
}

export interface SkillResponderTrace extends ResponderTrace {
  // Skills triage chose, and skills the responder loaded mid-turn with loadSkill.
  skills: { chosen: string[]; loaded: string[] };
  subagents: SubagentRecord[];
}

const LOAD_SKILL = "loadSkill";
const ESCALATE = "escalate";

const LoadSkillInput = z.object({ id: z.string() });
const EscalateInput = z.object({ reason: z.string(), cannotDo: z.string().nullable() });

const escalateTool = toolDefinition(
  ESCALATE,
  "Escalate to an Operator, who takes over the conversation, when the patient asks for something only a person can do. Ends the turn.",
  EscalateInput,
);

export interface SkillResponderInput {
  registry: SkillRegistry;
  // Skill ids triage chose. All must be in the registry.
  chosen: string[];
  patient: CoreContext & { SUPABASE_CHAT_ID: string };
  // The module for the Patient's Pipeline Status, which code picks.
  status: string | null;
  // The small model subagents run on. Defaults to the responder's model.
  subagentModel?: string;
}

// Writes the Reply from the core, the Pipeline Status module and the chosen skills, with only those skills' tools.
export async function respondWithSkills(
  message: string,
  { registry, chosen, patient, status, subagentModel }: SkillResponderInput,
  options: ModelOptions,
): Promise<{ reply: Reply; trace: SkillResponderTrace }> {
  const loaded: Skill[] = registry.resolve(chosen);
  const skillIds = registry.index().map(({ id }) => id);
  const trace: SkillResponderTrace = {
    system: buildResponderSystemPrompt({
      core: buildCorePrompt(patient, registry.index()),
      status,
      skills: loaded,
    }),
    userMessage: buildResponderUserMessage(message, patient),
    skills: { chosen, loaded: [] },
    subagents: [],
    modelCalls: [],
    toolCalls: [],
    finalOutput: null,
  };
  const loadSkillTool = toolDefinition(
    LOAD_SKILL,
    "Load another skill's rules and tools when this message needs rules you don't have.",
    z.object({ id: z.enum(skillIds as [string, ...string[]]) }),
  );
  const allowedTools = () => [...new Set(loaded.flatMap((skill) => skill.tools))];

  function loadSkill(input: unknown): ToolOutcome {
    const parsed = LoadSkillInput.safeParse(input);
    if (!parsed.success) return { isError: true, output: `${LOAD_SKILL} takes { id }` };
    const { id } = parsed.data;
    if (!registry.has(id)) return { isError: true, output: `No skill named ${id}. Skills: ${skillIds.join(", ")}` };
    const added = registry.resolve([id]).filter((skill) => !loaded.some((already) => already.id === skill.id));
    if (added.length === 0) return { isError: false, output: `${id} is already loaded.` };
    loaded.push(...added);
    trace.skills.loaded.push(...added.map((skill) => skill.id));
    return { isError: false, output: added.map(formatSkill).join("\n\n") };
  }

  // Only the subagent's short answer comes back, so call transcripts never enter this context.
  async function askCalls(input: unknown): Promise<ToolOutcome> {
    const parsed = AskCallHistoryInput.safeParse(input);
    if (!parsed.success) return { isError: true, output: `${ASK_CALL_HISTORY} takes { question }` };
    const { question } = parsed.data;
    try {
      const result = await askCallHistory(
        question,
        { create: options.create, model: subagentModel ?? options.model },
        { chatId: patient.SUPABASE_CHAT_ID },
      );
      trace.modelCalls.push(...result.trace.modelCalls);
      trace.subagents.push({
        subagent: "callHistory",
        question,
        answer: result.answer,
        callIds: result.callIds,
        usage: tokenUsage(result.trace),
        latencyMs: result.trace.modelCalls.reduce((total, call) => total + call.latencyMs, 0),
      });
      return { isError: false, output: result.answer };
    } catch (error) {
      if (error instanceof DraftingError) trace.modelCalls.push(...error.trace.modelCalls);
      if (error instanceof SetupError) throw error;
      throw new DraftingError(`Call history: ${error instanceof Error ? error.message : String(error)}`, trace);
    }
  }

  function callTool(name: string, input: unknown): ToolOutcome | Promise<ToolOutcome> {
    if (name === LOAD_SKILL) return loadSkill(input);
    if (name === ESCALATE) {
      const parsed = EscalateInput.safeParse(input);
      if (!parsed.success) return { isError: true, output: `${ESCALATE} takes { reason, cannotDo }` };
      return { reply: escalationReply(parsed.data.reason, parsed.data.cannotDo) };
    }
    if (!allowedTools().includes(name)) {
      return { isError: true, output: `${name} isn't available. Load the skill that has it with ${LOAD_SKILL}.` };
    }
    if (name === ASK_CALL_HISTORY) return askCalls(input);
    return runTool(name, input);
  }

  try {
    const reply = await runToolLoop(
      {
        trace,
        tools: () => [
          ...toolsNamed(allowedTools()),
          ...(allowedTools().includes(ASK_CALL_HISTORY) ? [askCallHistoryTool] : []),
          loadSkillTool,
          escalateTool,
        ],
        callTool,
        // Only the escalate tool escalates, so a submitted Reply never does.
        onSubmit: (submitted) => ({ ...submitted, templateId: null, escalate: false, escalationReason: null }),
      },
      options,
    );
    return { reply, trace };
  } catch (error) {
    throw asDraftingError(error, trace);
  }
}
