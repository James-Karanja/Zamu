import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../src/db/connection.ts';
import {
  MAX_ATTEMPTS, MAX_SMS, MessageTooLongError, NonGsmCharacterError, UnfilledPlaceholderError,
  dispatch, listMessages, nonGsmCharacters, pendingMessages, queuePending, renderBody, sendQueued, septetLength,
} from '../src/sms/dispatch.ts';
import { recordingSender } from '../src/sms/senders.ts';
import { closeRound, createCase, listCurrentCases, recordAward, recordStage } from '../src/store/cases.ts';
import { seedDatabase } from '../src/seed/data.ts';
import { rankRound } from '../src/queue/ranking.ts';
import { CHV, CLERK, COMMITTEE, PARENT, evidence, freshDb } from './helpers.ts';

const OPEN_ROUND = 'R-2026-T2';

function seeded(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'zamu-sms-'));
  const path = join(dir, 'zamu.db');
  seedDatabase(path);
  const db = openDatabase(path);
  // Close the database before the directory goes, as test/helpers.ts does.
  t.after(() => db.close());
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return db;
}

const openRounds = (db: ReturnType<typeof seeded>) =>
  (db
    .prepare(
      `SELECT r.id AS id FROM rounds r WHERE EXISTS (SELECT 1 FROM round_events o WHERE o.round_id = r.id AND o.type = 'opened')
         AND NOT EXISTS (SELECT 1 FROM round_events c WHERE c.round_id = r.id AND c.type = 'closed')`,
    )
    .all() as unknown as { id: string }[]).map((row) => row.id);

const attempts = (db: ReturnType<typeof seeded>) =>
  (db.prepare('SELECT outcome, COUNT(*) AS n FROM message_attempts GROUP BY outcome').all() as unknown as
    { outcome: string; n: number }[]).map((row) => ({ outcome: row.outcome, n: row.n }));

test('opening a round messages every household with a child, naming the money', async (t) => {
  const db = seeded(t);
  await dispatch(db, recordingSender());
  const households = db.prepare('SELECT COUNT(DISTINCT household_id) AS n FROM children').get() as { n: number };
  const openings = listMessages(db).filter((m) => ['smsWindowOpen', 'smsYourTurn'].includes(m.template));
  assert.equal(openings.length, households.n, 'one opening message per household, not one per round');
  assert.ok(openings.every((m) => m.body.includes('KES 180,000')), 'every household must learn the amount available');
});

test('a closed round is never announced as open', async (t) => {
  const db = seeded(t);
  await dispatch(db, recordingSender());
  const open = openRounds(db);
  assert.deepEqual(open, [OPEN_ROUND]);
  const openings = listMessages(db).filter((m) => ['smsWindowOpen', 'smsYourTurn'].includes(m.template));
  assert.ok(openings.length > 0);
  for (const message of openings) {
    assert.ok(open.includes(message.roundId!), `${message.roundId} is closed but was announced: ${message.body}`);
  }
});

test('a household registered after a round closes is not invited to it', async (t) => {
  const db = seeded(t);
  await dispatch(db, recordingSender());
  closeRound(db, OPEN_ROUND, CLERK);
  db.prepare("INSERT INTO households (id, guardian_name, phone, language) VALUES ('HH-LATE', 'Late', '+254700000905', 'en')").run();
  db.prepare("INSERT INTO children (id, household_id, school_id, name, admission_no) VALUES ('CH-LATE', 'HH-LATE', 'SCH-1', 'Late Child', 'ADM-LATE')").run();
  const report = await dispatch(db, recordingSender());
  assert.equal(report.queued, 0);
  assert.equal(listMessages(db, '+254700000905').length, 0);
});

