---
title: 'Immutable case store and synthetic seed data'
type: 'feature'
created: '2026-09-17'
status: 'done'
baseline_commit: 'NO_VCS'
route: 'dispatch'
review_loop_iteration: 2
context:
  - '{project-root}/_bmad-output/specs/spec-zamu/SPEC.md'
  - '{project-root}/_bmad-output/specs/spec-zamu/scoring-model.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Zamu's trust claim (SPEC CAP-5) depends on bursary cases and their evidence being impossible to alter silently. Today there is no codebase, no data model, and no demo data for any later story to build on.

**Decisions (human, review round 1):** the store enforces case lifecycle rules itself (Q1a); a case may be corrected only while its round is open and before any award (Q2a); every state change records the actor and role (Q3a).

**Approach:** Scaffold the Node/TypeScript project and an SQLite store in which cases, evidence, and all state changes are append-only, enforced by the database itself; corrections create a new case linked to the one it supersedes. Seed synthetic data rich enough to exercise every scoring band and the waiting-bonus rule.

## Boundaries & Constraints

**Always:**
- Immutability enforced in SQLite (triggers rejecting UPDATE and DELETE), not only in application code.
- Every state change (stage transitions, awards, round open/close) is a new row in an event table; current state is derived by reading, never by updating.
- A correction is a new case with `supersedes_case_id`; a case can be superseded at most once; the original and full chain stay readable.
- Stages move forward only: `applied` → `verified` | `rejected`; `verified` → `approved` | `rejected`; `approved` → `disbursed`; `disbursed` → `school_confirmed`. At most one award per case.
- Awards are whole currency units, and a round's approved total never exceeds its budget.
- A round opens once and closes once; a closed round never reopens and never accepts applications.
- A case may be corrected only while its round is open and its current stage is `applied`, `verified`, or `rejected`.
- Every case, correction, stage change, and round event records actor id and actor role.
- Timestamps are ISO-8601 and never earlier than the event they follow.
- Stored values are checked: integers stay integers, coordinates stay in range, required text is non-empty.
- Case evidence snapshots the verifiable scoring inputs at capture: fee balance (from school record), house type, cattle count, has goats/poultry, land acres, has title, plus photo reference, GPS lat/lng, capturer id and role, captured-at timestamp.
- Synthetic data only; names, phones (Kenyan format `+2547XXXXXXXX`, clearly fake range), and schools are invented.
- Currency and language stored as round/household configuration (`KES`, `sw`/`en`).

**Never:**
- No score computation (story 2), queue logic (story 3), USSD/SMS (stories 4–5), HTTP server, or UI.
- No retention/deletion job — 7-year retention is documented only.
- No native-compiled SQLite dependency; use Node's built-in `node:sqlite`.
- No real personal data, no network calls.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Create case | valid child, open round, evidence | case + evidence rows persisted, `applied` event recorded | N/A |
| Direct UPDATE/DELETE | SQL against `cases`, `evidence`, any event table | statement fails | SQLite trigger raises `immutable record` |
| Correct a case | existing, not-yet-superseded case + new evidence | new case linked via `supersedes_case_id`; original unchanged; `getCaseHistory` returns both, oldest first | N/A |
| Double supersede | case already superseded | rejected | unique constraint → typed `AlreadySupersededError` |
| Advance stage | case id + next stage | new event row; `getCurrentStage` returns latest | unknown stage → `InvalidStageError` |
| Duplicate application | same child, same round, no correction | rejected | `DuplicateApplicationError` |
| Reseed | `npm run seed` twice | fresh DB file each run, identical counts | deletes the DB file, not rows |
| INSERT OR REPLACE | REPLACE against any append-only table | statement fails | delete trigger fires → `immutable record` |
| Out-of-order stage | `disbursed` while `applied`; second `approved` | rejected | `InvalidTransitionError` |
| Award over budget | approved total would exceed `rounds.budget` | rejected | `BudgetExceededError` |
| Correct after award | case is `approved`/`disbursed`/`school_confirmed`, or round closed | rejected | `CaseNotCorrectableError` / `RoundNotOpenError` |
| Round lifecycle | open an open round, close a closed one, unknown round | rejected | `RoundStateError` / `RoundNotFoundError` |
| Bad values | fractional cattle or amount, lat 200, blank reason, backdated `at` | rejected | CHECK constraint or `InvalidTimestampError` |

