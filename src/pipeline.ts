import * as context from "./context.ts";
import { SetupError } from "./errors.ts";
import { escalationReply } from "./escalation.ts";
import { screenMessage } from "./guards.ts";
import type { Reply } from "./reply.ts";
import { DraftingError, type CreateResponse, type Step, type Trace } from "./model-calls.ts";
import { respondBaseline } from "./responder.ts";
import { respondWithSkills, type SkillResponderTrace } from "./skill-responder.ts";
import { loadSkillRegistry, statusModule, type SkillRegistry } from "./skills.ts";
import type { ResponderTrace } from "./tool-loop.ts";
import { buildStateCard, recentTurns } from "./state-card.ts";
import { triage, type TriageTrace } from "./triage.ts";

// "default" runs guards and triage first. "baseline" is the original prompt alone, kept as the "before".
export const MODES = ["default", "baseline"] as const;
export type Mode = (typeof MODES)[number];

export function parseMode(value: string | undefined): Mode {
  const mode = value ?? "default";
  if (!MODES.includes(mode as Mode)) {
    throw new Error(`--mode must be one of: ${MODES.join(", ")}`);
  }
  return mode as Mode;
}

export interface PipelineOptions {
  create: CreateResponse;
  responderModel: string;
  triageModel: string;
}

// Which way a message went: escalated by a guard in code, escalated by triage, answered with skills,
// answered by the baseline prompt because a skill it needs doesn't exist yet, or failed to draft.
export type PipelinePath = "guard-escalation" | "triage-escalation" | "skills" | "baseline" | "drafting-failed";

// A step's trace without its model and tool calls, which the pipeline keeps in one list each.
type StepTrace<T extends Trace> = Omit<T, "modelCalls" | "toolCalls">;

export interface PipelineTrace extends Trace {
  path: PipelinePath | null;
  guards: { cardNumberFound: boolean; humanRequested: boolean };
  triage: StepTrace<TriageTrace> | null;
  responder: StepTrace<ResponderTrace | SkillResponderTrace> | null;
  fallback: "baseline" | null;
  fallbackReason: string | null;
}

const TRIAGE_TURNS = 4;

let registry: SkillRegistry | null = null;
// Read once per run, the first time a message needs it.
function skills(): SkillRegistry {
  registry ??= loadSkillRegistry();
  return registry;
}

function detachCalls<T extends Trace>({ modelCalls, toolCalls, ...rest }: T, into: PipelineTrace): StepTrace<T> {
  into.modelCalls.push(...modelCalls);
  into.toolCalls!.push(...(toolCalls ?? []));
  return rest;
}

// Why the skill-based responder can't take this message yet, or null when it can.
function fallbackReason(chosen: string[], pipelineStatus: string): string | null {
  const missing = chosen.filter((id) => !skills().has(id));
  if (missing.length > 0) return `No skill named ${missing.join(", ")}`;
  if (statusModule(pipelineStatus) === null) return `No module for Pipeline Status ${pipelineStatus}`;
  return null;
}

export async function respond(
  text: string,
  mode: Mode,
  options: PipelineOptions,
): Promise<{ reply: Reply; trace: Trace }> {
  const responderOptions = { create: options.create, model: options.responderModel };
  if (mode === "baseline") return respondBaseline(text, responderOptions);

  const screening = screenMessage(text);
  const trace: PipelineTrace = {
    path: null,
    guards: { cardNumberFound: screening.cardNumberFound, humanRequested: screening.humanRequested },
    triage: null,
    responder: null,
    fallback: null,
    fallbackReason: null,
    modelCalls: [],
    toolCalls: [],
  };
  if (screening.forceEscalate) {
    trace.path = "guard-escalation";
    return { reply: escalationReply(screening.forceEscalate.reason, screening.forceEscalate.cannotDo), trace };
  }

  let step: Step = "triage";
  try {
    const { decision, trace: triageTrace } = await triage(
      {
        message: screening.redactedText,
        stateCard: buildStateCard(context),
        recentTurns: recentTurns(context, TRIAGE_TURNS),
        skillIndex: skills().index(),
      },
      { create: options.create, model: options.triageModel },
    );
    trace.triage = detachCalls(triageTrace, trace);
    if (decision.escalate) {
      trace.path = "triage-escalation";
      return { reply: escalationReply(decision.escalationReason ?? "Triage escalated", decision.cannotDo), trace };
    }

    step = "responder";
    const reason = fallbackReason(decision.skills, context.PIPELINE_STATUS);
    if (reason) {
      // A message that needs a skill that doesn't exist yet still gets the original prompt's full rules.
      trace.path = "baseline";
      trace.fallback = "baseline";
      trace.fallbackReason = reason;
      const { reply, trace: responderTrace } = await respondBaseline(screening.redactedText, responderOptions);
      trace.responder = detachCalls(responderTrace, trace);
      return { reply, trace };
    }
    trace.path = "skills";
    const { reply, trace: responderTrace } = await respondWithSkills(
      screening.redactedText,
      { registry: skills(), chosen: decision.skills, patient: context },
      responderOptions,
    );
    trace.responder = detachCalls(responderTrace, trace);
    return { reply, trace };
  } catch (error) {
    if (error instanceof SetupError) throw error;
    // Each step throws a DraftingError carrying its own partial trace.
    if (error instanceof DraftingError) {
      if (step === "triage") trace.triage = detachCalls(error.trace as TriageTrace, trace);
      else trace.responder = detachCalls(error.trace as ResponderTrace, trace);
    }
    trace.path = "drafting-failed";
    throw new DraftingError(error instanceof Error ? error.message : String(error), trace);
  }
}
