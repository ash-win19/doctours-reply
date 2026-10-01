import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS, runTool } from "../src/tools.ts";

test("exposes the 14 packet functions under the prompt's names", () => {
  assert.deepEqual(
    TOOLS.map((tool) => tool.name).sort(),
    [
      "getAllClinicsTool",
      "getClinicDoctorsTool",
      "getClinicPackagesTool",
      "getConsultationRescheduleLinkTool",
      "getFullCallsTool",
      "getLatestAssessmentTool",
      "getPatientContextTool",
      "getPatientImagesTool",
      "getPaymentLinkTool",
      "getSavedClinicsTool",
      "issuePromoCodeTool",
      "updateUserClinicPreferencesTool",
      "updateUserTool",
      "updateWorkingMemory",
    ],
  );
});

test("every tool has an object JSON Schema for its parameters", () => {
  for (const tool of TOOLS) {
    assert.equal((tool.parametersJsonSchema as { type: string }).type, "object", tool.name);
  }
});

test("runs a packet function by its tool name", () => {
  const result = runTool("getClinicPackagesTool", { clinicName: "Heva" });
  assert.equal(result.isError, false);
  const output = result.output as { packages: { name: string }[] };
  assert.deepEqual(output.packages.map((pkg) => pkg.name), ["Silver", "Gold"]);
});

test("a null result stays null", () => {
  const result = runTool("getClinicPackagesTool", { clinicName: "Nowhere" });
  assert.deepEqual(result, { isError: false, output: null });
});

test("bad input is an error result, not a throw", () => {
  const result = runTool("getClinicDoctorsTool", { clinicId: 42 });
  assert.equal(result.isError, true);
});

test("unknown tool is an error result", () => {
  const result = runTool("getTripDetailsTool", {});
  assert.equal(result.isError, true);
});
