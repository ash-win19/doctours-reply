import { test } from "node:test";
import assert from "node:assert/strict";
import { getAllClinics, getClinicPackages, getPatientImages, getPaymentLink } from "../src/packet-tools.ts";
import { collectEvidence, emptyEvidence, validate, type TurnEvidence } from "../src/validator.ts";
import { VALID_REPLY } from "./fakes.ts";

const PAYMENT_URL = "https://www.doctours.com/payment/44444444-4444-4444-8444-444444444441";

function evidenceFrom(...toolOutputs: unknown[]): TurnEvidence {
  const evidence = emptyEvidence();
  for (const output of toolOutputs) collectEvidence(evidence, output);
  return evidence;
}

function reply(response: string, overrides = {}) {
  return { ...VALID_REPLY, response, ...overrides };
}

test("evidence holds the URLs, slugs and money values of this turn's tool results", () => {
  const evidence = evidenceFrom(
    getAllClinics(),
    getPaymentLink({ type: "payment", clinicPackageId: "44444444-4444-4444-8444-444444444441" }),
    getClinicPackages({ clinicName: "Heva" }),
  );
  assert.ok(evidence.toolUrls.has(PAYMENT_URL));
  assert.ok(evidence.toolUrls.has("https://www.doctours.com/clinic/heva"));
  assert.deepEqual([...evidence.slugs].sort(), ["dr-hakan", "heva"]);
  assert.ok(evidence.amounts.has(500));
});

test("a fabricated payment link is removed along with its line", () => {
  const fabricated = reply("You can pay the Silver deposit using the link below.\nhttps://www.doctours.com/payment/silver-heva");
  const { reply: fixed, fixes, failures } = validate(fabricated, emptyEvidence());
  assert.equal(fixed.response, "You can pay the Silver deposit using the link below.");
  assert.deepEqual(fixes, ["removed https://www.doctours.com/payment/silver-heva, which no tool returned, and its line"]);
  assert.deepEqual(failures, [
    {
      name: "unknown URLs",
      detail:
        "Removed https://www.doctours.com/payment/silver-heva: no tool returned it this turn. If the Patient needs it, call the tool that returns it.",
    },
  ]);
});

test("a URL a tool returned this turn is kept", () => {
  const response = `Here's the Silver payment link.\n${PAYMENT_URL}`;
  const evidence = evidenceFrom(getPaymentLink({ type: "payment", clinicPackageId: "44444444-4444-4444-8444-444444444441" }));
  const result = validate(reply(response), evidence);
  assert.equal(result.reply.response, response);
  assert.deepEqual(result.fixes, []);
});

test("the static allowlist is the Consultation link, the image-upload link, and clinic pages from a slug a tool returned", () => {
  const consultation = reply("Book it using the link below.\nhttps://www.doctours.com/consultation");
  const upload = reply("Upload them using the link below.\nhttps://www.doctours.com/image-upload");
  const clinicPage = reply("See Heva using the link below.\nhttps://www.doctours.com/clinic/heva");
  assert.deepEqual(validate(consultation, emptyEvidence()).fixes, []);
  assert.deepEqual(validate(upload, emptyEvidence()).fixes, []);
  assert.deepEqual(validate(clinicPage, evidenceFrom({ slug: "heva" })).fixes, []);
  assert.equal(validate(clinicPage, emptyEvidence()).reply.response, "See Heva using the link below.");
});

test("a URL in the middle of a sentence moves to the last line", () => {
  const midSentence = reply("Book your free call at https://www.doctours.com/consultation and pick any time that suits you.");
  const { reply: fixed, fixes } = validate(midSentence, emptyEvidence());
  assert.equal(
    fixed.response,
    "Book your free call at the link below and pick any time that suits you.\nhttps://www.doctours.com/consultation",
  );
  assert.deepEqual(fixes, ["moved URLs to the last lines"]);
});

test("URLs stack on the last lines in order of first mention, each once", () => {
  const scattered = reply(
    [
      "Upload your photos first.",
      "https://www.doctours.com/image-upload",
      "Then book a call at https://www.doctours.com/consultation, or re-open the upload page at https://www.doctours.com/image-upload.",
    ].join("\n"),
  );
  assert.equal(
    validate(scattered, emptyEvidence()).reply.response,
    [
      "Upload your photos first.",
      "Then book a call at the link below, or re-open the upload page at the link below.",
      "https://www.doctours.com/image-upload",
      "https://www.doctours.com/consultation",
    ].join("\n"),
  );
});

