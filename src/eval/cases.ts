import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ToolCallTrace } from "../model-calls.ts";
import { loadContext, type PatientContext } from "../patient-context.ts";
import type { RunMessage } from "../runner.ts";
import type { Reply } from "../reply.ts";
import { parseJsonAs } from "../json.ts";
import {
  checkCalls,
  checkEscalate,
  checkExcludes,
  checkFields,
  checkLeadsWith,
  checkIncludes,
  checkLastLineUrl,
  checkMaxAttachments,
  checkMaxSentences,
  checkNoUrl,
  checkReply,
  checkSkills,
  type CheckResult,
  type NamedCheck,
} from "./checks.ts";

export const CASES_DIR = "evals/cases";

const ExpectSchema = z
  .object({
    escalate: z.boolean().optional(),
    includes: z.array(z.union([z.string(), z.array(z.string()).min(1)])).optional(),
    excludes: z.array(z.string()).optional(),
    lastLineUrl: z.string().optional(),
    noUrl: z.boolean().optional(),
    maxSentences: z.number().int().nonnegative().optional(),
    maxAttachments: z.number().int().nonnegative().optional(),
    calls: z
      .array(z.object({ tool: z.string().min(1), argsInclude: z.array(z.string()).optional() }).strict())
      .min(1)
      .optional(),
    // Dotted paths into the Reply, such as "followUpTiming" or "workingMemoryUpdates.promisesMade".
    fields: z
      .record(z.string(), z.union([z.boolean(), z.number(), z.null(), z.string(), z.array(z.string()).min(1)]))
      .optional(),
    skills: z.object({ includes: z.array(z.string()).optional(), excludes: z.array(z.string()).optional() }).strict().optional(),
    // The first sentence mentions one of these.
    leadsWith: z.array(z.string()).min(1).optional(),
  })
  .strict();

const EvalCaseSchema = z
  .object({
    id: z.string().min(1),
    // A skill name, or "escalation".
    group: z.string().min(1),
    // The source rule the case tests, such as a packet section or an ADR.
    rule: z.string().min(1),
    text: z.string(),
    // A Patient context file, such as evals/contexts/lead.json. Without one the case runs as the packet's Patient.
    context: z.string().min(1).optional(),
    expect: ExpectSchema,
  })
  .strict();

export type EvalCase = z.infer<typeof EvalCaseSchema>;
type Expect = EvalCase["expect"];

export function parseCases(raw: string, path: string): EvalCase[] {
  return parseJsonAs(raw, z.array(EvalCaseSchema), path, "has invalid cases");
}

export function loadCaseFiles(files: { path: string; raw: string }[]): EvalCase[] {
  const cases = files.flatMap(({ path, raw }) => parseCases(raw, path));
  const seen = new Set<string>();
  for (const { id } of cases) {
    if (seen.has(id)) throw new Error(`duplicate case id "${id}"`);
    seen.add(id);
  }
  return cases;
}

// Every case file in the cases directory, or only the named ones.
export function loadCases(names: string[] = []): EvalCase[] {
  const available = readdirSync(CASES_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.replace(/\.json$/, ""))
    .sort();
  const missing = names.filter((name) => !available.includes(name));
  if (missing.length > 0) {
    throw new Error(`No case file named ${missing.join(", ")} in ${CASES_DIR}. Available: ${available.join(", ")}`);
  }
  const fileNames = (names.length > 0 ? names : available).map((name) => `${name}.json`);
  if (fileNames.length === 0) throw new Error(`No case files found in ${CASES_DIR}`);
  return loadCaseFiles(fileNames.map((file) => ({ path: file, raw: readFileSync(join(CASES_DIR, file), "utf8") })));
}

// Each case's message with the Patient context it names, or the packet's Patient. Each context file is read once.
export function caseMessages(cases: EvalCase[]): RunMessage[] {
  const contexts = new Map<string | undefined, PatientContext>();
  return cases.map(({ id, text, context: path }) => {
    let context = contexts.get(path);
    if (!context) {
      context = loadContext(path);
      contexts.set(path, context);
    }
    return { id, text, context };
  });
}

export interface CaseOutcome {
  passed: boolean;
  checks: NamedCheck[];
}

// What the message did on its way to the Reply, read from its trace.
export interface Observed {
  toolCalls: ToolCallTrace[];
  // The skills that ran: the ones triage chose plus any loaded mid-turn.
  skills: string[];
  mode?: string;
}

const NOTHING_OBSERVED: Observed = { toolCalls: [], skills: [] };

type Check<Expected> = (reply: Reply, expected: Expected, observed: Observed) => CheckResult | null;

const CHECKS: { [Name in keyof Expect]-?: Check<NonNullable<Expect[Name]>> } = {
  escalate: checkEscalate,
  includes: checkIncludes,
  excludes: checkExcludes,
  lastLineUrl: checkLastLineUrl,
  noUrl: (reply, expected) => (expected ? checkNoUrl(reply) : null),
  maxSentences: checkMaxSentences,
  maxAttachments: checkMaxAttachments,
  calls: (_reply, expected, observed) => checkCalls(
    observed.toolCalls,
    expected.map((call) => observed.mode === "baseline" && call.tool === "askCallHistory"
      ? { ...call, tool: "getFullCallsTool" }
      : call),
  ),
  fields: (reply, expected) => checkFields(reply, expected),
  // Baseline has no skill router. Its ordinary tool calls and Reply checks still apply.
  skills: (_reply, expected, observed) => observed.mode === "baseline" ? null : checkSkills(observed.skills, expected),
  leadsWith: checkLeadsWith,
};

// Every Reply must match the schema with a null templateId, whatever the case expects.
export function scoreCase(evalCase: EvalCase, reply: Reply, observed: Observed = NOTHING_OBSERVED): CaseOutcome {
  const checks: NamedCheck[] = [{ name: "reply", ...checkReply(reply) }];
  for (const name of Object.keys(CHECKS) as (keyof Expect)[]) {
    const expected = evalCase.expect[name];
    if (expected === undefined) continue;
    const check = CHECKS[name] as Check<unknown>;
    const result = check(reply, expected, observed);
    if (result) checks.push({ name, ...result });
  }
  return { passed: checks.every((check) => check.ok), checks };
}
