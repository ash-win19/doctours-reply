import * as context from "./context.ts";
import { SetupError } from "./errors.ts";
import { escalationReply } from "./escalation.ts";
import { screenMessage } from "./guards.ts";
import type { Reply } from "./reply.ts";
import {
  DraftingError,
  type CreateResponse,
  type ModelCallTrace,
  type Step,
  type Trace,
} from "./model-calls.ts";
import { respondBaseline, type ResponderTrace } from "./responder.ts";
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

// Which way a message went: escalated by a guard in code, escalated by triage, answered, or failed to draft.
export type PipelinePath = "guard-escalation" | "triage-escalation" | "baseline" | "drafting-failed";

// A step's trace without its model calls, which the pipeline keeps in one list for token totals.
type StepTrace<T extends Trace> = Omit<T, "modelCalls">;

export interface PipelineTrace extends Trace {
  path: PipelinePath | null;
  guards: { cardNumberFound: boolean; humanRequested: boolean };
  triage: StepTrace<TriageTrace> | null;
  responder: StepTrace<ResponderTrace> | null;
}

const TRIAGE_TURNS = 4;

function detachModelCalls<T extends Trace>({ modelCalls, ...rest }: T, into: ModelCallTrace[]): StepTrace<T> {
  into.push(...modelCalls);
  return rest;
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
    modelCalls: [],
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
        skillIndex: [],
      },
      { create: options.create, model: options.triageModel },
    );
    trace.triage = detachModelCalls(triageTrace, trace.modelCalls);
    if (decision.escalate) {
      trace.path = "triage-escalation";
      return { reply: escalationReply(decision.escalationReason ?? "Triage escalated", decision.cannotDo), trace };
    }

    // Until the skill-based responder lands, anything that doesn't escalate goes to the original prompt.
    step = "responder";
    trace.path = "baseline";
    const { reply, trace: responderTrace } = await respondBaseline(screening.redactedText, responderOptions);
    trace.responder = detachModelCalls(responderTrace, trace.modelCalls);
    return { reply, trace };
  } catch (error) {
    if (error instanceof SetupError) throw error;
    // Each step throws a DraftingError carrying its own partial trace.
    if (error instanceof DraftingError) {
      if (step === "triage") trace.triage = detachModelCalls(error.trace as TriageTrace, trace.modelCalls);
      else trace.responder = detachModelCalls(error.trace as ResponderTrace, trace.modelCalls);
    }
    trace.path = "drafting-failed";
    throw new DraftingError(error instanceof Error ? error.message : String(error), trace);
  }
}
