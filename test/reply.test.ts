import { test } from "node:test";
import assert from "node:assert/strict";
import { ReplySchema } from "../src/reply.ts";

const valid = {
  response: "Dr. Hakan Clinic has one package, Sapphire, at $3,200 USD with a $500 deposit.",
  escalate: false,
  escalationReason: null,
  templateId: null,
  intent: "answer pricing question",
  shouldFollowUp: false,
  followUpTiming: null,
  attachmentUrls: null,
  highEngagement: true,
  workingMemoryUpdates: {
    collectionState: { lastAskedItem: "none", areaAskCount: null },
    preferredPaymentMethod: "layaway",
    targetProcedureWindow: "within_3_months",
  },
};

test("accepts a packet-shaped Reply", () => {
  assert.ok(ReplySchema.safeParse(valid).success);
});

test("accepts null workingMemoryUpdates", () => {
  assert.ok(ReplySchema.safeParse({ ...valid, workingMemoryUpdates: null }).success);
});

test("rejects a value outside a literal union", () => {
  const bad = { ...valid, workingMemoryUpdates: { communicationStyle: "chatty" } };
  assert.equal(ReplySchema.safeParse(bad).success, false);
});

test("rejects a missing field", () => {
  const { intent: _intent, ...bad } = valid;
  assert.equal(ReplySchema.safeParse(bad).success, false);
});
