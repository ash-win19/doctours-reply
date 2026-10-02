import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PACKET_CONTEXT, loadContext, workOutCollectionStatus } from "../src/patient-context.ts";
import * as packet from "../src/context.ts";

function contextFile(contents: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "context-")), "patient.json");
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

test("with no file, the context is the packet's constants", () => {
  const context = loadContext();
  assert.equal(context, PACKET_CONTEXT);
  assert.equal(context.PIPELINE_STATUS, packet.PIPELINE_STATUS);
  assert.equal(context.CHAT_LIST, packet.CHAT_LIST);
  assert.equal(context.COLLECTION_STATUS, packet.COLLECTION_STATUS);
  assert.deepEqual(context.RECENT_MEDIA_CONVERSATION, packet.RECENT_MEDIA_CONVERSATION);
  assert.equal(context.toolOverrides, undefined);
});

test("a file's keys replace the packet's, and every missing key falls back to the packet", () => {
  const context = loadContext(contextFile({ PIPELINE_STATUS: "LEAD", PATIENT_NAME: null, SAVED_CLINIC_COUNT: 0 }));
  assert.equal(context.PIPELINE_STATUS, "LEAD");
  assert.equal(context.PATIENT_NAME, null);
  assert.equal(context.SAVED_CLINIC_COUNT, 0);
  assert.equal(context.CLINIC_FLAGS, packet.CLINIC_FLAGS);
  assert.equal(context.COORDINATOR_DISPLAY_NAME, "Alex");
});

test("a file that omits COLLECTION_STATUS gets it worked out once, from its own fields", () => {
  const worked = loadContext(contextFile({ PATIENT_NAME: null, PROCEDURE_AREA: null, WORKING_MEMORY: "{}" }));
  assert.match(worked.COLLECTION_STATUS, /^area MISSING; name MISSING; photos received\./);
  assert.equal(loadContext(contextFile({ COLLECTION_STATUS: "area hairline" })).COLLECTION_STATUS, "area hairline");
});

test("a misspelled key or a wrong type is rejected with the file and the key", () => {
  assert.throws(() => loadContext(contextFile({ PIPELINE_STAUS: "LEAD" })), /patient\.json[\s\S]*PIPELINE_STAUS/);
  assert.throws(() => loadContext(contextFile({ PATIENT_IMAGE_COUNT: "five" })), /PATIENT_IMAGE_COUNT/);
  assert.throws(() => loadContext(join(tmpdir(), "no-such-context.json")), /no-such-context\.json/);
});

test("toolOverrides accept a packet function name or a tool name, and are stored by tool name", () => {
  const context = loadContext(
    contextFile({ toolOverrides: { getPatientImages: { hasImages: false }, getSavedClinicsTool: { count: 0 } } }),
  );
  assert.deepEqual(context.toolOverrides, { getPatientImagesTool: { hasImages: false }, getSavedClinicsTool: { count: 0 } });
  assert.throws(() => loadContext(contextFile({ toolOverrides: { bookFlight: {} } })), /bookFlight/);
  assert.throws(
    () => loadContext(contextFile({ toolOverrides: { getPatientImages: {}, getPatientImagesTool: {} } })),
    /getPatientImages.*twice/,
  );
});

const newPatient = {
  PATIENT_NAME: null,
  PROCEDURE_AREA: null,
  HAS_PATIENT_IMAGES: false,
  PATIENT_IMAGE_COUNT: 0,
  WORKING_MEMORY: "{}",
};

test("Intake item status is worked out in the packet's Collection Status format", () => {
  assert.equal(
    workOutCollectionStatus(newPatient),
    "area MISSING; name MISSING; photos MISSING. Asks so far -- area 0, name 0, photos 0 (budget 1 each). Next collection anchor: area.",
  );
});

test("the next anchor skips items already known or already asked", () => {
  const asked = {
    ...newPatient,
    PROCEDURE_AREA: "crown",
    WORKING_MEMORY: JSON.stringify({ collectionState: { areaAskCount: 1, nameAskCount: 1, photoAskCount: 0 } }),
  };
  assert.equal(
    workOutCollectionStatus(asked),
    "area crown; name MISSING; photos MISSING. Asks so far -- area 1, name 1, photos 0 (budget 1 each). Next collection anchor: photos.",
  );
  const allAsked = { ...asked, WORKING_MEMORY: JSON.stringify({ collectionState: { areaAskCount: 1, nameAskCount: 1, photoAskCount: 1 } }) };
  assert.match(workOutCollectionStatus(allAsked), /Every missing item has been asked -- add NO anchor\.$/);
  const done = { ...newPatient, PATIENT_NAME: "Sam", PROCEDURE_AREA: "crown", HAS_PATIENT_IMAGES: true, PATIENT_IMAGE_COUNT: 5 };
  assert.match(workOutCollectionStatus(done), /^area crown; name on file; photos received\. .*Everything is collected -- add NO anchor\.$/);
});

test("a name or area in working memory counts as known, and an empty one doesn't", () => {
  const remembered = { ...newPatient, WORKING_MEMORY: JSON.stringify({ patientName: "Sam", procedureArea: "hairline" }) };
  assert.match(workOutCollectionStatus(remembered), /^area hairline; name on file; photos MISSING\..*Next collection anchor: photos\.$/);
  const blank = { ...newPatient, PATIENT_NAME: "  ", PROCEDURE_AREA: "", WORKING_MEMORY: JSON.stringify({ patientName: "" }) };
  assert.match(workOutCollectionStatus(blank), /^area MISSING; name MISSING; photos MISSING\./);
});

test("the LEAD fixture is a brand-new Patient, and every Patient-specific tool agrees", () => {
  const leadPatient = loadContext("evals/contexts/lead.json");
  assert.equal(leadPatient.PIPELINE_STATUS, "LEAD");
  assert.equal(leadPatient.PATIENT_NAME, null);
  assert.equal(leadPatient.PROCEDURE_AREA, null);
  assert.equal(leadPatient.HAS_PATIENT_IMAGES, false);
  assert.deepEqual(leadPatient.RECENT_MEDIA_CONVERSATION, []);
  assert.match(leadPatient.COLLECTION_STATUS, /^area MISSING; name MISSING; photos MISSING\./);
  assert.deepEqual(Object.keys(leadPatient.toolOverrides ?? {}).sort(), [
    "getConsultationRescheduleLinkTool",
    "getFullCallsTool",
    "getLatestAssessmentTool",
    "getPatientContextTool",
    "getPatientImagesTool",
    "getSavedClinicsTool",
    "updateUserTool",
  ]);
});

test("the photos-asked fixture is a LEAD Patient who was already sent the photo ask", () => {
  const askedPatient = loadContext("evals/contexts/lead-photos-asked.json");
  assert.equal(askedPatient.PIPELINE_STATUS, "LEAD");
  assert.match(askedPatient.COLLECTION_STATUS, /photos MISSING\. Asks so far -- area 1, name 1, photos 1 .*add NO anchor\.$/);
  assert.match(askedPatient.RECENT_MEDIA_CONVERSATION.at(-1)!.text, /https:\/\/www\.doctours\.com\/image-upload$/);
  assert.equal((askedPatient.toolOverrides?.getPatientImagesTool as { hasImages: boolean }).hasImages, false);
});
