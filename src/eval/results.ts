import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseMode, type Mode } from "../runner.ts";
import type { Scorecard } from "./scorecard.ts";

export const RESULTS_DIR = "evals/results";

export type EvalArgs =
  | { kind: "run"; mode: Mode; caseFiles: string[] }
  | { kind: "compare"; before: string; after: string };

export function parseEvalArgs(argv: string[]): EvalArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      mode: { type: "string", default: "baseline" },
      cases: { type: "string", multiple: true, default: [] },
      compare: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  if (values.compare) {
    if (positionals.length !== 2) throw new Error("--compare takes two runs: --compare <runA> <runB>");
    return { kind: "compare", before: positionals[0], after: positionals[1] };
  }
  if (positionals.length > 0) throw new Error(`Unexpected argument: ${positionals[0]}`);
  return { kind: "run", mode: parseMode(values.mode), caseFiles: values.cases };
}

export function saveScorecard(card: Scorecard, dir = RESULTS_DIR): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${card.runId}.json`);
  writeFileSync(path, `${JSON.stringify(card, null, 2)}\n`);
  return path;
}

// A run can be named by its results file path or by its run id.
export function loadScorecard(ref: string, dir = RESULTS_DIR): Scorecard {
  const path = [ref, join(dir, ref), join(dir, `${ref}.json`)].find((candidate) => existsSync(candidate) && candidate.endsWith(".json"));
  if (!path) throw new Error(`No results file "${ref}" (looked for a path and in ${dir})`);
  const card = JSON.parse(readFileSync(path, "utf8")) as Partial<Scorecard>;
  if (!card.runId || !Array.isArray(card.cases) || !card.totals || !card.groups) {
    throw new Error(`${path} is not an eval results file`);
  }
  return card as Scorecard;
}
