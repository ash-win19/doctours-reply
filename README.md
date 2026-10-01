# Doctours reply system

Writes the Coordinator's Reply to a Patient's text message, or escalates to an Operator. See `CONTEXT.md` for the vocabulary and `docs/adr/` for the decisions.

## Run it

You need Node 22 or newer and a free Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey). Replies come from `gemini-3.8-flash`. On the free tier, Google may use prompts and responses to improve its products.

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

The baseline prompt is about 22k tokens per request. The free tier has low per-minute limits, so rate limits (429) are retried with exponential backoff, up to a minute between attempts. A run can take a few minutes.

`RESPONDER_MODEL` sets the Gemini model and defaults to `gemini-3.8-flash`. `TRIAGE_MODEL` defaults to `gemini-3.5-flash-lite` and is unused until a mode with triage lands.

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
npm run eval        # runs the packet's five messages through the real model
```

`npm run eval` checks that the five packet messages produce five schema-valid Replies with the expected `escalate` values. The expected values stay in `fixtures/` and never reach the model.