test('a superseded case sends no message about a place it no longer holds', async (t) => {
  const db = seeded(t);
  await dispatch(db, recordingSender());
  const messages = listMessages(db);
  for (const message of messages) assert.doesNotMatch(message.body, /place 0|nafasi 0/, message.body);

  const superseded = db
    .prepare('SELECT c.id AS id FROM cases c WHERE EXISTS (SELECT 1 FROM cases s WHERE s.supersedes_case_id = c.id)')
    .all() as unknown as { id: string }[];
  assert.ok(superseded.length > 0, 'the seed must contain a correction for this to mean anything');
  for (const { id } of superseded) assert.ok(!messages.some((m) => m.caseId === id), `${id} is superseded`);
});

test('the place in a message is the place the queue actually shows', async (t) => {
  const db = seeded(t);
  await dispatch(db, recordingSender());
  const verified = listMessages(db).filter((m) => m.template === 'smsVerified');
  assert.ok(verified.length > 0);
  for (const message of verified) {
    const place = Number(/(?:place|nafasi) (\d+)/.exec(message.body)![1]);
    const entry = rankRound(db, message.roundId!).find((e) => e.caseId === message.caseId);
    assert.equal(place, entry?.position, `${message.caseId}: ${message.body}`);
  }
});

test('a household that waited without an award is told it is their turn', async (t) => {
  const db = seeded(t);
  await dispatch(db, recordingSender());
  const turns = listMessages(db).filter((m) => m.template === 'smsYourTurn');
  assert.ok(turns.length > 0);
  for (const message of turns) assert.match(message.body, /your turn|zamu yako|ni zamu yako/i);
});

test('every stage change produces exactly one message for that household', async (t) => {
  const db = seeded(t);
  await dispatch(db, recordingSender());
  // Superseded cases are deliberately silent: their place no longer exists.
  const events = db
    .prepare(
      `SELECT COUNT(*) AS n FROM case_events e
       JOIN cases c ON c.id = e.case_id
       WHERE e.stage <> 'applied' AND NOT EXISTS (SELECT 1 FROM cases s WHERE s.supersedes_case_id = c.id)`,
    )
    .get() as { n: number };
  const stageMessages = listMessages(db).filter((m) => m.caseId !== null);
  assert.equal(stageMessages.length, events.n);
  assert.equal(new Set(stageMessages.map((m) => m.eventRef)).size, stageMessages.length, 'one message per event');
});

test('award, payment and confirmation each name the amount and the school', async (t) => {
  const db = seeded(t);
  await dispatch(db, recordingSender());
  const messages = listMessages(db);
  for (const template of ['smsAwarded', 'smsDisbursed', 'smsSchoolConfirmed'] as const) {
    const message = messages.find((m) => m.template === template)!;
    assert.ok(message, `${template} missing`);
    assert.match(message.body, /KES [1-9]/, `${template} must name a real amount: ${message.body}`);
  }
  assert.match(messages.find((m) => m.template === 'smsDisbursed')!.body, /School/);
});

test('a rejected case is told, and keeps its place for the next round', async (t) => {
  const db = freshDb(t);
  const caseId = createCase(db, { roundId: 'R-T', childId: 'CH-A', evidence: evidence(), actor: PARENT });
  recordStage(db, caseId, 'rejected', CLERK, undefined, 'evidence did not match');
  await dispatch(db, recordingSender());
  const message = listMessages(db).find((m) => m.template === 'smsRejected')!;
  assert.ok(message);
  // The test household's language is Swahili, so assert the message in either language.
  assert.match(message.body, /not selected|hakuchaguliwa/i);
  assert.match(message.body, /apply again|kuomba tena/i);
});

test('dispatching twice queues nothing and sends nothing the second time', async (t) => {
  const db = seeded(t);
  const first = await dispatch(db, recordingSender());
  assert.ok(first.queued > 0 && first.sent === first.queued);

  const sender = recordingSender();
  const second = await dispatch(db, sender);
  assert.deepEqual(second, { queued: 0, sent: 0, failed: 0 });
  assert.equal(sender.sent.length, 0);
  assert.equal(listMessages(db).length, first.queued);
});

