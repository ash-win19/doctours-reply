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
  // Null when the context leaves Intake item status to be worked out.
  COLLECTION_STATUS: string | null;
  PROCEDURE_AREA: string | null;
  HAS_PATIENT_IMAGES: boolean;
  PATIENT_IMAGE_COUNT: number;
  WORKING_MEMORY: string;
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

type IntakeContext = Pick<
  StateCardContext,
  "COLLECTION_STATUS" | "PROCEDURE_AREA" | "PATIENT_NAME" | "HAS_PATIENT_IMAGES" | "PATIENT_IMAGE_COUNT" | "WORKING_MEMORY"
>;

function askCounts(workingMemory: string): { area: number; name: number; photos: number } {
  let state: { areaAskCount?: number; nameAskCount?: number; photoAskCount?: number } = {};
  try {
    state = (JSON.parse(workingMemory) as { collectionState?: typeof state }).collectionState ?? {};
  } catch {
    // Unreadable working memory counts as no asks yet.
  }
  return { area: state.areaAskCount ?? 0, name: state.nameAskCount ?? 0, photos: state.photoAskCount ?? 0 };
}

// The Collection Status line in the packet's format, worked out from the Patient's fields and the ask counts
// in working memory when the context doesn't give one.
export function collectionStatus(context: IntakeContext): string {
  if (context.COLLECTION_STATUS !== null) return context.COLLECTION_STATUS;
  const asks = askCounts(context.WORKING_MEMORY);
  const items = [
    { item: "area", known: context.PROCEDURE_AREA !== null, status: context.PROCEDURE_AREA ? `area ${context.PROCEDURE_AREA}` : "area MISSING", asks: asks.area },
    { item: "name", known: context.PATIENT_NAME !== null, status: context.PATIENT_NAME ? "name on file" : "name MISSING", asks: asks.name },
    {
      item: "photos",
      known: context.HAS_PATIENT_IMAGES || context.PATIENT_IMAGE_COUNT > 0,
      status: context.HAS_PATIENT_IMAGES || context.PATIENT_IMAGE_COUNT > 0 ? "photos received" : "photos MISSING",
      asks: asks.photos,
    },
  ];
  const next = items.find(({ known, asks: count }) => !known && count < 1);
  const anchor = next
    ? `Next collection anchor: ${next.item}.`
    : items.every(({ known }) => known)
      ? "Everything is collected -- add NO anchor."
      : "Every missing item has been asked -- add NO anchor.";
  return `${items.map(({ status }) => status).join("; ")}. Asks so far -- area ${asks.area}, name ${asks.name}, photos ${asks.photos} (budget 1 each). ${anchor}`;
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
    `Intake items: ${collectionStatus(context)}`,
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
