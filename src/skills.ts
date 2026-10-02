import { readdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { SkillSummary } from "./prompt.ts";
import { SUBAGENT_TOOL_NAMES, TOOL_NAMES } from "./tools.ts";

// The packet's functions, plus the subagent tools the skill responder runs itself.
const KNOWN_TOOLS: string[] = [...TOOL_NAMES, ...SUBAGENT_TOOL_NAMES];

const SKILLS_DIR = new URL("../prompts/skills/", import.meta.url);
const STATUS_DIR = new URL("../prompts/status/", import.meta.url);

// One skill: a slice of the source prompt's rules, loaded only for the messages that need it.
export interface Skill {
  id: string;
  // One line, shown to triage and to the responder so either can pick the skill.
  description: string;
  // The only tools the responder gets for this skill.
  tools: string[];
  // Skills that are always loaded with this one.
  requires: string[];
  // Rules this skill beats under the core's rule precedence.
  overrides: string[];
  // The source prompt sections the text was copied from.
  sources: string[];
  text: string;
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;
const LIST_FIELDS = ["tools", "requires", "overrides", "sources"] as const;

function parseList(value: string, field: string, path: string): string[] {
  const match = value.match(/^\[(.*)\]$/);
  if (!match) throw new Error(`${path}: ${field} must be a [list]`);
  return match[1]
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

// Frontmatter holds one `key: value` per line, with lists written as [a, b].
export function parseSkill(raw: string, path: string): Skill {
  const match = raw.match(FRONTMATTER);
  if (!match) throw new Error(`${path}: a skill file starts with --- frontmatter`);
  const fields = new Map<string, string>();
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator > 0) fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  for (const field of ["id", "description", ...LIST_FIELDS]) {
    if (!fields.get(field)) throw new Error(`${path}: frontmatter needs ${field}`);
  }
  const [tools, requires, overrides, sources] = LIST_FIELDS.map((field) => parseList(fields.get(field)!, field, path));
  const unknownTools = tools.filter((tool) => !KNOWN_TOOLS.includes(tool));
  if (unknownTools.length > 0) throw new Error(`${path}: no tool named ${unknownTools.join(", ")}`);
  return {
    id: fields.get("id")!,
    description: fields.get("description")!,
    tools,
    requires,
    overrides,
    sources,
    text: raw.slice(match[0].length).trim(),
  };
}

export interface SkillRegistry {
  // Each skill's id and description, for triage and for loadSkill.
  index(): SkillSummary[];
  has(id: string): boolean;
  // The named skills plus everything they require, dependencies first, each once.
  resolve(ids: string[]): Skill[];
}

export function loadSkillRegistry(dir: string | URL = SKILLS_DIR): SkillRegistry {
  const files = readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .sort();
  const skills = new Map<string, Skill>();
  for (const file of files) {
    const skill = parseSkill(readFileSync(new URL(file, dirUrl(dir)), "utf8"), file);
    if (skills.has(skill.id)) throw new Error(`${file}: duplicate skill id ${skill.id}`);
    skills.set(skill.id, skill);
  }
  for (const skill of skills.values()) {
    const missing = skill.requires.filter((id) => !skills.has(id));
    if (missing.length > 0) throw new Error(`${skill.id} requires missing skill ${missing.join(", ")}`);
  }

  return {
    index: () => [...skills.values()].map(({ id, description }) => ({ id, description })),
    has: (id) => skills.has(id),
    resolve(ids) {
      const ordered: Skill[] = [];
      const visiting = new Set<string>();
      const visit = (id: string) => {
        if (ordered.some((skill) => skill.id === id) || visiting.has(id)) return;
        const skill = skills.get(id);
        if (!skill) throw new Error(`No skill named ${id}`);
        visiting.add(id);
        skill.requires.forEach(visit);
        ordered.push(skill);
      };
      ids.forEach(visit);
      return ordered;
    },
  };
}

function dirUrl(dir: string | URL): URL {
  return dir instanceof URL ? dir : pathToFileURL(dir.endsWith("/") ? dir : `${dir}/`);
}

const LENGTH_CAP = "shared/pre-assessment-length-cap";
const INTAKE_POINTER = "shared/intake-photos-pointer";

// Every Pipeline Status with a module of its own, and the files composed into it, in order. The source prompt gives
// MEETING_BOOKED and MEETING_COMPLETED one section, and its pricing length cap applies before the assessment is sent.
export const STATUS_MODULES: Record<string, string[]> = {
  LEAD: ["LEAD", INTAKE_POINTER, LENGTH_CAP],
  PREP_PRE_CLINICAL: ["PREP_PRE_CLINICAL", LENGTH_CAP],
  PRE_CLINICAL_SENT: ["PRE_CLINICAL_SENT"],
  MEETING_BOOKED: ["MEETING_BOOKED_OR_COMPLETED", INTAKE_POINTER, LENGTH_CAP],
  MEETING_COMPLETED: ["MEETING_BOOKED_OR_COMPLETED"],
  MEETING_MISSED: ["MEETING_MISSED"],
  WAITING: ["WAITING"],
};

// The module for any Pipeline Status without one of its own: answer reactively.
const DEFAULT_STATUS_MODULE = ["REACTIVE"];

// The module for the Patient's Pipeline Status. Code picks it, never triage.
export function statusModule(pipelineStatus: string): string {
  const files = Object.hasOwn(STATUS_MODULES, pipelineStatus) ? STATUS_MODULES[pipelineStatus] : DEFAULT_STATUS_MODULE;
  return files.map((file) => readFileSync(new URL(`${file}.md`, STATUS_DIR), "utf8").trim()).join("\n\n");
}