test('a new stage change after dispatch queues only its own message', async (t) => {
  const db = seeded(t);
  await dispatch(db, recordingSender());
  const before = listMessages(db).length;

  const target = listCurrentCases(db, OPEN_ROUND).find((c) => c.currentStage === 'applied')!;
  recordStage(db, target.id, 'verified', CHV);
  const sender = recordingSender();
  const report = await dispatch(db, sender);

  assert.deepEqual(report, { queued: 1, sent: 1, failed: 0 });
  assert.equal(listMessages(db).length, before + 1);
  assert.equal(sender.sent[0].caseId, target.id);
});

test('a failed send is recorded and retried, and never sent twice', async (t) => {
  const db = freshDb(t);
  const caseId = createCase(db, { roundId: 'R-T', childId: 'CH-A', evidence: evidence(), actor: PARENT });
  recordStage(db, caseId, 'verified', CHV);
  queuePending(db);
  const queued = pendingMessages(db).length;
  assert.ok(queued > 0);

  const failing = { name: 'failing', async send() { throw new Error('network down'); } };
  const failedRun = await sendQueued(db, failing);
  assert.equal(failedRun.failed, queued);
  assert.equal(pendingMessages(db).length, queued, 'a failed message stays pending');
  assert.deepEqual(attempts(db), [{ outcome: 'failed', n: queued }]);

  const sender = recordingSender();
  await sendQueued(db, sender);
  assert.equal(sender.sent.length, queued);
  assert.equal(pendingMessages(db).length, 0);

  const again = recordingSender();
  await sendQueued(db, again);
  assert.equal(again.sent.length, 0, 'a sent message is never sent again');
});

test('the household language decides the message', async (t) => {
  const db = seeded(t);
  await dispatch(db, recordingSender());
  const messages = listMessages(db);
  for (const message of messages) {
    const row = db.prepare('SELECT language FROM households WHERE phone = ?').get(message.phone) as { language: string };
    assert.equal(message.language, row.language);
  }
  // Assert the body itself, not just the stored column: rendering every message in one
  // language would otherwise pass.
  const swahili = messages.filter((m) => m.language === 'sw');
  const english = messages.filter((m) => m.language === 'en');
  assert.ok(swahili.length > 0 && english.length > 0);
  for (const message of swahili) assert.match(message.body, /imefunguliwa|amethibitishwa|amepewa|zimelipwa|imethibitisha|hakuchaguliwa/);
  for (const message of english) assert.match(message.body, /is open|is verified|is awarded|has been paid|confirms it received|was not selected/);
});

test('every message fits one GSM-7 SMS with no placeholder left behind', async (t) => {
  const db = seeded(t);
  await dispatch(db, recordingSender());
  for (const message of listMessages(db)) {
    assert.ok(message.body.length <= MAX_SMS, `${message.template} is ${message.body.length} chars`);
    assert.doesNotMatch(message.body, /\{\w+\}/, `${message.template} has an unfilled placeholder`);
    const nonGsm = [...message.body].filter((c) => c.charCodeAt(0) > 127);
    assert.deepEqual(nonGsm, [], `${message.template} has non-GSM characters`);
  }
});

test('an over-long, unfilled or non-GSM message is refused rather than truncated', () => {
  const values = { child: 'Ada', round: 'R', caseId: 'ZM-1', amount: 'KES 1' };
  assert.throws(() => renderBody('en', 'smsAwarded', { ...values, child: 'x'.repeat(200) }), MessageTooLongError);
  assert.throws(() => renderBody('en', 'smsAwarded', { child: 'Ada' }), UnfilledPlaceholderError);
  // A typographic apostrophe would force UCS-2 and halve the limit.
  assert.throws(() => renderBody('en', 'smsAwarded', { ...values, child: 'Ada\u2019s' }), NonGsmCharacterError);
  assert.throws(() => renderBody('en', 'smsAwarded', { ...values, child: 'Ade\u0301lai\u0308de \u4e2d' }), NonGsmCharacterError);
});

