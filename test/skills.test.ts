import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkillRegistry, parseSkill, statusModule } from "../src/skills.ts";

function skillFile(fields: Record<string, string>, body = "Body text."): string {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join("\n")}\n---\n${body}\n`;
}

const FIELDS = {
  id: "alpha",
  description: "Alpha questions.",
  tools: "[getAllClinicsTool]",
  requires: "[]",
  overrides: "[]",
  sources: "[SOME SECTION]",
};

function registryFrom(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "skills-"));
  for (const [name, raw] of Object.entries(files)) writeFileSync(join(dir, name), raw);
  return loadSkillRegistry(dir);
}

test("a skill file is frontmatter plus the rule text", () => {
  const skill = parseSkill(skillFile(FIELDS, "# ALPHA\nRules."), "alpha.md");
  assert.deepEqual(skill, {
    id: "alpha",
    description: "Alpha questions.",
    tools: ["getAllClinicsTool"],
    requires: [],
    overrides: [],
    sources: ["SOME SECTION"],
    text: "# ALPHA\nRules.",
  });
});

test("a skill file must have every frontmatter field", () => {
  const { tools: _tools, ...noTools } = FIELDS;
  assert.throws(() => parseSkill(skillFile(noTools), "alpha.md"), /alpha\.md.*tools/);
  assert.throws(() => parseSkill("# no frontmatter", "alpha.md"), /alpha\.md.*frontmatter/);
});

test("a skill can only declare tools that exist", () => {
  assert.throws(() => parseSkill(skillFile({ ...FIELDS, tools: "[bookFlightTool]" }), "alpha.md"), /bookFlightTool/);
});

test("requires load transitively, dependencies first, without duplicates", () => {
  const registry = registryFrom({
    "a.md": skillFile({ ...FIELDS, id: "a", requires: "[b]" }),
    "b.md": skillFile({ ...FIELDS, id: "b", requires: "[c]" }),
    "c.md": skillFile({ ...FIELDS, id: "c" }),
  });
  assert.deepEqual(registry.resolve(["a"]).map((skill) => skill.id), ["c", "b", "a"]);
  assert.deepEqual(registry.resolve(["c", "a", "b"]).map((skill) => skill.id), ["c", "b", "a"]);
});

test("a skill can't require one that doesn't exist", () => {
  assert.throws(() => registryFrom({ "a.md": skillFile({ ...FIELDS, id: "a", requires: "[ghost]" }) }), /ghost/);
});

test("the index gives triage each skill's id and description", () => {
  const registry = registryFrom({
    "a.md": skillFile({ ...FIELDS, id: "a", description: "About a." }),
    "b.md": skillFile({ ...FIELDS, id: "b", description: "About b." }),
  });
  assert.deepEqual(registry.index(), [
    { id: "a", description: "About a." },
    { id: "b", description: "About b." },
  ]);
  assert.equal(registry.has("a"), true);
  assert.equal(registry.has("z"), false);
});

test("the shipped skills load, and decision-funnel brings clinic-packages", () => {
  const registry = loadSkillRegistry();
  for (const id of ["clinic-packages", "decision-funnel", "payments"]) assert.ok(registry.has(id), id);
  assert.deepEqual(registry.resolve(["decision-funnel"]).map((skill) => skill.id), ["clinic-packages", "decision-funnel"]);
  for (const { id } of registry.index()) {
    const [skill] = registry.resolve([id]).filter((loaded) => loaded.id === id);
    assert.ok(skill.sources.length > 0, `${id} names its sources`);
    assert.ok(!skill.tools.includes("updateWorkingMemory"), `${id} must not expose updateWorkingMemory`);
  }
});

test("code picks the Pipeline Status module for every pre-deposit status", () => {
  for (const status of ["LEAD", "PREP_PRE_CLINICAL", "PRE_CLINICAL_SENT", "MEETING_MISSED", "WAITING"]) {
    assert.match(statusModule(status), new RegExp(`^# PIPELINE STATUS: ${status}\\b`), status);
  }
  assert.match(statusModule("MEETING_BOOKED"), /^# PIPELINE STATUS: MEETING_BOOKED \/ MEETING_COMPLETED/);
  assert.equal(statusModule("MEETING_COMPLETED"), statusModule("MEETING_BOOKED"));
});

test("an unknown Pipeline Status gets a short module that answers reactively", () => {
  assert.match(statusModule("SOMETHING_NEW"), /answer reactively/);
  assert.equal(statusModule("../core"), statusModule("SOMETHING_NEW"));
});

test("the statuses before the assessment is sent carry the pricing length cap", () => {
  for (const status of ["LEAD", "PREP_PRE_CLINICAL", "MEETING_BOOKED"]) {
    assert.match(statusModule(status), /PRE-ASSESSMENT CLINIC AND PRICING ANSWERS \(LENGTH CAP/, status);
  }
  assert.doesNotMatch(statusModule("PRE_CLINICAL_SENT"), /LENGTH CAP/);
});

test("intake-photos holds the intake rules and only the photo and name tools", () => {
  const [skill] = loadSkillRegistry().resolve(["intake-photos"]);
  assert.deepEqual(skill.tools, ["getPatientImagesTool", "updateUserTool"]);
  for (const section of [
    "# COLLECTION PERSISTENCE",
    "# INFORMATION COLLECTION",
    "# IMAGE GUIDANCE",
    "# IMAGE DELAY HANDLING",
    "# CONCERN REFLECTION",
    "# FIRST-CONTACT INTRODUCTION",
    "# INSTANT FORM AREA CONFIRMATION",
    "# DATA COLLECTION",
  ]) {
    assert.ok(skill.text.includes(section), section);
  }
  assert.match(skill.text, /never list more than 3 URLs/);
});
