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

test("the Pipeline Status module is picked by status, and only exists for statuses that have one", () => {
  assert.match(statusModule("PRE_CLINICAL_SENT")!, /^# PIPELINE STATUS: PRE_CLINICAL_SENT/);
  assert.equal(statusModule("NOT_A_STATUS"), null);
});

test("every PRE_CLINICAL_SENT topic has a skill with the tools its rules call for", () => {
  const registry = loadSkillRegistry();
  const skill = (id: string) => registry.resolve([id]).find((loaded) => loaded.id === id)!;
  assert.deepEqual(skill("consultation").tools, ["getConsultationRescheduleLinkTool"]);
  assert.deepEqual(skill("pause").tools, []);
  assert.deepEqual(skill("pause").overrides, ["decision-funnel advancement", "collection anchors"]);
  assert.deepEqual(registry.resolve(["travel"]).map(({ id }) => id), ["clinic-packages", "travel"]);
  assert.deepEqual(skill("clinic-contact").tools, ["getAllClinicsTool"]);
  assert.deepEqual(skill("assessment-aftercare").tools, ["getLatestAssessmentTool"]);
  assert.deepEqual(skill("creator").tools, []);
  assert.match(skill("pause").text, /^# TIME-BOUND PAUSE/);
  assert.match(skill("clinic-contact").text, /^# CLINIC WEBSITE/);
  assert.match(skill("creator").text, /molly@doctours\.com/);
});

test("each rule lives in one skill: the parked PACKAGE & CLINIC FACTS bullets moved to their homes", () => {
  const registry = loadSkillRegistry();
  const holders = (phrase: string) =>
    registry
      .index()
      .map(({ id }) => registry.resolve([id]).find((loaded) => loaded.id === id)!)
      .filter((loaded) => loaded.text.includes(phrase))
      .map(({ id }) => id);
  assert.deepEqual(holders("**Why we need the passport:**"), ["travel"]);
  assert.deepEqual(holders("**Where to get finasteride or minoxidil:**"), ["assessment-aftercare"]);
  assert.deepEqual(holders("**Can they message the clinic themselves:**"), ["clinic-contact"]);
});
