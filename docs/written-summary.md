# Zamu — written summary

**Public money made visible, so bursaries are a right, not a favour.**
Repository: https://github.com/James-Karanja/Zamu · Demo: `npm run demo`

## 1. Track: Transparency & Accountability

Kenyan school bursaries are public money allocated three ways at once: the MCA's ward fund, the MP's NG-CDF allocation, and the county. A parent applies to all three blind, hears about distributions by word of mouth, and queues at the chief's camp from 3 a.m. Results appear as a list pinned to a wall, and families with a connection inside the office are served first.

I chose **Transparency & Accountability** because the failure is not a shortage of information but a decision that is hidden on purpose. Working the problem down with the Five Whys led to two root causes. First, **opacity pays**: an official who hands out public money as a personal gift collects the loyalty, so nobody inside the system has a reason to publish the rules. Second, **the money is short**: too little for too many produces an informal rotation, and even honest parents look for a favour to stay on the list.

Zamu cannot make the pot bigger. It makes the allocation **visible, checkable and predictable** — a published score, a public queue, and records nobody can quietly change — which is what makes a favour worthless.

I considered also entering *Safety, Reporting & Protection*, since anonymous reporting is in the design. I did not, because that feature is specified but not built, and I did not want to claim a track the demo cannot show.

## 2. Information sources

**What Zamu decides with.** Every input to a decision is something a person can check:

- **The school record** — the child's enrolment and fee balance.
- **Witnessed household evidence** — house type, livestock and land, captured with a photo reference and GPS by a community health volunteer or a teacher, who already visit these homes and owe nothing to the MCA or MP.
- **The parent's own application**, made on a basic phone after a consent screen.
- **Every decision**, recorded with who made it and in what role — verification, award, payment to the school, and the school's confirmation that the money arrived.

In the proof of concept all data is synthetic, and volunteer capture and school confirmation are simulated by the seed data. Their screens are specified but not built.

**What the problem statement rests on.**

- Auditor-General audits as reported in the press: Lang'ata constituency, KES 52.9M in bursaries with "no clear criteria" and no acknowledgement letters from schools; Sirisia, KES 35.6M that could not be verified; and seven counties, including Nairobi, unable to account for over KES 880M in bursary funds in FY2023/24 (Eastleigh Voice; Daily Nation).
- The NG-CDF Act No. 30 of 2015, as amended: the fund is at least 2.5% of the national government's revenue share (s.4), and bursaries may take up to 35% of a constituency's allocation (s.48). The Controller of Budget authorises withdrawals from public funds (Constitution, Art. 228) and the Auditor-General audits both the constituency and county routes. That is where adoption can be required, rather than depending on the goodwill of the officials who lose patronage.
- HELB, Kenya's university loans board, as proof that a means-tested, status-tracked, pay-the-institution model already works here. Zamu applies it to the most politicised layer, the one that is still undigitised.
- Lived experience of how bursaries actually reach families: the chief's camp, the three forms, the list on the wall.

## 3. How Zamu keeps information trustworthy and accurate

**One published rule, no discretion.** The need score is four inputs with fixed weights: fee balance 35, house type 30, livestock 20, land 15. The same evidence always produces the same score, and no code path lets an official set one. Queue priority adds 10 points for every closed round a child applied in without an award, so a parent can see when their turn will come. The scoring rules are published in the repository.

**Records that refuse to change.** Cases, evidence, rounds and every stage change are append-only. The database refuses `UPDATE`, `DELETE` and `INSERT OR REPLACE` on those tables for *any* connection, including someone opening the file directly. A correction — say, a volunteer finding seven cattle that were moved to a neighbour's homestead for the first visit — creates a new case linked to the original, and both stay readable. The demo's final act attempts all three edits through a plain database connection and shows each refusal.

**Many witnesses, no single person to bribe.** The whole ward can see the queue: position, score, waiting bonus and award, per round, with each round's budget and total awarded. The parent sees their own breakdown privately over USSD. The school confirms receipt. Every action is attributed to a person and a role.

**Privacy by construction.** Names on the public page are masked (`F. W****`), enough for a neighbour to recognise a household but not enough for a stranger to compile a list of poor families. Photos, GPS, phone numbers and the score breakdown never appear publicly, and a test scans every public response for them. No application exists until the parent consents on screen.

**Built for the people it serves.** USSD needs no smartphone and no data: applying takes three key presses. Every screen and SMS is in Swahili or English, every screen fits one USSD page, and every SMS fits a single GSM-7 message, enforced in code rather than hoped for.

**Honest about its limits.** The README lists what is not built (the admin dashboard, volunteer and school screens, round-totals SMS, anonymous reporting) and what is not solved. Identity is only the caller's phone number. Append-only prevents changes but cannot yet *detect* someone who alters the schema itself; a hash chain over events is the next step. Immutable records sit awkwardly with the right to erasure under Kenya's Data Protection Act 2019, which needs a documented redaction approach before any pilot.

## 4. How I used AI tools

I built Zamu alone, using **BMAD Method skills inside Claude Code**. The idea is mine, and so is every product decision. The AI structured the work, laid out options when a decision was needed, wrote the code, and — most usefully — criticised it.

**Idea.** I ran BMAD's brainstorming skill in *facilitator* mode, where the AI only asks questions and supplies no ideas. First Principles, the Five Whys and the Disney Method took me from "parents don't know about bursaries" to the two root causes above, and to the public turn-queue as the answer to both. In that session the AI's only suggestion was the name, when I asked for one; *Zamu* is Swahili for *turn*, and I kept it.

**Plan.** BMAD's spec skill turned the session into a specification of eleven capabilities, split into Must, Should and Could. I cut it to five Musts for a four-day build and settled every open question myself, often choosing between options the AI laid out with their trade-offs:

- which scoring inputs count and how much;
- +10 per round waited;
- exactly which fields are public;
- consent before any application;
- that land over two acres scores the same with or without a title deed, so hiding paperwork cannot raise a score.

**Build and review.** Each story went through the same loop: the AI wrote a plan, I approved or changed it, it implemented the plan with tests, and then **three independent reviewer agents** examined the change. One reviewed it blind, one traced edge cases, and one mutated the code to prove which tests could not fail. Every finding was checked against the code and logged with a verdict. Across six stories that came to 196 findings: 153 fixed, 14 deferred with reasons, 22 rejected with evidence, and 7 escalated to me as decisions only I could make.

That review loop is why I trust the result. It caught:

- evidence that could be silently rewritten through `INSERT OR REPLACE`, and later found that the first fix only held on the app's own connections;
- a uniqueness rule that never applied to databases created before it;
- 60 SMS announcing closed rounds as open;
- a parent told they were in "place 0";
- tests that passed whatever the code did.

It also disproved two fixes the AI had reported as done — the uniqueness rule and the child menu — a reminder that the AI's account of its own work needed checking too.

The full trail is in the repository under `_bmad-output/`: the brainstorming session, the specification, and one spec per story with its complete review log.

**Result.** About 2,800 lines of TypeScript with 189 tests, no runtime dependencies beyond Node's built-in SQLite, and a five-act demo that asserts its own story as it runs.
