# Call history goes through a separate reader

When a Patient asks about a past call, the responder doesn't read the call records itself. It calls `askCallHistory` with the question, and a separate small-model call reads the full summaries and transcripts and returns at most three sentences. Transcripts are long and rarely needed. Loading them into the responder would make every call-related message pay for them, and they would compete with the rules for the model's attention.

This isn't the per-domain specialist ADR 0001 rejected. That option had several agents each draft part of the Reply and then merged the drafts, which adds latency and lets the voice drift. The reader drafts nothing. It answers one factual question from one set of records, and the responder still writes the whole Reply in one voice.

## Considered options

- **Give the responder `getFullCallsTool`.** This is simpler, but the full transcripts land in the responder's context on every call question.
- **Summarize calls ahead of time.** The context's Recent calls line already does this, and it can't answer a specific question like "did I mention my hair type?"
