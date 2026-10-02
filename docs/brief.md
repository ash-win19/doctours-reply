# The eight concerns in the source brief

These are the numbered concerns from the supplied `pre-deposit-respond-packet.md`. The README maps the implementation to them in the same order.

1. A huge prompt on every turn crowds the context. The model spends attention on rules this message never needed, and the reply gets worse.
2. When a reply is wrong, a trace cannot show which part of the prompt produced it. Debugging means rereading the whole block.
3. A new line of care, such as fertility, means pasting another domain into the same prompt. The hair-transplant rules and the new ones compete for the same context.
4. A subtask has nowhere to go. Inspecting every call log, for example, cannot be handed to a subagent that does that work and returns a result.
5. Every message pays for the full prompt in tokens and latency, including a one-line question.
6. A small policy change can alter replies that never needed that policy, because the model sees every instruction at once.
7. Conflicting rules sit in one block, and nothing records which rule won, so the same situation can resolve differently on the next run.
8. One behavior cannot be tested on its own. A wrong price and a wrong tone fail as the same reply.
