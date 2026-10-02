# Submission plan and evidence

The submission must run from a clone, answer unseen messages using the packet's rules and tools, and stop when an Operator is needed. Offline tests verify implementation behavior. Live evaluations must establish model behavior separately.

## Implementation

- [x] Replace the invalid-draft repair fallback with a fixed escalation.
- [x] Permit an escalation discovered during repair, through either responder submission or the escalation tool.
- [x] Use one fixed sentence for every default-mode escalation.
- [x] Reserve trace filenames globally, including suffix and case collisions; bound long ids.
- [x] Check package-to-price and package-to-deposit attribution in evaluations.
- [x] Check Reply consistency, attachment provenance, URL placement and escalation length.
- [x] Add 18 generalization cases, including mixed requests, quotations, negations, missing tool data and unsupported actions.
- [x] Add repeated evaluations and save full Replies in scorecards.
- [x] Add a reproducible CLI demo and offline CI checks.
- [ ] Publish live packet and full-suite results, inspect failures, and fix any demonstrated regressions.
- [ ] Publish a matched baseline/default comparison and measured token/latency results.
- [ ] Verify the five-message live command from a fresh clone with accessible models.

## Commands

Configure `OPENAI_API_KEY` in the repository-root `.env`. Never commit that file. Both configured model ids must be accessible to the key; override `RESPONDER_MODEL` and `TRIAGE_MODEL` if needed. Use the same responder configuration and concurrency for both modes in a comparison. Run them sequentially to avoid sharing and exhausting the API token-per-minute allowance.

```sh
npm ci
npm run typecheck
npm test
npm run demo -- --offline
npm run demo
npm run eval -- --mode baseline --cases packet-check
npm run eval -- --cases packet-check
REPLY_CONCURRENCY=1 npm run eval -- --mode baseline
REPLY_CONCURRENCY=1 npm run eval
npm run eval -- --cases escalation --cases generalization --repeat 3
npm run eval -- --compare BASELINE_RUN_ID DEFAULT_RUN_ID
```

The eval command saves a scorecard even when cases fail, but a setup failure stops it before that scorecard exists. Inspect each run and all repeated cases. Do not publish only the best repetition. Expected baseline failures do not prevent running the default comparison.

The historical baseline used weaker checks and is retained for provenance, not as the current matched comparison. Current comparisons should use identical suite hashes. Copy only the scorecards cited in the README into `evals/published/`.

## Demo artifacts

`npm run demo` runs the documented CLI as a separate process. It parses stdout as JSON, verifies the Reply count and packet expectations, and records one trace per input. Artifacts go to a new directory under `evals/published/`; use `--out DIR` to select another directory.

| File | Purpose |
| --- | --- |
| `input.json` | The exact array of `{id, text}` messages given to the CLI. |
| `output.json` | The actual Reply array in input order, including all nullable fields. |
| `manifest.json` | Command, commit, dirty-worktree flag, Node version, timestamp and checks. |
| `trace-summary.json` | Routing, selected skills, tool names, validation decisions and actual model usage. |

Read a trace summary in order: `path` explains the route; `skills` shows the loaded topics; `tools` shows successful lookups or actions; `validation` lists any checks, repair and the final choice; `modelCalls` records which models ran and their latency and token use. Full local traces remain under `traces/` and are not published automatically.

`npm run demo -- --offline` exercises only the explicit-human and card-detail guards. It forces a placeholder key and loopback endpoint and verifies zero model calls. An offline demo is execution evidence, not evidence of model quality, model availability or token savings.

## Acceptance and limits

Require all five packet cases, inspect the full 96-case suite, and require every critical escalation repetition to pass. Confirm no unsupported-topic baseline fallbacks on the supported suite. Investigate every regression against the matched baseline, including increased unnecessary escalation. Report correctness alongside input/output tokens and latency so a faster but less useful system is not presented as an improvement.

The package attribution checker is deliberately conservative. It handles ordinary named-package summaries and labels amounts by adjacent deposit wording; it rejects ambiguous grouped lists. Human review must resolve unusual phrasing and facts outside its coverage. Runtime money validation checks that amounts appear in tool results or policy, but does not prove every number's attribution. Passing the code checks is not a universal factual guarantee.

No web UI, live clinic/payment integration, deployment, or additional agent is required by the assignment. Repository access and a working CLI are the deliverables. Confirm reviewer access before handing over the GitHub URL.