</frozen-after-approval>

## Code Map

Greenfield — project root holds only BMAD tooling (`.claude/`, `.agents/`, `_bmad/`, `_bmad-output/`). Do not modify those. Node v26.7.0 runs `.ts` via built-in type stripping; `node:sqlite` is available.

- `package.json` -- new; scripts `seed`, `test`, `typecheck`
- `tsconfig.json` -- new; strict, `noEmit`, `erasableSyntaxOnly` (Node type stripping forbids enums/namespaces)
- `src/db/schema.sql` -- new; tables + immutability triggers
- `src/db/connection.ts` -- new; opens DB (path from `ZAMU_DB`, default `data/zamu.db`), applies schema, enables foreign keys
- `src/store/cases.ts` -- new; public store API later stories depend on
- `src/seed/` -- new; synthetic data generator + entrypoint
- `test/` -- new; `node:test` suites

## Tasks & Acceptance

**Execution:**
- [x] `package.json`, `tsconfig.json`, `.gitignore` -- scaffold ESM project; dev deps `typescript`, `@types/node` only; ignore `data/`, `node_modules/`, journal files -- minimal, fast setup
- [x] `src/db/schema.sql` -- tables `schools`, `households`, `children`, `rounds`, `round_events`, `cases`, `evidence`, `case_events` with actor columns; BEFORE UPDATE/DELETE triggers on `cases`, `evidence`, `round_events`, `case_events`, `rounds`; unique index on `cases.supersedes_case_id`; `UNIQUE(school_id, admission_no)` on children; stage CHECK; value CHECKs (`typeof(...) = 'integer'`, coordinate ranges, non-empty text) -- DB-level immutability and value domains
- [x] `src/db/connection.ts` -- open/initialise database; `PRAGMA recursive_triggers = ON` so `INSERT OR REPLACE` fires delete triggers; resolve the default path from the project root; treat an empty `ZAMU_DB` as unset -- single entry point for all stories
- [x] `src/store/cases.ts` -- `createCase`, `correctCase`, `recordStage`, `recordAward`, `getCurrentStage`, `getCase`, `getCaseHistory`, `listCurrentCases(roundId)`, `createRound`, `openRound`, `closeRound`, `isRoundOpen`, plus lifecycle enforcement (transition map, single award, budget cap, round state, correction window, monotonic ISO timestamps), actor recording, `supersededByCaseId` on reads, and typed errors -- safe API for stories 2–9
- [x] `src/seed/data.ts`, `src/seed/run.ts` -- deterministic seeded generator: 1 ward, 3 schools, ~40 children across 30 households covering every band in `scoring-model.md`; three rounds (two closed with awards, one open) so applicants carry 0, 1 or 2 rounds of waiting; actors on every event; one corrected case derived from `CORRECTED_CHILD` -- demo-ready dataset
- [x] `test/immutability.test.ts`, `test/store.test.ts`, `test/seed.test.ts` -- cover every I/O matrix row plus the review's verification gaps: rollback on failed insert, round filter and ordering of `listCurrentCases`, multi-step `getCaseHistory`, `CaseNotFoundError` on all five readers/writers, never-opened round, REPLACE on every append-only table -- proves CAP-5 and the lifecycle rules

