---
title: 'Scoring engine'
type: 'feature'
created: '2026-09-18'
status: 'done'
route: 'dispatch'
review_loop_iteration: 1
baseline_commit: 'f1253bf'
context:
  - '{project-root}/_bmad-output/specs/spec-zamu/SPEC.md'
  - '{project-root}/_bmad-output/specs/spec-zamu/scoring-model.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Zamu's promise is that selection follows verifiable data, not an official's discretion (SPEC CAP-3). The store holds evidence but nothing turns it into a need score, a parent-readable reason, or the queue priority that makes waiting predictable. The seeded closed rounds currently award by house type, which contradicts the scoring model and would be visible in the demo.

**Approach:** A pure, deterministic scoring module that maps a case's evidence to a need score out of 100 with a per-input breakdown, composes a one-screen reason from the two largest contributors, and computes queue priority as need score plus a waiting bonus derived from the child's earlier unawarded rounds. Re-derive the seed's closed-round awards from that priority so demo history matches the published rules.

## Boundaries & Constraints

**Always:**
- Scoring is a pure function of stored evidence plus the child's round history: same inputs, same score, no clock, no randomness, no officer input.
- Bands and weights match `scoring-model.md` exactly: fee balance 35, house type 30, livestock 20, land 15.
- **Decision (human):** land over 2 acres scores 0 whether or not a title deed exists — the land is the visible asset, and hiding paperwork must not raise a score. The title flag stays recorded as evidence.
- Need score is 0–100; the breakdown names every input's points so any total can be recomputed by hand.
- Queue priority = need score + 10 per earlier round the child applied in without receiving an award, counted back to their last award; the bonus is reported separately from the need score.
- Reason text names the two highest-scoring inputs with their real values and fits 160 characters.
- Awards in the seed follow priority order (ties: earlier application first) until the round budget cannot cover the next award.

