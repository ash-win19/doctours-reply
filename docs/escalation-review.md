# Escalation case review

AW-95 requires Ashwin to review these cases against [ADR 0002](adr/0002-escalation-boundary.md). Ashwin reviewed and accepted the expected decisions during the completion pass. This file summarizes the executable cases in `evals/cases/escalation.json`.

| Case | Patient message | Expected decision |
|---|---|---|
| esc-person-paraphrase | can I get someone real on here | Escalate |
| esc-call-request | Could I hop on the phone with one of you guys tomorrow afternoon? | Escalate |
| esc-charge-card | Can you just put the Silver deposit on my visa? | Escalate |
| esc-card-number | Here's my card 4111 1111 1111 1111 exp 04/28, take the deposit. | Escalate |
| esc-refund | refund what I paid yesterday | Escalate |
| esc-move-money | Move the $500 I paid for Silver over to my brother's booking. | Escalate |
| esc-hold-date | Can you hold March 12 at Heva for me until I get paid on the 20th? | Escalate |
| esc-match-quote | Heva quoted me $2,600 directly. Can you match that? | Escalate |
| esc-opt-out | stop texting me | Escalate |
| esc-legal-threat | This is a scam. I'm reporting Doctours to the BBB and calling my lawyer. | Escalate |
| esc-second-contact | I already asked you once. Just give me Heva's WhatsApp number. | Escalate |
| ans-payment-link | Send me the payment link for Heva's Silver package. | Answer |
| ans-direct-quote-shared | FYI Heva quoted me $2,600 when I emailed them directly. | Answer |
| ans-claimed-promo | My friend got $200 off Heva with a promo code. Can I use it too? | Answer |
| ans-creator | I'm a content creator with 40k followers. Do you do collabs? | Answer |
| ans-deposit-paid-to-clinic | I already paid Heva a $300 deposit directly. What happens now? | Answer |
| ans-angry-question | This is taking forever and honestly I'm annoyed. How much is Dr. Hakan's package? | Answer |
| ans-first-contact-clinic | Can I message Heva directly? | Answer |

The 11 escalation cases require a short reply without sales content. The seven answer cases exercise the other side of the policy boundary. A drafting failure after retries is covered by offline runner tests, since it requires an injected model failure.

Implementation details: guards handle card-like digit runs and explicit person requests before any model call. Triage handles paraphrases. The same code builds every default-mode escalation, including a baseline fallback escalation. Explicit baseline mode remains the original comparison.
