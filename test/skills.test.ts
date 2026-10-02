import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATUS_MODULES, loadSkillRegistry, parseSkill, statusModule } from "../src/skills.ts";

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

test("code picks a module for every Pipeline Status in the map, each naming its status", () => {
  for (const status of Object.keys(STATUS_MODULES)) {
    const heading = statusModule(status).split("\n")[0];
    assert.match(heading, /^# PIPELINE STATUS: /, status);
    assert.ok(heading.includes(status), `${status}: ${heading}`);
  }
  assert.ok(Object.keys(STATUS_MODULES).includes("PRE_CLINICAL_SENT"));
});

test("any other Pipeline Status gets the default module, which answers reactively", () => {
  assert.equal(statusModule("SOMETHING_NEW"), statusModule("../core"));
  assert.match(statusModule("SOMETHING_NEW"), /answer reactively/);
});

test("the pricing length cap is one shared file, composed into the statuses before the assessment is sent", () => {
  const cap = readFileSync("prompts/status/shared/pre-assessment-length-cap.md", "utf8").trim();
  for (const status of ["LEAD", "PREP_PRE_CLINICAL", "MEETING_BOOKED"]) assert.ok(statusModule(status).includes(cap), status);
  for (const status of ["PRE_CLINICAL_SENT", "MEETING_COMPLETED", "MEETING_MISSED", "WAITING"]) {
    assert.ok(!statusModule(status).includes("LENGTH CAP"), status);
  }
  const copies = readdirSync("prompts/status").filter(
    (file) => file.endsWith(".md") && readFileSync(`prompts/status/${file}`, "utf8").includes("LENGTH CAP"),
  );
  assert.deepEqual(copies, []);
});

test("a module that points at another skill's rule says to load that skill", () => {
  assert.match(statusModule("MEETING_MISSED"), /CONSULTATION RESCHEDULING \(the consultation skill, load it with loadSkill\)/);
  assert.match(statusModule("MEETING_BOOKED"), /CONSULTATION BOOKING CONFIRMATION \(the consultation skill, load it with loadSkill\)/);
  assert.match(statusModule("PREP_PRE_CLINICAL"), /\(the assessment-aftercare skill, load it with loadSkill\)/);
  assert.match(statusModule("LEAD"), /\(the intake-photos skill, load it with loadSkill\)/);
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

test("every skill a status module or another skill points at exists in the registry", () => {
  const registry = loadSkillRegistry();
  const files = [
    ...readdirSync("prompts/status", { recursive: true, encoding: "utf8" }).map((file) => `prompts/status/${file}`),
    ...readdirSync("prompts/skills").map((file) => `prompts/skills/${file}`),
  ].filter((path) => path.endsWith(".md"));
  const mentions = files.flatMap((path) =>
    [...readFileSync(path, "utf8").matchAll(/(?:the |\()([a-z][a-z-]*) skill\b/g)].map((match) => ({ path, id: match[1] })),
  );
  assert.ok(mentions.length > 0);
  for (const { path, id } of mentions) assert.ok(registry.has(id), `${path} points at a missing skill: ${id}`);
  const fromModules = new Set(mentions.filter(({ path }) => path.startsWith("prompts/status/")).map(({ id }) => id));
  assert.deepEqual([...fromModules].sort(), ["assessment-aftercare", "consultation", "decision-funnel", "intake-photos", "pause"]);
});
