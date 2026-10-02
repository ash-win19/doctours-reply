# Triage runs before the responder

Each Patient message goes first to a small triage model. It decides on Escalation and picks which rule sets to load. A second model then writes the Reply with only those rules and their tools, and it can pull in more rules mid-turn if it finds a gap. Doing it this way means Escalation and rule choice are settled before any sales content exists, and both show up in the trace.

A few guards in code run before triage. They redact card numbers, and they escalate card details or a plainly worded request for a person without a model call. Triage still handles every paraphrase. The guards only take the cases where a model could only add risk.

## Considered options

- **One agent that loads its own rules.** This uses fewer calls, but every turn would depend on the main model choosing to load the right rules and choosing to escalate.
- **Routing in code only, with keywords or embeddings.** It's cheap and predictable, but it misses paraphrased requests for a person.
- **One specialist agent per domain plus a merger.** It adds latency, and the voice drifts when several drafts get merged into one two-line text message.
