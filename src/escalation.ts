import type { Reply } from "./reply.ts";

export const VALIDATION_FAILED = "Could not produce a grounded reply after repair";

export const DRAFTING_FAILED = "Could not draft a reply";

// Code owns the entire sentence: model text cannot add sales content, links, or extra sentences.
export function escalationReply(reason: string, _cannotDo: string | null): Reply {
  reason = reason.replace(/\s+/g, " ").trim().slice(0, 200) || "Needs an Operator";
  return {
    response: "I'm getting a person for you.",
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
