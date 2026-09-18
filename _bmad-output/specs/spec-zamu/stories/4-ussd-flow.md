---
title: 'USSD flow'
type: 'feature'
created: '2026-09-18'
status: 'done'
route: 'dispatch'
review_loop_iteration: 1
baseline_commit: '7490800'
context:
  - '{project-root}/_bmad-output/specs/spec-zamu/SPEC.md'
  - '{project-root}/_bmad-output/specs/spec-zamu/scoring-model.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Everything Zamu knows is currently reachable only from a browser, while the parents it exists for queue at a chief's camp from 3 a.m. with a feature phone and no internet (SPEC CAP-2, CAP-4). Without a USSD channel there is no way to apply without paperwork, and no way to see your own place or the reason behind your score.

**Approach:** A stateless USSD endpoint in Africa's Talking's format, driven entirely by numbered menus — no free-text entry, no literacy assumption beyond reading a short menu. The phone number identifies the household; consent is taken before any application is created; the parent's own score breakdown is available here and nowhere public.

## Boundaries & Constraints

**Always:**
- Africa's Talking contract: `POST` form body of `sessionId`, `serviceCode`, `phoneNumber`, `text`; reply `text/plain` beginning `CON ` to continue or `END ` to finish. Session state is derived from the accumulated `text`, never stored.
- Every screen is at most 182 characters, including the `CON `/`END ` prefix.
- Menus and messages in the household's stored language, Swahili or English, from one shared strings module.
- Parental consent screen before an application is created; declining creates nothing at all.
- Applying takes at most three inputs after the menu appears, and no free text.
- The parent's own score breakdown is available only here, keyed to their phone number; a household can only ever see its own children.
- A child not on file produces an append-only verification request, and the session tells the parent what to bring and where — it never creates an unverified application.
- Writes go through the story-1 store: no new stage rules, no direct SQL for case changes.

**Never:**
- No SMS (story 5), no admin actions (story 6), no anonymous reporting (story 9).
- No new scoring rules, no session table, no cookies, no authentication beyond the caller's phone number.
- No PIN or identity check beyond the number: the demo's threat model is visibility, not impersonation. Recorded as a known limitation.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First screen | known household, open round | `CON` menu: apply, my place, my score, add a child | N/A |
| Unknown number | phone not registered | `END` with where to register | no case, no crash |
| Apply, one child | `1` → child → `1` (agree) | case created; `END` with case id and queue place | N/A |
| Consent declined | `2` at the consent screen | `END` "nothing was sent"; no case exists | N/A |
| Already applied | child already has a case this round | `END` telling them, with the case id and place | `DuplicateApplicationError` never surfaces raw |
| No open round | all rounds closed | `END` explaining when to check back | N/A |
| My place | `2` | `END` position, need, waiting bonus, priority | N/A |
| My score | `3` | `END` per-input breakdown and total, parent-only | N/A |
| Add a child | `4` | verification request recorded; `END` with what to bring | N/A |
| Invalid choice | `9` at the menu | `CON` re-prompt, same screen | no crash, no state loss |
| Swahili household | `language = 'sw'` | every screen in Swahili | N/A |
| Screen length | any screen | ≤182 characters | N/A |
| Wrong method | `GET /ussd` | 405 | N/A |

</frozen-after-approval>

## Code Map

- `src/store/cases.ts` -- `createCase`, `listCurrentCases`, `isRoundOpen`, typed errors; the only write path
- `src/queue/ranking.ts` -- `rankRound` for the parent's place; entries carry need, waiting bonus, priority
- `src/scoring/model.ts` -- `scoreNeed`, `reasonText`, `MAX_SCORE` for the breakdown screen
- `src/db/schema.sql` -- add `verification_requests` (append-only, with the same UPDATE/DELETE triggers)
- `src/web/server.ts` -- the shape to follow for a small Node `http` handler; the USSD server is separate because it writes
- `test/helpers.ts` -- `freshDb`, actor constants, `evidence()`

## Tasks & Acceptance

**Execution:**
- [x] `src/db/schema.sql`, `src/store/cases.ts` -- `verification_requests` table (phone, child name, note, actor, at) with append-only triggers, plus `requestVerification`/`listVerificationRequests` -- records the new-child path without inventing an application
- [x] `src/i18n/strings.ts` -- `sw` and `en` message tables with typed keys and simple interpolation -- one source for USSD now and SMS in story 5
- [x] `src/ussd/session.ts` -- pure `respond(db, { phoneNumber, text })` returning `{ type: 'CON' | 'END', text }`; routing, consent, apply, place, score, add-a-child -- testable without HTTP
- [x] `src/ussd/server.ts`, `src/ussd/run.ts` -- Africa's Talking form parsing, `POST /ussd`, 405 elsewhere, `USSD_PORT` (default 4001); `npm run ussd` -- what the sandbox simulator calls
- [x] `test/ussd.test.ts` -- every matrix row as a scripted session, screen-length check on every reply, both languages -- proves CAP-2
- [x] `test/ussd-server.test.ts` -- form parsing, `CON`/`END` wire format, 405, malformed body -- proves the Africa's Talking contract

**Acceptance Criteria:**
- Given a registered household and an open round, when the parent dials and answers apply → child → agree, then a case exists for that child and the reply names its case id and queue position.
- Given the same parent declines consent, when the session ends, then the database holds no new case and no evidence row.
- Given any session in either language, when every reply is measured, then no screen exceeds 182 characters and every reply starts with `CON ` or `END `.
- Given a parent asks for their score, when the reply is read, then it shows each input's points and the total, and that breakdown appears in no public response.

