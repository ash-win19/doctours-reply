import { z } from "zod";

// Matches the packet's Reply and WorkingMemoryUpdates interfaces field for field.
export const WorkingMemoryUpdatesSchema = z.object({
  collectionState: z
    .object({
      areaAskCount: z.number().nullable().optional(),
      lastAskedItem: z.enum(["area", "name", "photos", "none"]).nullable().optional(),
      nameAskCount: z.number().nullable().optional(),
      photoAskCount: z.number().nullable().optional(),
    })
    .nullable()
    .optional(),
  communicationStyle: z
    .enum(["detailed", "concise", "casual", "formal", "unknown"])
    .nullable()
    .optional(),
  escalationFlags: z.string().nullable().optional(),
  keyConcerns: z.string().nullable().optional(),
  patientName: z.string().nullable().optional(),
  preferredPaymentMethod: z
    .enum(["financing", "layaway", "pay_in_full", "cash_preference", "unknown"])
    .nullable()
    .optional(),
  procedureArea: z.string().nullable().optional(),
  promisesMade: z.string().nullable().optional(),
  targetProcedureWindow: z
    .enum([
      "within_3_months",
      "within_6_months",
      "within_8_months",
      "within_12_months",
      "over_12_months",
      "unknown",
    ])
    .nullable()
    .optional(),
});

export const ReplySchema = z.object({
  response: z.string(),
  escalate: z.boolean(),
  escalationReason: z.string().nullable(),
  templateId: z.string().nullable(),
  intent: z.string(),
  shouldFollowUp: z.boolean(),
  followUpTiming: z.string().nullable(),
  attachmentUrls: z.array(z.string()).nullable(),
  highEngagement: z.boolean(),
  workingMemoryUpdates: WorkingMemoryUpdatesSchema.nullable(),
});

export type WorkingMemoryUpdates = z.infer<typeof WorkingMemoryUpdatesSchema>;
export type Reply = z.infer<typeof ReplySchema>;
