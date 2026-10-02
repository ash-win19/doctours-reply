import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStateCard, collectionStatus, recentTurns } from "../src/state-card.ts";
import * as context from "../src/context.ts";

test("the packet Patient's state card", () => {
  assert.equal(
    buildStateCard(context),
    [
      "Patient name: Jordan Hale",
      "Tier: pre_deposit",
      "Pipeline Status: PRE_CLINICAL_SENT",
      "Financing (Klarna/PayPal): eligible, home country US",
      "Intake items: area hairline; name on file; photos received. Asks so far -- area 1, name 1, photos 1 (budget 1 each). Last collection ask: 3 patient turn(s) ago. Everything is collected -- add NO anchor.",
      "Promo: none",
      "Matched clinics: 2",
      "Selected clinic: none",
      "Consultation: none scheduled",
      "Links already sent: https://www.doctours.com/image-upload, https://www.doctours.com/assessment/c3d4e5f6-3333-4333-8333-333333333333",
      "First contact: no, the Coordinator has already written in this thread",
      "Current time: September 27, 2026 at 07:37 PM UTC",
    ].join("\n"),
  );
});

test("a brand-new Patient with nothing on file", () => {
  const card = buildStateCard({
    ...context,
    PATIENT_NAME: null,
    PIPELINE_STATUS: "LEAD",
    KLARNA_PAYPAL_FINANCING_ELIGIBLE: null,
    PATIENT_COUNTRY_CODE: null,
    PROMO_OFFER: { code: "HAIR200", amount: 200 },
    SAVED_CLINIC_COUNT: 0,
    SELECTED_CLINIC: { name: "Heva Clinic" },
    CONSULTATION_TIME: "2026-10-02T15:00:00.000Z",
    RECENT_MEDIA_CONVERSATION: [],
  });
  assert.match(card, /^Patient name: unknown$/m);
  assert.match(card, /^Financing \(Klarna\/PayPal\): unknown, home country unknown$/m);
  assert.match(card, /^Promo: \{"code":"HAIR200","amount":200\}$/m);
  assert.match(card, /^Selected clinic: Heva Clinic$/m);
  assert.match(card, /^Consultation: 2026-10-02T15:00:00.000Z$/m);
  assert.match(card, /^Links already sent: none$/m);
  assert.match(card, /^First contact: yes, the Coordinator has not written in this thread yet$/m);
});

test("recent turns are the last four messages, oldest first", () => {
  assert.deepEqual(recentTurns(context, 4), [
    "Jordan Hale: Any update?",
    "Alex: Your assessment is ready. It has your graft estimate and the clinics we matched you with. You can open it using the link below.\nhttps://www.doctours.com/assessment/c3d4e5f6-3333-4333-8333-333333333333",
    "Jordan Hale: Got it",
    "Alex: Did any clinic catch your eye, or do you have questions about the plan?",
  ]);
});

const newPatient = {
  ...context,
  COLLECTION_STATUS: null,
  PATIENT_NAME: null,
  PROCEDURE_AREA: null,
  HAS_PATIENT_IMAGES: false,
  PATIENT_IMAGE_COUNT: 0,
  WORKING_MEMORY: "{}",
};

test("without a Collection Status, Intake item status is worked out from the other fields", () => {
  assert.equal(
    collectionStatus(newPatient),
    "area MISSING; name MISSING; photos MISSING. Asks so far -- area 0, name 0, photos 0 (budget 1 each). Next collection anchor: area.",
  );
  assert.match(buildStateCard(newPatient), /^Intake items: area MISSING; name MISSING; photos MISSING\./m);
});

test("the next anchor skips items already known or already asked", () => {
  const asked = {
    ...newPatient,
    PROCEDURE_AREA: "crown",
    WORKING_MEMORY: JSON.stringify({ collectionState: { areaAskCount: 1, nameAskCount: 1, photoAskCount: 0 } }),
  };
  assert.equal(
    collectionStatus(asked),
    "area crown; name MISSING; photos MISSING. Asks so far -- area 1, name 1, photos 0 (budget 1 each). Next collection anchor: photos.",
  );
  const allAsked = { ...asked, WORKING_MEMORY: JSON.stringify({ collectionState: { areaAskCount: 1, nameAskCount: 1, photoAskCount: 1 } }) };
  assert.match(collectionStatus(allAsked), /Every missing item has been asked -- add NO anchor\.$/);
  const done = { ...newPatient, PATIENT_NAME: "Sam", PROCEDURE_AREA: "crown", HAS_PATIENT_IMAGES: true, PATIENT_IMAGE_COUNT: 5 };
  assert.match(collectionStatus(done), /^area crown; name on file; photos received\. .*Everything is collected -- add NO anchor\.$/);
});

test("a Collection Status the context gives is used as it is", () => {
  assert.equal(collectionStatus(context), context.COLLECTION_STATUS);
});