test("markdown markers are stripped, but URLs keep their underscores", () => {
  const markdown = reply(
    ["## Heva packages", "- **Silver** is $3,000", "* __Gold__ is *$4,500*", "Pay with `the link below`.", "https://example.test/pay_now_link"].join("\n"),
  );
  const { reply: fixed, fixes } = validate(markdown, evidenceFrom("https://example.test/pay_now_link $3,000 $4,500"));
  assert.equal(fixed.response, ["Heva packages", "Silver is $3,000", "Gold is $4,500", "Pay with the link below.", "https://example.test/pay_now_link"].join("\n"));
  assert.deepEqual(fixes, ["stripped markdown"]);
});

test("card digits from the Patient's message are removed from the Reply", () => {
  const evidence = emptyEvidence(["1234567812345678"]);
  const repeated = reply("I can't use the card 1234 5678 1234 5678, the one ending in 5678.");
  const { reply: fixed, fixes } = validate(repeated, evidence);
  assert.equal(fixed.response, "I can't use the card, the one ending in.");
  assert.deepEqual(fixes, ["removed card digits from the Patient's message"]);
});

test("the last four digits go only where they follow card-ending wording, so a matching year stays", () => {
  const evidence = emptyEvidence(["2026"]);
  const { reply: fixed } = validate(reply("Heva has dates open in 2026. I can't charge the card ending in 2026."), evidence);
  assert.equal(fixed.response, "Heva has dates open in 2026. I can't charge the card ending in.");
  const lastFour = validate(reply("Your card's last four are 2026."), evidence).reply.response;
  assert.equal(lastFour, "Your card's last four are.");
});

test("field consistency is enforced in code", () => {
  const inconsistent = reply("Sounds good.", {
    escalationReason: "left over",
    shouldFollowUp: false,
    followUpTiming: "1 month",
    attachmentUrls: [],
  });
  const { reply: fixed, fixes } = validate(inconsistent, emptyEvidence());
  assert.equal(fixed.escalationReason, null);
  assert.equal(fixed.followUpTiming, null);
  assert.equal(fixed.attachmentUrls, null);
  assert.deepEqual(fixes, [
    "set escalationReason to null because escalate is false",
    "set followUpTiming to null because shouldFollowUp is false",
    "set empty attachmentUrls to null",
  ]);
});

test("the validator never changes escalate", () => {
  const escalation = reply("I'm getting a person for you. https://made.up/link", { escalate: true, escalationReason: "why" });
  const { reply: fixed } = validate(escalation, emptyEvidence());
  assert.equal(fixed.escalate, true);
  assert.equal(fixed.escalationReason, "why");
  const answer = reply("Yes, it's free.", { escalate: false });
  assert.equal(validate(answer, emptyEvidence()).reply.escalate, false);
});

test("amounts come from money values in tool results, never from digits inside ids", () => {
  const heva = evidenceFrom(getClinicPackages({ clinicName: "Heva" }));
  assert.deepEqual(validate(reply("Silver is $3,000 with a $500 deposit, and Gold is $4,500 with $600 down."), heva).failures, []);
  for (const made_up of ["$4,444", "$8,444", "$3", "$1,111"]) {
    assert.equal(validate(reply(`Silver is ${made_up}.`), heva).failures[0]?.name, "amounts", made_up);
  }
});

test("a string in a tool result grounds an amount only when it reads as money", () => {
  const evidence = evidenceFrom({ note: "The companion fee is $75 per night, room 204." });
  assert.deepEqual(validate(reply("The companion fee is $75 a night."), evidence).failures, []);
  assert.equal(validate(reply("That's $204."), evidence).failures[0]?.name, "amounts");
});

test("every dollar amount must come from this turn's tool results or the policy list", () => {
  const heva = evidenceFrom({ packages: [{ name: "Silver", basePrice: 3000, depositAmount: 500 }] });
  const grounded = reply("Silver is $3,000 with a $500 deposit, and the deposit is refundable less a $25 cancellation fee.");
  assert.deepEqual(validate(grounded, heva).failures, []);
  assert.deepEqual(validate(reply("Silver is 3000 USD, or USD 500 down."), heva).failures, []);
  const invented = validate(reply("Silver is $2,999 and Gold is $4,500.00."), heva);
  assert.deepEqual(invented.failures, [
    { name: "amounts", detail: "$2,999 and $4,500.00 aren't in this turn's tool results or the policy amounts ($25)" },
  ]);
  assert.equal(invented.checks.find((check) => check.name === "amounts")?.ok, false);
});

