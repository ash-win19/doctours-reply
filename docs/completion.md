# Completion checklist

The combined implementation and offline review are complete. Live acceptance remains pending an API key, per Ashwin's request to continue offline. Ashwin subsequently authorized merging the full PR stack before live acceptance. The 18 escalation decisions have been accepted by Ashwin.

## Current work

| Issues | Offline result | Remaining acceptance |
|---|---|---|
| AW-95 through AW-100 | Built, integration-reviewed, fixes pushed on AW-98. Escalation decisions accepted. | Live packet, escalation, skill, LEAD and reader evals; ticket closeout. |
| AW-101 | [PR #9](https://github.com/ash-win19/doctours-reply/pull/9): explicit cache endpoints, opt-out, saved metrics and provenance implemented and reviewed. | Cache-hit evidence, measured trimming with no loss, final regression run. |
| AW-102 | [PR #10](https://github.com/ash-win19/doctours-reply/pull/10): seven-section README, original eight-problem mapping, examples and runtime reference reviewed. | Real final measurements, live five-message fresh-clone run and acceptance review. |

The README labels missing results as pending. The only published live scorecard remains the historical five-case baseline. Do not substitute unit-test results or token estimates for live measurements.

## Live runs

Use `main` after the full stack is merged. Add `OPENAI_API_KEY` to the shared `doctours-reply/.env`, or export it for a standalone clone. Do not put the key in the repository, a ticket, or a PR.

1. Run `npm test` and `npm run typecheck` after any new code change.
2. Run `npm run eval -- --cases packet-check`. Require all five cases to pass. Inspect `heva-packages` specifically: if its assessment URL comes from history, repair must fetch grounding evidence before the final Reply.
3. Compare that packet-only run with `npm run eval -- --compare 2026-10-02T00-31-24.474Z PACKET_DEFAULT_RUN_ID`.
4. Run `npm run eval -- --mode baseline` and `npm run eval` over all 78 current cases. Then run `npm run eval -- --compare FULL_BASELINE_RUN_ID FULL_DEFAULT_RUN_ID`. These must use the same case/context hash.
5. Inspect every failure and any baseline case that regressed. Fix the cause, rerun its case file, then rerun the full suite on the final code.

The eval command returns a nonzero exit if any case fails, including expected baseline failures. A saved scorecard still exists when the run completed. Distinguish that from setup failures that stop before a scorecard is written.

## Required results

- Five packet cases pass.
- All escalation decisions pass, including both code guards and model paraphrases.
- Three call-history cases pass with a successful reader call, and the responder never receives transcripts.
- Six LEAD cases pass, plus the packet-Patient photo inclusion and exclusion cases.
- Default-mode `metrics.fallbackMessages` is zero on the full supported suite.
- The full pass rate and the clinic/Package/payment criteria meet or exceed the matched baseline.
- Trace inspection confirms swapped context reaches ordinary tools, repair and the reader; usage includes every model call once.
- Check validator no-regression behavior against comparable pre-validator supported cases. The offline tests establish its repair and escalation invariants; live reply-quality parity still needs evidence.

## Optimization

Use `PROMPT_CACHE=off npm run eval` as the original-request-shape reference and `npm run eval` for explicit caching. Both still permit provider automatic caching. Inspect cache reads on compatible sequential requests; a concurrent second message need not hit a cache that is still being written.

After behavior passes, trim one skill at a time. Rerun that skill's cases and retain a trim only if its group's pass rate is maintained or improved. Record cuts and before/after token counts in [optimization.md](optimization.md). A measured reduction in median input tokens is still required for AW-101. Run the full suite after the final retained trim.

## Evidence and handoff

Copy only the final scorecards cited by the README into `evals/published/`, which is tracked. Preserve the historical baseline. Keep raw traces out of git. Record the command, commit, models, run ids and case set alongside the results.

Replace pending README values from those saved results. Verify the core's exact model-token budget and measure the Pipeline Status module and loaded skills; the current character-based test is only a heuristic. Review the seven sections against AW-102 and the eight source concerns in [brief.md](brief.md).

In a fresh clone, run `npm ci`, configure the real key and execute the README command against `examples/packet-messages.json`. Verify five schema-valid Replies in input order, stdout containing only JSON, and one trace per message. Run explicit baseline and the LEAD context examples too. Reviewer invitations remain excluded at Ashwin's request.

## Merge and closeout

Ashwin explicitly authorized merging all eight PRs in sequence while live acceptance remains pending. This supersedes the earlier instruction to wait for live results before merging. Use this order:

| PR | Ticket |
|---|---|
| #3 | AW-95 |
| #4 | AW-96 |
| #5 | AW-97 |
| #6 | AW-100 |
| #7 | AW-99 |
| #8 | AW-98, including integration fixes |
| #9 | AW-101 |
| #10 | AW-102 |

Use merge commits and check the next PR's base after each merge. Retarget it to `main` if needed. Delete remote branches after dependent PRs are safely retargeted; active local worktrees can prevent local branch deletion. Verify final `main` and record the merges in Linear. Keep tickets In Progress until their remaining acceptance criteria are met, then attach the evidence and mark them Done.

Merge authorization does not establish live acceptance or measured savings. If trimming is explicitly cut, record AW-101 as deferred or canceled and explain it in the README. Do not mark unmeasured savings as completed work.

## Fresh-clone verification

Cloned the pushed AW-102 branch from GitHub into a separate temporary directory at `ecfe12c`, with no linked dependencies or `.env`. Installation, typecheck and all 236 unit tests passed.

The documented quiet CLI command was checked with the two guard-only inputs in `examples/offline-escalations.json`, once with the packet context and once with the LEAD context. It produced valid JSON in input order and four trace files with zero model calls and no input card digits. The smoke test used a nonsecret placeholder key and a loopback API origin, so it could not use a live model.

The full packet command with no key failed clearly, returned a nonzero exit, and left stdout empty. These checks establish installability and offline CLI behavior. The five-message live run, baseline example and LEAD model reply remain pending a real key.

Standards and Spec reviews found two inherited runtime-documentation issues: a command without npm's `--silent` flag, and a historical cache percentage without saved evidence. Both were corrected before the fresh clone. Seven-section order, all local document links, source-problem mapping, saved baseline values and example shapes were verified.
