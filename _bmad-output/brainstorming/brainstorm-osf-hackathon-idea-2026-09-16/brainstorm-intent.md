# Intent: Zamu

**One line:** Public money made visible, so bursaries are a right, not a favour.

**Context:** Individual entry, OSF × Andela "Information You Can Trust" hackathon. Track: **Transparency & Accountability** (single track). Deadline 2026-09-21 23:59 UTC. Deliverables: public GitHub repo + README, demo video, PDF pitch deck, written summary. Judged equally on uniqueness, scalability across geographies, AI coding tool usage, presentation/track alignment.

**Name:** *Zamu* is Swahili for "turn". Everything is allocated in turn, and nobody jumps the queue.

## Problem (Kenya, school bursaries)

- Bursaries come from three sources: the MCA ward fund, the MP's NG-CDF, and the county/governor. Parents apply to all three blind, as a gamble. They can't see the criteria, the stage their application is at, or their chances.
- News spreads by word of mouth (chief → elders → parents). Parents queue at the chief's camp from 3 am. Results appear only as a list pinned at the chief's office.
- Connected families get priority.

## Root causes (Five Whys)

1. **Opacity is deliberate.** Officials present public money as a personal gift and bank political loyalty. Parents don't know it's their tax money. Budgets exist but sit in online PDFs nobody reads, and officials benefit from parents staying uninformed, so the fix can't depend on their goodwill.
2. **Scarcity.** There's too little money for too many families. That leads to an unwritten rotation ("you got it last time"), so even honest parents who need support every term seek favours to stay on the list.

## Users

- **Primary:** low-income parents or guardians on basic feature phones. Many have no digital footprint (no bank records, some have no national ID); the child's school record is often the only record.
- **Secondary:** bursary committee/admins, schools, community health volunteers (CHVs) and teachers (evidence capture), and oversight bodies (Controller of Budget, Auditor General).

## Solution

- **The system comes to the parent.** An SMS in their language says the window is open, that it's their turn, and how much is available. They apply by USSD with records already on file; a new child needs a one-time verification.
- **A suitability score** from verifiable data is shown across the whole list, so decisions aren't at officials' discretion. The inputs are school records plus visible livelihood evidence (house, livestock, land, title deed, economic activity), captured as geotagged photos by CHVs or teachers.
- **A public queue** shows each parent their place and when their turn comes. This makes waiting predictable and removes the incentive to buy priority. *This is the core: it answers both root causes.*
- **Immutable records.** Evidence and GPS data are locked to the case at capture. Any change opens a new case, and the original is preserved.
- **SMS updates at every stage.** The money goes to the school, which confirms receipt. A round-totals SMS tells every parent the amount distributed and the number of recipients.
- **Trust model:** many independent witnesses (parents, school, CHVs/teachers, public list) and no single point to bribe.

## PoC scope (MoSCoW)

| | |
|---|---|
| **Must** | SMS notifications (window open, your turn, every stage) · USSD apply · Suitability score · Public queue · Immutable records (change = new case) |
| **Should** | CHV/teacher geotagged capture · School confirms fees received · Round-totals SMS · Anonymous USSD report → independent review · Role-based access/process flow · Admin dashboard |
| **Could** | AI check for AI-generated or manipulated evidence photos · Public list at school + SMS alerts to CHVs/teachers · Per-country config · Free-text AI SMS assistant (via SMS shortcode, since USSD can't take free text) |
| **Won't (pitch only)** | Budget reconciliation (allocations sum to the published budget) |

**Demo reality:** USSD apply, SMS, score, queue, and immutable records are **real**. CHV capture and school confirmation are **simulated** (seeded data).

## Differentiation and pitch arguments

- **vs HELB:** HELB already proves this model works (means-tested, status updates, pays the institution directly). Zamu applies it to the most politicised part of the system that still isn't digitised: ward, constituency, and county bursaries. What HELB doesn't have is the **public turn-queue and witnessed, immutable evidence**.
- **Scalability:** a fixed integrity core (immutable records, evidence verification, tokenization, data management) plus per-country configuration (language, currency, funding cycle, funding bodies, evidence capturers). The problem, opaque allocation of public support, is universal.
- **Adoption without officials' buy-in:** the Controller of Budget / Auditor General require it as a condition of releasing or auditing bursary funds ("no clean audit, no next allocation").
- **Honest framing:** Zamu can't grow the pot. It makes allocation fair and predictable.

## Open items to resolve before building

- **Verify the funding flows:** NG-CDF (via the NG-CDF Board) and county bursaries (county budgets) reach the Controller of Budget by different routes. Confirm before claiming the mandate path.
- **Surface for the public queue and score:** USSD lookup, a web page, or the Should-tier admin dashboard. Decide what the demo shows.
- **Scoring model:** pick the specific inputs and weights, and how they're explained to parents in one SMS or USSD screen.
- **Written summary needs:** information sources, the trust/accuracy approach, and how AI coding tools were used.
- **Privacy:** a public list shows scores. Decide what is public (score, rank, amount) and what stays private (photos, household details).
