import { test } from "node:test";
import assert from "node:assert/strict";
import { escalationReply } from "../src/escalation.ts";
import { ReplySchema } from "../src/reply.ts";

test("an Escalation with nothing we can't do is one sentence", () => {
  assert.deepEqual(escalationReply("Patient asked for a person", null), {
    response: "I'm getting a person for you.",
    escalate: true,
    escalationReason: "Patient asked for a person",
    templateId: null,
    intent: "escalate to a person",
    shouldFollowUp: false,
    followUpTiming: null,
    attachmentUrls: null,
    highEngagement: false,
    workingMemoryUpdates: { escalationFlags: "Patient asked for a person" },
  });
});

test("an Escalation names what we can't do from the template", () => {
  const reply = escalationReply("Patient asked us to charge a card", "charge a card");
  assert.equal(reply.response, "I can't charge a card. I'm getting a person for you.");
  assert.ok(ReplySchema.safeParse(reply).success);
});

test("digits never reach the Escalation sentence", () => {
  const reply = escalationReply("Card", "charge the card ending in 4242");
  assert.equal(reply.response, "I can't charge the card ending in. I'm getting a person for you.");
  assert.doesNotMatch(JSON.stringify(reply), /4242/);
});

test("amounts are stripped along with their digits", () => {
  assert.equal(escalationReply("r", "move the $500 payment").response, "I can't move the payment. I'm getting a person for you.");
});

test("the phrase is tidied into the template", () => {
  assert.equal(escalationReply("r", "  Hold a date for you.  ").response, "I can't hold a date for you. I'm getting a person for you.");
  assert.equal(escalationReply("r", "1234").response, "I'm getting a person for you.");
  assert.equal(escalationReply("r", "").response, "I'm getting a person for you.");
});
