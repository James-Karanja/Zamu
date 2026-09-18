---
title: 'SMS notifications'
type: 'feature'
created: '2026-09-18'
status: 'done'
route: 'dispatch'
review_loop_iteration: 1
baseline_commit: '6949fde'
context:
  - '{project-root}/_bmad-output/specs/spec-zamu/SPEC.md'
  - '{project-root}/_bmad-output/specs/spec-zamu/scoring-model.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Zamu only speaks when spoken to. The root cause it exists to break is that information never reaches parents: budgets sit in PDFs, and a rumour of a date is all anyone gets (SPEC CAP-1). Without outbound SMS a parent must keep dialling to learn anything, and the "it is your turn" moment — the thing that makes waiting predictable and favour-seeking pointless — never happens.

**Approach:** Messages are derived from the append-only event log rather than sent by whatever code advanced a case, so a transition can never happen without its message. A dispatcher reads events that have no message yet, writes the message in the household's language, and hands it to a pluggable sender: a recording sender for tests and the demo, and an Africa's Talking sender switched on by credentials.

## Boundaries & Constraints

**Always:**
- Every message is derived from a stored event (`round_events` or `case_events`); dispatching is idempotent, so running it twice sends nothing twice.
- Messages and send attempts are append-only, like every other record: an attempt never mutates a message, and delivery state is the latest attempt.
- A message is written in the household's stored language, from `src/i18n/strings.ts`.
- One SMS per message: at most 160 characters, GSM-7 only, no placeholder left unfilled.
- Opening a round messages every household with a child on file, names the amount available, and tells a household that waited without an award that it is their turn.
- Every case stage change messages that household: verified, awarded (with the amount), paid to the school, school confirmed, and not selected.
- A failed send is recorded and retried on the next dispatch; a sent message is never sent again.
- Sending is opt-in: the default sender records only. The Africa's Talking sender is used only when credentials are present and `--live` is passed, and it is never reached from a test.

**Never:**
- No round-totals SMS (story 8), no anonymous reporting (story 9), no inbound SMS.
- No scheduler or daemon: dispatch runs on demand, from the CLI or a caller.
- No network call in any test, and no credentials in the repository.
- The store gains no knowledge of messaging; the dispatcher reads the log from outside.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Round opens | seed's open round | one message per household with a child, naming the budget | N/A |
| Turn message | household waited a round without an award | its message says it is their turn | N/A |
| Stage change | case advances to verified | one message to that household | N/A |
| Award | case approved for 15,000 | message names the amount | N/A |
| Paid and confirmed | disbursed, then school_confirmed | a message for each | N/A |
| Not selected | case rejected | message says so, with what happens next | N/A |
| Dispatch twice | no new events | nothing queued, nothing sent | N/A |
| Send fails | sender throws | attempt recorded as failed; message stays unsent | error not raised to the caller |
| Retry | dispatch after a failure | the same message is attempted again, once | N/A |
| Already sent | message with a successful attempt | never attempted again | N/A |
| Language | Swahili household | body is Swahili | N/A |
| Length | any message | ≤160 characters, GSM-7 only | over-long body is a build failure, not a truncation |
| Live sender | credentials absent but `--live` passed | refuses to start, explains what is missing | no partial send |

</frozen-after-approval>

## Code Map

- `src/db/schema.sql` -- add `messages` and `message_attempts`, append-only with the same triggers, plus a unique index on the event a message came from
- `src/store/cases.ts` -- `listCurrentCases`, `getCase`; the event log is the source, read-only here
- `src/i18n/strings.ts` -- add the SMS keys to both tables; the parity and GSM-7 tests already cover them
- `src/queue/ranking.ts` -- `rankRound` for the waiting bonus that decides a "your turn" message
- `src/server-runtime.ts` -- pattern for a CLI entry point
- `test/helpers.ts`, `test/ussd.test.ts` -- fixtures and the seeded-database helper shape

## Tasks & Acceptance

