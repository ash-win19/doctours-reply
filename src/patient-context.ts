import { readFileSync } from "node:fs";
import { z } from "zod";
import * as packet from "./context.ts";
import { PACKET_FUNCTION_NAMES } from "./tools.ts";

const ChatMessageSchema = z.looseObject({ role: z.string(), sender: z.string(), text: z.string() });

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
    // Null means Intake item status is worked out from the other fields.
    COLLECTION_STATUS: z.string().nullable(),
    WORKING_MEMORY: z.string(),
    CURRENT_DATE_TIME: z.string(),
    // A fixed result per packet function, such as getPatientImages, returned instead of running it.
    toolOverrides: z.partialRecord(z.enum(PACKET_FUNCTION_NAMES), z.unknown()).optional(),
  })
  .strict();

export type PatientContext = z.infer<typeof PatientContextSchema>;

export const PACKET_CONTEXT: PatientContext = PatientContextSchema.parse({ ...packet });

// The packet's Patient, or the Patient in a JSON file merged over the packet's constants.
export function loadContext(path?: string): PatientContext {
  if (!path) return PACKET_CONTEXT;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`No context file at ${path}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  const parsed = PatientContextSchema.partial().safeParse(json);
  if (!parsed.success) throw new Error(`${path} is not a valid Patient context\n${z.prettifyError(parsed.error)}`);
  // The packet's Intake item status describes the packet Patient, so another Patient's is worked out unless the file sets it.
  return PatientContextSchema.parse({ ...PACKET_CONTEXT, COLLECTION_STATUS: null, ...parsed.data });
}