test('GSM-7 accounting counts extension characters twice', () => {
  assert.equal(septetLength('abc'), 3);
  assert.equal(septetLength('[]{}'), 8, 'brackets and braces cost two septets each');
  assert.deepEqual(nonGsmCharacters('Ada Kariuki'), []);
  assert.deepEqual(nonGsmCharacters('caf\u00e9 \u2019'), ['\u2019'], 'e-acute is GSM-7, the curly quote is not');
  // 120 characters of brackets is 240 septets: over one SMS despite being under 160 characters.
  assert.throws(
    () => renderBody('en', 'smsAwarded', { child: '['.repeat(60), round: 'R', caseId: 'ZM-1', amount: 'KES 1' }),
    MessageTooLongError,
  );
});

test('a message that cannot be rendered is skipped without blocking the rest', async (t) => {
  const db = seeded(t);
  db.prepare("INSERT INTO households (id, guardian_name, phone, language) VALUES ('HH-ODD', 'Odd', '+254700000906', 'en')").run();
  db.prepare("INSERT INTO children (id, household_id, school_id, name, admission_no) VALUES ('CH-ODD', 'HH-ODD', 'SCH-1', ?, 'ADM-ODD')").run('Name \u2019 With Curly Quote');
  const report = await dispatch(db, recordingSender());
  assert.ok(report.queued > 0, 'other households are still messaged');
  assert.equal(listMessages(db, '+254700000906').length, 1, 'the opening message does not name the child, so it renders');
});

test('a message that keeps failing is abandoned rather than retried forever', async (t) => {
  const db = freshDb(t);
  const caseId = createCase(db, { roundId: 'R-T', childId: 'CH-A', evidence: evidence(), actor: PARENT });
  recordStage(db, caseId, 'verified', CHV);
  queuePending(db);
  const queued = pendingMessages(db).length;
  const failing = { name: 'failing', async send() { throw new Error('never works'); } };
  for (let attempt = 0; attempt < MAX_ATTEMPTS + 2; attempt++) await sendQueued(db, failing);
  const tries = db.prepare('SELECT COUNT(*) AS n FROM message_attempts').get() as { n: number };
  assert.equal(tries.n, MAX_ATTEMPTS * queued);
  assert.equal(pendingMessages(db).length, 0, 'an abandoned message leaves the queue');
});

test('messages and attempts cannot be altered after the fact', async (t) => {
  const db = seeded(t);
  await dispatch(db, recordingSender());
  assert.throws(() => db.exec("UPDATE messages SET body = 'rewritten'"), /immutable record/);
  assert.throws(() => db.exec('DELETE FROM messages'), /immutable record/);
  assert.throws(() => db.exec("UPDATE message_attempts SET outcome = 'failed'"), /immutable record/);
  assert.throws(() => db.exec('DELETE FROM message_attempts'), /immutable record/);
});

test('closing a round sends nothing: the totals message belongs to a later story', async (t) => {
  const db = seeded(t);
  await dispatch(db, recordingSender());
  const before = listMessages(db).length;
  closeRound(db, OPEN_ROUND, CLERK);
  const report = await dispatch(db, recordingSender());
  assert.equal(report.queued, 0);
  assert.equal(listMessages(db).length, before);
});

test('an award recorded now reaches the parent with the right amount', async (t) => {
  const db = freshDb(t);
  const caseId = createCase(db, { roundId: 'R-T', childId: 'CH-A', evidence: evidence(), actor: PARENT });
  recordStage(db, caseId, 'verified', CHV);
  recordAward(db, caseId, 12_345, COMMITTEE);
  const sender = recordingSender();
  await dispatch(db, sender);
  const awarded = sender.sent.find((m) => m.template === 'smsAwarded')!;
  assert.match(awarded.body, /KES 12,345/);
  assert.equal(awarded.phone, '+254700000999');
});
