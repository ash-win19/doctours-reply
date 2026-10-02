# Doctours reply system

Writes the Coordinator's Reply to a Patient's text message, or escalates to an Operator. See `CONTEXT.md` for the vocabulary and `docs/adr/` for the decisions.

## Run it

You need Node 22.9 or newer and an [OpenAI API key](https://platform.openai.com/api-keys). Replies come from `gpt-6.1-sol` through the Responses API.

```sh
npm ci
cp .env.example .env
# Set OPENAI_API_KEY in .env using your editor, or export it in your shell.
npm run --silent respond -- examples/packet-messages.json > replies.json
```

`npm run --silent respond` and `npm run eval` load `.env` when it exists. Node prints a note on stderr when it doesn't.

- Input is a JSON array of `{id, text}` messages, read from the file argument or from stdin when there is no file.
- Output is a JSON array of `Reply` objects, one per message, in input order. It goes to stdout, or to `--out <file>`.
- stdout holds only that JSON array. Progress and errors go to stderr.
- `--context <file>` swaps in another Patient. See [Patient context](#patient-context).
- Up to 4 messages run at once.
- Each message writes a trace to `traces/<runId>/<messageId>.json`. A trace holds the input, the filled prompts, every tool call and result, the final model output, and tokens (including cached and reasoning tokens) and latency for each model call.

Rate limits (429), server errors and network errors are retried by the OpenAI SDK with exponential backoff, honoring `retry-after`, up to 3 times. Each attempt times out after 3 minutes. A message whose model call still fails escalates. An account that is out of credit (`insufficient_quota`) stops the run instead of retrying.

`RESPONDER_MODEL` sets the OpenAI model that writes Replies and defaults to `gpt-6.1-sol`. Use `gpt-6-astra` for the strongest replies or `gpt-6-luna` for the cheapest. `TRIAGE_MODEL` sets the small model that triages each message and defaults to `gpt-6-luna`.

Default-mode skill Replies use explicit prompt-cache endpoints on the core and Pipeline Status module. `PROMPT_CACHE=off` restores the original request shape while leaving provider automatic caching enabled. See [caching and trim notes](optimization.md) for limits and pending measurements.

The run ID is the run's start time as an ISO timestamp, with `:` swapped for `-` so it works as a directory name.

If a message can't be drafted, its Reply escalates ("I'm getting a person for you.", with `escalationReason` "Could not draft a reply"), so every message still gets exactly one Reply. Setup problems such as a missing or rejected key or an unknown model stop the whole run with a non-zero exit instead.

## Patient context

Every Reply is written for one Patient. By default that is the packet's Patient, whose constants are in `src/context.ts`. `--context <file>` swaps in another one:

```sh
npm run --silent respond -- --context evals/contexts/lead.json messages.json
```

A context file is a JSON object with any of the packet constants' keys, such as `PIPELINE_STATUS`, `PATIENT_NAME`, `RECENT_MEDIA_CONVERSATION` or `CHAT_LIST`. `src/patient-context.ts` validates it against a schema of every key. A misspelled key or a wrong type stops the run. Any key the file leaves out takes the packet's value, with one exception: `COLLECTION_STATUS` describes the packet Patient, so when a file omits it, `loadContext` works out Intake item status once, from the name, procedure area and photos plus what working memory remembers (`patientName`, `procedureArea` and the ask counts).

`toolOverrides` fixes what a tool returns for this Patient. A key can be the tool's name (`getPatientImagesTool`) or the packet function behind it (`getPatientImages`), and both are stored by tool name. Each value is returned instead of running the function, once the call's input has passed validation. A string value of exactly `"{{input.firstName}}"` takes that field from the call's arguments, or null:

```json
{
  "PIPELINE_STATUS": "LEAD",
  "toolOverrides": {
    "getPatientImages": { "hasImages": false, "imageCount": 0 },
    "updateUser": { "firstName": "{{input.firstName}}", "updated": true }
  }
}
```

The packet functions return Jordan's data whatever the context says, so a context file should override every tool whose packet result would contradict it, such as the Patient's name, Pipeline Status, assessment, Matched clinics, photos, calls and consultation.

Fixtures live in `evals/contexts/`:
- `lead.json` is a brand-new LEAD Patient: no name, procedure area, photos or chat history, with overrides for every Patient-specific tool.
- `lead-photos-asked.json` is a LEAD Patient who has answered the area and name asks and was just sent the photo-upload link, with no photos saved yet.
- `clinic-own-websites.json` is the packet Patient, but each clinic's own `url` differs from its Doctours page, so a website case can tell which one went out.
- `heva-preferred-airport.json` is the packet Patient, with Heva's Packages returning a `preferredAirport` (SAW) and nearby airports.

## Modes

`--mode` picks how Replies are drafted. It defaults to `default`.

### default

Escalation is settled before any Reply is drafted, and the responder can still escalate mid-turn (ADR 0001, ADR 0002):

1. **Guards, in code.** Card numbers (13 to 19 digits with optional spaces or dashes, regardless of checksum) and phrases like "card ending in 4242" are replaced with "[card number]" before triage, a trace or any model sees the text. Card details or an explicit request for a person ("talk to a human", "real person", "someone call me") escalate with no model call.
2. **Triage.** One `TRIAGE_MODEL` call reads the redacted message, a state card built from the Patient context, the last 4 chat turns and the escalation policy in `prompts/triage/`, and submits `{ escalate, escalationReason, cannotDo, skills, intent }`.
3. **Escalation.** Code renders the Reply from the ADR 0002 template: "I can't {cannotDo}. I'm getting a person for you.", or "I'm getting a person for you." with no `cannotDo`. A `cannotDo` holding digits is dropped. The Reply sets `escalationReason`, `intent` "escalate to a person" and `workingMemoryUpdates.escalationFlags`.
4. **Skills.** Everything else is answered by a responder that sees only three things, in this order:
   - the core (`prompts/core.md`): identity and single voice, plain-text SMS, answer then stop, reply sizing, no stalling, grounding, link placement and the static URL allowlist, rule precedence, the state card, working memory and the chat history
   - the module for the Patient's Pipeline Status (`prompts/status/`), which code picks and triage never does. `STATUS_MODULES` in `src/skills.ts` lists every status with a module of its own and the files composed into it: today LEAD, PREP_PRE_CLINICAL, PRE_CLINICAL_SENT, MEETING_BOOKED and MEETING_COMPLETED (one shared section, as in the source), MEETING_MISSED and WAITING. Files under `prompts/status/shared/` are composed into more than one, such as the pre-assessment pricing length cap for LEAD, PREP_PRE_CLINICAL and MEETING_BOOKED. Any other status gets `REACTIVE.md`, which says to answer reactively
   - the skills triage chose (`prompts/skills/`), plus every skill they `requires`

   Its tools are the loaded skills' tools plus `loadSkill`, `escalate` and `submitReply`. `loadSkill` pulls in another skill's text and tools mid-turn. `escalate` returns the same template Reply as step 3. `updateWorkingMemory` is never exposed, so memory changes come back only in `workingMemoryUpdates`. Code sets `templateId` to null, and a submitted Reply never escalates.
5. **Call-history subagent** (ADR 0003). The `call-history` skill is new behaviour that wraps one source rule, TOOL USAGE's "Use getFullCallsTool only when you need full call context and there has been a very recent call listed in context." It gives the responder one tool, `askCallHistory({ question })`, which runs a separate `TRIAGE_MODEL` call (`src/call-history.ts`, `prompts/call-history/`):
   - The reader fetches `getFullCallsTool` itself, reads the summaries and transcripts, and answers in at most 3 sentences, or says the calls don't cover the question. The cap is checked when the answer is parsed. An overlong answer gets one request to shorten it; a second invalid answer fails the reader. Code never cuts the answer.
   - Card-like digit runs are redacted from call records before the reader sees them, and from its answer before the responder or trace sees it.
   - The responder gets only the answer, so on the skills path transcript text never enters its context. A message that falls back to the baseline responder still has `getFullCallsTool`, because the baseline stays the original prompt.
   - The trace adds `{ subagent: "callHistory", question, answer, callIds, usage, latencyMs, error }` to the responder's `subagents`. The reader's model calls also go into `modelCalls` under the step `callHistory`, so its tokens count in eval totals.
   - If the reader still fails after retries, its record keeps the usage, latency and error, and the message fails like any other drafting failure and escalates. A Reply written without the answer could only guess at what was said.
   - Subagent tools are listed by name in `src/tools.ts` and defined in one map in `src/subagent-tools.ts`, so adding another means one name and one map entry.
6. **Fallback.** If triage names a skill that doesn't exist yet (it says `other` for a topic no skill covers), the message goes to the baseline responder and the trace records `fallback: { to: "baseline", reason }`.
7. **Validator.** Every Reply that isn't an Escalation goes through `src/validator.ts` before output, including a Reply from the baseline fallback. Escalations from the guards, triage or the `escalate` tool skip it, and it never changes `escalate`. A default-mode fallback escalation uses the same fixed template and fields. Repair cannot escalate, including through the `escalate` tool. See [Validator](#validator).

The trace records the guard hits, the triage input and output, the path the message took (`guard-escalation`, `triage-escalation`, `skills`, `baseline` or `drafting-failed`), the skills triage chose and any loaded mid-turn, every tool call with its arguments and result, and every model call tagged with its step. Trace files never hold card digits in this mode. Default mode also redacts text in the Patient context and tool results. Baseline mode still sends the raw text to the model, so its `userMessage` does.

### Validator

Some failures are cheap to catch in code, so every Reply is checked against what this turn's tool results said. As tool results arrive, the responder collects their URLs, clinic slugs and money values: numbers under a price, amount, deposit, fee or cost key, plus numbers written next to "$" or "USD". Ids and counts never count. The pipeline adds the card digit runs the guards found in the Patient's raw message. The `askCallHistory` answer is not evidence: it's a model's summary of the calls, so a URL or amount in it reaches a Reply only if a packet tool returned it this turn. A Reply that escalates is never validated, and the validator never changes `escalate`.

Fixed in code right away:
- A URL that no tool returned this turn and that isn't on the static allowlist is removed, along with its line. This also asks for a repair, so a Reply isn't left saying "the link below" with no link. The allowlist is the Consultation link, the image-upload link, and `https://www.doctours.com/clinic/{slug}` for a slug a tool returned this turn. The core prompt is filled from the same constants in `src/validator.ts`.
- The Patient's card numbers are removed: whole runs anywhere, and the last four only where they follow "ending in" or "last four" style wording.
- URLs move to the last lines, one per line, in order of first mention. A URL inside a sentence becomes "the link below".
- Markdown markers are stripped. URLs keep their underscores.
- Field consistency: `escalationReason` is null when `escalate` is false, `followUpTiming` is null when `shouldFollowUp` is false, and an empty `attachmentUrls` is null. The tool loop sets `templateId` to null on every submitted Reply.

Checked, then repaired once:
- Every amount next to "$" or "USD" is a money value in this turn's tool results, or on the policy list (the $25 cancellation fee).
- No banned phrases: an assessment turnaround window (a window tied to the assessment being ready, done, back, sent or delivered), "I'll get back to you", saying "a coordinator will…" or "someone from our team", and advice to bring, pack, wear, buy or pick out a head covering. The list is `BANNED_PHRASES`, with the source rule next to each entry.
- `attachmentUrls` has at most 3 entries, all returned by a tool.

If anything still fails, the responder gets one repair turn. A `user`-role message lists the failures. The model may make up to 2 lookups, and its last call must submit the Reply again. Further submitReply calls in the response that asked for the repair don't count as the repair. The version with fewer failures ships, unless the repair changed `escalate`, in which case the first version ships. If the repair doesn't come back as a valid Reply, the first version ships. Anything still failing ships anyway. The trace's `responder.validation` holds each run's fixes and check results, whether repair ran, and which version shipped.

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
| `intake-photos` | Collecting procedure area, name and intake photos: the first-contact introduction, the one collection ask, uploads and "done", photo delays, a Patient's own photos (at most 3 attached) | `getPatientImagesTool`, `updateUserTool` |
| `consultation` | Whether the free Consultation is free (a phone call with Doctours' team, with the Consultation link last), booking, confirming or rescheduling it. Its PHONE CONTACT slip-through line now calls `escalate`, per ADR 0002 | `getConsultationRescheduleLinkTool` |
| `pause` | A Patient stepping back: the dated Follow-up close, `shouldFollowUp`, `followUpTiming` and `promisesMade`. Overrides DECISION STEPS advancement (decision-funnel), the Intake item ask (intake-photos), and the core's NO STALLING rule for the dated Follow-up | none |
| `travel` | Flights, travel timing, airports, hotels, transfers, passports. Requires `clinic-packages` | `getClinicPackagesTool` |
| `clinic-contact` | A clinic's website (the Doctours clinic page first), and whether the Patient can message a clinic themselves | `getAllClinicsTool`, `getSavedClinicsTool` |
| `assessment-aftercare` | What the Assessment shows, revision requests, no turnaround windows, what to wear after, finasteride and minoxidil. Overrides the core's NO STALLING rule for the one revision commitment | `getLatestAssessmentTool` |
| `creator` | Creator and partnership requests, answered only with Molly's email. The source's claim that these are routed to a person first is dropped, since ADR 0002 answers them | none |
| `call-history` | What was said, asked or decided on a past call with Doctours, such as the Consultation. Its one tool runs the call-history reader | `askCallHistory` |

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
- New scorecards include median input tokens, cache reads and writes, loaded-skill counts, fallback and repair counts, and commit/suite provenance. Every run saves its scorecard to `evals/results/<runId>.json`, with the same run ID as its traces.
- `npm run eval -- --compare <runA> <runB>` prints the two runs side by side, plus the cases that were fixed or broke. Both runs must contain the same case ids. Run `--cases packet-check` separately for comparison with the historical five-case baseline. A run is named by its run ID or by a results file path.

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

Baseline scoring skips skill-selection checks because baseline has no skill router. A call-history lookup must use `getFullCallsTool` in baseline and `askCallHistory` in default mode. All other tool calls, arguments and Reply checks apply in both modes.

A case can also name a Patient context file with `"context": "evals/contexts/lead.json"`, and its message then runs as that Patient. Without one it runs as the packet's Patient.

`group` is the skill the case exercises, or `escalation`. `rule` cites the source rule it tests. The checks are `escalate` (exact match), `calls` (each listed tool ran without error, with arguments containing each `argsInclude` text), `skills` (`includes` and `excludes` lists checked against the skills that ran: the ones triage chose plus any loaded mid-turn), `fields` (dotted paths into the Reply such as `followUpTiming` or `workingMemoryUpdates.promisesMade` hold an exact value, any of a list of strings, or `"*"` for any non-empty value; strings compare ignoring case), `includes` and `excludes` (substrings, ignoring case; an `includes` entry can be a list of alternatives, any one of which is enough), `leadsWith` (the first sentence mentions one of a list of alternatives), `lastLineUrl` (the Reply's last line is exactly that URL), `noUrl`, `maxSentences` (split on `.`, `?` and `!` after removing URLs) and `maxAttachments`. Numbers match however they're written, as whole numbers: `"$3,000"` matches "3000 USD" but `"$500"` doesn't match inside "$4,500". Every case also checks that the Reply matches the schema with a null `templateId`. An unknown check name is rejected, so a typo can't pass silently.

There is one case file per skill, each case citing the source section it tests: `clinic-packages.json`, `decision-funnel.json` and `payments.json` (16 cases), plus `consultation.json`, `pause.json`, `travel.json`, `clinic-contact.json`, `assessment-aftercare.json` and `creator.json` (26 cases). Every file for the later six has at least one mixed message that needs two skills. `call-history.json` holds 3 cases for the call-history reader: what the call covered, a detail from the transcript, and a question the calls don't cover. `intake-photos.json` runs six cases as a LEAD Patient: the first-contact introduction, the area ask, the photo ask with "send done", a hair-state delay, a shared name, and "done" when no photos were saved (against `lead-photos-asked.json`, since that rule only applies after a photo ask). Two more run as the packet Patient: "Can I see my photos?" must load intake-photos, and "What does Dr. Hakan Clinic cost?" must not.

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

The saved scorecard does not record cache-read tokens. Input tokens 536,458, output tokens 1,599, median latency 14.0s per message. Every message re-sends the ~38k-token original prompt on each of its 1 to 4 model calls.

What the original prompt gets wrong:

- `charge-card` doesn't escalate. It declines the charge, tells the Patient to pay from the assessment, and quotes the deposit's refund terms.
- `heva-packages` leaves out both deposits and doesn't end on the assessment link.
- `consultation` says it's free but leaves out the consultation link.
- `demand-human` sets `escalate` but its sentence ("I understand, Jordan. I'm sorry for the frustration.") never says a person is coming. No packet-check rule covers the sentence, so it passes.