**Acceptance Criteria:**
- Given a seeded database, when any UPDATE or DELETE is attempted on an append-only table, then SQLite rejects it.
- Given `npm run seed`, when it completes, then every scoring-model band has at least one case and at least one round-2 applicant had no round-1 award.
- Given the seeded data, when grepping the repo for real phone numbers or IDs, then only the fake range is present.
- Given any append-only table, when a row is rewritten with `INSERT OR REPLACE`, then the statement fails and the stored values are unchanged.
- Given a case at any stage, when a transition outside the allowed map is recorded, then it is rejected and no event is stored.

## Implementation Notes

- Added `src/store/registry.ts` (`addSchool`, `addHousehold`, `addChild`) and `createRound`/`isRoundOpen` in `src/store/cases.ts` — needed by seed and tests; registry tables are not append-only (school records change).
- `approved` is recorded only via `recordAward` (DB CHECK: `approved` ⇔ amount present); `recordStage(..., 'approved')` throws `InvalidStageError`.
- A correction starts again at `applied` (must be re-verified); stages and awards on a superseded case throw `AlreadySupersededError`.
- Duplicate-application and single-supersede rules are enforced by partial unique indexes, mapped to typed errors.
- Case IDs are `ZM-0001` style (public-queue friendly).
- Seed: 3 rounds (two closed with awards to mud then semi-permanent houses, within budget; one open), so open-round applicants carry 0, 1, or 2 rounds of waiting. HH-005's open-round case is corrected (0 → 7 cattle) to demo the "hidden cows" attack.
- `@types/node` pinned to ^26 to match the Node 26 runtime (npm `latest` tag points at 22). TypeScript 7.0.2.
- `test/helpers.ts` provides temp-file DBs; not matched by the test glob. Hook order closes the DB before removing the temp dir (Windows EBUSY).

**Review round 1 rebuild:**
- `PRAGMA recursive_triggers = ON` closes the `INSERT OR REPLACE` bypass; `rounds` is now append-only too, so a budget cannot be rewritten.
- Lifecycle lives in `NEXT_STAGES` (transition map) + `CORRECTABLE_STAGES`; `recordAward` checks whole-number amounts and the round's remaining budget via `awardedTotal`.
- Every write takes an `Actor` (`id` + role from `parent|chv|teacher|clerk|committee|school|system`), stored on `cases`, `case_events`, `round_events`.
- Timestamps are validated ISO-8601 and never earlier than the event they follow, so the "earlier application" tie-break cannot be gamed; `listCurrentCases` orders by `rowid` rather than `created_at`.
- Value domains enforced in SQL (`typeof(...) = 'integer'`, coordinate ranges, non-empty text), so fractional cattle or amounts are rejected rather than silently stored as REAL.
- `databasePath()` resolves from the project root and treats an empty `ZAMU_DB` as unset; transactions use `BEGIN IMMEDIATE` with a 5s busy timeout.
- 56 tests (was 25), including every review verification gap: rollback on failed insert, round filter and order of `listCurrentCases`, multi-step history walk, `CaseNotFoundError` from all six entry points, never-opened round, REPLACE on all five append-only tables.

## Spec Change Log

- **Review round 1 (intent_gap).** Findings 2–7 and 18: `correctCase` allowed double awards, stages could be recorded in any order, awards ignored the round budget, rounds could reopen, events named no actor, callers could backdate, and reads hid superseded status. Human answered Q1a/Q2a/Q3a: lifecycle enforced in the store, corrections only before award in an open round, actors recorded. Amended Boundaries, I/O matrix, Tasks and Acceptance accordingly, and folded in the patch-tier findings (REPLACE bypass, value CHECKs, rounds immutability, path/seed fixes, verification-gap tests). Avoids a store that later stories can drive into impossible states. KEEP: the append-only schema shape, event-sourced stages, `ZM-0001` case ids, partial unique indexes for duplicate/supersede rules, deterministic seed with the hidden-cattle correction, and the existing 25 passing tests.

## Review Triage Log

