# Zamu

**Public money made visible, so bursaries are a right, not a favour.**

*Zamu* is Swahili for *turn*. Everything here is allocated in turn, and nobody can jump the queue unseen.

Built for the OSF × Andela hackathon, **Information You Can Trust** — track: *Transparency & Accountability*.

---

## The problem

Kenyan school bursaries come from three places at once — the MCA's ward fund, the MP's NG-CDF, and the county. A parent applies to all three blind, hears about distributions by word of mouth, and queues at the chief's camp from 3 a.m. Results appear as a list pinned to an office wall. Families with a connection inside the office are served first.

The Auditor-General keeps finding the same thing: Lang'ata, KES 52.9M in bursaries with *"no clear criteria"* and no acknowledgement letters from schools; Sirisia, KES 35.6M unverifiable; seven counties unable to account for over KES 880M in one year.¹

Two causes sit underneath it. **Opacity pays**: an official who hands out public money as a personal gift collects the loyalty. **Money is short**: too little for too many, so an informal rotation forms, and even honest parents look for a favour to stay on the list.

Zamu cannot make the pot bigger. It makes the allocation **visible, checkable and predictable** — which is what makes a favour worthless.

## How it works

| | |
|---|---|
| **A need score** | Four inputs a volunteer can see — fee balance, house type, livestock, land — scored by one published rule ([scoring model](_bmad-output/specs/spec-zamu/scoring-model.md)). No officer discretion exists in the code. A parent sees their own points for each input; the public sees the score. |
| **A public queue** | Position, score, waiting bonus and award, published per round. Names are masked; a neighbour recognises a household, a stranger cannot compile a list of poor families. |
| **Waiting counts** | Ten points for every closed round a child applied in without an award, so a parent knows when their turn comes. A rejected application earns nothing. |
| **Records that cannot be altered** | Cases, evidence, rounds and every state change are append-only, enforced by the database. A correction creates a **new linked case**; the original stays readable. |
| **A basic phone is enough** | Apply over USSD in three key presses, in Swahili or English, after a consent screen. No literacy assumption beyond a numbered menu. |
| **Each step has one owner** | A volunteer or teacher verifies, the committee rejects (with a reason the parent receives) and awards, the clerk pays, and only the child's own school confirms receipt. Roles are looked up in the staff register, never taken from the caller, and the same map is enforced by the database itself. |
| **The system speaks first** | Round openings and every decision on a case — verified, awarded, paid, confirmed, rejected — become SMS derived from the event log, so no decision can be missed: each gets its message the next time dispatch runs. |

## Run it

Requires **Node 24+** (Node 26 recommended — the project uses the built-in SQLite and TypeScript support, so there is no build step).

```bash
npm install
npm run seed     # build the demo database (synthetic data only)
npm run demo     # the whole story in five acts — start here
```

The demo rebuilds its own `data/demo.db` each run. To see the queue it just created, run `ZAMU_DB=data/demo.db npm run web`.

Then, in separate terminals:

```bash
npm run web      # public queue at http://localhost:4000
npm run ussd     # USSD endpoint at http://localhost:4001/ussd
npm run sms      # dispatch pending SMS and print the outbox
npm run admin    # staff dashboard at http://127.0.0.1:4002 (localhost only)
```

The staff dashboard runs a round end to end — create and open it, verify, reject with a reason, award within budget, mark paid, confirm receipt, close it, and queue the SMS — without touching the database. Pick yourself from the staff list at the top; the server looks up your role and refuses anything that role doesn't own, logging the attempt. It only listens on `127.0.0.1` (`ADMIN_PORT` changes the port; it refuses to start on a network address), and every form carries a per-process token, so a page on another site cannot drive it. Queuing writes the messages; sending stays a separate `npm run sms`.

If the dashboard shows no staff, the database predates the staff register: run `npm run seed` again.

Drive the USSD endpoint the way Africa's Talking will. Each request carries the whole keypress history in `text`; this household has a child with evidence on file who has not applied yet:

