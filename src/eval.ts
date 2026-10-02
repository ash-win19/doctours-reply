import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { caseMessages, loadCases } from "./eval/cases.ts";
import { loadScorecard, saveScorecard } from "./eval/results.ts";
import { buildScorecard, compareScorecards, formatScorecard } from "./eval/scorecard.ts";
import { defaultRunnerDeps, log } from "./deps.ts";
import { parseMode, type Mode } from "./pipeline.ts";
import { runMessages } from "./runner.ts";

export type EvalArgs =
  | { kind: "run"; mode: Mode; caseFiles: string[] }
  | { kind: "compare"; before: string; after: string };

export function parseEvalArgs(argv: string[]): EvalArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      mode: { type: "string" },
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

// Runs eval cases through the same runner the CLI uses, prints a scorecard and saves it for comparison.
// Expectations stay in the case files and never reach the model.
async function main(): Promise<void> {
  const args = parseEvalArgs(process.argv.slice(2));
  if (args.kind === "compare") {
    log(compareScorecards(loadScorecard(args.before), loadScorecard(args.after)));
    return;
  }
  const cases = loadCases(args.caseFiles);
  const deps = defaultRunnerDeps();
  const messages = caseMessages(cases);
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  const status = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" });
  const provenance = {
    commit: revision.status === 0 ? revision.stdout.trim() : null,
    dirty: status.status === 0 ? status.stdout.trim().length > 0 : null,
    suiteHash: createHash("sha256").update(JSON.stringify({ cases, messages })).digest("hex"),
    promptCache: args.mode === "default" && deps.promptCache !== false,
  };
  const run = await runMessages(messages, args.mode, deps);
  const model = args.mode === "baseline" ? deps.responderModel : `${deps.responderModel}, triage ${deps.triageModel}`;
  const card = buildScorecard({ cases, run, mode: args.mode, model });
  card.provenance = provenance;
  log(`\n${formatScorecard(card)}`);
  log(`\nSaved results to ${saveScorecard(card)}`);
  process.exitCode = card.totals.passed === card.totals.cases ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    log(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
