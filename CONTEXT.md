# Doctours reply system

Writes the Coordinator's reply to a text message from a pre-deposit Patient, or escalates the conversation to an Operator when the request needs a person.

## Language

### People

**Patient**:
A person exploring a hair transplant through Doctours who texts the Coordinator.
_Avoid_: user, lead, customer

**Coordinator**:
The patient-facing persona, Alex, that every reply is written as, whether software or an Operator is typing.
_Avoid_: agent, assistant, concierge, bot

**Operator**:
A Doctours staff member who takes over a conversation after an Escalation and keeps writing as the Coordinator.
_Avoid_: human agent, team member, coordinator

### Conversation

**Reply**:
The one structured answer returned for one incoming Patient message.
_Avoid_: response, draft

**Escalation**:
An Operator takes over the conversation, and the Reply is one short sentence saying so.
_Avoid_: handoff, routing, transfer

**Intake item**:
One of the three things collected before an Assessment can be built: procedure area, name, photos.
_Avoid_: collection field, required info

**Time-bound pause**:
A Reply to a Patient who is stepping back from the next decision, promising a dated check-in.
_Avoid_: open-ended pause

### Journey

**Tier**:
The broad phase of a Patient's journey, either before or after a Deposit.
_Avoid_: stage, package tier

**Pipeline Status**:
Where a pre-deposit Patient sits in the sales pipeline, such as LEAD, PREP_PRE_CLINICAL or PRE_CLINICAL_SENT.
_Avoid_: stage, funnel step

**Assessment**:
The medical team's preliminary plan for a Patient, holding the graft range, hairline drawing and Recommended clinics.
_Avoid_: report, evaluation, quote

**Recommended clinics**:
The clinics the Assessment matched to a Patient.
_Avoid_: saved clinics, assessment clinic recommendations

**Selected clinic**:
The one clinic a Patient has chosen or is leaning toward.
_Avoid_: preferred clinic, favorite

**Soft interest**:
Two or more clinics or Packages a Patient is torn between, with no clear lean.
_Avoid_: shortlist

**Consultation**:
The free phone call between a Patient and Doctours' team, never with the clinic or surgeon.
_Avoid_: surgeon call, video call, meeting

### Clinics and packages

**Package**:
A clinic's priced bundle of the procedure plus included extras such as hotel nights.
_Avoid_: tier, plan

**Addon**:
An extra attached to a Package, either included in it or paid on top.
_Avoid_: upgrade, upsell

### Money

**Deposit**:
The amount paid through Doctours that submits a date request for one Package.
_Avoid_: down payment, booking fee

**Remaining balance**:
The Package price minus the Deposit, paid through Doctours before the procedure.
_Avoid_: final payment, clinic payment

**Payment link**:
A link to pay the Deposit for one specific Package.
_Avoid_: deposit link

**Checkout link**:
A link to one clinic's Packages, where the Patient picks a Package and pays the Deposit.
_Avoid_: deposit link, booking link

**Financing**:
Klarna or PayPal lender credit for the Remaining balance, open only to US and Canada residents.
_Avoid_: instalments, payment plan

**Layaway**:
Doctours' own interest-free monthly card plan for the Remaining balance.
_Avoid_: financing

## Relationships

- A **Patient** talks to exactly one **Coordinator**. After an **Escalation**, an **Operator** types as that Coordinator.
- An **Assessment** produces zero or more **Recommended clinics**. A **Selected clinic** may come from outside them.
- A **Payment link** belongs to one **Package**. A **Checkout link** belongs to one clinic.
- A **Deposit** comes before the **Remaining balance**. **Financing** and **Layaway** only ever cover the Remaining balance.

## Flagged ambiguities

- The source prompt used "tier" for both the journey phase and Package levels. **Tier** now means the journey phase only.
- The source data labels the Coordinator's messages `OPERATOR`. In this glossary, **Operator** means only the staff member who takes over after an Escalation.
- "Deposit link" could mean either link. Use **Payment link** or **Checkout link**.