| # | Source | Finding | Verdict | Route | Evidence |
|---|---|---|---|---|---|
| 1 | blind, edge, verif-gap | `INSERT OR REPLACE` bypasses UPDATE/DELETE triggers on cases, evidence, case_events, round_events | high | patch | Reproduced by two reviewers on node:sqlite; REPLACE deletes fire triggers only with `recursive_triggers` on. Fix: enable it in `openDatabase` + REPLACE tests |
| 2 | blind, edge | `correctCase` allowed on awarded cases and closed rounds; correction restarts at `applied` and can be awarded again; paid award drops from `listCurrentCases` | high | intent_gap | No stage or round check in `correctCase`; frozen intent does not say when corrections are allowed |
| 3 | blind, edge | Stage transitions unordered: disburse before approve, multiple `approved`, events after `rejected`, award on unverified case | medium | intent_gap | `recordStage`/`recordAward` only validate name + currency; intent silent on lifecycle rules (CAP-10 is story 6) |
| 4 | blind, edge | Awards not capped by round budget | medium | intent_gap | `recordAward` never reads `rounds.budget`; same lifecycle question as #3 |
| 5 | blind, edge | `openRound`/`closeRound` unguarded: reopen closed round, close unopened, unknown id raw FK error | medium | intent_gap | Plain inserts; same lifecycle question as #3 |
| 6 | blind | No actor recorded on case/round events or corrections | medium | intent_gap | No actor columns; accountability requirement unstated; adding later needs a schema change with no migrations |
| 7 | edge | Caller-supplied `at` allows backdating; `listCurrentCases` orders by `created_at`, so a backdated case wins the "earlier application" tie-break | medium | intent_gap | `at` is a public param on every write; ordering uses it. Folded into lifecycle question #3 (store-assigned timestamps) |
| 8 | blind, edge | `rounds` (budget), `children`, `households`, `schools` mutable | medium | patch (rounds) / defer (registry) | `UPDATE rounds SET budget` succeeds. Round definition should be immutable (trigger). Registry records legitimately change (transfers, phones) → defer registry history |
| 9 | blind, edge | Fractional/non-integer values stored in INTEGER columns (amount 150.5, cattle 2.5); empty strings; lat/lng out of range; blank correction reason | medium | patch | SQLite type affinity stores REAL; fix with `typeof(...) = 'integer'`, range and `length(trim(...)) > 0` CHECKs |
| 10 | blind | Same child registrable twice defeats duplicate-application guard | low | patch | `children` lacks `UNIQUE(school_id, admission_no)`; direct constraint |
| 11 | blind, edge | Child's school ward not checked against round ward | medium | defer | Single-ward demo; multi-ward routing is later scope |
| 12 | blind | Seed doesn't remove `-journal`; `.gitignore` misses `*.db-journal` | low | patch | Direct addition to suffix list and ignore file |
| 13 | blind, edge | Concurrency: `COUNT(*)` id race, checks outside transaction, no `BEGIN IMMEDIATE`/busy timeout | medium (unverified) | defer | Not demonstrated; single-process demo. Settle with a two-connection race test |
| 14 | blind, edge | `ZM-%04d` overflows past 9,999 | low | reject | Demo scale ~100 cases; fix changes public ID format |
| 15 | blind | No schema versioning/migrations | low | reject | Seed rebuilds the DB every run; fix adds machinery |
| 16 | blind | "Fake" phone range `+254700000xxx` may be real subscribers | medium | defer | Kenya reserves no fictional range; story 5 must send only via Africa's Talking sandbox — record there |
| 17 | blind | Source-scan phone test only matches the comment | low | patch | Numbers built via template string; delete the source-scan half, keep DB check |
| 18 | blind, edge | Read APIs don't expose superseded status; `getCurrentStage` on superseded case looks live | medium | intent_gap | Later stories can act on stale cases; adds public surface — resolved with lifecycle answers |
| 19 | blind | Seed hard-codes index `4` instead of deriving from `CORRECTED_CHILD` | low | patch | Direct correction |
| 20 | blind | Scoring bands duplicated in seed comments and seed test | low | reject | Story 2 owns bands; not a defect today |
| 21 | blind | `engines >=24` vs `@types/node ^26`; no lockfile | low | reject | `package-lock.json` exists (omitted from diff listing); type/engine skew unlikely to bite |
| 22 | blind, edge | `npm run seed` deletes `ZAMU_DB` target without guard; `:memory:` message | low | reject | Deleting the file is specified behaviour; PoC has no live DB |
| 23 | edge | Seed awards by house type contradict scoring model (CH-008 need 70 unawarded; CH-009 need 37 awarded) | medium | defer | Verified by hand. Intent excludes score computation from story 1 → story 2 must re-derive closed-round awards from the engine |
| 24 | edge | `ROLLBACK` throws after SQLite auto-rollback, masking original error | low | reject | Needs SQLITE_FULL/IOERR; fix adds a branch |
| 25 | edge | Unknown child / CHECK violation surface as raw SQLite errors | low | reject | Loud failure; story 4 validates children on file |
| 26 | edge | `ZAMU_DB=''` opens a temp DB (`??` keeps empty string) | low | patch | Direct `??` → `||` |
| 27 | edge | `DEFAULT_DB_PATH` relative to cwd | low | patch | Direct: resolve from project root |
| 28 | edge | Partially seeded DB left on failure | low | reject | Deterministic seed; fix adds cleanup branch |
| 29 | edge | `t.after` removes temp dir before `db.close()` (EBUSY on Windows) | low | patch | Direct reorder of hook registration |
| 30 | edge | Spec task said 2 rounds (round 2 open); seed has 3 (third open) | low | reject | Fix would be a spec edit; deviation is recorded in Implementation Notes and enables the +20 waiting example |
| 31 | verif-gap | Rollback path of `createCase`/`correctCase` untested | medium | patch | Mutation ROLLBACK→COMMIT passed all tests (pre-verified) |
| 32 | verif-gap | `listCurrentCases` round filter untested | medium | patch | Mutation removed filter, suite passed (pre-verified) |
| 33 | verif-gap | `listCurrentCases` order untested (`.sort()` discards it) | low | patch | Mutation reversed order, suite passed (pre-verified) |
| 34 | verif-gap | `getCaseHistory` root walk tested one step deep only | medium | patch | Mutation `while`→`if` passed (pre-verified) |
| 35 | verif-gap | `CaseNotFoundError` tested only on `correctCase` | low | patch | Mutations on 3 guards passed (pre-verified) |
| 36 | verif-gap | Never-opened round not tested as closed | medium | patch | Mutation passed (pre-verified) |
| 37 | verif-gap | Removing `PRAGMA foreign_keys` changes nothing | false | reject | Reviewer's own note: node:sqlite enables foreign keys by default; not a defect |

