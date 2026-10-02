import { tokenUsage } from "../model-calls.ts";
import { skillsRun } from "../pipeline.ts";
import type { RunOutput } from "../runner.ts";
import { scoreCase, type EvalCase } from "./cases.ts";
import type { NamedCheck } from "./checks.ts";

export interface CaseScore {
  id: string;
  group: string;
  rule: string;
  passed: boolean;
  checks: NamedCheck[];
  response: string;
  escalate: boolean;
  inputTokens: number;
  outputTokens: number;
  wallTimeMs: number;
}

export interface Tally {
  cases: number;
  passed: number;
  passRate: number;
}

export interface Scorecard {
  runId: string;
  // A string, not Mode, so results saved by a mode that was later renamed or removed still load.
  mode: string;
  model: string;
  cases: CaseScore[];
  groups: Record<string, Tally>;
  totals: Tally & { inputTokens: number; outputTokens: number; medianLatencyMs: number };
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function tally(scores: CaseScore[]): Tally {
  const passed = scores.filter((score) => score.passed).length;
  return { cases: scores.length, passed, passRate: scores.length ? passed / scores.length : 0 };
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

export function buildScorecard({
  cases,
  run,
  mode,
  model,
}: {
  cases: EvalCase[];
  run: RunOutput;
  mode: string;
  model: string;
}): Scorecard {
  const scores = cases.map((evalCase, index): CaseScore => {
    const { reply, trace, error, wallTimeMs } = run.results[index];
    // A fallback Reply is not the model's work, so the case fails however its checks would score.
    const { passed, checks } =
      error !== null
        ? { passed: false, checks: [{ name: "drafted", ok: false, detail: error }] }
        : scoreCase(evalCase, reply, { toolCalls: trace?.toolCalls ?? [], skills: skillsRun(trace), mode });
    return {
      id: evalCase.id,
      group: evalCase.group,
      rule: evalCase.rule,
      passed,
      checks,
      response: reply.response,
      escalate: reply.escalate,
      ...tokenUsage(trace),
      wallTimeMs,
    };
  });

  const groups: Record<string, Tally> = {};
  for (const group of [...new Set(scores.map((score) => score.group))].sort()) {
    groups[group] = tally(scores.filter((score) => score.group === group));
  }

  return {
    runId: run.runId,
    mode,
    model,
    cases: scores,
    groups,
    totals: {
      ...tally(scores),
      inputTokens: sum(scores.map((score) => score.inputTokens)),
      outputTokens: sum(scores.map((score) => score.outputTokens)),
      medianLatencyMs: median(scores.map((score) => score.wallTimeMs)),
    },
  };
}

const percent = (rate: number) => `${Math.round(rate * 100)}%`;
const count = (value: number) => value.toLocaleString("en-US");
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function table(rows: string[][]): string {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => (row[column] ?? "").length)));
  return rows
    .map((row) => row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]))).join("  "))
    .join("\n");
}

export function formatScorecard(card: Scorecard): string {
  const caseRows = card.cases.map((score) => {
    const failures = score.checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.detail}`);
    return [score.passed ? "PASS" : "FAIL", score.group, score.id, failures.join("; ")];
  });
  const groupRows = Object.entries(card.groups).map(([group, groupTally]) => [
    group,
    `${groupTally.passed}/${groupTally.cases}`,
    percent(groupTally.passRate),
  ]);
  return [
    `Run ${card.runId} (${card.mode}, ${card.model})`,
    "",
    table(caseRows),
    "",
    table([...groupRows, ["Total", `${card.totals.passed}/${card.totals.cases}`, percent(card.totals.passRate)]]),
    "",
    table([
      ["Input tokens", count(card.totals.inputTokens)],
      ["Output tokens", count(card.totals.outputTokens)],
      ["Median latency", `${seconds(card.totals.medianLatencyMs)} per message`],
    ]),
  ].join("\n");
}

export function compareScorecards(before: Scorecard, after: Scorecard): string {
  const ids = (card: Scorecard) => card.cases.map(({ id }) => id).sort();
  if (JSON.stringify(ids(before)) !== JSON.stringify(ids(after))) {
    throw new Error("Compare runs with the same case ids. Select matching case files for both runs.");
  }
  const groups = [...new Set([...Object.keys(before.groups), ...Object.keys(after.groups)])].sort();
  const rate = (card: Scorecard, group: string) => (card.groups[group] ? percent(card.groups[group].passRate) : "-");
  const passedBefore = new Map(before.cases.map((score) => [score.id, score.passed]));
  const fixed: string[] = [];
  const broke: string[] = [];
  for (const score of after.cases) {
    const previously = passedBefore.get(score.id);
    if (previously === false && score.passed) fixed.push(score.id);
    if (previously === true && !score.passed) broke.push(score.id);
  }
  return [
    `Before: ${before.mode} ${before.runId} (${before.model})`,
    `After:  ${after.mode} ${after.runId} (${after.model})`,
    "",
    table([
      ["", "Before", "After"],
      ...groups.map((group) => [group, rate(before, group), rate(after, group)]),
      ["Total", percent(before.totals.passRate), percent(after.totals.passRate)],
      ["Input tokens", count(before.totals.inputTokens), count(after.totals.inputTokens)],
      ["Output tokens", count(before.totals.outputTokens), count(after.totals.outputTokens)],
      ["Median latency", seconds(before.totals.medianLatencyMs), seconds(after.totals.medianLatencyMs)],
    ]),
    "",
    `Fixed  ${fixed.length ? fixed.join(", ") : "none"}`,
    `Broke  ${broke.length ? broke.join(", ") : "none"}`,
  ].join("\n");
}
