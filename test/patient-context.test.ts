import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PACKET_CONTEXT, loadContext } from "../src/patient-context.ts";
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

test("a file that omits COLLECTION_STATUS leaves Intake item status to be worked out", () => {
  assert.equal(loadContext(contextFile({ PIPELINE_STATUS: "LEAD" })).COLLECTION_STATUS, null);
  assert.equal(loadContext(contextFile({ COLLECTION_STATUS: "area hairline" })).COLLECTION_STATUS, "area hairline");
});

test("a misspelled key or a wrong type is rejected with the file and the key", () => {
  assert.throws(() => loadContext(contextFile({ PIPELINE_STAUS: "LEAD" })), /patient\.json[\s\S]*PIPELINE_STAUS/);
  assert.throws(() => loadContext(contextFile({ PATIENT_IMAGE_COUNT: "five" })), /PATIENT_IMAGE_COUNT/);
  assert.throws(() => loadContext(join(tmpdir(), "no-such-context.json")), /no-such-context\.json/);
});

test("toolOverrides are keyed by the packet function they replace", () => {
  const context = loadContext(contextFile({ toolOverrides: { getPatientImages: { hasImages: false } } }));
  assert.deepEqual(context.toolOverrides, { getPatientImages: { hasImages: false } });
  assert.throws(
    () => loadContext(contextFile({ toolOverrides: { getPatientImagesTool: { hasImages: false } } })),
    /getPatientImagesTool/,
  );
});

test("the LEAD fixture is a brand-new Patient with no name, area, photos or chat history", () => {
  const lead = loadContext("evals/contexts/lead.json");
  assert.equal(lead.PIPELINE_STATUS, "LEAD");
  assert.equal(lead.PATIENT_NAME, null);
  assert.equal(lead.PROCEDURE_AREA, null);
  assert.equal(lead.HAS_PATIENT_IMAGES, false);
  assert.deepEqual(lead.RECENT_MEDIA_CONVERSATION, []);
  assert.equal(lead.COLLECTION_STATUS, null);
  assert.equal((lead.toolOverrides?.getPatientImages as { hasImages: boolean }).hasImages, false);
});
