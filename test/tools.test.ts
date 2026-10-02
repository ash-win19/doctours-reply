import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS, runTool } from "../src/tools.ts";

// The packet's Patient has no tool overrides, so every tool runs its packet function.
const packetPatient = { toolOverrides: undefined };

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

test("every tool is a function with an object JSON Schema for its parameters", () => {
  for (const tool of TOOLS) {
    assert.equal(tool.type, "function", tool.name);
    assert.equal((tool.parameters as { type: string }).type, "object", tool.name);
  }
});

test("runs a packet function by its tool name", () => {
  const result = runTool("getClinicPackagesTool", { clinicName: "Heva" }, packetPatient);
  assert.equal(result.isError, false);
  const output = result.output as { packages: { name: string }[] };
  assert.deepEqual(output.packages.map((pkg) => pkg.name), ["Silver", "Gold"]);
});

test("a null result stays null", () => {
  const result = runTool("getClinicPackagesTool", { clinicName: "Nowhere" }, packetPatient);
  assert.deepEqual(result, { isError: false, output: null });
});

test("bad input is an error result, not a throw", () => {
  const result = runTool("getClinicDoctorsTool", { clinicId: 42 }, packetPatient);
  assert.equal(result.isError, true);
});

test("unknown tool is an error result", () => {
  const result = runTool("getTripDetailsTool", {}, packetPatient);
  assert.equal(result.isError, true);
});

test("a context's tool override replaces the packet function's result", () => {
  const context = { toolOverrides: { getPatientImagesTool: { hasImages: false, imageCount: 0 } } };
  assert.deepEqual(runTool("getPatientImagesTool", {}, context), { isError: false, output: { hasImages: false, imageCount: 0 } });
  const packages = runTool("getClinicPackagesTool", { clinicName: "Heva" }, context);
  assert.equal((packages.output as { clinicName: string }).clinicName, "Heva Clinic");
});

test("an override's {{input.field}} values are filled from the call's arguments", () => {
  const context = {
    toolOverrides: { updateUserTool: { firstName: "{{input.firstName}}", lastName: "{{input.lastName}}", updated: true } },
  };
  assert.deepEqual(runTool("updateUserTool", { firstName: "Marcus" }, context).output, {
    firstName: "Marcus",
    lastName: null,
    updated: true,
  });
});

test("an overridden tool still rejects bad input", () => {
  const context = { toolOverrides: { getClinicDoctorsTool: { doctors: [] } } };
  assert.equal(runTool("getClinicDoctorsTool", { clinicId: 42 }, context).isError, true);
});
