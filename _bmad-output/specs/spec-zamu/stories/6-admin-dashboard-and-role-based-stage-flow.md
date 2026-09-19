---
title: 'Admin dashboard and role-based stage flow'
type: 'feature'
created: '2026-09-19'
status: 'done'
route: 'dispatch'
review_loop_iteration: 1
baseline_commit: 'ceba8c6'
context:
  - '{project-root}/_bmad-output/specs/spec-zamu/SPEC.md'
  - '{project-root}/_bmad-output/specs/spec-zamu/scoring-model.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Every stage after "applied" is recorded today by scripts, and the store accepts any actor for any stage: a parent could verify their own case, a school could approve an award (SPEC CAP-10, deferred from story 1). There is also no way for the people who run a round to run it — the demo labels those steps as simulated because nothing else exists (SPEC CAP-11).

**Approach:** Enforce, in the store, which role may record which stage, and keep an append-only log of every refused attempt. Then give staff a small server-rendered dashboard that runs a round end to end — open it, review cases, verify, reject with a reason, award within budget, mark paid, confirm receipt, close it, send the resulting SMS — without touching the database.

## Boundaries & Constraints

**Always:**
- Role rules live in the store (the single write path), so every caller — dashboard, USSD, seed, demo — is held to them.
- A refused action is recorded in an append-only `refused_actions` table (who, role, case or round, what they tried, why, when) before the error is raised, so the refusal survives the failed transaction.
- A school may confirm receipt only for a child registered at that school.
- A rejection needs a written reason; it is stored on the event and reaches the parent's SMS.
- The dashboard is server-rendered HTML with plain forms and no client JavaScript, reusing the public page's look; every action is a POST followed by a redirect.
- The dashboard binds to `127.0.0.1` by default and says on every page who is acting and in what role.
- An action's actor comes from a staff registry; the role is looked up server-side, never taken from the form.
- The public queue server stays read-only and unchanged.
- **Decision (human): the role map.** Open and close rounds — clerk. Verify, and correct evidence — volunteer (`chv`) or teacher. Reject and award — committee. Mark paid — clerk. Confirm receipt — the child's own school. Apply — parent (USSD) or clerk (walk-in). Nobody who pays also vouches for need.
- **Decision (human): identity.** No login. Staff pick themselves from the registry; the server looks up the role. The dashboard binds to localhost, and the README states that role rules are enforced while identity is on trust.

**Never:**
- No volunteer capture screen or evidence entry (story 7), no round-totals SMS (story 8), no anonymous reporting (story 9).
- No passwords, sessions or accounts in this story (see the identity decision above).
- No new scoring rules, and no bypass of the lifecycle rules story 1 enforces.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Permitted stage | committee awards a verified case | event recorded with committee as actor | N/A |
| Wrong role | parent tries to verify their own case | refused; a `refused_actions` row names parent, case, `verified` | `RoleNotPermittedError`; dashboard shows the reason |
| Wrong school | school SCH-1 confirms a child registered at SCH-2 | refused and logged | `RoleNotPermittedError` |
| Reject without reason | committee rejects with a blank note | refused | `MissingReasonError` |
| Round control | clerk opens / closes a round | round event recorded | non-clerk refused and logged |
| Award over budget | committee awards more than remains | refused with the remaining amount shown | existing `BudgetExceededError` |
| Dashboard round page | `GET /round/:id` | cases in queue order, stage, need, priority, per-stage actions, budget used and remaining | N/A |
| Dashboard action | `POST` a stage change | redirect to the round page with a result banner | refusals render as a banner, never a stack trace |
| Unknown staff id | form names an actor not in the registry | refused | 400 |
| Send SMS | `POST /sms` | dispatch runs with the recording sender; count shown | N/A |
| Refusal log | `GET /refused` | every refused attempt, newest first | N/A |
| Full round | open → verify → award → pay → confirm → close, all from the dashboard | the round ends with awards, receipts and messages, no database access | N/A |

</frozen-after-approval>

## Code Map

- `src/store/cases.ts` -- `recordStage`, `recordAward`, `createCase`, `correctCase`, `openRound`, `closeRound`: add the role check and refusal logging here
- `src/db/schema.sql` -- add `staff` (registry) and `refused_actions` (append-only, with insert guards like the other tables)
- `src/seed/data.ts` -- seed the staff registry; existing seed actors already match the proposed map
- `src/web/render.ts`, `src/web/server.ts` -- look and handler shape to reuse; the public server itself does not change
- `src/sms/dispatch.ts` -- `dispatch` for the dashboard's send button
- `src/demo/run.ts`, `docs/demo-script.md`, `README.md` -- Act 4's "Simulated" label, the Built/Not-built lists and the roles limitation all change
- `test/store.test.ts`, `test/sms.test.ts`, `test/priority.test.ts` -- reject with `CLERK` today; move to the committee