**Never:**
- No USSD, SMS, HTTP, or UI (stories 3–5).
- No translation of reason text (story 5 owns language).
- No change to the store's public API or schema, and no new mutable state: scoring is computed on read.
- No new scoring inputs beyond the four in `scoring-model.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Neediest case | fee 32,000; mud; no livestock; 0.3 acre | need 100 with breakdown 35/30/20/15 | N/A |
| Least needy case | fee 0; permanent; 7 cattle; 3 acres titled | need 0; reason still names two inputs | N/A |
| Band edges | fee exactly 10,000 and 25,000; land exactly 0.5 and 2 acres; 5 cattle | lands in the documented band, not the neighbouring one | N/A |
| Untitled large plot | 3 acres, no title | land scores 0, same as titled | N/A |
| Reason text | any evidence | `Score 89/100: fee balance KES 28,000 · mud house`, ≤160 chars | N/A |
| First-time applicant | child with no earlier rounds | waiting bonus 0; priority = need | N/A |
| Waited twice | applied in two earlier rounds, never awarded | bonus 20; priority = need + 20 | N/A |
| Awarded last round | awarded in the most recent earlier round | bonus 0 | N/A |
| Awarded, then skipped | awarded 3 rounds ago, applied since without award | bonus counts only rounds after that award | N/A |
| Superseded case | corrected case in an earlier round | the current case decides, the superseded one is ignored | N/A |
| Seed awards | closed rounds | awards follow priority order within budget | N/A |

</frozen-after-approval>

## Code Map

- `src/store/cases.ts` -- `CaseRecord`, `EvidenceInput`, `listCurrentCases`, `getCase`; read-only here, do not change its API
- `src/seed/data.ts` -- `AWARDS` + `seedRounds` award by house type today; replace with priority-ordered awards. `evidenceFor` already spans every band
- `src/db/schema.sql` -- evidence columns are the scoring inputs; no change needed
- `test/seed.test.ts` -- re-implements `feeBand`/`livestockBand`/`landBand` inline; switch those assertions to the new module so bands have one source of truth
- `test/helpers.ts` -- `evidence()` fixture and actor constants for new tests

## Tasks & Acceptance

**Execution:**
- [x] `src/scoring/model.ts` -- band tables, `scoreNeed(evidence)` returning `{ total, components }`, and `reasonText(score)` -- the published rules as executable code
- [x] `src/scoring/priority.ts` -- `roundsWaited(db, childId, roundId)` from case history and `queuePriority(db, caseRecord)` returning `{ need, waitingBonus, priority }` -- predictable turn-taking
- [x] `src/seed/data.ts` -- award closed rounds by priority order within budget instead of house type -- demo history matches the published rules
- [x] `test/scoring.test.ts` -- every band edge, both extremes, reason format and length, and hand-computed totals -- proves the model
- [x] `test/priority.test.ts` -- first-time, waited once/twice, awarded-then-skipped, superseded cases -- proves the waiting bonus
- [x] `test/seed.test.ts` -- assert seeded awards are the top-priority applicants within budget, using the scoring module rather than inline bands -- removes the duplicated source of truth

**Acceptance Criteria:**
- Given any seeded case, when scored twice, then both results are identical and the breakdown sums to the total.
- Given the seeded closed rounds, when awards are listed, then no unawarded applicant has a higher priority than an awarded one, and the awarded total stays within budget.
- Given a case scoring 80 with fee balance 28,000 in a mud house, when the reason is rendered, then it names those two inputs and is at most 160 characters.

## Implementation Notes

- `src/scoring/model.ts` holds the band tables, `scoreNeed` (returns `{ total, components }` with per-input points, max and a parent-facing label) and `reasonText` (top two components, `Score 80/100: fee balance KES 28,000 · mud house`).
- Land: `> 2 acres` scores 0 regardless of `hasTitle`, per the human decision; the title flag is still stored as evidence.
- `src/scoring/priority.ts` adds `roundsWaited` (walks the child's earlier rounds newest-first, stopping at their last award; rounds they did not apply in are skipped) and `queuePriority` / `queuePriorityOf`.
- Seed now awards by priority: `awardByPriority` ranks `listCurrentCases` by priority, ties by insertion order, and awards a fixed amount per round until the budget cannot cover the next one. `AWARDS` by house type is gone.
- Seeded open round now shows waiting bonuses of 0, 10 and 20, so the demo can point at a parent who moved up after being passed over.
- Review round 1 hardening: bonus counts only closed rounds and ignores rejected applications; `roundsWaited` raises `RoundNotFoundError`; ties use the first case in a correction chain; awards skip unverified cases and resume from `awardedTotal`; reason text drops zero-point inputs and is capped at 160 characters.
- `test/seed.test.ts` no longer re-implements the bands; it asserts against `scoreNeed` and checks no unawarded applicant outranks an awarded one.
- 81 tests (was 56): `test/scoring.test.ts` covers every band edge and both extremes, `test/priority.test.ts` covers first-time, waited once/twice, award-resets-bonus, skipped rounds and corrections.

## Spec Change Log

- **Review round 1 (patch tier, no loopback).** Findings on `reasonText` naming zero-point inputs, the waiting bonus accruing for undecided or rejected rounds, `roundsWaited` swallowing unknown ids, and the seed's untested award set. Amended the non-frozen sections: the acceptance example moved from an unreachable 89 to 80, `breakdown` renamed to `components` to match the code, and `scoring-model.md` updated for the land/title decision and the new reason wording. KEEP: pure scoring module split from priority, per-input `components` with `max`, priority = need + 10 per waited round reported separately, and seed awards derived from the published rule.

## Review Triage Log

| # | Source | Finding | Verdict | Route | Evidence |
|---|---|---|---|---|---|
| 1 | blind | `reasonText` named inputs worth 0 points ("fee balance KES 0" as a reason for a low score) | medium | patch | Confirmed on 5 of 40 seeded cases. Now only scoring inputs appear; an all-zero case reads `no scored needs recorded` |
| 2 | blind, edge | An earlier round still open earned the +10 waiting bonus | medium | patch | Confirmed; only closed rounds now count |
| 3 | blind, edge | A rejected earlier application earned the same bonus as being passed over | medium | patch | Confirmed; rejected rounds are skipped. Policy call flagged to the user |
| 4 | blind, edge, verif-gap | `roundsWaited` returned 0 for an unknown round or child | medium | patch | Confirmed; now raises `RoundNotFoundError`, with a test |
| 5 | blind, verif-gap | Tie-break untested, and the seed's budget cut-off falls exactly on a three-way tie | medium | patch | Mutation flipping the tie-break left 72/72 green. Awarded child sets are now pinned |
| 6 | verif-gap | Seed could under-spend a budget with tests still green | medium | patch | Mutation `>` → `>=` dropped an award, suite stayed green. Exact totals now asserted |
| 7 | blind | Seed award test passed vacuously if every applicant was awarded (`Math.max` of `[]`) | low | patch | Confirmed; the test now requires a non-empty unawarded set |
| 8 | verif-gap, edge | Correcting a case demoted it in the tie-break (insertion order, not application time) | medium | patch | Confirmed on a 3-applicant database. Ties now use the first case in the correction chain |
| 9 | blind, edge | `awardByPriority` re-derived the school by parsing the child id | medium | patch | `SCHOOLS[NaN]` on any id-format change. Now reads `children.school_id` |
| 10 | blind, edge | `awardByPriority` assumed no prior awards and that every case was verified | medium | patch | Now starts from `awardedTotal`, skips unverified cases, validates the amount against the budget |
| 11 | edge | Award amount indexed by global round index, not closed-round ordinal | low | patch | Would hand `undefined` to a third closed round. Now uses a closed-round counter and throws if missing |
| 12 | edge | Close timestamp could precede award events past 120 awards | low | patch | Close time now derived from the award count |
| 13 | blind, edge | `MAX_SCORE` was a literal 100 independent of `MAX_POINTS` | low | patch | Now derived from the weights, with a test |
| 14 | blind | `toLocaleString('en-KE')` made a "deterministic" module ICU-dependent | low | patch | Replaced with hand-rolled grouping, with a test |
| 15 | blind | 160-character reason cap was stated but unenforced | low | patch | `reasonText` now truncates at `MAX_REASON_LENGTH`, tested with a 9-digit balance |
| 16 | blind, edge, verif-gap | Stale comment in the seed still described the old land/title rule | low | patch | Fixed |
| 17 | blind, edge | No seeded household had over 2 acres without a title, so the decision was undemonstrated | medium | patch | Added a 3-acre untitled band; a seed test asserts both score 0 |
| 18 | edge | Acceptance example "Score 89" is unreachable; spec said `breakdown`, code returns `components` | low | patch | Spec text corrected (non-frozen sections) |
| 19 | blind | `scoreNeed`'s currency parameter was never supplied in production | low | patch | `queuePriority` now passes the round's currency |
| 20 | blind | Story shipped with an empty Spec Change Log despite editing `scoring-model.md` | low | patch | Entry added |
| 21 | edge | Round `created_at` compared as text across differing UTC offsets | low | patch | Comparison and ordering now use `julianday` |

## Verification

**Commands:**
- `npm run typecheck` -- expected: no errors
- `npm test` -- expected: all suites pass
- `npm run seed` -- expected: rebuilds the demo database, exits 0
