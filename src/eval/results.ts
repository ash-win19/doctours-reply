import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Scorecard } from "./scorecard.ts";

export const RESULTS_DIR = "evals/results";

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