```bash
curl -s -X POST http://localhost:4001/ussd -d 'phoneNumber=%2B254700000006&text='       # menu
curl -s -X POST http://localhost:4001/ussd -d 'phoneNumber=%2B254700000006&text=1'      # choose a child
curl -s -X POST http://localhost:4001/ussd -d 'phoneNumber=%2B254700000006&text=1*2'    # consent screen
curl -s -X POST http://localhost:4001/ussd -d 'phoneNumber=%2B254700000006&text=1*2*1'  # apply
```

To use the Africa's Talking simulator instead, expose port 4001 with a tunnel (ngrok or similar) and set the callback URL in your sandbox USSD channel to `https://<tunnel>/ussd`.

`npm test` runs the whole suite; `npm run typecheck` is clean.

**Sending real SMS is opt-in.** The default sender records messages and nothing leaves the machine. `npm run sms -- --live` needs `AT_USERNAME` and `AT_API_KEY` in the environment, and refuses to start without them; it sends through the Africa's Talking **sandbox** unless `AT_BASE_URL` says otherwise. Do not point it at the production API with the demo data (see *Data* below). No credentials are in this repository.

## Why you can trust what it shows

- **Many independent witnesses, no single point to bribe.** Every parent can check any place in the queue, and each round's budget, awards and recipient count are public. A volunteer or teacher verifies each case and the child's own school confirms the money arrived, each from the staff dashboard. The household evidence itself (photos, GPS) is seeded, because field capture — story 7 — is not built.
- **Records that refuse to change.** Cases, evidence, rounds, stage and round events, verification requests, messages, send attempts and refused actions are append-only. The database refuses `UPDATE`, `DELETE` and `INSERT OR REPLACE` on them for **every connection**, including a plain `sqlite3` session with none of Zamu's settings. Act 5 of the demo opens exactly such a connection and shows the refusals. The role map is enforced there too: a direct `INSERT` cannot record a stage under the wrong role, as someone who is not registered, or past a round's budget. This prevents changes; it does not yet *detect* them (see limitations).
- **Every action is attributed.** Each case, correction, stage change and round event stores who did it and in what role.
- **Consent first.** No application is created until the parent agrees on screen; declining creates nothing. One thing is written earlier: if a parent picks a child with no evidence on file, or their household has no child registered, Zamu records a home-visit request instead of an application. That request holds no information about the child's circumstances.
- **The public page shows numbers, not households.** Photos, GPS, phone numbers, full names and the score breakdown never appear on it; a test scans every public response for them. A parent sees their own breakdown over USSD.

## What is built, and what is not

**Built** (each with a spec, a review by three independent reviewers, and tests):

1. Append-only case store with synthetic demo data
2. Scoring engine, reason text and queue priority
3. Public queue page
4. USSD flow (apply, my place, my score, add a child)
5. SMS notifications derived from the event log
6. Staff dashboard and role-based stage flow

**Not built** — specified, not implemented:

7. Volunteer evidence capture in the field — photos and GPS are seeded today, not captured
8. Round-totals SMS when a round closes
9. Anonymous reporting over USSD, opening an independent review

**Known limitations, recorded rather than hidden:**

