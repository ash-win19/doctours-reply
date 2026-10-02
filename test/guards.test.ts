import { test } from "node:test";
import assert from "node:assert/strict";
import { cardDigitsIn, detectHumanRequest, redactCardNumbers, screenMessage } from "../src/guards.ts";

test("redacts a card number written as one digit run", () => {
  const { text, found } = redactCardNumbers("Use 4111111111111111 for the deposit");
  assert.equal(text, "Use [card number] for the deposit");
  assert.equal(found, true);
});

test("redacts card numbers split by spaces or dashes", () => {
  assert.equal(redactCardNumbers("card 4111 1111 1111 1111 exp 04/28").text, "card [card number] exp 04/28");
  assert.equal(redactCardNumbers("5500-0000-0000-0004").text, "[card number]");
  assert.equal(redactCardNumbers("amex 3782 822463 10005").text, "amex [card number]");
});

test("redacts the last four digits when the Patient names the card they end", () => {
  assert.equal(
    redactCardNumbers("Charge the deposit on my card ending in 4242 right now.").text,
    "Charge the deposit on my card ending in [card number] right now.",
  );
  assert.equal(redactCardNumbers("my card ending 4242").text, "my card ending [card number]");
  assert.equal(redactCardNumbers("use the visa that ends with 1234").text, "use the visa that ends with [card number]");
  assert.equal(redactCardNumbers("my card's last four are 9876").text, "my card's last four are [card number]");
});

test("leaves ordinary numbers alone", () => {
  for (const text of [
    "Is 2800 grafts enough?",
    "Silver is $3,000 and Gold is $4,500",
    "Call me at +1 555 555 0123",
    "I'm thinking March 12, 2027",
    "my phone number ending in 5678",
    "I was quoted 1500 2000 3000 4000 grafts by different clinics",
    "booking 44444444-4444-4444-8444-444444444441",
  ]) {
    assert.deepEqual(redactCardNumbers(text), { text, found: false });
  }
});

test("an explicit request for a person is caught in code", () => {
  for (const text of [
    "I demand to talk to a human",
    "Can I speak with a real person please",
    "get me a human",
    "Can someone call me tomorrow?",
    "please call me back",
    "Could you call me tonight?",
    "I need someone to call me",
    "I want to talk to someone, not a bot",
    "Is there a live agent?",
    "representative",
  ]) {
    assert.equal(detectHumanRequest(text), true, text);
  }
});

test("mentions of people that aren't a request for one pass through to triage", () => {
  for (const text of [
    "Are you a real person?",
    "Is this a human or a bot?",
    "My friend can call me Jay",
    "Does a real doctor do the incisions?",
    "Will someone pick me up from the airport?",
    "My name is Michael but you can call me Mike",
    "Can I talk to someone at Heva before I book?",
    "Can I speak with the surgeon before the procedure?",
  ]) {
    assert.equal(detectHumanRequest(text), false, text);
  }
});

test("screening redacts card numbers and forces an Escalation for cards or a person", () => {
  assert.deepEqual(screenMessage("Charge my card ending in 4242"), {
    redactedText: "Charge my card ending in [card number]",
    cardNumberFound: true,
    humanRequested: false,
    forceEscalate: { reason: "Patient shared card details", cannotDo: "take card details" },
  });
  assert.deepEqual(screenMessage("I demand to talk to a human"), {
    redactedText: "I demand to talk to a human",
    cardNumberFound: false,
    humanRequested: true,
    forceEscalate: { reason: "Patient asked for a person", cannotDo: null },
  });
  assert.deepEqual(screenMessage("What does Heva cost?"), {
    redactedText: "What does Heva cost?",
    cardNumberFound: false,
    humanRequested: false,
    forceEscalate: null,
  });
});

test("card digits in a message are listed, including runs that fail the Luhn check", () => {
  assert.deepEqual(cardDigitsIn("use 4111 1111 1111 1112, or my card ending in 4242"), ["4111111111111112", "4242"]);
  assert.deepEqual(cardDigitsIn("What does Heva cost?"), []);
});
