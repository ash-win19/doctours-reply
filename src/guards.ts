export const CARD_PLACEHOLDER = "[card number]";

// 13 to 19 digits, each optionally separated by one space or dash, and not part of a longer digit run.
const CARD_RUN = /(?<!\d[ -]?)\d(?:[ -]?\d){12,18}(?![ -]?\d)/g;
// Numeric suffixes of real IDs can resemble cards. Preserve the whole UUID as an indivisible token.
const UUID = /(\b[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b)/gi;
// The four digits after "card ending (in)", "visa ends with" or "card's last four are", with a card word first.
const CARD_ENDING =
  /\b((?:card|visa|mastercard|amex|debit|credit)\b[^.?!\n\d]{0,30}?\b(?:(?:ending|ends)(?:\s+(?:in|with))?\s+|last\s+(?:four|4)(?:\s+digits)?(?:\s+(?:are|is))?[:\s]\s*))\d{4}(?!\d)/gi;

// Replaces card digits with a placeholder so no model, trace or Reply ever sees them.
export function redactCardNumbers(text: string): { text: string; found: boolean } {
  let found = false;
  const redacted = text.split(UUID).map((part, index) => index % 2 ? part : part
    .replace(CARD_RUN, () => {
      found = true;
      return CARD_PLACEHOLDER;
    })
    .replace(CARD_ENDING, (_match, lead: string) => {
      found = true;
      return `${lead}${CARD_PLACEHOLDER}`;
    })).join("");
  return { text: redacted, found };
}

// Context and tool data are JSON values. Redact every text field without mutating the shared Patient fixture.
export function redactCardData<T>(value: T): T {
  if (typeof value === "string") return redactCardNumbers(value).text as T;
  if (Array.isArray(value)) return value.map((item) => redactCardData(item)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactCardData(item)])) as T;
  }
  return value;
}

// Every card-like digit run and "card ending in" group, for the validator's second check.
export function cardDigitsIn(text: string): string[] {
  const plain = text.split(UUID).filter((_part, index) => index % 2 === 0).join("\n");
  const runs = [...plain.matchAll(CARD_RUN)].map(([run]) => run.replace(/\D/g, ""));
  const endings = [...plain.matchAll(CARD_ENDING)].map(([match]) => match.slice(-4));
  return [...runs, ...endings];
}

const PERSON = String.raw`(?:a\s+|an\s+|some\s+)?(?:real\s+|live\s+|actual\s+)?(?:human(?:\s+being)?|person|someone|somebody|agent|representative|manager)`;

// Match complete affirmative requests only. Negations, quotations, clinic contacts and
// compound messages need triage's context; a matching substring is not proof of a request.
const ASK_TO_TALK = String.raw`(?:(?:i\s+(?:want|need|demand)\s+to|(?:can|could|may)\s+i)\s+)?`;
const REQUEST_END = String.raw`(?:\s*,?\s+(?:please|now|right\s+now|tonight|tomorrow|not\s+a\s+bot))?[.!?]*`;
const HUMAN_REQUESTS = [
  String.raw`${ASK_TO_TALK}(?:talk|speak|chat)\s+(?:to|with)\s+${PERSON}`,
  String.raw`(?:get|give|connect|transfer|put)\s+me\s+(?:to\s+|through\s+to\s+|with\s+)?${PERSON}`,
  String.raw`(?:can|could|would|will)\s+(?:you|someone|somebody|anyone)\s+(?:please\s+)?call\s+me(?:\s+back)?`,
  String.raw`(?:i\s+(?:want|need)\s+)?(?:someone|somebody|anyone)\s+(?:to\s+)?call\s+me(?:\s+back)?`,
  String.raw`call\s+me(?:\s+back)?`,
  String.raw`give\s+me\s+a\s+(?:call|ring)`,
  String.raw`is\s+there\s+${PERSON}`,
  String.raw`(?:i\s+(?:want|need)\s+)?${PERSON}`,
].map((request) => new RegExp(String.raw`^(?:please\s+)?${request}${REQUEST_END}$`, "i"));

// Only these unambiguous full-message forms skip the model. Triage handles other requests.
export function detectHumanRequest(text: string): boolean {
  return HUMAN_REQUESTS.some((pattern) => pattern.test(text.trim()));
}

export interface ForcedEscalation {
  reason: string;
  cannotDo: string | null;
}

export interface Screening {
  redactedText: string;
  cardNumberFound: boolean;
  humanRequested: boolean;
  forceEscalate: ForcedEscalation | null;
}

// Runs before triage. Card details and explicit requests for a person escalate without a model call.
export function screenMessage(text: string): Screening {
  const { text: redactedText, found: cardNumberFound } = redactCardNumbers(text);
  const humanRequested = detectHumanRequest(redactedText);
  let forceEscalate: ForcedEscalation | null = null;
  if (cardNumberFound) forceEscalate = { reason: "Patient shared card details", cannotDo: "take card details" };
  else if (humanRequested) forceEscalate = { reason: "Patient asked for a person", cannotDo: null };
  return { redactedText, cardNumberFound, humanRequested, forceEscalate };
}
