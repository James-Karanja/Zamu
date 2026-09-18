// The recorded demo, in five acts. Every line comes from the same modules the servers use:
// nothing here is staged for the camera. It rebuilds data/demo.db each run — never data/zamu.db —
// so it can be re-run mid-recording, and `ZAMU_DB=data/demo.db npm run web` shows the same queue.
//
// Pass --step to pause between acts while recording.
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../db/connection.ts';
import { publicQueue, rankRound } from '../queue/ranking.ts';
import { MAX_SCORE, reasonText, scoreNeed } from '../scoring/model.ts';
import { roundsWaited } from '../scoring/priority.ts';
import { OPEN_ROUND_SKIPPED, seedDatabase } from '../seed/data.ts';
import { USSD_CODE, dispatch, listMessages } from '../sms/dispatch.ts';
import { recordingSender } from '../sms/senders.ts';
import { correctCase, getCase, getCaseHistory, listCurrentCases, recordAward, recordStage } from '../store/cases.ts';
import { MAX_SCREEN, renderReply, respond } from '../ussd/session.ts';

const ROOT = resolve(import.meta.dirname, '../..');
/** Relative on screen, so the recording shows the same text on every machine and every run. */
export const DEMO_DB = 'data/demo.db';
const OPEN_ROUND = 'R-2026-T2';

const CLERK = { id: 'CLERK-01', role: 'clerk' as const };
const CHV = { id: 'CHV-02', role: 'chv' as const };
const COMMITTEE = { id: 'BC-01', role: 'committee' as const };

class DemoFailure extends Error {}

let currentAct = 0;

function act(number: number, title: string): void {
  currentAct = number;
  console.log(`\n${'─'.repeat(72)}\nACT ${number}  ${title}\n${'─'.repeat(72)}`);
}

/** Prints the claim with its result; the first claim that does not hold stops the demo. */
function check(claim: string, holds: boolean): void {
  console.log(`  ${holds ? '✓' : '✗'} ${claim}`);
  if (!holds) throw new DemoFailure(claim);
}

/** A value the demo cannot continue without: missing means a named failure, not a stack trace. */
function need<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new DemoFailure(`missing: ${what}`);
  return value;
}

async function pause(step: boolean): Promise<void> {
  if (!step || !process.stdin.isTTY) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('\n  [Enter for the next act] ');
  rl.close();
}

const step = process.argv.includes('--step');
const dbPath = join(ROOT, DEMO_DB);
mkdirSync(dirname(dbPath), { recursive: true });

