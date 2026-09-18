---
title: 'Queue and public queue page'
type: 'feature'
created: '2026-09-18'
status: 'done'
route: 'dispatch'
review_loop_iteration: 1
baseline_commit: '7f3bd8d'
context:
  - '{project-root}/_bmad-output/specs/spec-zamu/SPEC.md'
  - '{project-root}/_bmad-output/specs/spec-zamu/scoring-model.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The queue is the core of Zamu (SPEC CAP-4): it replaces the list pinned at the chief's office, and it is what makes jumping the line visible. Scores and priorities exist in code, but nothing ranks a round or publishes it, so neither a parent nor a neighbour can see who is where and why.

**Approach:** One ranking function that orders a round's current cases by priority, and a read-only web page that publishes it — plain server-rendered HTML, no client JavaScript, readable on a cheap phone over a weak connection. The page carries only the fields SPEC Constraints allow in public; anything identifying a household stays out of the response entirely.

## Boundaries & Constraints

**Always:**
- Ranking is priority order (need + waiting bonus), ties to the earlier application measured from the first case in a correction chain, then by case id. One implementation, used by the page and by the seed.
- Published per entry: position, case id, masked name, school name, need score, waiting bonus, priority, stage, and award amount when awarded.
- Masked name is the given name's initial plus the surname's initial and stars (`B. K****`) — enough for a neighbour to recognise a household, not enough to compile a list of poor families.
- Never published: full names, phone numbers, evidence photos, GPS, capture details, fee balance, house type, livestock, land, and the score breakdown or reason text (parent-only, over USSD in story 4).
- Every page states the round's budget, currency, amount awarded so far, recipient count, and whether the round is open or closed.
- Server-rendered HTML with inline CSS, no client JavaScript, no external requests; a 40-entry page stays under 50 KB.
- Read-only: the server opens the database, writes nothing, and exposes no route that changes state.

**Never:**
- No USSD or SMS (stories 4–5), no admin actions (story 6), no authentication, no styling framework or third-party dependency.
- No new scoring rules: ranking consumes `src/scoring`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Rank a round | seeded open round | 40 entries, positions 1..40, priority descending | N/A |
| Tie | equal priority | earlier first application wins, then lower case id | N/A |
| Correction | corrected case in the round | the current case is listed once; the superseded one never appears | N/A |
| Awarded round | closed round | awarded entries show their amount; totals match the round's awarded sum | N/A |
| Index page | `/` | lists rounds, newest first, each linking to its queue | N/A |
| Queue page | `/round/R-2026-T2` | ranked table plus round summary, under 50 KB | N/A |
| JSON view | `/round/R-2026-T2.json` | the same public entries as data | N/A |
| Unknown round | `/round/NOPE` | 404 with a short message | no stack trace, no database detail |
| Unknown path | `/anything` | 404 | N/A |
| Empty round | round with no applications | page renders with an empty-queue note | N/A |
| Private data | any response | contains no phone, photo reference, GPS, full name, or evidence value | N/A |

</frozen-after-approval>

## Code Map

- `src/scoring/priority.ts` -- `queuePriority`; consume, do not change
- `src/store/cases.ts` -- `listCurrentCases`, `getCaseHistory`, `awardedTotal`, `isRoundOpen`; read-only
- `src/seed/data.ts` -- `awardByPriority` currently sorts inline; replace that sort with the shared ranking so both agree
- `src/db/connection.ts` -- `openDatabase`, `databasePath`
- `test/helpers.ts` -- `tempDir`, actor constants, `evidence()` fixture

## Tasks & Acceptance

**Execution:**
- [x] `src/queue/ranking.ts` -- `rankRound(db, roundId)` returning ordered entries with position, priority parts, stage and award; `publicEntry` masking names and dropping private fields; `roundSummary(db, roundId)` -- one ranking rule for every consumer
- [x] `src/web/server.ts` -- Node `http` server: `/`, `/round/:id`, `/round/:id.json`, 404 for anything else; `createServer` exported for tests, started by `src/web/run.ts` on `PORT` (default 4000) -- the public list that replaces the pinned notice
- [x] `src/web/render.ts` -- HTML for the index and queue pages with inline CSS, escaped output, mobile-first table -- readable on a cheap phone
- [x] `src/seed/data.ts` -- use `rankRound` in `awardByPriority` -- removes the duplicate ordering rule
- [x] `package.json` -- `web` script running `src/web/run.ts` -- one command for the demo
- [x] `test/queue.test.ts` -- ranking order, tie-break, corrections, masking, and that public entries carry no private field -- proves CAP-4's ordering and privacy
- [x] `test/web.test.ts` -- each route, 404s, empty round, page size, and a scan of every response for seeded phone numbers, photo refs, GPS and full names -- proves the page leaks nothing

**Acceptance Criteria:**
- Given the seeded open round, when the queue page is requested, then positions run 1..40 in priority order and the response is under 50 KB.
- Given any seeded round, when every response body is scanned, then no household phone number, photo reference, GPS coordinate, full child name, or evidence value appears.
- Given the ranking used by the page and by the seed, when both order the same round, then they produce the same sequence.

## Implementation Notes

