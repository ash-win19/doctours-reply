import { z } from "zod";
import { escalationReply } from "./escalation.ts";
import { DraftingError, asDraftingError, type ModelOptions } from "./model-calls.ts";
import {
  buildCorePrompt,
  buildResponderSystemPrompt,
  buildResponderUserMessage,
  formatSkill,
} from "./prompt.ts";
import type { PatientContext } from "./patient-context.ts";
import type { Reply } from "./reply.ts";
import type { Skill, SkillRegistry } from "./skills.ts";
import { SUBAGENT_TOOLS, isSubagentTool, type SubagentRecord } from "./subagent-tools.ts";
import { runToolLoop, type ResponderTrace, type ToolOutcome } from "./tool-loop.ts";
import { toolDefinition, toolsNamed, type SubagentToolName } from "./tools.ts";
import {
  emptyEvidence,
  emptyValidationTrace,
  runToolForEvidence,
  validatingSubmit,
  type ValidationTrace,
} from "./validator.ts";

export interface SkillResponderTrace extends ResponderTrace {
  // Skills triage chose, and skills the responder loaded mid-turn with loadSkill.
  skills: { chosen: string[]; loaded: string[] };
  // One record per subagent call. Their model calls are in modelCalls too, under their own step.
  subagents: SubagentRecord[];
  validation: ValidationTrace;
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
  patient: PatientContext;
  // The module for the Patient's Pipeline Status, which code picks.
  status: string;
  // Card digit runs in the Patient's raw message, which the validator keeps out of the Reply.
  inputCardDigits?: string[];
  // The small model subagents run on. Defaults to the responder's model.
  subagentModel?: string;
}

// Writes the Reply from the core, the Pipeline Status module and the chosen skills, with only those skills' tools.
export async function respondWithSkills(
  message: string,
  { registry, chosen, patient, status, inputCardDigits = [], subagentModel }: SkillResponderInput,
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
    validation: emptyValidationTrace(),
  };
  const evidence = emptyEvidence(inputCardDigits);
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

  // Only the subagent's short answer comes back, so what it read never enters this context.
  // A subagent that fails still leaves its record, and the message fails like any other drafting failure.
  async function runSubagent(name: SubagentToolName, input: unknown): Promise<ToolOutcome> {
    const tool = SUBAGENT_TOOLS[name];
    const parsed = tool.input.safeParse(input);
    if (!parsed.success) return { isError: true, output: `Invalid input for ${name}: ${z.prettifyError(parsed.error)}` };
    const run = await tool.run(parsed.data, { create: options.create, model: subagentModel ?? options.model }, patient);
    const { modelCalls, ...record } = run.trace;
    trace.modelCalls.push(...modelCalls);
    trace.subagents.push(record);
    if (run.answer === null) throw new DraftingError(`${name} failed: ${record.error}`, trace);
    return { isError: false, output: run.answer };
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
    // A subagent's answer is a model's summary, not tool data, so it never becomes evidence for the validator.
    if (isSubagentTool(name)) return runSubagent(name, input);
    return runToolForEvidence(name, input, patient, evidence);
  }

  const submit = validatingSubmit(evidence, trace.validation);

  try {
    const reply = await runToolLoop(
      {
        trace,
        tools: () => [
          ...toolsNamed(allowedTools()),
          ...allowedTools()
            .filter(isSubagentTool)
            .map((name) => SUBAGENT_TOOLS[name].definition),
          loadSkillTool,
          escalateTool,
        ],
        callTool,
        // Only the escalate tool escalates, so a submitted Reply never does.
        onSubmit: (submitted) => submit({ ...submitted, escalate: false, escalationReason: null }),
      },
      options,
    );
    return { reply, trace };
  } catch (error) {
    throw asDraftingError(error, trace);
  }
}
