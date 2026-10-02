# Doctours reply system

Writes the Coordinator's Reply to a Patient's text message, or escalates to an Operator. See `CONTEXT.md` for the vocabulary and `docs/adr/` for the decisions.

## Run it

You need Node 22.9 or newer and an [OpenAI API key](https://platform.openai.com/api-keys). Replies come from `gpt-6.1-sol` through the Responses API.

```sh
npm install
echo "OPENAI_API_KEY=..." > .env   # or export it in your shell
npm run respond -- messages.json > replies.json
```

`npm run respond` and `npm run eval` load `.env` when it exists. Node prints a note on stderr when it doesn't.

- Input is a JSON array of `{id, text}` messages, read from the file argument or from stdin when there is no file.
- Output is a JSON array of `Reply` objects, one per message, in input order. It goes to stdout, or to `--out <file>`.
- stdout holds only that JSON array. Progress and errors go to stderr.
- Up to 4 messages run at once.
- Each message writes a trace to `traces/<runId>/<messageId>.json`. A trace holds the input, the filled prompts, every tool call and result, the final model output, and tokens (including cached and reasoning tokens) and latency for each model call.

Rate limits (429), server errors and network errors are retried by the OpenAI SDK with exponential backoff, honoring `retry-after`, up to 3 times. Each attempt times out after 3 minutes. A message whose model call still fails escalates. An account that is out of credit (`insufficient_quota`) stops the run instead of retrying.

`RESPONDER_MODEL` sets the OpenAI model that writes Replies and defaults to `gpt-6.1-sol`. Use `gpt-6-astra` for the strongest replies or `gpt-6-luna` for the cheapest. `TRIAGE_MODEL` sets the small model that triages each message and defaults to `gpt-6-luna`.

The run ID is the run's start time as an ISO timestamp, with `:` swapped for `-` so it works as a directory name.

If a message can't be drafted, its Reply escalates ("I'm getting a person for you.", with `escalationReason` "Could not draft a reply"), so every message still gets exactly one Reply. Setup problems such as a missing or rejected key or an unknown model stop the whole run with a non-zero exit instead.

## Modes

`--mode` picks how Replies are drafted. It defaults to `default`.

### default

Escalation is settled before any Reply is drafted, and the responder can still escalate mid-turn (ADR 0001, ADR 0002):

1. **Guards, in code.** Card numbers (13 to 19 digits with optional spaces or dashes that pass the Luhn check) and phrases like "card ending in 4242" are replaced with "[card number]" before triage, a trace or any model sees the text. Card details or an explicit request for a person ("talk to a human", "real person", "someone call me") escalate with no model call.
2. **Triage.** One `TRIAGE_MODEL` call reads the redacted message, a state card built from the Patient context, the last 4 chat turns and the escalation policy in `prompts/triage/`, and submits `{ escalate, escalationReason, cannotDo, skills, intent }`.
3. **Escalation.** Code renders the Reply from the ADR 0002 template: "I can't {cannotDo}. I'm getting a person for you.", or "I'm getting a person for you." with no `cannotDo`. A `cannotDo` holding digits is dropped. The Reply sets `escalationReason`, `intent` "escalate to a person" and `workingMemoryUpdates.escalationFlags`.
4. **Skills.** Everything else is answered by a responder that sees only three things, in this order:
   - the core (`prompts/core.md`): identity and single voice, plain-text SMS, answer then stop, reply sizing, no stalling, grounding, link placement and the static URL allowlist, rule precedence, the state card, working memory and the chat history
   - the module for the Patient's Pipeline Status (`prompts/status/`), which code picks and triage never does
   - the skills triage chose (`prompts/skills/`), plus every skill they `requires`

   Its tools are the loaded skills' tools plus `loadSkill`, `escalate` and `submitReply`. `loadSkill` pulls in another skill's text and tools mid-turn. `escalate` returns the same template Reply as step 3. `updateWorkingMemory` is never exposed, so memory changes come back only in `workingMemoryUpdates`. Code sets `templateId` to null, and a submitted Reply never escalates.
5. **Fallback.** If triage names a skill that doesn't exist yet (it says `other` for a topic no skill covers), or the Pipeline Status has no module, the message goes to the baseline responder and the trace records `fallback: { to: "baseline", reason }`.
6. **Validator.** Every Reply that isn't an Escalation goes through `src/validator.ts` before output, including a Reply from the baseline fallback. Escalations from the guards, triage or the `escalate` tool skip it, and it never changes `escalate`. See [Validator](#validator).

The trace records the guard hits, the triage input and output, the path the message took (`guard-escalation`, `triage-escalation`, `skills`, `baseline` or `drafting-failed`), the skills triage chose and any loaded mid-turn, every tool call with its arguments and result, and every model call tagged with its step. Trace files never hold card digits in this mode. Baseline mode still sends the raw text to the model, so its `userMessage` does.

### Validator

Some failures are cheap to catch in code, so every draft is checked against what this turn's tool results said. As tool results arrive, the responder collects their URLs, clinic slugs and text, and the pipeline adds any card digit runs from the Patient's raw message.

Fixed in code right away:
- A URL that no tool returned this turn and that isn't on the static allowlist is removed, along with its line. The allowlist is the Consultation link, the image-upload link, and `https://www.doctours.com/clinic/{slug}` for a slug a tool returned this turn.
- Card digits from the Patient's message, and their last four, are removed.
- URLs move to the last lines, one per line, in order of first mention. A URL inside a sentence becomes "the link below".
- Markdown markers are stripped. URLs keep their underscores.
- Field consistency: `templateId` is null, `escalationReason` is null when `escalate` is false, `followUpTiming` is null when `shouldFollowUp` is false, and an empty `attachmentUrls` is null.

Checked, then repaired once:
- Every amount next to "$" or "USD" appears as a number in this turn's tool results, or on the policy list (the $25 cancellation fee).
- No banned phrases: assessment turnaround windows, stalling ("I'll get back to you"), handing off to "a coordinator" or "someone from our team", and head-covering advice. The list is `BANNED_PHRASES`, with the source rule next to each entry.
- `attachmentUrls` has at most 3 entries, all returned by a tool.

If a check fails, the responder gets one more turn. A user message lists the failures, and the next call must submit the Reply again. The version with fewer failures ships. If the repair doesn't come back as a valid Reply, the first version ships. Anything still failing ships anyway. The trace's `responder.validation` holds each run's fixes and check results, whether repair ran, and which version shipped.

### Skills

A skill is a Markdown file of rules copied nearly word for word from the original prompt, with frontmatter:

```
---
id: decision-funnel
description: One line that triage and loadSkill see.
tools: [getLatestAssessmentTool, getPatientContextTool, updateUserClinicPreferencesTool, getPaymentLinkTool]
requires: [clinic-packages]
overrides: []
sources: [PRE_CLINICAL_SENT Steps 0 to 3, REVERSIBILITY, ...]
---
```

`sources` names the original prompt's sections the text came from, and `overrides` names rules the skill beats under the core's rule precedence (Escalation, then hard rules, then the Pipeline Status module, then skills, then style). For a cross-cutting section, the general rule stays in the core and the topic's examples move into the skill.

| Skill | What it answers | Tools |
|---|---|---|
| `clinic-packages` | Package prices, Deposits, inclusions, hotel nights, bookable weekdays, doctors, Clinic status, afro specialty, a clinic's direct quote | `getAllClinicsTool`, `getClinicPackagesTool`, `getClinicDoctorsTool`, `getSavedClinicsTool` |
| `decision-funnel` | Choosing a clinic and Package, booking from the assessment, Payment and Checkout links, tentative dates, what can change later. Requires `clinic-packages` | `getLatestAssessmentTool`, `getPatientContextTool`, `updateUserClinicPreferencesTool`, `getPaymentLinkTool`, `issuePromoCodeTool` |
| `payments` | Financing, Layaway, insurance, CareCredit and Cherry, Deposit and balance terms, a Deposit paid to a clinic, promos. Requires `clinic-packages` | `issuePromoCodeTool`, `getPaymentLinkTool` |

### baseline

`baseline` runs the packet's original system prompt, filled as the packet's Flow section describes, with the packet's 14 functions as the only tools. It's the "before" that later changes are measured against.

- `prompts/baseline/` holds the original system prompt and user message template. Each `{{NAME}}` takes the constant of the same name from `src/context.ts`. Strings go in as they are, and anything else is JSON-stringified.
- `src/packet-tools.ts` and `src/context.ts` are the packet's code and constants, unchanged. `src/tools.ts` exposes each function under the name the prompt uses, such as `getClinicPackagesTool`.
- The model finishes by calling `submitReply`, whose parameters schema is the `Reply` type. Every model call uses `tool_choice: "required"`, so it must call a function. After 8 tool rounds the next call is forced to `submitReply`. Each response's output goes back whole, so reasoning items stay with the calls they led to. `templateId` is always set to null.

## Check it

```sh
npm test            # unit tests, no API key needed
npm run typecheck
npm run eval        # runs every eval case through the real model
```

### Evals

`npm run eval -- --mode <mode>` runs the cases in `evals/cases/` through the same runner the CLI uses, scores each Reply, and prints a scorecard to stderr: pass or fail per case with the failing check, the pass rate per group, total input and output tokens, and the median latency per message. Output tokens include reasoning tokens. A message the model never finished fails as `drafted`, even if its fallback Reply happens to match.

- `--cases <name>` runs one case file, such as `--cases packet-check`. Repeat it for more.
- Every run saves its scorecard to `evals/results/<runId>.json`, with the same run ID as its traces.
- `npm run eval -- --compare <runA> <runB>` prints the two runs side by side, plus the cases that were fixed or broke. A run is named by its run ID or by a results file path.

A case is one Patient message plus deterministic checks:

```json
{
  "id": "consultation",
  "group": "consultation",
  "rule": "Packet, Expected outputs: consultation must say it is free and include the consultation URL.",
  "text": "Is the consultation free?",
  "expect": { "escalate": false, "includes": ["free"], "lastLineUrl": "https://www.doctours.com/consultation" }
}
```

`group` is the skill the case exercises, or `escalation`. `rule` cites the source rule it tests. The checks are `escalate` (exact match), `calls` (each listed tool ran without error, with arguments containing each `argsInclude` text), `includes` and `excludes` (substrings, ignoring case; an `includes` entry can be a list of alternatives, any one of which is enough), `lastLineUrl` (the Reply's last line is exactly that URL), `noUrl`, `maxSentences` (split on `.`, `?` and `!` after removing URLs) and `maxAttachments`. Numbers match however they're written, as whole numbers: `"$3,000"` matches "3000 USD" but `"$500"` doesn't match inside "$4,500". Every case also checks that the Reply matches the schema with a null `templateId`. An unknown check name is rejected, so a typo can't pass silently.

`evals/cases/clinic-packages.json`, `decision-funnel.json` and `payments.json` hold 16 cases for the first three skills, each citing the source section it tests.

`evals/cases/escalation.json` covers both sides of every line in ADR 0002: 11 messages that must escalate, including paraphrases triage has to catch, and 7 that must be answered.

`evals/cases/packet-check.json` holds the packet's five messages and only the checks the packet says must match. Nothing outside the eval harness reads it. A unit test fails if any source file or prompt mentions it.

Result files stay out of git, except the baseline below.

### Baseline

`evals/results/2026-10-02T00-31-24.474Z.json` is the first "before": baseline mode on packet-check with `gpt-6.1-sol`. Later changes are compared against it with `npm run eval -- --compare 2026-10-02T00-31-24.474Z <newRunId>`.

| Group | Passed |
|---|---|
| clinic-packages | 1/2 (50%) |
| consultation | 0/1 (0%) |
| escalation | 1/2 (50%) |
| **Total** | **2/5 (40%)** |

Input tokens 536,458 (about 98% served from OpenAI's prompt cache), output tokens 1,599, median latency 14.0s per message. Every message re-sends the ~38k-token original prompt on each of its 1 to 4 model calls.

What the original prompt gets wrong:

- `charge-card` doesn't escalate. It declines the charge, tells the Patient to pay from the assessment, and quotes the deposit's refund terms.
- `heva-packages` leaves out both deposits and doesn't end on the assessment link.
- `consultation` says it's free but leaves out the consultation link.
- `demand-human` sets `escalate` but its sentence ("I understand, Jordan. I'm sorry for the frustration.") never says a person is coming. No packet-check rule covers the sentence, so it passes.
