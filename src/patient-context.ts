import { readFileSync } from "node:fs";
import { z } from "zod";
import * as packet from "./context.ts";
import { parseJsonAs } from "./json.ts";
import { TOOL_NAMES } from "./tools.ts";

const ChatMessageSchema = z.looseObject({ role: z.string(), sender: z.string(), text: z.string() });

// Fixed tool results for one Patient. A key can name the tool (getPatientImagesTool) or the packet function behind it
// (getPatientImages), and is stored by tool name.
const ToolOverridesSchema = z.record(z.string(), z.unknown()).transform((overrides, ctx) => {
  const byTool: Partial<Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(overrides)) {
    const tool = TOOL_NAMES.includes(key) ? key : `${key}Tool`;
    if (!TOOL_NAMES.includes(tool)) {
      ctx.addIssue({ code: "custom", message: `No tool or packet function named ${key}`, path: [key] });
    } else if (tool in byTool) {
      ctx.addIssue({ code: "custom", message: `${key} is overridden twice`, path: [key] });
    } else {
      byTool[tool] = value;
    }
  }
  return byTool;
});

// Every packet constant, so another Patient can be swapped in for the packet's.
export const PatientContextSchema = z
  .object({
    PATIENT_SUMMARY: z.string(),
    CLINIC_FLAGS: z.string(),
    RECENT_CALLS: z.string(),
    CHAT_LIST: z.string(),
    RECENT_CONVERSATION_SUMMARY: z.string(),
    TIER: z.string(),
    PATIENT_NAME: z.string().nullable(),
    PROCEDURE_AREA: z.string().nullable(),
    OPENER_TYPE: z.string().nullable(),
    PATIENT_EMAIL: z.string().nullable(),
    PATIENT_PHONE: z.string().nullable(),
    PATIENT_COUNTRY_CODE: z.string().nullable(),
    KLARNA_PAYPAL_FINANCING_ELIGIBLE: z.boolean().nullable(),
    PATIENT_SEX: z.string().nullable(),
    PROMO_OFFER: z.record(z.string(), z.unknown()).nullable(),
    PIPELINE_STATUS: z.string(),
    CONSULTATION_TIME: z.string().nullable(),
    CONSULTATION_ID: z.string().nullable(),
    SELECTED_CLINIC: z.union([z.string(), z.record(z.string(), z.unknown())]).nullable(),
    HAS_ACTIVE_BOOKING: z.boolean(),
    BOOKINGS: z.array(z.unknown()),
    PROCEDURE_INTEREST: z.string().nullable(),
    ESTIMATED_GRAFTS: z.number().nullable(),
    GRAFT_RANGE: z.object({ max: z.number(), min: z.number() }).nullable(),
    GRAFTS: z.number().nullable(),
    SAVED_CLINIC_COUNT: z.number().int().nonnegative(),
    WEBSITE_INTAKE_QA: z.array(z.object({ answer: z.string(), question: z.string() })),
    HAS_PATIENT_IMAGES: z.boolean(),
    PATIENT_IMAGE_COUNT: z.number().int().nonnegative(),
    CHAT_KIND: z.string(),
    COORDINATOR_DISPLAY_NAME: z.string(),
    RECENT_MEDIA_CONVERSATION: z.array(ChatMessageSchema),
    SENDER_PARTICIPANT_ID: z.string(),
    SENDER_PARTICIPANT_ROLE: z.string(),
    SENDER_DISPLAY_NAME: z.string(),
    SENDER_USER_ID: z.string(),
    THREAD_ID: z.string(),
    RESOURCE_ID: z.string(),
    USER_ID: z.string(),
    SUPABASE_CHAT_ID: z.string(),
    // The Intake item status line. A context file that leaves it out gets it worked out from its own fields.
    COLLECTION_STATUS: z.string(),
    WORKING_MEMORY: z.string(),
    CURRENT_DATE_TIME: z.string(),
    // A fixed result per tool, returned instead of running its packet function.
    toolOverrides: ToolOverridesSchema.optional(),
  })
  .strict();

export type PatientContext = z.infer<typeof PatientContextSchema>;

export const PACKET_CONTEXT: PatientContext = PatientContextSchema.parse({ ...packet });

type IntakeFields = Pick<PatientContext, "PATIENT_NAME" | "PROCEDURE_AREA" | "HAS_PATIENT_IMAGES" | "PATIENT_IMAGE_COUNT" | "WORKING_MEMORY">;

interface RememberedIntake {
  patientName?: unknown;
  procedureArea?: unknown;
  collectionState?: { areaAskCount?: number; nameAskCount?: number; photoAskCount?: number } | null;
}

function remembered(workingMemory: string): RememberedIntake {
  try {
    return (JSON.parse(workingMemory) as RememberedIntake | null) ?? {};
  } catch {
    // Unreadable working memory counts as nothing remembered and no asks yet.
    return {};
  }
}

// One rule for "known": a non-empty value from the context fields or from working memory.
function known(...values: unknown[]): string | null {
  const value = values.find((candidate) => typeof candidate === "string" && candidate.trim() !== "");
  return typeof value === "string" ? value.trim() : null;
}

// The Collection Status line in the packet's format. An item is satisfied when the context or working memory has it,
// and the ask counts come from working memory.
export function workOutCollectionStatus(context: IntakeFields): string {
  const memory = remembered(context.WORKING_MEMORY);
  const asked = memory.collectionState ?? {};
  const area = known(context.PROCEDURE_AREA, memory.procedureArea);
  const name = known(context.PATIENT_NAME, memory.patientName);
  const photos = context.HAS_PATIENT_IMAGES || context.PATIENT_IMAGE_COUNT > 0;
  const items = [
    { item: "area", known: area !== null, status: area ? `area ${area}` : "area MISSING", asks: asked.areaAskCount ?? 0 },
    { item: "name", known: name !== null, status: name ? "name on file" : "name MISSING", asks: asked.nameAskCount ?? 0 },
    { item: "photos", known: photos, status: photos ? "photos received" : "photos MISSING", asks: asked.photoAskCount ?? 0 },
  ];
  const next = items.find((intake) => !intake.known && intake.asks < 1);
  const anchor = next
    ? `Next collection anchor: ${next.item}.`
    : items.every((intake) => intake.known)
      ? "Everything is collected -- add NO anchor."
      : "Every missing item has been asked -- add NO anchor.";
  const [areaAsks, nameAsks, photoAsks] = items.map((intake) => intake.asks);
  return `${items.map((intake) => intake.status).join("; ")}. Asks so far -- area ${areaAsks}, name ${nameAsks}, photos ${photoAsks} (budget 1 each). ${anchor}`;
}

// The packet's Patient, or the Patient in a JSON file merged over the packet's constants.
export function loadContext(path?: string): PatientContext {
  if (!path) return PACKET_CONTEXT;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`No context file at ${path}`);
  }
  const file = parseJsonAs(raw, PatientContextSchema.partial(), path, "is not a valid Patient context");
  const merged = { ...PACKET_CONTEXT, ...file };
  // The packet's Intake item status describes the packet Patient, so another Patient's is worked out unless the file sets it.
  return PatientContextSchema.parse({ ...merged, COLLECTION_STATUS: file.COLLECTION_STATUS ?? workOutCollectionStatus(merged) });
}
