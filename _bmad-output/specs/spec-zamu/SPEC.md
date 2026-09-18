---
id: SPEC-zamu
companions:
  - poc-scope.md
  - pitch-positioning.md
  - glossary.md
  - scoring-model.md
sources:
  - ../../brainstorming/brainstorm-osf-hackathon-idea-2026-09-16/brainstorm-intent.md
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# Zamu — public money made visible, so bursaries are a right, not a favour

## Why

**Pain + mandate.** Kenyan school bursaries (MCA ward fund, MP's NG-CDF, county) are allocated blind: parents apply to all three as a gamble, learn of distributions by word of mouth, queue at the chief's camp from 3 a.m., and see results only on a pinned list — while connected families get priority. Two root causes: **deliberate opacity** (officials present public money as personal gifts to bank political loyalty; budgets sit in PDFs nobody reads) and **scarcity** (too little money drives an informal rotation, so even honest parents seek favours to stay on the list). Zamu cannot grow the pot; it makes allocation visible, verifiable, and predictable. Built as a solo proof of concept for the OSF × Andela "Information You Can Trust" hackathon, **Transparency & Accountability** track, due 2026-09-21 23:59 UTC.

## Capabilities

Tier and demo reality per capability: see `poc-scope.md`.

- **CAP-1** *(Must)*
  - **intent:** A parent is told by SMS, in their language, when the bursary window opens, when it is their turn (with the amount available), and at every stage change.
  - **success:** Opening a round and advancing a case through each stage delivers the correct Swahili or English SMS to the parent's number at each transition.
- **CAP-2** *(Must)*
  - **intent:** A parent applies from a feature phone over USSD using the child's record already on file; a new child is flagged for one-time verification.
  - **success:** After a consent screen (decline creates nothing), a USSD session for an on-file child creates an application in ≤3 menu steps with no free-text data entry; an unknown child produces a "verification required" case instead.
- **CAP-3** *(Must)*
  - **intent:** Each applicant receives a suitability score computed only from verifiable inputs (school record, witnessed livelihood evidence), with a reason the parent can read.
  - **success:** Scores follow `scoring-model.md` exactly; same inputs always yield the same score; the score cannot be set manually; the reason names the top two contributors and fits one SMS/USSD screen.
- **CAP-4** *(Must)*
  - **intent:** Anyone can see the round's ranked queue on a public web page, and each parent can look up their child's place and full score breakdown over USSD.
  - **success:** Queue order follows the priority rule in `scoring-model.md`; the public page shows only public fields (see Constraints); the USSD lookup returns the same position the public page shows.
- **CAP-5** *(Must)*
  - **intent:** Case records and their evidence (photos, GPS, timestamp) are locked at capture; any change creates a new linked case and the original stays visible.
  - **success:** No operation mutates a stored case; an attempted correction produces a new case referencing the original, and both appear in the case history.
- **CAP-6** *(Should — simulated)*
  - **intent:** A CHV or teacher captures geotagged household evidence against a case.
  - **success:** A capture attaches photo reference, GPS, capturer identity, and timestamp to a case and feeds CAP-3 inputs.
- **CAP-7** *(Should — simulated)*
  - **intent:** The school confirms fees received, closing the loop without cash passing through the parent.
  - **success:** A school confirmation marks the case disbursed-confirmed and triggers the CAP-1 SMS; a mismatch in amount is visible.
- **CAP-8** *(Should)*
  - **intent:** When a round closes, every applicant learns the total amount distributed and number of recipients.
  - **success:** Closing a round sends one totals SMS whose figures equal the sum of confirmed awards.
- **CAP-9** *(Should)*
  - **intent:** A parent can anonymously report a skipped turn, amount mismatch, or ineligible beneficiary over USSD, opening an independent review.
  - **success:** A report creates a review case with no reporter phone number stored against it.
- **CAP-10** *(Should)*
  - **intent:** Each stage can be advanced only by the role that owns it.
  - **success:** An action by a role not permitted for the current stage is rejected and logged.
- **CAP-11** *(Should)*
  - **intent:** An administrator runs a round end to end: open window, review cases, advance stages, view queue and totals.
  - **success:** A full demo round can be driven from the dashboard without touching the database directly.

## Constraints

- Parent-facing flows work over USSD and SMS only — no smartphone or internet assumed.
- No design may require national ID or bank data; the child's school record is the anchor identifier.
- Score inputs are verifiable records or witnessed evidence; no officer-discretion input exists.
- Adoption must not rely on local officials' goodwill (see `pitch-positioning.md`).
- Public queue shows only position, need score, waiting bonus, award amount, school, masked name (initial + partial surname), and case ID. A parent sees their own full breakdown via USSD only. Evidence photos, GPS, and phone numbers are reviewer-only.
- Parental consent is captured before any application (Kenya Data Protection Act 2019); case records are retained a minimum of 7 years as an audit trail, then deleted.
- Parent-facing text in Swahili and English; language, currency, and funding cycle are configuration, the integrity core (CAP-3, CAP-5) is not.
- Public repository: synthetic data only, no real personal data.
- Solo build; demo video, public repo with README, PDF deck (problem, users, solution, impact), and written summary (track choice, information sources, trust/accuracy approach, AI tool usage) due 2026-09-21 23:59 UTC.

## Non-goals

- Increasing bursary budgets.
- Paying money to parents — awards go to the school.
- Budget reconciliation against published allocations (pitched as future work).
- Production deployment or real government/telco integration.
- The Safety, Reporting & Protection track (CAP-9 is supporting, not claimed).

## Success signal

- In one recorded demo: a parent receives a "your turn" SMS, applies via USSD, sees their score and queue place, receives stage SMS through (simulated) school confirmation — and an attempt to alter a locked case produces a new, visible linked case.

## Assumptions

- Awards are paid to the school, not the parent.
- One applicant record per child; the parent's phone number is the contact channel.
- PoC score uses only fee balance, house type, livestock, and land; other need inputs are future configuration.
- Waiting bonus resets on award, has no cap; ties go to the earlier application.

## Open Questions

- The 7-year retention is a design choice, not a cited legal requirement — no single statute found for public-entity records; confirm before stating it as law. Deleting public records may also need national archives approval.