let db: DatabaseSync | undefined;
try {
  seedDatabase(dbPath);
  db = openDatabase(dbPath);
  const store = db;

  // The parent the story follows: a child left out of the open round who waited without an award,
  // so "it is your turn" is true, and the queue shows the same wait.
  const demoChild = need(
    OPEN_ROUND_SKIPPED.map((i) => `CH-${String(i + 1).padStart(3, '0')}`).find((id) => roundsWaited(store, id, OPEN_ROUND) > 0),
    'a child who waited a round without an award',
  );
  const household = need(
    store
      .prepare(
        `SELECT c.name AS child, c.school_id AS school, h.phone AS phone, h.language AS language
         FROM children c JOIN households h ON h.id = c.household_id WHERE c.id = ?`,
      )
      .get(demoChild) as { child: string; school: string; phone: string; language: 'sw' | 'en' } | undefined,
    `household of ${demoChild}`,
  );

  console.log(`\nZAMU — public money made visible, so bursaries are a right, not a favour.`);
  console.log(`Demo database: ${DEMO_DB} (rebuilt each run, synthetic data only)`);
  console.log(`Following one household: ${household.phone}, applying for ${household.child}.`);

  // ── Act 1 ──────────────────────────────────────────────────────────────────
  act(1, 'The system speaks first: an SMS says it is their turn');
  await dispatch(store, recordingSender());
  const opening = need(
    listMessages(store, household.phone).find((m) => m.roundId === OPEN_ROUND && m.template === 'smsYourTurn'),
    'a "your turn" SMS for the household',
  );
  console.log(`\n  SMS to ${opening.phone} [${opening.language}]:\n  "${opening.body}"\n`);
  check('the parent is told, without dialling anyone, that it is their turn', true);
  check('the message names the money available', /KES \d/.test(opening.body));
  check(
    'it is in the language the household registered with',
    opening.language === household.language &&
      (household.language === 'sw' ? /ni zamu yako/.test(opening.body) : /your turn/.test(opening.body)),
  );
  await pause(step);

  // ── Act 2 ──────────────────────────────────────────────────────────────────
  act(2, 'They apply on a basic phone: three key presses, no paperwork');
  const siblings = store
    .prepare('SELECT c.id AS id FROM children c JOIN households h ON h.id = c.household_id WHERE h.phone = ? ORDER BY c.id')
    .all(household.phone) as unknown as { id: string }[];
  const childIndex = siblings.findIndex((c) => c.id === demoChild);
  check('the child is on the household’s menu', childIndex >= 0);
  const presses = ['1', String(childIndex + 1), '1'];

  let confirmation = '';
  for (let i = 0; i <= presses.length; i++) {
    const text = presses.slice(0, i).join('*');
    const reply = respond(store, { phoneNumber: household.phone, text });
    console.log(`\n  ${i === 0 ? `dials ${USSD_CODE}` : `presses ${presses[i - 1]}`}\n  ${renderReply(reply).split('\n').join('\n  ')}`);
    // Measured before any trimming: a screen that needed cutting would lose its options.
    check('the whole screen fits one USSD page', `${reply.type} ${reply.text}`.length <= MAX_SCREEN);
    confirmation = reply.text;
  }
  const applied = need(listCurrentCases(store, OPEN_ROUND).find((c) => c.childId === demoChild), 'the new application');
  check('an application now exists for the child', true);
  check('it was made by the parent, not an official', applied.actorRole === 'parent');
  await pause(step);

  // ── Act 3 ──────────────────────────────────────────────────────────────────
  act(3, 'They see their score and place — and so do their neighbours');
  const caseId = applied.id;
  const score = scoreNeed(getCase(store, caseId).evidence);
  const index = String(childIndex + 1);
  const scoreScreen = respond(store, { phoneNumber: household.phone, text: `3*${index}` });
  const placeScreen = respond(store, { phoneNumber: household.phone, text: `2*${index}` });
  console.log(`\n  On their phone — private to this household:`);
  console.log(`  ${renderReply(scoreScreen)}`);
  console.log(`  ${renderReply(placeScreen)}`);
  console.log(`  (the rule applied to their evidence: ${reasonText(score)})`);

  const row = need(publicQueue(store, OPEN_ROUND).find((e) => e.caseId === caseId), 'their row on the public queue');
  console.log(`\n  On the public queue — anyone can see this row (\`ZAMU_DB=${DEMO_DB} npm run web\`):`);
  console.log(`  #${row.position}  ${row.maskedName}  ${row.caseId}  ${row.school}  need ${row.need}  waiting +${row.waitingBonus}  priority ${row.priority}`);

  const ussdPlace = Number(/(?:place|nafasi) (\d+)/i.exec(placeScreen.text)?.[1]);
  const appliedPlace = Number(/(?:Place|Nafasi) (\d+)/.exec(confirmation)?.[1]);
  check('the parent sees their own score out of the published maximum', scoreScreen.text.includes(`${score.total}/${MAX_SCORE}`));
  check('the place on their phone is the place the public sees', ussdPlace === row.position && appliedPlace === row.position);
  check('the queue shows the same wait the SMS promised', row.waitingBonus > 0);
  const published = JSON.stringify(row);
  check(
    'the public row carries no name, phone or household evidence',
    !published.includes(household.child) && !published.includes(household.phone) && !/cattle|house|fee|acre/i.test(published),
  );
  await pause(step);

  // ── Act 4 ──────────────────────────────────────────────────────────────────
  act(4, 'Every decision reaches them, ending with the school confirming the money');
  console.log(`\n  (Simulated: this script records the volunteer, committee, clerk and school steps.`);
  console.log(`   Their own screens are stories 6 and 7, which are not built.)`);
  recordStage(store, caseId, 'verified', CHV);
  recordAward(store, caseId, 12_000, COMMITTEE);
  recordStage(store, caseId, 'disbursed', CLERK);
  recordStage(store, caseId, 'school_confirmed', { id: household.school, role: 'school' });
  await dispatch(store, recordingSender());

  const journey = listMessages(store, household.phone).filter((m) => m.caseId === caseId);
  for (const message of journey) console.log(`\n  [${message.template}] "${message.body}"`);
  const expected = ['smsVerified', 'smsAwarded', 'smsDisbursed', 'smsSchoolConfirmed'];
  check('they were told at every step, in order', JSON.stringify(journey.map((m) => m.template)) === JSON.stringify(expected));
  check('the money went to the school, not to them', journey.some((m) => /paid to|zimelipwa/.test(m.body)));
  check(
    'the school that confirmed is the child’s own',
    getCase(store, caseId).events.at(-1)?.actorId === household.school,
  );
  await pause(step);

  // ── Act 5 ──────────────────────────────────────────────────────────────────
  act(5, 'Someone tries to change the record');
  const target = need(
    listCurrentCases(store, OPEN_ROUND).find((c) => c.currentStage === 'applied' && c.childId !== demoChild && c.supersedesCaseId === null),
    'an original application to tamper with',
  );
  const before = getCase(store, target.id);
  console.log(`\n  ${target.id} records ${before.evidence.cattle} cattle.`);

  // The way a clerk with the file would try it: a plain connection, none of Zamu's settings.
  const clerk = new DatabaseSync(dbPath);
  const attempts: [string, () => void][] = [
    ['UPDATE evidence SET cattle = 0 ...', () => clerk.prepare('UPDATE evidence SET cattle = 0 WHERE case_id = ?').run(target.id)],
    ['INSERT OR REPLACE INTO evidence ...', () => clerk.prepare(
      `INSERT OR REPLACE INTO evidence (case_id, fee_balance, house_type, cattle, has_goats_or_poultry, land_acres, has_title,
         photo_ref, lat, lng, captured_by, captured_by_role, captured_at)
       SELECT case_id, fee_balance, house_type, 0, has_goats_or_poultry, land_acres, has_title,
         photo_ref, lat, lng, captured_by, captured_by_role, captured_at FROM evidence WHERE case_id = ?`,
    ).run(target.id)],
    ['DELETE FROM cases ...', () => clerk.prepare('DELETE FROM cases WHERE id = ?').run(target.id)],
  ];
  try {
    for (const [statement, attempt] of attempts) {
      let answer = 'NO ERROR — the record was altered';
      try {
        attempt();
      } catch (err) {
        answer = err instanceof Error ? err.message : String(err);
      }
      console.log(`  A clerk runs:           ${statement}`);
      console.log(`  The database answers:   ${answer}`);
      check('refused, on a plain connection with no Zamu settings', answer.includes('immutable record'));
    }
  } finally {
    clerk.close();
  }
  check('the stored evidence is unchanged', getCase(store, target.id).evidence.cattle === before.evidence.cattle);

  const corrected = correctCase(store, target.id, {
    evidence: {
      ...before.evidence,
      cattle: 7,
      capturedBy: CHV.id,
      capturedByRole: 'chv',
      capturedAt: new Date().toISOString(),
      photoRef: `evidence/${target.id}-revisit.jpg`,
    },
    reason: 'CHV re-visit found 7 cattle moved to a neighbour during the first visit',
    actor: CHV,
  });
  const history = getCaseHistory(store, corrected);
  console.log(`\n  The honest route — a correction — leaves both versions standing:`);
  for (const entry of history) {
    console.log(`    ${entry.id}  ${entry.evidence.cattle} cattle  by ${entry.actorId}  ${entry.correctionReason ?? '(original)'}`);
  }
  const ranked = rankRound(store, OPEN_ROUND).map((e) => e.caseId);
  check('the correction is a new case, linked to the original', history.length === 2 && history[1].supersedesCaseId === history[0].id);
  check('the original is still readable', history[0].evidence.cattle === before.evidence.cattle);
  check('the queue now holds the correction and not the original', ranked.includes(corrected) && !ranked.includes(history[0].id));

  console.log(`\n${'─'.repeat(72)}\nAll acts held. This is the recording.\n${'─'.repeat(72)}\n`);
} catch (err) {
  const reason = err instanceof Error ? err.message : String(err);
  console.log(`\n${'─'.repeat(72)}\nACT ${currentAct} FAILED: ${reason}\nFix this before recording.\n${'─'.repeat(72)}\n`);
  process.exitCode = 1;
} finally {
  db?.close();
}
