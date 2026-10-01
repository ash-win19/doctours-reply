import { loadCases } from "./eval/cases.ts";
import { loadScorecard, parseEvalArgs, saveScorecard } from "./eval/results.ts";
import { buildScorecard, compareScorecards, formatScorecard } from "./eval/scorecard.ts";
import { defaultRunnerDeps, log } from "./deps.ts";
import { runMessages } from "./runner.ts";

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
  const run = await runMessages(
    cases.map(({ id, text }) => ({ id, text })),
    args.mode,
    deps,
  );
  const card = buildScorecard({ cases, run, mode: args.mode, model: deps.responderModel });
  log(`\n${formatScorecard(card)}`);
  log(`\nSaved results to ${saveScorecard(card)}`);
  process.exitCode = card.totals.passed === card.totals.cases ? 0 : 1;
}

main().catch((error: unknown) => {
  log(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
