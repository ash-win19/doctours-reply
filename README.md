# Doctours reply system

Writes the Coordinator's Reply to a Patient's text message, or escalates to an Operator. See `CONTEXT.md` for the vocabulary and `docs/adr/` for the decisions.

## Run it

You need Node 22 or newer and a free Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey). Replies come from `gemini-3.5-flash-lite`. On the free tier, Google may use prompts and responses to improve its products.

```sh
npm install
export GEMINI_API_KEY=...
npm run respond -- --mode baseline messages.json > replies.json
```

- Input is a JSON array of `{id, text}` messages, read from the file argument or from stdin when there is no file.
- Output is a JSON array of `Reply` objects, one per message, in input order. It goes to stdout, or to `--out <file>`.
- stdout holds only that JSON array. Progress and errors go to stderr.
- Up to 4 messages run at once.
- Each message writes a trace to `traces/<runId>/<messageId>.json`. A trace holds the input, the filled prompts, every tool call and result, the final model output, and tokens (including cached and thinking tokens) and latency for each model call.

The free tier has a low per-model request limit (5 per minute for Flash when this was written), and Gemini counts the baseline prompt at about 40k tokens per request. So the runner paces requests:

- `REQUESTS_PER_MINUTE` (default 5) caps how many model requests start in any rolling minute, across all 4 concurrent messages. Retries count against it too. Raise it if your AI Studio rate-limit page shows a higher limit.
- A rate limit (429) is retried after the delay Gemini asks for. An overload (503 "high demand") backs off exponentially, up to a minute between tries, for 8 attempts in total.
- If the free daily quota is used up, the run stops instead of retrying.

Expect the five packet messages to take a few minutes.

`RESPONDER_MODEL` sets the Gemini model and defaults to `gemini-3.5-flash-lite`, a free model that tends to see less demand than the newest Flash. Set it to `gemini-3.8-flash` for stronger replies if your quota allows. `TRIAGE_MODEL` defaults to `gemini-3.5-flash-lite` and is unused until a mode with triage lands.

The run ID is the run's start time as an ISO timestamp, with `:` swapped for `-` so it works as a directory name.

If a message can't be drafted, its Reply escalates ("I can't answer this one myself. I'm getting a person for you."), so every message still gets exactly one Reply. Setup problems such as a missing or rejected key or an unknown model stop the whole run with a non-zero exit instead.

## Modes

`baseline` runs the packet's original system prompt, filled as the packet's Flow section describes, with the packet's 14 functions as the only tools. It's the "before" that later changes are measured against.

- `prompts/baseline/` holds the original system prompt and user message template. Each `{{NAME}}` takes the constant of the same name from `src/context.ts`. Strings go in as they are, and anything else is JSON-stringified.
- `src/packet-tools.ts` and `src/context.ts` are the packet's code and constants, unchanged. `src/tools.ts` exposes each function under the name the prompt uses, such as `getClinicPackagesTool`.
- The model finishes by calling `submitReply`, whose parameters schema is the `Reply` type. Every model call uses function-calling mode `ANY`, so it must call a function. After 8 tool rounds the next call is limited to `submitReply`. Each model turn goes back unchanged so Gemini's thought signatures carry over. `templateId` is always set to null.

## Check it

```sh
npm test            # unit tests, no API key needed
npm run typecheck
npm run eval        # runs every eval case through the real model
```

### Evals

`npm run eval -- --mode <mode>` runs the cases in `evals/cases/` through the same runner the CLI uses, scores each Reply, and prints a scorecard to stderr: pass or fail per case with the failing check, the pass rate per group, total input and output tokens, and the median latency per message. Output tokens include Gemini's thinking tokens. A message the model never finished fails as `drafted`, even if its fallback Reply happens to match.

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

`group` is the skill the case exercises, or `escalation`. `rule` cites the source rule it tests. The checks are `escalate` (exact match), `includes` and `excludes` (substrings, ignoring case), `lastLineUrl` (the response's last line is exactly that URL), `noUrl`, `maxSentences` (split on `.`, `?` and `!` after removing URLs) and `maxAttachments`. An unknown check name is rejected, so a typo can't pass silently.

`evals/cases/packet-check.json` holds the packet's five messages and only the checks the packet says must match. Nothing outside the eval harness reads it. A unit test fails if any source file or prompt mentions it.

Result files stay out of git, except the baseline one cited below.
