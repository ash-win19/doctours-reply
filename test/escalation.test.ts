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

test("an unsupported action gets the same fixed one-sentence Escalation", () => {
  const reply = escalationReply("Patient asked us to charge a card", "charge a card");
  assert.equal(reply.response, "I'm getting a person for you.");
  assert.ok(ReplySchema.safeParse(reply).success);
});

test("a phrase with digits or amounts is dropped, so digits never reach the Escalation sentence", () => {
  const reply = escalationReply("Card", "charge the card ending in 4242");
  assert.equal(reply.response, "I'm getting a person for you.");
  assert.doesNotMatch(JSON.stringify(reply), /4242/);
  assert.equal(escalationReply("r", "charge a card for $500").response, "I'm getting a person for you.");
});

test("model wording cannot expand the Escalation", () => {
  assert.equal(escalationReply("r", "  Hold a date for you.  ").response, "I'm getting a person for you.");
  assert.equal(escalationReply("r", "").response, "I'm getting a person for you.");
});


test("arbitrary model phrases cannot add sales content, sentences, or links", () => {
  for (const phrase of ["hold a date. Gold is great", "visit https://example.invalid", "charge " + "a ".repeat(200)]) {
    assert.equal(escalationReply("Needs an Operator", phrase).response, "I'm getting a person for you.");
  }
});


test("Escalation reasons are nonempty and bounded", () => {
  assert.equal(escalationReply(" ", null).escalationReason, "Needs an Operator");
  assert.equal(escalationReply("x".repeat(400), null).escalationReason?.length, 200);
});
