// The facts about a Patient that decide what a Reply may do, in a few lines for triage and the responder.

export interface ChatMessage {
  role: string;
  sender: string;
  text: string;
}

export interface StateCardContext {
  PATIENT_NAME: string | null;
  TIER: string;
  PIPELINE_STATUS: string;
  KLARNA_PAYPAL_FINANCING_ELIGIBLE: boolean | null;
  PATIENT_COUNTRY_CODE: string | null;
  COLLECTION_STATUS: string;
  PROMO_OFFER: unknown;
  SAVED_CLINIC_COUNT: number;
  SELECTED_CLINIC: unknown;
  CONSULTATION_TIME: string | null;
  RECENT_MEDIA_CONVERSATION: readonly ChatMessage[];
  CURRENT_DATE_TIME: string;
}

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