- `src/queue/ranking.ts` is the single ordering rule: `rankRound` (priority desc, then first application in the correction chain, then case id), `publicEntry`/`publicQueue` (drops name, childId, appliedAt), `roundSummary`, `listRounds`. `src/seed/data.ts` now ranks through it, so the seed and the page cannot diverge.
- `maskName('Baraka Kariuki')` → `B. K******`; a single-word name renders as `B.`.
- `src/web/server.ts` handles `/`, `/round/:id`, `/round/:id.json`, 404s everything else, and answers 405 to non-GET so no route implies a change. Errors render a plain page — no stack traces or SQLite messages.
- `src/web/render.ts` inlines all CSS, emits no `<script>` and no external URL, escapes every interpolated value, and supports light and dark. On phones the school and stage columns collapse into the applicant cell so nothing is cut off; the 40-entry page is ~17 KB.
- Verified in a real browser at 375px and desktop width: open round (40 applicants, waiting bonuses visible) and closed round (12 recipients, KES 150,000 of 150,000).
- 105 tests (was 81): `test/queue.test.ts` covers ranking, ties after a correction, superseded cases, masking and the public projection; `test/web.test.ts` covers every route, 404/405, page size, no-script/no-external-request, and scans every response against the seeded phones, names, photo refs, GPS and evidence values.

## Spec Change Log

- **Review round 1 (patch tier, no loopback).** Publishing `priority` and `stage` went beyond SPEC Constraints' public field list; rather than drop them (both are useful to a parent and priority is derivable from the two published parts), SPEC Constraints and the spec memlog now record the wider set. Masking moved to fixed-width stars so surname length is not disclosed. KEEP: one ranking rule shared with the seed, single-pass `roundView`, read-only serving, and the response-wide privacy scan.

## Review Triage Log

| # | Source | Finding | Verdict | Route | Evidence |
|---|---|---|---|---|---|
| 1 | blind, edge, verif-gap | A malformed percent-escape (`/round/%E0%A4%A`) returned 500 instead of 404 | medium | patch | Reproduced live; `decodeURIComponent` now guarded, with tests |
| 2 | blind, edge, verif-gap | `/round/NOPE.json` answered 404 as HTML | medium | patch | JSON routes now answer JSON errors |
| 3 | blind | The "read-only" server ran schema DDL and set WAL on every start | medium | patch | Added `openReadOnly`; a test asserts the database file is byte-identical after serving |
| 4 | blind | `priority` and `stage` were published beyond the SPEC's public field list | medium | patch | Real disclosure change. SPEC Constraints and the spec memlog updated to record it |
| 5 | blind | Public text hardcoded "out of 100" and "10 points" while the code derives both | low | patch | Now renders `MAX_SCORE` and `WAITING_BONUS_PER_ROUND` |
| 6 | blind, edge, verif-gap | Privacy scan skipped `lng`, never asserted `fee_balance`, and its evidence regex could not fail | medium | patch | Scan now covers all three rounds, both views, and every evidence value, matching fee balances as standalone tokens |
| 7 | blind, edge, verif-gap | Empty-round and empty-index pages were never rendered by a test | medium | patch | Added a server backed by an empty round |
| 8 | verif-gap | Renderer-level escaping was untested; removing every `escapeHtml` left the suite green | medium | patch | Added a render test with markup in names, school and round title |
| 9 | verif-gap | The 500 safety net was unreachable from any test | medium | patch | Added a closed-database test asserting a plain 500 |
| 10 | blind, edge | 405 carried no `Allow` header | low | patch | Added, with a test |
| 11 | blind, edge | 500 handler could throw `ERR_HTTP_HEADERS_SENT` and take the server down | medium | patch | Guarded on `res.headersSent` |
| 12 | blind | Each page ran ~600 queries: summary and queue each loaded every case | medium | patch | `roundView` ranks and summarises from one `listCurrentCases` pass |
| 13 | blind, edge | `childOf` cast an unchecked row; a missing child became a 500 | low | patch | Now throws `ChildNotFoundError` |
| 14 | edge | A never-opened round was published as "Closed" | medium | patch | `RoundStatus` is now `not_opened`/`open`/`closed` |
| 15 | blind, edge | Mask disclosed surname length; hyphenated names lost their surname | medium | patch | Fixed-width `****`, hyphen-aware split, tested |
| 16 | blind, edge | `STAGE_LABELS` typed `Record<string, string>` could publish a raw enum key | low | patch | Typed `Record<Stage, string>` |
| 17 | blind | Index column labelled a recipient count "Awarded" next to a money column | low | patch | Renamed to Recipients / Awarded of budget |
| 18 | blind, edge | `run.ts` had no PORT validation, no listen-error handler, no shutdown, and would create a database | medium | patch | All added; it now refuses to start without a seeded database |
| 19 | blind | No security headers; `no-store` fought the weak-connection goal | low | patch | CSP, `nosniff`, `no-referrer`, `max-age=30`, and a 204 favicon |
| 20 | blind, edge, verif-gap | Test teardown removed the temp directory before closing the database | low | patch | Order fixed; connections closed explicitly so teardown does not wait on keep-alive |
| 21 | edge | Index order was nondeterministic for rounds sharing a timestamp | low | patch | Tie-broken by id |
| 22 | edge | Summary and queue could disagree if another process committed between reads | low | reject | Single-writer demo; `roundView` now reads both from one pass, which narrows it further |
| 23 | blind | `maskName` JSDoc, story text and output disagreed on star count | low | patch | All three now say `B. K****` |
| 24 | blind | `package.json` description em dash rewritten as an escape | low | patch | Reverted to the original character |
| 25 | edge | Masked name plus school in a single ward is still re-identifiable | low | defer | Inherent to a public queue a neighbour must be able to check; recorded as a privacy trade-off |

## Verification

**Commands:**
- `npm run typecheck` -- expected: no errors
- `npm test` -- expected: all suites pass
- `npm run seed && npm run web` -- expected: serves the queue on http://localhost:4000
