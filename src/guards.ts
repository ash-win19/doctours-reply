export const CARD_PLACEHOLDER = "[card number]";

// 13 to 19 digits, each optionally separated by one space or dash.
const CARD_RUN = /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g;
// The four digits after "ending in", "ends with" or "last four (digits) are".
const CARD_ENDING = /\b((?:ending|ends)\s+(?:in|with)\s+|last\s+(?:four|4)(?:\s+digits)?(?:\s+(?:are|is))?[:\s]\s*)\d{4}(?!\d)/gi;

// Replaces card digits with a placeholder so no model, trace or Reply ever sees them.
export function redactCardNumbers(text: string): { text: string; found: boolean } {
  let found = false;
  const redacted = text
    .replace(CARD_RUN, () => {
      found = true;
      return CARD_PLACEHOLDER;
    })
    .replace(CARD_ENDING, (_match, lead: string) => {
      found = true;
      return `${lead}${CARD_PLACEHOLDER}`;
    });
  return { text: redacted, found };
}

const PERSON = String.raw`(?:a\s+|an\s+|some\s+)?(?:real\s+|live\s+|actual\s+)?(?:human(?:\s+being)?|person|someone|somebody|agent|representative|manager)`;

// Asking to be put through to a person, or asking for a call.
const HUMAN_REQUESTS = [
  new RegExp(String.raw`\b(?:talk|speak|chat)\s+(?:to|with)\s+${PERSON}\b`, "i"),
  new RegExp(String.raw`\b(?:get|give|connect|transfer|put)\s+me\s+(?:to\s+|through\s+to\s+|with\s+)?${PERSON}\b`, "i"),
  /\b(?:someone|somebody|anyone|you|a\s+person|a\s+human)\s+(?:can\s+|could\s+|to\s+)?call\s+me\b/i,
  /\bcall\s+me\s+back\b/i,
  /\bgive\s+me\s+a\s+(?:call|ring)\b/i,
];
// Bare mentions that still mean "a person, please", unless the Patient is asking what we are.
const PERSON_NOUNS = /\b(?:real\s+(?:person|human)|live\s+(?:person|agent)|human\s+being|representative)\b/i;
const IDENTITY_QUESTION = /\b(?:are\s+you|is\s+this|am\s+i\s+(?:talking|speaking|texting|chatting)\s+(?:to|with))\s+(?:a\s+|an\s+)?(?:real\s+)?(?:person|human|bot|robot|ai)\b/i;

// A short phrase list for the certain cases. Triage handles paraphrases.
export function detectHumanRequest(text: string): boolean {
  if (HUMAN_REQUESTS.some((pattern) => pattern.test(text))) return true;
  return PERSON_NOUNS.test(text) && !IDENTITY_QUESTION.test(text);
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
