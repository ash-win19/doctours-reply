import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ToolCallTrace } from "../model-calls.ts";
import type { Reply } from "../reply.ts";
import {
  checkCalls,
  checkEscalate,
  checkExcludes,
  checkFields,
  checkIncludes,
  checkLastLineUrl,
  checkMaxAttachments,
  checkMaxSentences,
  checkNoUrl,
  checkReply,
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
    // Patient context overrides. The runner can't swap context in yet, so a case that sets it is rejected.
    context: z.never({ error: "context is not supported until the runner can swap Patient context" }).optional(),
    expect: ExpectSchema,
  })
  .strict();

export type EvalCase = z.infer<typeof EvalCaseSchema>;
type Expect = EvalCase["expect"];

export function parseCases(raw: string, path: string): EvalCase[] {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  const parsed = z.array(EvalCaseSchema).safeParse(json);
  if (!parsed.success) {
    throw new Error(`${path} has invalid cases\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
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

export interface CaseOutcome {
  passed: boolean;
  checks: NamedCheck[];
}

type Check<Expected> = (reply: Reply, expected: Expected, toolCalls: ToolCallTrace[]) => CheckResult | null;

const CHECKS: { [Name in keyof Expect]-?: Check<NonNullable<Expect[Name]>> } = {
  escalate: checkEscalate,
  includes: checkIncludes,
  excludes: checkExcludes,
  lastLineUrl: checkLastLineUrl,
  noUrl: (reply, expected) => (expected ? checkNoUrl(reply) : null),
  maxSentences: checkMaxSentences,
  maxAttachments: checkMaxAttachments,
  calls: (_reply, expected, toolCalls) => checkCalls(toolCalls, expected),
  fields: checkFields,
};

// Every Reply must match the schema with a null templateId, whatever the case expects.
export function scoreCase(evalCase: EvalCase, reply: Reply, toolCalls: ToolCallTrace[] = []): CaseOutcome {
  const checks: NamedCheck[] = [{ name: "reply", ...checkReply(reply) }];
  for (const name of Object.keys(CHECKS) as (keyof Expect)[]) {
    const expected = evalCase.expect[name];
    if (expected === undefined) continue;
    const check = CHECKS[name] as Check<unknown>;
    const result = check(reply, expected, toolCalls);
    if (result) checks.push({ name, ...result });
  }
  return { passed: checks.every((check) => check.ok), checks };
}