## Tasks & Acceptance

**Execution:**
- [x] `src/db/schema.sql`, `src/store/registry.ts` -- `staff` table and `addStaff`/`getStaff`; `refused_actions` with append-only triggers and insert guards -- identity and an audit trail of refusals
- [x] `src/store/cases.ts` -- role map, school-ownership check, required rejection reason, `RoleNotPermittedError`, `MissingReasonError`, refusal logging written outside the failing transaction -- CAP-10
- [x] `src/seed/data.ts` -- seed staff for every role and school -- demo-ready
- [x] `src/admin/render.ts`, `src/admin/server.ts`, `src/admin/run.ts`, `package.json` -- the dashboard pages and POST actions; `npm run admin` on `127.0.0.1:4002` -- CAP-11
- [x] `src/demo/run.ts`, `docs/demo-script.md`, `README.md` -- drop "Simulated" for the steps now enforced, show one refused action in Act 4, move story 6 to Built -- the story stays true
- [x] `test/roles.test.ts` -- every row of the role map, wrong school, blank rejection, refusal log contents -- proves CAP-10
- [x] `test/admin.test.ts` -- a full round driven over HTTP from open to close, refusals as banners, unknown staff, localhost binding -- proves CAP-11

**Acceptance Criteria:**
- Given a seeded database, when a full round is driven through the dashboard's forms, then it ends with awards, school receipts and queued SMS, and no step touched the database directly.
- Given any action by a role the map does not permit, when it is attempted through any caller, then it is refused and a `refused_actions` row records it.
- Given the dashboard, when any page renders, then it names the acting person and role, and it is reachable only on localhost by default.

## Implementation Notes

- `PERMITTED_ROLES` in `src/store/cases.ts` is the single role map; `requireRole` runs before each write's transaction, so a refusal is written to `refused_actions` (append-only, insert-guarded) even though the action itself never happens. `requireOwnSchool` checks a school confirms only its own pupils.
- Rejection needs a reason (`MissingReasonError`), checked after the lifecycle rules so an impossible rejection reports why it is impossible; the reason is trimmed and stored on the event.
- Refusal messages are plain English for staff: "may not verify a case: only a chv or teacher may do this".
- `staff` registry seeded with a clerk, the committee, three volunteers, three teachers and one bursar account per school (id = the school id, so receipts are attributable).
- `src/admin/` is a separate server bound to `127.0.0.1:4002` by default (`ADMIN_HOST`, `ADMIN_PORT`). Every action is a POST from a plain form, redirected back with a banner. The acting person comes from `as` and must be in the registry; a `role` field in the form is ignored. Rule outcomes (role, reason, budget, transition, round state) become banners; anything else is a logged 500 with no internals.
- The round page lists cases in queue order with full names (internal view), budget used and remaining, and only the actions the case's stage allows, each labelled with the role that owns it.
- `runServer` gained an optional `host`.
- Demo Act 4 no longer says "Simulated": it shows the parent's refused attempt to verify their own case, then each step by its own role. README, written summary and recording script updated to match.
- Tests that rejected with the clerk now reject with the committee. 221 tests (was 189): `test/roles.test.ts` walks every role outside the map at every stage; `test/admin.test.ts` drives a whole round over HTTP from verify to close and SMS, plus refusals, forged roles, unknown staff and the localhost binding.

## Spec Change Log

- **Review round 1.** The first build enforced the role map only against the role a caller *claimed*; the store now resolves roles from the registry, and the schema enforces the same map on every connection. The dashboard gained a form token and origin checks, round creation (so "open → close from the dashboard" is true), clerk-only SMS queueing, and signed banners. The rejection reason now reaches the parent, capped to fit one SMS. A live browser check after the tests passed found the origin check refusing the dashboard's own forms; fixed and tested. KEEP: role checks before transactions so refusals survive; one role map shared by store and schema; tests that submit the rendered forms.

## Review Triage Log