**Execution:**
- [x] `src/db/schema.sql` -- `messages` (event ref, phone, language, template, body, at) and `message_attempts` (message, outcome, provider ref, error, at), append-only triggers, unique index on the source event -- messages are records, not side effects
- [x] `src/i18n/strings.ts`, `src/sms/dispatch.ts` -- SMS templates in both languages plus `renderBody`, enforcing the 160-septet GSM-7 limit -- one SMS per event
- [x] `src/sms/dispatch.ts` -- `queuePending(db)` deriving messages from unmessaged events, `sendQueued(db, sender)` recording an attempt per message, and `dispatch(db, sender)` running both -- idempotent by construction
- [x] `src/sms/senders.ts` -- `recordingSender` (default) and `africasTalkingSender(config, fetch)` posting the sandbox's form body, injectable so tests never touch the network -- opt-in sending
- [x] `src/sms/run.ts`, `package.json` -- `npm run sms` dispatches with the recording sender and prints the outbox; `--live` requires credentials -- one command for the demo
- [x] `test/sms.test.ts` -- every matrix row: derivation, idempotence, failure and retry, language, length -- proves CAP-1
- [x] `test/sms-sender.test.ts` -- the Africa's Talking request shape and its error handling, with an injected fetch -- proves the provider contract without a network

**Acceptance Criteria:**
- Given the seeded database, when dispatch runs, then every household with a child has a window-open message and every recorded stage change has exactly one message.
- Given dispatch runs twice, when the outbox is compared, then the second run queues nothing and sends nothing.
- Given a sender that throws, when dispatch runs and then runs again, then the first attempt is recorded as failed and the message is sent on the retry.
- Given every message in the outbox, when each body is measured, then all are ≤160 characters, contain no `{placeholder}`, and use GSM-7 characters only.

## Implementation Notes

- Messages are derived, not pushed: `queuePending` scans `round_events` (opened) and `case_events` (every stage but `applied`) for events with no message, so a transition cannot happen without its SMS regardless of which code advanced it. A unique index on `(event_ref, phone)` makes a second run a no-op.
- `applied` deliberately sends nothing: the USSD session already told the parent their case id and place.
- Delivery state is the latest row in `message_attempts`; `pendingMessages` is "no successful attempt yet", so a failure retries and a success never repeats.
- `renderBody` refuses an over-long body or an unfilled placeholder rather than truncating — a parent gets a clean SMS or the build fails.
- Round-opening messages name the budget; a household that waited a closed round without an award gets the "your turn" template instead, with a language-aware plural ("1 round" / "raundi 1").
- `smsDisbursed` and `smsSchoolConfirmed` carry the case's approved amount, since those events hold no amount of their own.
- `recordingSender` is the default everywhere, including `npm run sms`; `africasTalkingSender` takes an injected `fetch`, so no test touches the network, and `--live` without `AT_USERNAME`/`AT_API_KEY` exits with what is missing.
- On the seeded database: 186 messages across six templates (247 before closed-round announcements were removed), longest 144 characters, all GSM-7, all single-SMS. `smsRejected` has no seeded case and is covered by a unit test instead.
- 181 tests (was 148): `test/sms.test.ts` covers every matrix row; `test/sms-sender.test.ts` pins the Africa's Talking request shape, HTTP errors, rejected recipients and credential handling.

## Spec Change Log

- **Post-commit correction.** Triage row 16 was recorded as fixed in `89ecbb5`, but the edit never matched the ticked task line, so the task list still named a nonexistent `src/sms/messages.ts`. Caught while resuming after a rate limit; corrected here.

- **Review round 1 (patch tier).** Two live defects fixed: closed rounds were announced as open, and superseded cases rendered "place 0". GSM-7 went from asserted to enforced (real alphabet, septet counting, typed errors). The `--live` gate moved out of the untested entry point into `chooseSender`. Deferred and recorded rather than built: duplicate-send protection across a crash (needs a provider idempotency key) and STOP/opt-out handling (needs inbound SMS and a suppression column). KEEP: messages derived from the event log, append-only messages and attempts, the recording sender as the default everywhere.

## Review Triage Log