- **Identity is the phone number.** Anyone holding a parent's handset can see that household's scores. A real deployment needs a PIN or a network-level identity check.
- **A duplicate SMS is possible** if the process dies between the provider accepting a message and the write recording it. Closing that needs a provider idempotency key.
- **No opt-out yet.** Inbound SMS is out of scope, so there is no STOP handling or suppression flag.
- **Append-only is prevention, not detection.** Someone who can change the database *schema* (drop a trigger, use `PRAGMA writable_schema`) could still remove the protections. A hash chain over events would make that detectable, and is the natural next step.
- **The registry is editable by design.** Schools, households, children and staff change in real life (a phone number, a school transfer, a new clerk), so those tables are not append-only yet — which means a phone, a child's school or a staff member's role can be changed without a trail, and a child's school decides which bursar may confirm their fees. A history table for the registry is the fix.
- **Passed-over applicants hear nothing.** A case explicitly rejected gets an SMS; one simply not reached before a round closes does not. That message belongs with the round-totals SMS (story 8).
- **Erasure and rectification** (Kenya's Data Protection Act 2019) sit awkwardly with immutable records: corrections supersede, they never delete. A production system needs a documented redaction approach.
- **The dashboard trusts who you say you are.** Role rules are enforced on every action and requests must come from the dashboard's own pages, but there is no login: anyone at this machine can pick any name from the staff list. A deployment needs real sign-in before those rules protect against staff themselves.

## Architecture

```
src/
  db/          schema.sql (append-only tables and their guards), connection
  store/       cases.ts — the only write path: lifecycle rules, typed errors, attribution
               registry.ts — schools, households, children
  scoring/     model.ts — the published need score; priority.ts — waiting bonus and queue priority
  queue/       ranking.ts — one ranking rule, used by the page, USSD, SMS and the seed
  web/         read-only public queue (server-rendered, no JavaScript)
  admin/       staff dashboard (localhost only, token-checked forms); every action goes through the store's role rules
  ussd/        stateless Africa's Talking USSD session and server
  sms/         dispatch.ts — derives messages from the event log; senders.ts — recording and live
  i18n/        Swahili and English message tables, shared by USSD and SMS
  seed/        deterministic synthetic data
  demo/        the five-act walkthrough
```

Every state change is a new row in an event table, never an update. Current state is read from the latest event. The public page, USSD and SMS all read from that log through the same ranking function, so they cannot disagree about who is where.

## How this was built

Zamu was planned and implemented with **[BMAD Method](https://bmadcode.com/) skills running inside Claude Code**. The core idea, the problem, and every product decision are the author's; the AI tools did the structuring, the implementation, and the critique.

The full trail is in this repository, under `_bmad-output/`:

- **`brainstorming/`** — the facilitated session that produced the idea: First Principles, Five Whys (which found the root cause: *officials benefit when parents stay uninformed*), and the Disney Method.
- **`specs/spec-zamu/`** — `SPEC.md` with eleven capabilities, the scoring model, the pitch positioning, and `stories.yaml`.
- **`specs/spec-zamu/stories/`** — one spec per story, each carrying its **Review Triage Log**: every finding from three independent reviewers, with a verdict and what was done about it.

That review loop earned its place. It caught an `INSERT OR REPLACE` hole that let evidence be rewritten silently, a uniqueness rule that never applied to existing databases, 60 messages announcing closed rounds as open, and several tests that passed no matter what the code did.

## Scaling beyond one ward

The integrity core is fixed: append-only records, attribution of every action, and deterministic scoring from witnessed evidence. What varies by place is configuration — language, currency, funding cycle, funding bodies, who captures evidence, and the scoring inputs themselves.

The problem is not Kenyan. Opaque allocation of scarce public support is everywhere; only the structures differ.

## Sources

1. Auditor-General findings as reported in the press: [Eastleigh Voice — audit questions MPs' NG-CDF bursary disbursements](https://eastleighvoice.co.ke/national/111674/audit-report-questions-mps-ng-cdf-bursary-disbursements) (Lang'ata, Sirisia, Kapseret, Saku); [Eastleigh Voice — seven counties over Sh880 million in unaccounted bursary funds](https://eastleighvoice.co.ke/national/194497/audit-flags-seven-counties-over-sh880-million-in-unaccounted-bursary-funds); [Daily Nation — audit faults counties on bursary funds](https://nation.africa/kenya/counties/stealing-from-the-needy-audit-faults-counties-on-bursary-funds-alleges-theft-4545612). Funding structure: [NG-CDF Act No. 30 of 2015, as amended](https://ngcdf.go.ke/wp-content/uploads/2023/10/new-NGCDF-Act-As-Amended-in-2022-2023.pdf) (s.4 financing, s.48 bursary cap).

## Licence

MIT — see [LICENSE](LICENSE).

## Data

Everything in this repository is synthetic: invented names, invented schools, and phone numbers drawn from one narrow range (`+254700000001`–`+254700000999`). Kenya reserves no fictional range, so those numbers could belong to real subscribers — which is why sending is off by default and only ever goes through the Africa's Talking sandbox.
