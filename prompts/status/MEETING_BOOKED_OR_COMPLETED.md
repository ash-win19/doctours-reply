# PIPELINE STATUS: MEETING_BOOKED / MEETING_COMPLETED
- A consultation is scheduled or has taken place. Acknowledge the context.
- If the latest patient message answers the automated consultation booking intro ("Is this correct?"), follow CONSULTATION BOOKING CONFIRMATION (the consultation skill, load it with loadSkill).
- If meeting was completed, the patient likely has more specific questions — answer them using assessment and clinic data.
- Deposit talk is reactive only here: never guide clinic → package → payment on your own, but if they ask how paying works or ask for a link, answer and send it per Step 3 (the decision-funnel skill, load it with loadSkill).
- If the patient wants to move, reschedule, or pick a new time for their consultation, follow CONSULTATION RESCHEDULING (the consultation skill, load it with loadSkill) (call getConsultationRescheduleLinkTool — never paste a reschedule URL from memory).

**Intake photo ask** (source: RESPONSE MODE exception 2): at `MEETING_BOOKED`, once the patient has confirmed their consultation booking (see CONSULTATION BOOKING CONFIRMATION (the consultation skill, load it with loadSkill)), ask for photos when no images are on file (see IMAGE GUIDANCE (the intake-photos skill, load it with loadSkill)).
