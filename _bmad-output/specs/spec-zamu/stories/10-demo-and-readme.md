---
title: 'End-to-end demo scenario and README'
type: 'feature'
created: '2026-09-18'
status: 'done'
route: 'dispatch'
review_loop_iteration: 1
baseline_commit: '89ecbb5'
context:
  - '{project-root}/_bmad-output/specs/spec-zamu/SPEC.md'
  - '{project-root}/_bmad-output/specs/spec-zamu/pitch-positioning.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Five capabilities work, but nothing connects them for someone with five minutes: a judge, or James recording the demo under deadline. The submission needs a public repository with a README, and the whole SPEC success signal has to be visible in one recorded run. Today that would mean juggling three terminals and remembering which child to apply for.

**Approach:** One scripted walkthrough that drives the real code — no mock layer, no recorded output — printing each act as it happens, so recording the video is reading a script aloud. Plus a README that explains the problem, the trust model, how to run it in three commands, and how AI tools built it.

## Boundaries & Constraints

**Always:**
- The walkthrough calls the same modules the servers do: store, scoring, queue, USSD session, SMS dispatch. Nothing is faked for the camera.
- It runs against a fresh database it seeds itself and never touches `data/zamu.db`, so it can be re-run mid-recording.
- Every act prints what a real person would see: the SMS text, the USSD screens keypress by keypress, the queue row, the rejected edit.
- It covers the SPEC success signal in order: "your turn" SMS → USSD apply with consent → score and queue place → stage SMS through school confirmation → an attempted edit of a locked case producing a new linked case.
- It exits non-zero if any act does not hold, so a broken demo fails before the camera, not during it.
- The README states plainly what is built and what is not (stories 6–9), names the deferred limitations, and explains the BMAD-plus-Claude-Code workflow the written summary must describe.
- Only synthetic data appears anywhere; nothing in the repository identifies a real person or number.

**Never:**
- No new product behaviour: this story adds a script and documents, not features.
- No recorded or hardcoded output standing in for a real run.
- No claim in the README that the code does not support, and no unbuilt story described as done.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Full run | `npm run demo` | every act prints in order, exit 0 | any failed check exits non-zero with what broke |
| Act 1 | round opened | the parent's "your turn" SMS, in their language, with the amount | N/A |
| Act 2 | USSD session | menu, child list, consent, confirmation — each screen as the phone shows it | N/A |
| Act 3 | after applying | the parent's own score breakdown and queue place | N/A |
| Act 4 | case advanced | verified, awarded, paid, school-confirmed SMS in sequence | N/A |
| Act 5 | direct SQL edit of a case | the database refuses; the correction path creates a new linked case, both visible | N/A |
| Re-run | `npm run demo` twice | identical output; no state carried over | N/A |
| Repo scan | README and scripts | no real phone number, name, or credential | N/A |

</frozen-after-approval>

## Code Map

- `src/seed/data.ts` -- `seedDatabase`, `OPEN_ROUND_SKIPPED` (the children left unapplied for exactly this)
- `src/ussd/session.ts` -- `respond`, `renderReply` for the phone screens
- `src/sms/dispatch.ts` -- `dispatch`, `listMessages`; `src/sms/senders.ts` -- `recordingSender`
- `src/queue/ranking.ts` -- `rankRound`, `publicQueue` for the queue rows
- `src/store/cases.ts` -- `recordStage`, `recordAward`, `correctCase`, `getCaseHistory` for acts 4 and 5
- `src/scoring/model.ts` -- `scoreNeed`, `reasonText` for the score act
- `_bmad-output/specs/spec-zamu/` -- SPEC, scoring model, pitch positioning: the README's source of truth

## Tasks & Acceptance

**Execution:**
- [x] `src/demo/run.ts` -- the five acts against a temporary seeded database, printing each screen and asserting each expectation; exits non-zero on the first failure -- the video script
- [x] `package.json` -- `demo` script -- one command
- [x] `README.md` -- what Zamu is, the problem in three sentences, how to run it (`seed`, `web`, `ussd`, `sms`, `demo`), the trust model, what is and is not built, the deferred limitations, and how BMAD skills plus Claude Code produced it -- the repository's front door
- [x] `docs/demo-script.md` -- the recording plan: what to say per act, what to show on screen, and the two places a judge should look -- so the video is a read-through
- [x] `test/demo.test.ts` -- runs the demo end to end and asserts every act appeared and the exit code is 0 -- a broken demo fails in CI, not on camera

**Acceptance Criteria:**
- Given a clean checkout, when `npm run demo` runs, then all five acts print and the process exits 0.
- Given the demo has run, when `data/zamu.db` is inspected, then it is unchanged.
- Given the README, when its run instructions are followed in order, then each command works as described.
- Given the repository, when it is scanned for phone numbers, then only the documented fake range appears.

## Implementation Notes

- `npm run demo` rebuilds `data/demo.db` (gitignored, never `data/zamu.db`) and plays five acts through the real modules. `ZAMU_DB=data/demo.db npm run web` then shows the same queue in a browser. `--step` pauses between acts for recording.
- The household followed is chosen by rule, not hardcoded: the first child left out of the open round who waited a closed round without an award (CH-036, Faraja Wekesa). So "it is your turn" in Act 1 and `waiting +10` in Act 3 are the same fact.
- Checks stop the run at the first claim that does not hold and print `ACT n FAILED: <claim>`; missing values fail by name rather than with a stack trace.
- Act 5 attacks through a plain `DatabaseSync` connection with none of Zamu's pragmas — the way a clerk with the file would — and all three attempts are refused.
- `README.md` covers the problem (with sources), how it works, running it, the full USSD sequence, trust model, architecture, what is and is not built, known limitations, and the BMAD + Claude Code workflow. `LICENSE` is MIT, added at the author's request.
- `test/demo.test.ts` runs the demo twice with the test runner's own Node: every act in order, no failed check, identical output across runs, `data/zamu.db` untouched (including its WAL), every **Point at** quote in the recording script present in the output, and no phone number outside the demo range or credential in any tracked file.
- 189 tests (was 181 before this story).

