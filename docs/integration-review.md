# Combined integration review

Reviewed AW-95 through AW-100 together, from `main` at `7e38da0` through the stacked tip `3f41d9b`. The review used separate Standards and Spec reviewers. The repository has no additional coding-standards file. CONTEXT.md, the ADRs, README behavior, and the Linear acceptance criteria supplied the requirements.

## Standards

Two documented-behavior findings, both fixed:

- Card numbers in earlier chat history could reach triage, the responder, and traces. Default mode now redacts a copy of the Patient context and tool results before use, including call-reader records. The original context and explicit baseline mode remain unchanged. Follow-up review caught UUID suffixes that resemble card numbers; redaction now preserves complete UUIDs in identifiers and URLs, with regression coverage.
- A repair-time `escalate` call bypassed validation and changed the decision, while the trace claimed the first Reply shipped. Terminal tool outcomes now preserve the original escalation decision during repair and record a rejected attempt. Tests cover a later repair call and a second tool call in the initial batch.

No code-smell judgment required a change. The most serious Standards finding was card disclosure through history.

## Spec

Four findings, all fixed:

- AW-99: repair could change escalation through the terminal tool path. Covered by the fix above.
- AW-95: default-mode baseline fallback could ship an escalation containing sales text and ordinary Reply metadata. It now uses `escalationReply`; explicit baseline mode keeps its original behavior.
- AW-97: baseline scoring required a skill router and `askCallHistory`, neither of which baseline has. Baseline skips skill-selection checks and requires its own `getFullCallsTool` for call-history cases. Default mode still requires the reader. Ordinary tool-call and argument checks remain active in both modes. Comparing different case sets now fails instead of presenting misleading totals.
- AW-100: the reader's three-sentence cap was only a prompt instruction. Parsing now rejects longer answers, requests a shorter answer once, and fails if it remains invalid. It preserves valid answers containing titles and decimal prices without truncating them.

The most serious Spec findings were escalation changes during repair and sales content in fallback escalations.

## Additional acceptance correction

AW-95 requires redacting every card-like run of 13 to 19 digits. The old guard required a valid Luhn checksum. The guard now follows the ticket regardless of checksum, with tests for every supported length, separators, and adjacent out-of-range lengths.

## Verification and remaining gates

- All 230 unit tests pass; typecheck and `git diff --check` pass.
- Context propagation already worked through packet tools, repair, fallback, and the reader. The new tests additionally cover redaction across those boundaries.
- Ashwin accepted the 18 expected escalation decisions. See [the reviewed cases](escalation-review.md).
- Live evaluation remains pending because no API key is configured. No model-quality, cache-hit, token-saving, or latency claims follow from the offline tests.
- Keep the current OpenAI models, `gpt-6.1-sol` for Replies and `gpt-6-luna` for triage and the reader. The earlier Haiku references in Linear describe the intended small-model role; this implementation uses the existing OpenAI provider.
- Unknown topics can still fall back to the original prompt. Acceptance requires zero fallbacks on the supported evaluation suite, not the removal of that fallback for every possible topic.
- Reader failures escalate the whole message. Explicit baseline mode remains unvalidated for the before comparison.