| # | Source | Finding | Verdict | Route | Evidence |
|---|---|---|---|---|---|
| 1 | blind | **The store trusted the caller's claimed role**: `{ id: 'CLERK-01', role: 'chv' }` let the clerk who pays verify need | high | patch | Reproduced. The store now resolves every actor from the registry (staff, or households for parents), refuses unknown ids and role mismatches, and logs both |
| 2 | blind | Role map not enforced by the database: a plain connection could insert an award as a clerk, or past the budget | high | patch | Reproduced. `BEFORE INSERT` guards on `case_events`, `round_events` and `rounds` enforce the role map, the school's own pupils and the budget on every connection; tested |
| 3 | blind, edge, verif-gap | Any web page could drive the dashboard; a rebound hostname could read full names | high | patch | Reproduced with a foreign `Origin`. Per-process form token, `Host` and `Origin`/`Sec-Fetch-Site` checks, form-encoded bodies only, `frame-ancestors 'none'`; each tested |
| 4 | *(self, live browser check)* | The origin check refused the dashboard's **own** form in a real browser: `Referrer-Policy: no-referrer` makes browsers send `Origin: null` | high | patch | Found by submitting in the in-app browser after the tests passed. Policy is now `same-origin`, with a test sending the headers a browser actually sends |
| 5 | blind, edge, verif-gap | "Open it" was impossible: every seeded round is open or closed and there was no way to create one | high | patch | `create_round` added (clerk, attributed, schema-guarded) with a dashboard form; the whole-round test now starts from creation, verified live |
| 6 | blind, verif-gap | The rejection reason never reached the parent, as the frozen intent requires | medium | patch | `smsRejected` carries it; the store caps reasons at 50 characters of GSM-7 so the SMS always fits, proven for both languages |
| 7 | blind, edge | `requireOwnSchool` compared against `actor.id`, ignoring `staff.school_id` | medium | patch | Uses the resolved staff record's school |
| 8 | blind, edge | `POST /sms` had no owner, and marking messages sent with the recording sender would stop a later live run delivering them | medium | patch | Clerk only (`dispatch_sms`, refusals logged); the dashboard now only queues |
| 9 | verif-gap, edge | Tests posted hand-built bodies, so forms and routes could drift apart | medium | patch | Tests now submit the dashboard's own rendered forms; a test asserts every form carries `as` and `token` |
| 10 | verif-gap | A successful rejection and a successful open were never run over HTTP | medium | patch | Both in the whole-round test |
| 11 | verif-gap, edge | The localhost test asserted a banner built from the requested host | medium | patch | The banner now reports `server.address()`; a second test shows a network host is refused at startup |
| 12 | blind | Forged success banners could be linked | low | patch | Banners are HMAC-signed; unsigned ones are not shown |
| 13 | blind, edge | Wrong-role attempts that also failed another validation were never logged | medium | patch | Role check now runs first (after existence), in every write |
| 14 | blind | Unregistered `as` values left no trace | medium | patch | Logged to `refused_actions` as `(unregistered)` |
| 15 | blind | `PERMITTED_ROLES` could be widened at runtime | low | patch | Deep-frozen and typed read-only; tested |
| 16 | blind | Evidence could name a capturer who never existed | medium | patch | `capturedBy` must be a registered volunteer or teacher with that role |
| 17 | blind, edge | Whitespace actor ids crashed `refuse()` | low | patch | Trimmed with fallbacks |
| 18 | edge | Hex, exponent and padded amounts were accepted | low | patch | Decimal digits only; tested |
| 19 | edge | An oversized body reset the connection instead of a 413 | low | patch | The body is drained before replying |
| 20 | edge | `InvalidTimestampError` became a 500 | low | patch | Now a banner |
| 21 | verif-gap | `refused_actions` was outside the append-only tests | medium | patch | Added to the matrix and the plain-connection attacks |
| 22 | verif-gap | Newest-first order of the refusal log was unasserted | low | patch | Asserted without sorting |
| 23 | blind | Staff roles are editable without a trail | medium | defer | Same class as the editable registry; README limitation now names staff |
| 24 | blind, edge | A database seeded before this change has an empty staff list | low | patch | The dashboard says so and tells staff to re-seed; README notes it |
| 25 | blind | Refusal messages used role codes (`chv`) | low | patch | Plain role names throughout |
| 26 | blind | Demo Act 4's parent was a made-up id and the log was unchecked | low | patch | Uses the household's real id and checks the refusal row |
| 27 | edge | IPv6 banner and non-loopback `ADMIN_HOST` | low | patch | Banner brackets IPv6; non-loopback hosts refused |
| 28 | blind, edge | CSRF within the same machine: anyone at the keyboard can still pick any staff name | medium | defer | Identity on trust is the recorded decision for this story; real sign-in is the stated next step |

## Verification

**Commands:**
- `npm run typecheck` -- expected: no errors
- `npm test` -- expected: all suites pass
- `npm run seed && npm run admin` -- expected: dashboard on http://127.0.0.1:4002
