import type { PatientContext } from "./patient-context.ts";

// The facts about a Patient that decide what a Reply may do, in a few lines for triage and the responder.

export type ChatMessage = PatientContext["RECENT_MEDIA_CONVERSATION"][number];

export type StateCardContext = Pick<
  PatientContext,
  | "PATIENT_NAME"
  | "TIER"
  | "PIPELINE_STATUS"
  | "KLARNA_PAYPAL_FINANCING_ELIGIBLE"
  | "PATIENT_COUNTRY_CODE"
  | "COLLECTION_STATUS"
  | "PROMO_OFFER"
  | "SAVED_CLINIC_COUNT"
  | "SELECTED_CLINIC"
  | "CONSULTATION_TIME"
  | "RECENT_MEDIA_CONVERSATION"
  | "CURRENT_DATE_TIME"
>;

const URL_PATTERN = /https?:\/\/\S+/g;

function financing(eligible: boolean | null): string {
  if (eligible === true) return "eligible";
  if (eligible === false) return "not eligible";
  return "unknown";
}

function clinicName(selected: unknown): string {
  if (selected == null) return "none";
  if (typeof selected === "string") return selected;
  if (typeof selected === "object" && "name" in selected && typeof selected.name === "string") return selected.name;
  return JSON.stringify(selected);
}

// Every URL the Coordinator already sent, in the order first sent.
export function linksAlreadySent(messages: readonly ChatMessage[]): string[] {
  const urls = messages.filter((message) => message.role === "assistant").flatMap((message) => message.text.match(URL_PATTERN) ?? []);
  return [...new Set(urls)];
}

export function buildStateCard(context: StateCardContext): string {
  const links = linksAlreadySent(context.RECENT_MEDIA_CONVERSATION);
  const coordinatorHasWritten = context.RECENT_MEDIA_CONVERSATION.some((message) => message.role === "assistant");
  return [
    `Patient name: ${context.PATIENT_NAME ?? "unknown"}`,
    `Tier: ${context.TIER}`,
    `Pipeline Status: ${context.PIPELINE_STATUS}`,
    `Financing (Klarna/PayPal): ${financing(context.KLARNA_PAYPAL_FINANCING_ELIGIBLE)}, home country ${context.PATIENT_COUNTRY_CODE ?? "unknown"}`,
    `Intake items: ${context.COLLECTION_STATUS}`,
    `Promo: ${context.PROMO_OFFER == null ? "none" : JSON.stringify(context.PROMO_OFFER)}`,
    `Matched clinics: ${context.SAVED_CLINIC_COUNT}`,
    `Selected clinic: ${clinicName(context.SELECTED_CLINIC)}`,
    `Consultation: ${context.CONSULTATION_TIME ?? "none scheduled"}`,
    `Links already sent: ${links.length ? links.join(", ") : "none"}`,
    coordinatorHasWritten
      ? "First contact: no, the Coordinator has already written in this thread"
      : "First contact: yes, the Coordinator has not written in this thread yet",
    `Current time: ${context.CURRENT_DATE_TIME}`,
  ].join("\n");
}

// The last few messages of the chat, oldest first, as "Sender: text".
export function recentTurns(context: Pick<StateCardContext, "RECENT_MEDIA_CONVERSATION">, count: number): string[] {
  return context.RECENT_MEDIA_CONVERSATION.slice(-count).map((message) => `${message.sender}: ${message.text}`);
}
