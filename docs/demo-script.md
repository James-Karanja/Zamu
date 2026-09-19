# Recording the demo

Target: **3–4 minutes**. Everything below is real output from `npm run demo`; nothing is staged, and `test/demo.test.ts` fails if any quote marked **Point at** stops appearing in it.

**Before you record**

```bash
npm install
npm run demo -- --step               # must end "All acts held." — --step pauses between acts
ZAMU_DB=data/demo.db npm run web     # second terminal: the same database the demo just built
```

The demo rebuilds `data/demo.db` every run and never touches `data/zamu.db`, so a second take is just running it again.

Have two windows side by side: the terminal, and a browser on `http://localhost:4000/round/R-2026-T2`, set to phone width. The page is built for a cheap phone, and it shows.

**The two places a judge should look:** Act 3, where the parent's private screen and the public queue show the **same place** — the queue is the product. And Act 5, where a direct database edit is **refused** and the correction leaves both versions readable — that's why the queue can be trusted.

---

## Open (20s) — the problem, not the product

> "In much of Kenya, a parent hears about a bursary by word of mouth. They fill forms for the MCA, the MP and the governor, hoping one lands, and queue at the chief's camp from 3 a.m. Weeks later a list appears on a wall. The Auditor-General keeps finding the same thing: in Lang'ata, 52.9 million shillings handed out with — their words — no clear criteria, and no letters from schools confirming the money arrived.
>
> The money is public. The queue is not. That is what Zamu changes."

## Act 1 (25s) — the system speaks first

> "Nobody dialled anyone. The round opened, and Zamu told this household: it's open, this much is available, and it's your turn — you waited a round with no award. In the language they registered with."

**Point at:** `ni zamu yako` and `KES 180,000`.

## Act 2 (40s) — they apply on a basic phone

> "A feature phone. No internet. Menu, child, consent, done — three key presses. They're told their case number and their place in the queue.
>
> Consent comes before any application exists. Decline, and nothing is created."

**Point at:** `1. Nakubali 2. Hapana`, then `Nafasi 19 kati ya 39`.

## Act 3 (40s) — the part that kills the favour

Switch to the browser. Their row is on the page.

> "On their phone, privately, they see their score and what earned it: fee balance, house, livestock, land, point by point.
>
> On the public page, the whole ward sees the same queue — place 19, need 53, plus 10 for the round they waited. Their name is masked. A neighbour recognises the household; a stranger cannot compile a list of poor families.
>
> This is the part that matters. If a family that owns twenty cows sits above one in a mud house, everybody can see it — and the published rule says exactly why it shouldn't."

**Point at:** `kusubiri 10` on the phone and `waiting +10` on the queue row. Then, in the browser, open the closed round *2026 Term 1*, where every award is listed.

## Act 4 (30s) — every decision reaches them

> "First, the parent tries to verify their own case — and is refused. Each step belongs to one role: a volunteer verifies, the committee awards, the clerk pays, and only the child's own school can confirm the money arrived. Nobody who pays also vouches for need.
>
> Then: verified, awarded twelve thousand, paid to the school — not to the family — and the school confirms it. The last message closes the loop that audits keep finding open."

**Point at:** `only a community health volunteer or teacher may do this`, then `Pesa huenda shuleni, si kwako` (the money goes to the school, not to you).

*Optional, if you have 20 seconds:* run `ZAMU_DB=data/demo.db npm run admin` and show the staff dashboard at `http://127.0.0.1:4002` — pick yourself from the staff list, and try an action your role doesn't own to show the refusal banner.

## Act 5 (45s) — the strongest moment

> "Now the honest test. Someone with the database file opens it directly — no Zamu code in the way — and tries to change what a household owns."

Let the three refusals land before speaking.

> "Update, replace, delete: all refused, on a plain connection. Records here are append-only.
>
> The honest route is a correction. The original stays, the new version links to it, and both are readable for good. In Zamu, the record of someone hiding seven cattle is itself permanent."

**Point at:** `immutable record`, then the two rows marked `(original)` and `CHV re-visit found 7 cattle`.

## Close (25s) — scale and honesty

> "The same core works anywhere: append-only records, attributed actions, one published rule. Language, currency, funding cycle and the scoring inputs are configuration.
>
> What isn't built is written down in the README: volunteer evidence capture in the field, round-totals SMS, anonymous reporting. So are the limits — identity is just the phone number today, and someone who can change the database's schema could still remove its protections. A hash chain over events is the next step that would make even that detectable.
>
> Zamu can't make the bursary pot bigger. It makes waiting fair, and it makes jumping the queue impossible to hide."

---

## If something goes wrong

- **The demo fails a check:** it stops, prints `ACT n FAILED` with the claim that did not hold, and exits non-zero. Don't record until it's green.
- **The dashboard doesn't start:** it needs a database too — `ZAMU_DB=data/demo.db npm run admin` shows the demo's round.
- **The browser doesn't show their case:** the web server is reading a different database. Restart it with `ZAMU_DB=data/demo.db npm run web` after running the demo.
- **`npm run web` won't start:** it refuses to run without a database. Run the demo (or `npm run seed`) first.

## Worth saying if you have time

- Three independent AI reviewers checked every story. They caught a way to rewrite evidence through a plain database connection, and 60 SMS announcing closed rounds as open. Every finding and its verdict is in `_bmad-output/specs/spec-zamu/stories/`.
- One test scans every public response for phone numbers, names, photos, GPS and evidence values, so a privacy leak fails the build.
