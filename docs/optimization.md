# Caching and trim notes

AW-101 has an offline-tested caching implementation. Cache hits, token savings and behavior parity are not yet measured. Ashwin requested continuing offline while the API key is unavailable. No skill text has been trimmed.

## Request layout

The responder sends the same text, in the same order, as before this change. It now uses a developer message with text blocks instead of top-level `instructions`. Three blocks have explicit cache endpoints:

1. Core rules, before the Patient context.
2. The rest of the core, which holds the Patient context.
3. The Pipeline Status module.

Skills follow these blocks. Implicit caching remains enabled for the growing tool conversation. Each request uses a stable key derived from the Patient's chat id, hashed to avoid putting the raw identifier in the key. This key separates cache accounting; it does not make different prefixes match.

The [OpenAI prompt-caching guide](https://developers.openai.com/api/docs/guides/prompt-caching) documents a 1,024-token minimum for GPT-5.6 and later, explicit breakpoints on input text blocks, and up to three explicit cache writes alongside the implicit endpoint. Top-level instructions cannot carry explicit breakpoints. The installed OpenAI SDK exposes these fields.

Changing the tool list changes the rendered prefix, so different skill sets can miss the cache. A history or state change also invalidates prefixes after that change; the endpoint before Patient context preserves the earlier core rules when the tools match. The first concurrent messages may all arrive before a cache write finishes. Do not claim that every second message must hit the cache.

`PROMPT_CACHE=off` restores the prior responder request shape for a comparison or an older model without explicit breakpoint support. OpenAI's automatic caching remains enabled in that mode; this switch only removes this application's explicit cache plan. Baseline mode always keeps its original request shape regardless of this setting. Caching changes input processing and billing; it does not itself reduce the number of input tokens.

## Saved measurements

Every new eval scorecard records:

- Median total input tokens per message, including triage, responder, repair and reader calls.
- Cache-read and cache-write input tokens from the API's usage fields, summed once from the parent trace's model-call list.
- Median number of loaded skills, including required dependencies and skills loaded mid-turn.
- Counts of baseline fallbacks and messages that needed repair.
- Commit, dirty-worktree flag, a hash of cases and Patient contexts, and whether explicit caching was enabled.

Older scorecards remain readable. Missing cache measurements appear as `not recorded`. Comparisons reject different case ids or different recorded suite hashes.

## Trim decisions

| Skill | Change | Reason |
|---|---|---|
| clinic-packages | None | Await a passing live reference run. |
| decision-funnel | None | Await a passing live reference run. |
| payments | None | Await a passing live reference run. |
| intake-photos | None | Await a passing live reference run. |
| consultation | None | Await a passing live reference run. |
| pause | None | Await a passing live reference run. |
| travel | None | Await a passing live reference run. |
| clinic-contact | None | Await a passing live reference run. |
| assessment-aftercare | None | Await a passing live reference run. |
| creator | None | Await a passing live reference run. |
| call-history | None | Await a passing live reference run. |

## Live completion

Run the full default suite with `PROMPT_CACHE=off`, then with caching enabled, on the same code and cases. Inspect cache-read tokens on compatible sequential messages and tool rounds; do not infer hits from the presence of a breakpoint.

Only after behavior meets acceptance, shorten one skill, run that skill's cases, and compare its pass rate and input tokens against the saved reference. Record the exact cut, before/after measurements, and run ids here. Revert any trim that lowers the pass rate. Finish with a full default run and a matched full baseline run.

AW-101 remains In Progress until it has real cache-hit evidence, a measured reduction in median input tokens, and trim notes backed by saved runs. If the trim pass is dropped, close it explicitly as deferred or canceled and explain that choice in the README.

## Offline review

Standards: no findings. Spec: no implementation blockers for the offline scope. Both reviewers checked the installed SDK fields, preserved prompt composition, metrics and backward-compatible scorecards. All 236 unit tests and typecheck pass. Live acceptance remains pending.
