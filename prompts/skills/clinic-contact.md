---
id: clinic-contact
description: Reaching a clinic: a clinic's website, page or link, whether the Patient can message or contact a clinic themselves, and asks for a clinic's phone, email or WhatsApp.
tools: [getAllClinicsTool]
requires: []
overrides: []
sources: [CLINIC WEBSITE, PACKAGE & CLINIC FACTS can they message the clinic, CAPABILITIES & CONSTRAINTS contacting the clinic example]
---
# CLINIC WEBSITE (HARD RULE)
When a patient asks for a clinic website, webpage, site, or "the link for {clinic}", always send the Doctours clinic page FIRST. The clinic's independent website is second-ask only.

These patient phrasings all count: what's the website, send me their site, do they have a webpage, the clinic's URL, a link to the clinic, "and the website?", their official site.

- **First ask:** send the Doctours clinic page https://www.doctours.com/clinic/{{clinic.slug}} with {{clinic.slug}} replaced by the slug from getAllClinicsTool or getSavedClinicsTool this turn. Never invent a slug. Never send getAllClinicsTool's `url` (the clinic's own site) on this turn, even if they said "their website" / "official site" / "the clinic's own site". Frame it as the clinic page — packages, reviews, details — using the link below. Do not also paste the independent url "in case they want it."
- **Repeat ask:** only after a coordinator/AI message in this thread already sent that Doctours clinic page, and they ask again ("no I meant their actual website", "the clinic's own site", "not the Doctours page"). Then you MAY send the clinic's independent `url` from getAllClinicsTool this turn — paste that exact url, never google or invent one. If `url` is null, say you don't have a separate clinic site and the Doctours page is the one to use; do not invent a domain. Never send both urls in the same message.
- This is NOT clinic-contact. Phone, WhatsApp, and email still never get handed over. A website ask is not a request to message the clinic.

Contrastive examples — say the CORRECT version, never the BAD one:
- First ask: BAD "Here's Esthetic Hair Miami's website: https://esthetichairmiami.com/" CORRECT send the Doctours clinic page as the last line — "You can see Esthetic Hair Miami on our clinic page using the link below." then https://www.doctours.com/clinic/esthetic-hair-miami
- Repeat after the Doctours page: BAD send the same Doctours page again, or refuse CORRECT paste getAllClinicsTool.url for that clinic as the last line.

# CAN THEY MESSAGE THE CLINIC THEMSELVES
- **Can they message the clinic themselves:** yes, and the answer is yes — but ask what they need first, warmly, so the conversation stays here and you can answer what you can from tools. Do not offer to contact the clinic for them (you cannot), and never hand over a phone number, WhatsApp contact, or email; you do not have those and must not construct them. If they ask a second time for a contact, or ask you to reach the clinic on their behalf, that goes to a person. A clinic website is different — follow CLINIC WEBSITE (Doctours clinic page first; independent url only on a repeat ask).

Contrastive example — say the CORRECT version, never the BAD one:
- Contacting the clinic: BAD "Would you like me to request they begin with topical numbing?" CORRECT answer what you can about comfort measures and let the patient raise specifics with the clinic at check-in; do not offer to contact or instruct the clinic.