## Spec Change Log

- **Review round 1.** The review of this story found that story 1's immutability guarantee held only for connections that set `PRAGMA recursive_triggers`. Fixed at the schema level with `BEFORE INSERT` guards, so it holds for any connection; story 1's spec is annotated. The demo was rebuilt around a household whose SMS and queue agree, on a fixed `data/demo.db` the web server can show. KEEP: real modules only, stop-on-first-failure checks, and the test that ties the recording script to the actual output.

## Review Triage Log

| # | Source | Finding | Verdict | Route | Evidence |
|---|---|---|---|---|---|
| 1 | blind | **Immutability held only on Zamu's own connections.** A plain `sqlite3`-style connection rewrote cattle 3 → 0 with `INSERT OR REPLACE`, because the delete triggers depend on `PRAGMA recursive_triggers`, which is per connection | high | patch | Reproduced by the reviewer. `BEFORE INSERT` guards on every append-only table now refuse any colliding insert regardless of connection settings; a test and Act 5 both attack through a plain connection. Story 1's round-2 fix is annotated |
| 2 | blind, edge | README said triggers covered "every record table"; schools, households and children are editable | high | patch | README names the append-only tables and lists the editable registry as a limitation |
| 3 | blind, edge | The demo followed the wrong household: the SMS said "waited 2 rounds" while their child showed `waiting +0` | high | patch | Root cause: the SMS counted waiting per household, the queue per child. The SMS now uses the queue's own rule, and the demo picks its household by that rule |
| 4 | blind, edge | The browser step showed a different database, so the demo's case never appeared | high | patch | The demo now writes `data/demo.db`; the script runs `web` against it; verified the case appears |
| 5 | blind, edge, verif-gap | "Fits one USSD page" measured text already trimmed to 182, so it could not fail | medium | patch | Measured before trimming, against `MAX_SCREEN` |
| 6 | blind, edge, verif-gap | Act 1 accepted the ordinary opening SMS while the script pointed at "your turn" | medium | patch | Act 1 requires `smsYourTurn` for the household |
| 7 | verif-gap | Act 4 checked presence, not order | medium | patch | Order is now asserted |
| 8 | blind, edge, verif-gap | "Same place in both places" only checked position > 0 | medium | patch | Compares the USSD place screen and the confirmation to the public row |
| 9 | edge, verif-gap | "Household language" compared the message to its own field | low | patch | Compared to `households.language` |
| 10 | blind | Act 3 printed private reason text under the "public" heading, built from the private `QueueEntry` | medium | patch | Private and public sections separated; the public row comes from `publicQueue` and is checked for name, phone and evidence |
| 11 | blind, edge | `!` lookups crashed with a stack trace instead of a named failure; failures did not stop the run | medium | patch | `need()` and a stopping `check()` name the act and claim |
| 12 | edge | School confirmation was credited to SCH-1 while the child attends another school | medium | patch | Uses the child's own school, checked |
| 13 | edge | The correction kept the original capture time and photo while naming a new capturer | low | patch | Fresh capture time and photo reference |
| 14 | blind | Act 4 presented simulated steps as working | medium | patch | Labelled "Simulated" on screen and in the script |
| 15 | blind | "A decision cannot be recorded without its message" overstated; rejected SMS promised a kept place the rules do not give | medium | patch | README reworded; `smsRejected` now says "apply again" in both languages; passed-over applicants listed as a limitation |
| 16 | blind | README contradicted itself on who can recompute the score and whether the breakdown leaves the server | low | patch | Reworded |
| 17 | blind | README claimed sending only ever goes through the sandbox | medium | patch | Reworded to what the code does, with a warning |
| 18 | blind | README "consent first" omitted the home-visit requests written before consent; the session comment was false | medium | patch | Both corrected |
| 19 | blind | `zamu.go.ke` on camera implied a government body | medium | patch | Default is now `zamu.example` (reserved, RFC 2606) |
| 20 | blind | Auditor-General figures had no sources | medium | patch | Sources section added |
| 21 | blind | No architecture section, no full USSD walkthrough, no simulator instructions | low | patch | All three added; the curl sequence verified live |
| 22 | blind, edge | `test/demo.test.ts`: vacuous when `data/zamu.db` is absent, ignored the WAL, scanned two files, ran `node` from PATH, ran the demo three times | medium | patch | Runs twice with `process.execPath`, compares output and the WAL, scans every tracked file including `%2B254` |
| 23 | edge | The script quoted output the demo does not print, and nothing tied them together | medium | patch | Every **Point at** quote is now asserted against the output — and it immediately caught two stale quotes |
| 24 | edge | Printed a random temp path, so output differed per run | low | patch | Fixed relative path |
| 25 | blind | Act 5 built SQL by string interpolation | low | patch | Prepared statements |
| 26 | edge | No way to pause between acts while recording | low | patch | `--step` |
| 27 | edge | Script promised "the two places a judge should look" and did not name them | low | patch | Named at the top |

## Verification

**Commands:**
- `npm run typecheck` -- expected: no errors
- `npm test` -- expected: all suites pass
- `npm run demo` -- expected: five acts, exit 0