## Implementation Notes

- `src/ussd/session.ts` is pure: `respond(db, { phoneNumber, text })` derives the screen from the accumulated keypresses, so there is no session store. `renderReply` adds the `CON `/`END ` prefix and trims to 182 characters.
- Applying reuses the evidence already on file for that child (the last capture from any round), which is what "records already on file" means in CAP-2. A child with no capture gets a verification request instead, never an unverified application.
- New table `verification_requests` (append-only, same triggers) plus `requestVerification` / `listVerificationRequests` in the store.
- `src/i18n/strings.ts` holds the Swahili and English tables with `{placeholder}` interpolation; story 5 reuses it for SMS.
- Seed change: `OPEN_ROUND_SKIPPED = [34, 35]` leaves two children who applied in earlier rounds out of the open round, so a live demo can apply for them over USSD and watch the queue move. The open round now holds 38 applications.
- `src/ussd/server.ts` parses the Africa's Talking form body, answers `POST /ussd` only (405 + `Allow: POST` elsewhere), caps the body at 8 KB, and always returns a valid `END ` screen rather than an error page.
- Verified live over HTTP: menu → child list → consent → `END Ombi limepokelewa. Kesi ZM-0106 ya Amani Mwangi. Nafasi 17 kati ya 39.`
- 138 tests (was 105): `test/ussd.test.ts` walks every matrix row keypress by keypress, checking the prefix and length of every screen in both languages; `test/ussd-server.test.ts` covers the wire contract, malformed bodies, oversized bodies, wrong methods and a closed database.

## Spec Change Log

- **Seed invariant changed for the demo.** `OPEN_ROUND_SKIPPED = [34, 35]` leaves two children unapplied in the open round so a live USSD application can be demonstrated; story 1 and story 3 tests that asserted "one case per child" were updated to expect 38. KEEP: the skipped children must keep evidence on file from an earlier round, or the USSD apply path cannot run.
- **Review round 1 (patch tier).** Consent wording now matches what the code does (reuses the last capture) and stale evidence triggers a re-visit request; `verification_requests` gained `child_id`, `reason`, an index, de-duplication and the append-only triggers it was missing; `households.phone` is unique.

## Review Triage Log

| # | Source | Finding | Verdict | Route | Evidence |
|---|---|---|---|---|---|
| 1 | blind | A registered household with no children looped forever on an empty child menu | high | patch | Reproduced; now records a verification request and ends with what to bring |
| 2 | blind | The child menu was truncated, so later options vanished while `pick` still accepted them | medium | patch | Names are now shortened to fit; a test with 8 children asserts every option is listed |
| 3 | blind | No `UNIQUE` on `households.phone`, so a second household on one number was invisible | medium | patch | Unique constraint added; the identity model is now enforced |
| 4 | blind | Phone trimmed for lookup but stored raw, orphaning verification requests | medium | patch | Normalised once; a test dials with stray spaces |
| 5 | blind | Verification requests duplicated without limit, had no child link, index or reason | medium | patch | Added `child_id`, `reason`, an index, and de-duplication; resolution documented as belonging in a companion table |
| 6 | *(self, during fix)* | `verification_requests` shipped with **no append-only triggers** — an edit I dropped when adding the table | high | patch | Triggers and index added; the table now matches every other one |
| 7 | blind | Consent promised a home visit the apply path never performed | high | patch | Consent now says "the last home visit"; evidence older than 180 days records a `stale_evidence` re-visit request, tested |
| 8 | blind | "My place" cost ~581 queries per keypress | medium | patch | One `rankRound` pass answers applied/place/score |
| 9 | blind | Score screen re-derived `MAX_SCORE` and scored the newest evidence, not the case's | medium | patch | Imports `MAX_SCORE`; scores the case it ranked |
| 10 | blind | `src/i18n/strings.ts` had no test | medium | patch | `test/i18n.test.ts` checks key parity, placeholder parity and GSM-7 |
| 11 | blind | The unregistered-caller screen was English only | medium | patch | Now bilingual in one screen |
| 12 | blind | Typographic `'` and `…` fall outside GSM-7 | low | patch | Replaced; a test forbids non-ASCII in parent-facing strings |
| 13 | blind | The USSD error handler logged nothing | low | patch | Logs server-side, body still clean |
| 14 | blind | `readBody` concatenated strings and capped on characters | low | patch | Buffers, byte cap, `content-length` check |
| 15 | blind | Unknown paths answered 405 rather than 404 | low | patch | Split; tests updated |
| 16 | blind | `run.ts` files were near-duplicates | low | patch | Shared `src/server-runtime.ts` |
| 17 | blind | Non-null assertions turned a data gap into an outage | low | patch | Optional chaining with sensible fallbacks |
| 18 | blind | Stale test name after the seed changed to 38 applicants | low | patch | Renamed |
| 19 | blind | Empty Spec Change Log despite a cross-story seed change | low | patch | Entry added |
| — | edge-case, verification-gap | **Not run:** both reviewers failed with a session rate limit before reporting | — | — | Story 4 has had one review, not three; re-run after the limit resets |

## Verification

**Commands:**
- `npm run typecheck` -- expected: no errors
- `npm test` -- expected: all suites pass
- `npm run seed && npm run ussd` -- expected: serves USSD on http://localhost:4001/ussd, driveable with curl in the Africa's Talking format