| # | Source | Finding | Verdict | Route | Evidence |
|---|---|---|---|---|---|
| 1 | blind, edge, verif-gap | **Live defect:** 60 of 247 messages announced closed rounds as open, inviting parents to apply into nothing | high | patch | Reproduced in the outbox. Only rounds with no `closed` event are announced now; two tests pin it, including a household registered after a close |
| 2 | blind, edge, verif-gap | **Live defect:** a superseded case produced "place 0" for a real parent | high | patch | `ZM-0071` rendered `nafasi 0`. Superseded cases are skipped; a test asserts no message ever renders place 0 and that every place matches the live queue |
| 3 | blind, edge | GSM-7 was asserted in a test but enforced nowhere; the test was an ASCII check | high | patch | Real GSM 03.38 alphabet and septet counting added: extension characters cost two, non-GSM raises `NonGsmCharacterError` |
| 4 | blind, edge | An empty or statusless provider response was recorded as sent and never retried | high | patch | `accepted no recipient` / `rejected the message` now raise; tested |
| 5 | edge | A non-JSON 200 (captive portal) crashed with a `SyntaxError` | medium | patch | Raises a readable error; tested |
| 6 | blind, verif-gap | `MessageTooLongError` was thrown for unfilled placeholders, reporting a length that was not over the limit | medium | patch | Split into `UnfilledPlaceholderError` and `NonGsmCharacterError` |
| 7 | blind, edge | "Your turn" households never learned the amount or the queue link | medium | patch | Both templates now carry the amount and the site |
| 8 | blind, edge | One unrenderable name aborted the whole queue permanently | high | patch | Per-message isolation: the failure is logged and the rest still go out; tested with a curly-quote name |
| 9 | blind, edge | Retries were unbounded against a live provider | medium | patch | `MAX_ATTEMPTS = 5`, then the message leaves the queue; tested |
| 10 | blind, edge | SELECT-then-INSERT could collide between overlapping runs | medium | patch | `INSERT OR IGNORE`, relying on the unique index the schema comment already claimed |
| 11 | blind, verif-gap | The `--live` gate lived in an untested entry point | high | patch | Extracted `chooseSender(argv, env)`; four assertions cover both directions |
| 12 | edge | A blank `AT_BASE_URL` made every send fail; any host could receive the API key | medium | patch | Blank is ignored; a non-https base URL is refused |
| 13 | blind, edge | `run.ts` left the database open on failure and printed unrelated messages | medium | patch | `try/finally`, exit code, and only this run's messages |
| 14 | verif-gap | The language test passed even when every message was rendered in English | high | patch | Bodies are now asserted per language |
| 15 | verif-gap | Stage-message content was never compared to its own case | high | patch | Place, child and school are checked against the ranking |
| 16 | blind, edge, verif-gap | Task list claimed `src/sms/messages.ts` and `renderMessage`, which do not exist | medium | patch | Task text corrected to `src/i18n/strings.ts` and `renderBody`. *(The first attempt at this correction did not apply — the line had already become `- [x]` — and was fixed after the commit; see Spec Change Log.)* |
| 17 | blind | Two tests could not fail (credential scan, either-language rejection) | medium | patch | Replaced with assertions that can |
| 18 | edge, verif-gap | Test teardown removed the temp directory before closing the database | low | patch | Order fixed |
| 19 | blind | Retry duplicates a real SMS if the process dies between provider call and write | medium | defer | Needs a provider idempotency key or an in-flight row; recorded as a known limitation |
| 20 | blind | No opt-out (STOP) handling or suppression flag | medium | defer | Inbound SMS is out of scope; a suppression column needs a migration path, recorded for the pitch's privacy section |
| 21 | blind | `roundsWaitedByHousehold` runs per household per round event | low | reject | 30 households in the demo; correctness first with the deadline this close |

## Verification

**Commands:**
- `npm run typecheck` -- expected: no errors
- `npm test` -- expected: all suites pass
- `npm run seed && npm run sms` -- expected: prints the queued outbox, exits 0