test("banned phrases fail with the source rule that bans them", () => {
  const cases: [string, RegExp][] = [
    ["Your assessment should be ready in 24-48 hours.", /assessment turnaround/],
    ["The team usually finishes your assessment within a day.", /assessment turnaround/],
    ["Your assessment will be ready later today.", /assessment turnaround/],
    ["I'll get back to you on that.", /never stall/],
    ["Your assessment will be back to you by tomorrow.", /assessment turnaround/],
    ["Pack a beanie for the flight home.", /head-covering/],
    ["A coordinator will reach out tomorrow.", /a coordinator will/i],
    ["Someone from our team will confirm it.", /someone from our team/i],
    ["Bring a loose cap for the flight home.", /head-covering/],
    ["You could wear a very loose scarf if you feel self-conscious.", /head-covering/],
  ];
  for (const [response, rule] of cases) {
    const { failures } = validate(reply(response), emptyEvidence());
    assert.equal(failures.length, 1, response);
    assert.equal(failures[0].name, "banned phrases");
    assert.match(failures[0].detail, rule, response);
  }
});

test("timings that are real commitments, and the hat question, are allowed", () => {
  for (const response of [
    "After the deposit, the clinic confirms your date, normally within 24 hours.",
    "The procedure takes 6-8 hours.",
    "The medical team is working on your assessment and you'll get it as soon as it's ready.",
    "You can wear a hat again after about two weeks.",
    "I'll check in after a month if I don't hear from you.",
    "Once your assessment is ready, plan on 3 days in Istanbul.",
    "We can go over your assessment tomorrow if you have questions.",
    "Please don't wear a hat until your doctor says it's okay.",
    "Avoid wearing a cap for the first two weeks.",
    "Please take your hat off for the photos.",
    "Let me check Heva's packages for you.",
    "A team member will meet you at the airport.",
  ]) {
    assert.deepEqual(validate(reply(response), emptyEvidence()).failures, [], response);
  }
});

test("attachmentUrls holds at most 3 entries, all returned by a tool", () => {
  const images = getPatientImages({});
  const evidence = evidenceFrom(images);
  const [front, top, left, right] = ["front", "top", "left", "right"].map(
    (angle) => images.angles[angle as keyof typeof images.angles].urls[0],
  );
  assert.deepEqual(validate(reply("Here are three of them.", { attachmentUrls: [front, top, left] }), evidence).failures, []);
  assert.deepEqual(validate(reply("Here they are.", { attachmentUrls: [front, top, left, right] }), evidence).failures, [
    { name: "attachments", detail: "4 attachment URLs, at most 3" },
  ]);
  assert.deepEqual(validate(reply("Here it is.", { attachmentUrls: ["https://made.up/photo.jpg"] }), evidence).failures, [
    { name: "attachments", detail: "https://made.up/photo.jpg wasn't returned by a tool" },
  ]);
});

test("attachments are filtered before the cap, preserving tool-returned order and normalizing empty output", () => {
  const urls = ["a", "b", "c", "d"].map((name) => `https://example.test/${name}.jpg`);
  const evidence = evidenceFrom(urls);
  const draft = reply("Here are photos.", { attachmentUrls: ["https://made.up/photo.jpg", ...urls] });
  const result = validate(draft, evidence);
  assert.deepEqual(result.reply.attachmentUrls, urls.slice(0, 3));
  assert.equal(draft.attachmentUrls?.length, 5, "do not mutate the submitted draft");
  assert.equal(result.checks.find((check) => check.name === "attachments")?.ok, true);
  assert.ok(result.failures.some((failure) => failure.name === "attachments"), "still ask for a repair after removal");
  assert.equal(validate(reply("Here it is.", { attachmentUrls: ["https://made.up/photo.jpg"] }), evidence).reply.attachmentUrls, null);
});


test("policy-prescribed provider URLs can appear in text but never ungrounded attachments", () => {
  const response = "Select the hair-loss option on either.\nhttps://hims.com\nhttps://keeps.com";
  const result = validate(reply(response), emptyEvidence());
  assert.deepEqual(result.failures, []);
  assert.equal(result.reply.response, response);
  assert.equal(validate({ ...reply(response), attachmentUrls: ["https://hims.com"] }, emptyEvidence()).reply.attachmentUrls, null);
});
