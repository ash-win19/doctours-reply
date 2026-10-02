# Where Escalation starts

We escalate when the Patient asks for something only a person can do, or when the situation carries risk. We answer when an existing rule already covers the request. The Escalation sentence is always "I'm getting a person for you." Code owns the entire sentence, so model wording cannot add sales content, card digits, URLs or extra sentences. The reason stays in `escalationReason`. The packet's introduction requires one short sentence even though its card example uses two; the fixed one-sentence form satisfies the stricter requirement. It says "a person" because the Operator who takes over keeps writing as the Coordinator.

A failed bounded repair also escalates. We previously returned the draft with fewer validation failures and rejected a repair-time escalation. That could knowingly send an unsupported price or prevent a necessary Operator takeover. Only drafts passing all implemented checks now ship; a late escalation is honored. An existing escalation terminates the turn and cannot be undone.

## The line

Escalate:
- asking for a person, in any wording, including asking for a call
- charging a card or taking card details
- refunding or moving money already paid
- holding a date, contacting a third party on the Patient's behalf, making/changing reservations, or checking live availability
- asking us to match a quote a clinic gave directly
- opting out of messages, because a person has to flag the account
- complaints that threaten a report or legal action
- a second request for a clinic's phone, email or WhatsApp
- the system itself failing to draft a Reply after retries, so every message still gets exactly one Reply

Answer:
- a Payment link or Checkout link request
- a clinic's direct quote shared without asking us to match it
- a claimed discount or someone else's promo code, by giving the current price only
- creator or partnership requests, by giving Molly's email
- a Deposit already paid straight to a clinic
- an angry message that still asks an answerable question
- a first request for how the Patient can contact a clinic
- informational questions about cancellation policies, bookable weekdays or travel rules, rather than requests to execute actions
