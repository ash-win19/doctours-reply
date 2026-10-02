import type { Reply } from "./reply.ts";

export const DRAFTING_FAILED = "Could not draft a reply";

// The model supplies at most a short verb phrase. As a second safety after redaction, a phrase holding digits
// is dropped, so the sentence falls back to "I'm getting a person for you."
function tidyCannotDo(cannotDo: string | null): string | null {
  if (!cannotDo || /\d/.test(cannotDo)) return null;
  const phrase = cannotDo.replace(/\s+/g, " ").trim().replace(/[.!?,;:\s]+$/, "");
  if (!/[a-z]/i.test(phrase)) return null;
  // "Hold a date" becomes "hold a date", but a name like "PayPal" keeps its case.
  return /^[A-Z][a-z]*\b/.test(phrase) ? phrase[0].toLowerCase() + phrase.slice(1) : phrase;
}

// ADR 0002: the Escalation sentence comes from a fixed template, so it can't answer a sales question.
export function escalationReply(reason: string, cannotDo: string | null): Reply {
  const phrase = tidyCannotDo(cannotDo);
  return {
    response: phrase ? `I can't ${phrase}. I'm getting a person for you.` : "I'm getting a person for you.",
    escalate: true,
    escalationReason: reason,
    templateId: null,
    intent: "escalate to a person",
    shouldFollowUp: false,
    followUpTiming: null,
    attachmentUrls: null,
    highEngagement: false,
    workingMemoryUpdates: { escalationFlags: reason },
  };
}
