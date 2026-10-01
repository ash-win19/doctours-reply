import type Groq from "groq-sdk";
import { z } from "zod";
import * as packet from "./packet-tools.ts";

const UserIdInput = z.object({ userId: z.string().optional() });
const ClinicInput = z.object({
  clinicId: z.string().optional(),
  clinicName: z.string().optional(),
});

interface ToolSpec<Input extends z.ZodType> {
  description: string;
  input: Input;
  run: (input: z.infer<Input>) => unknown;
}

function spec<Input extends z.ZodType>(toolSpec: ToolSpec<Input>): ToolSpec<z.ZodType> {
  return toolSpec as ToolSpec<z.ZodType>;
}

// Keyed by the names the system prompt uses. The prompt calls updateWorkingMemory without the Tool suffix.
const SPECS: Record<string, ToolSpec<z.ZodType>> = {
  getAllClinicsTool: spec({
    description: "Basic information for every clinic: name, id, slug, address, clinic_flags and ai_context.",
    input: z.object({}),
    run: () => packet.getAllClinics(),
  }),
  getClinicDoctorsTool: spec({
    description: "Doctors for one clinic, by clinic id or clinic name.",
    input: ClinicInput,
    run: packet.getClinicDoctors,
  }),
  getClinicPackagesTool: spec({
    description: "Packages for one clinic, by clinic id or clinic name: pricing, deposit, addons and bookable weekdays.",
    input: ClinicInput,
    run: packet.getClinicPackages,
  }),
  getConsultationRescheduleLinkTool: spec({
    description: "The trusted reschedule link for the patient's consultation call.",
    input: UserIdInput,
    run: packet.getConsultationRescheduleLink,
  }),
  getFullCallsTool: spec({
    description: "Full records of recent calls for a chat, including summaries and transcripts.",
    input: z.object({ chatId: z.string().optional(), limit: z.number().optional() }),
    run: packet.getFullCalls,
  }),
  getLatestAssessmentTool: spec({
    description: "The patient's latest assessment, including the assessment link and graft range.",
    input: UserIdInput,
    run: packet.getLatestAssessment,
  }),
  getPatientContextTool: spec({
    description: "Patient profile, pipeline status, clinic and package selection preferences, and tentative procedure dates.",
    input: UserIdInput,
    run: packet.getPatientContext,
  }),
  getPatientImagesTool: spec({
    description: "Which intake photo angles the patient has uploaded.",
    input: UserIdInput,
    run: packet.getPatientImages,
  }),
  getPaymentLinkTool: spec({
    description:
      'A trusted Payment link (type "payment", takes clinicPackageId) or Checkout link (type "checkout", takes clinicId).',
    input: z.object({
      clinicPackageId: z.string().optional(),
      type: z.string().optional(),
      clinicId: z.string().optional(),
    }),
    run: packet.getPaymentLink,
  }),
  getSavedClinicsTool: spec({
    description: "The clinics the patient's assessment matched them with.",
    input: UserIdInput,
    run: packet.getSavedClinics,
  }),
  issuePromoCodeTool: spec({
    description: "Issue a promo code to the patient if they are eligible.",
    input: UserIdInput,
    run: packet.issuePromoCode,
  }),
  updateUserTool: spec({
    description: "Save the patient's name. Only updates if no name is on file.",
    input: z.object({
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      userId: z.string().optional(),
    }),
    run: packet.updateUser,
  }),
  updateUserClinicPreferencesTool: spec({
    description:
      "Save clinic and package selection, soft interests, and tentativeProcedureDates ({text, strength}).",
    input: z.object({
      clinicSelection: z.record(z.string(), z.unknown()).optional(),
      userId: z.string().optional(),
    }),
    run: packet.updateUserClinicPreferences,
  }),
  updateWorkingMemory: spec({
    description: "Store or update conversation-relevant facts in working memory.",
    input: z.object({ memory: z.record(z.string(), z.unknown()).optional() }),
    run: packet.updateWorkingMemory,
  }),
};

function toParameters(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...jsonSchema } = z.toJSONSchema(schema) as Record<string, unknown>;
  return jsonSchema;
}

export type FunctionTool = Groq.Chat.ChatCompletionTool & { type: "function"; function: Groq.FunctionDefinition };

export function toolDefinition(name: string, description: string, input: z.ZodType): FunctionTool {
  return { type: "function", function: { name, description, parameters: toParameters(input) } };
}

export const TOOLS: FunctionTool[] = Object.entries(SPECS).map(([name, toolSpec]) =>
  toolDefinition(name, toolSpec.description, toolSpec.input),
);

export type ToolRun = { isError: false; output: unknown } | { isError: true; output: string };

export function runTool(name: string, input: unknown): ToolRun {
  const toolSpec = SPECS[name];
  if (!toolSpec) return { isError: true, output: `Unknown tool: ${name}` };
  const parsed = toolSpec.input.safeParse(input);
  if (!parsed.success) {
    return { isError: true, output: `Invalid input for ${name}: ${z.prettifyError(parsed.error)}` };
  }
  return { isError: false, output: toolSpec.run(parsed.data) ?? null };
}