**Round 2** (after the rebuild):

| # | Source | Finding | Verdict | Route | Evidence |
|---|---|---|---|---|---|
| 38 | edge | Decision stages (`verified`, `approved`, `rejected`) could still be recorded after the round closed | medium | patch | Confirmed: `prepareTransition` had no round check. Now rejects with `RoundNotOpenError` |
| 39 | edge, blind | `createCase` and `correctCase` timestamps unanchored — an application could predate its round, a correction its original | medium | patch | Confirmed; both now pass `notBefore` to `checkTimestamp` |
| 40 | blind, edge, verif-gap | `checkTimestamp` used `Date.parse`, accepting `12/25/2026`, `May 4 2026` | medium | patch | Confirmed; strict ISO-8601 regex added with tests |
| 41 | blind, edge | Self-superseding row (direct INSERT) makes `getCaseHistory` loop forever | medium | patch | Confirmed; `CHECK (supersedes_case_id <> id)` added. Longer cycles are impossible: a correction can only reference an existing row |
| 42 | blind | WAL files cleaned up and ignored but WAL never enabled | low | patch | Confirmed; `journal_mode = WAL` now set for file databases, which also makes the busy timeout useful |
| 43 | blind, edge | Schema comment overstated the guarantee (no protection against `DROP TRIGGER` / `writable_schema`) | low | patch | Confirmed; comment now states the scope, hash chain deferred |
| 44 | verif-gap | `databasePath()` branches and parent-directory creation untested | medium | patch | Pre-verified by mutation; new `test/connection.test.ts` covers unset/blank/relative/absolute/`:memory:` and nested paths |
| 45 | verif-gap, edge | Blank `correction_reason` / blank `actor_id` CHECKs untested | medium | patch | Pre-verified: removing either CHECK left the suite green. Tests added |
| 46 | verif-gap | Half the evidence snapshot and the correction note never read back | medium | patch | Pre-verified: swapping lat/lng or dropping the note left the suite green. Full `deepEqual` on evidence + note assertion added |
| 47 | verif-gap, edge | Evidence `capturedAt` and round-event ordering unexercised | medium | patch | Pre-verified by mutation; tests added |
| 48 | blind, edge | No role authorization — any actor may record any stage | medium | defer | Real, but it is CAP-10 (story 6, role-based stage flow) |
| 49 | blind | No remedy after an award (no revoke/reverse); rejection needs no reason | medium | defer | Pairs with CAP-9 review flow; budget released only by a future reversal stage |
| 50 | blind | Ward never checked between child's school and round | medium | defer | Carried from round 1 (#11); single-ward demo |
| 51 | blind | Append-only is not tamper-proofing (`DROP TRIGGER`, `writable_schema`); suggests a hash chain | medium | defer | True at file level; hash chain over events recorded as future work |
| 52 | blind | No erasure/rectification path for household data held immutably | medium | defer | Kenya DPA 2019 tension; needs a documented approach in the written summary |
| 53 | blind | `seedDatabase` destroys whatever `ZAMU_DB` points at | low | reject (carried) | Deleting the file is the specified reseed behaviour; PoC has no live database |
| 54 | blind, edge | Unknown `childId` raises a raw FK error rather than `ChildNotFoundError` | low | reject (carried) | Loud failure; story 4 validates children against the register before applying |
| 55 | blind | No schema versioning / migrations | low | defer | Carried from round 1 (#15); seed rebuilds the file each run |
| 56 | blind | Scoring bands duplicated in seed comments and seed test | low | reject (carried) | Story 2 owns the scoring module |
| 57 | blind | No README / CI workflow | low | reject | Story 10 delivers the README; CI is not part of the hackathon deliverables |
| 58 | edge | `toRecord`/`lastEvent` throw `TypeError` on a case with no events or evidence | low | reject | Only reachable by direct INSERT into a corrupted database |
| 59 | edge | `transaction()` would break if nested | low | reject | No nested call exists; guarding an unreachable path |
| 60 | edge | Seed `at()` helper would overflow past minute 960 | low | reject | Current maximum is 240; seed-only helper |
| 61 | edge | `openDatabase` leaks the handle if schema application throws | low | reject | Process-fatal path in a demo tool |
| 62 | edge | Phone-range acceptance criterion only checks the database, not repo sources | low | reject | The generator builds numbers from one template; the DB check covers it |
| 63 | edge | `CORRECTED_CHILD` derives from `CORRECTED_CHILD_INDEX`, so changing the id alone would mislead | low | reject | Index is the documented source of truth |

## Design Notes

State-as-events keeps stage changes compatible with DB-enforced immutability:

```sql
CREATE TRIGGER case_events_no_update BEFORE UPDATE ON case_events
BEGIN SELECT RAISE(ABORT, 'immutable record'); END;
-- current stage = latest case_events row by id for a case
```

App code lives at the repository root so the public repo shows the BMAD artifacts (evidence of AI-tool usage for the written summary) next to the code.

## Verification

**Commands:**
- `npm run typecheck` -- expected: no errors
- `npm test` -- expected: all suites pass
- `npm run seed` -- expected: prints row counts per table, exits 0
