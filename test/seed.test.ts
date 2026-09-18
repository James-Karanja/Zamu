import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../src/db/connection.ts';
import { awardedTotal, getCaseHistory, listCurrentCases } from '../src/store/cases.ts';
import { MAX_POINTS, scoreNeed } from '../src/scoring/model.ts';
import { queuePriority } from '../src/scoring/priority.ts';
import { CHILD_COUNT, CORRECTED_CHILD, FAKE_PHONE_PATTERN, seedDatabase } from '../src/seed/data.ts';
import { tempDir } from './helpers.ts';

const OPEN_ROUND = 'R-2026-T2';

function seeded(t: Parameters<typeof tempDir>[0]) {
  const path = join(tempDir(t), 'zamu.db');
  const counts = seedDatabase(path);
  const db = openDatabase(path);
  t.after(() => db.close());
  return { path, counts, db };
}

test('reseeding rebuilds a fresh database with identical counts', (t) => {
  const path = join(tempDir(t), 'zamu.db');
  const first = seedDatabase(path);
  const second = seedDatabase(path);
  assert.deepEqual(second, first);
  assert.equal(first.children, CHILD_COUNT);
  assert.equal(first.households, 30);
  assert.equal(first.rounds, 3);
});

test('open round holds one current case per applicant', (t) => {
  const { db } = seeded(t);
  const cases = listCurrentCases(db, OPEN_ROUND);
  assert.equal(cases.length, CHILD_COUNT);
  assert.ok(cases.every((c) => c.roundId === OPEN_ROUND));
  assert.equal(new Set(cases.map((c) => c.childId)).size, CHILD_COUNT);
});

test('open round covers every band of the scoring module', (t) => {
  const { db } = seeded(t);
  const scores = listCurrentCases(db, OPEN_ROUND).map((c) => scoreNeed(c.evidence));
  const pointsFor = (input: string) => new Set(scores.map((s) => s.components.find((c) => c.input === input)!.points));

  assert.deepEqual(pointsFor('fee_balance'), new Set([0, 12, 24, 35]));
  assert.deepEqual(pointsFor('house_type'), new Set([0, 15, 30]));
  assert.deepEqual(pointsFor('livestock'), new Set([0, 8, 14, 20]));
  assert.deepEqual(pointsFor('land'), new Set([0, 7, 15]));
  assert.ok(scores.every((s) => s.total >= 0 && s.total <= MAX_POINTS.fee_balance + MAX_POINTS.house_type + MAX_POINTS.livestock + MAX_POINTS.land));
});

const EXPECTED_AWARDS = {
  'R-2025-T3': {
    amount: 15_000,
    children: ['CH-003', 'CH-004', 'CH-006', 'CH-008', 'CH-012', 'CH-015', 'CH-020', 'CH-024', 'CH-027', 'CH-030'],
  },
  'R-2026-T1': {
    amount: 12_500,
    children: ['CH-003', 'CH-006', 'CH-011', 'CH-014', 'CH-015', 'CH-018', 'CH-019', 'CH-021', 'CH-023', 'CH-027', 'CH-030', 'CH-035'],
  },
};

test('closed-round awards went to the highest-priority applicants', (t) => {
  const { db } = seeded(t);
  for (const roundId of Object.keys(EXPECTED_AWARDS)) {
    const ranked = listCurrentCases(db, roundId).map((record) => ({
      childId: record.childId,
      awarded: record.events.some((e) => e.stage === 'approved'),
      priority: queuePriority(db, record).priority,
    }));
    const awarded = ranked.filter((r) => r.awarded);
    const unawarded = ranked.filter((r) => !r.awarded);
    assert.ok(awarded.length > 0, `${roundId} awarded nobody`);
    assert.ok(unawarded.length > 0, `${roundId} awarded everybody, so ranking proves nothing`);
    const lowestAwarded = Math.min(...awarded.map((r) => r.priority));
    const highestUnawarded = Math.max(...unawarded.map((r) => r.priority));
    assert.ok(lowestAwarded >= highestUnawarded, `${roundId}: an unawarded applicant outranked an awarded one`);
  }
});

test('closed rounds award exactly the recipients the budget covers, ties to the earlier application', (t) => {
  const { db } = seeded(t);
  for (const [roundId, expected] of Object.entries(EXPECTED_AWARDS)) {
    const awarded = listCurrentCases(db, roundId)
      .filter((record) => record.events.some((e) => e.stage === 'approved'))
      .map((record) => record.childId)
      .sort();
    assert.deepEqual(awarded, expected.children, `${roundId} recipients`);

    const budget = (db.prepare('SELECT budget FROM rounds WHERE id = ?').get(roundId) as { budget: number }).budget;
    assert.equal(awardedTotal(db, roundId), Math.floor(budget / expected.amount) * expected.amount);
    assert.ok(awardedTotal(db, roundId) + expected.amount > budget, `${roundId} left room for another award`);
  }
});

test('the seed demonstrates that hiding a title deed does not raise a score', (t) => {
  const { db } = seeded(t);
  const evidence = listCurrentCases(db, OPEN_ROUND).map((c) => c.evidence);
  const untitledLarge = evidence.filter((e) => e.landAcres > 2 && !e.hasTitle);
  const titledLarge = evidence.filter((e) => e.landAcres > 2 && e.hasTitle);
  assert.ok(untitledLarge.length > 0 && titledLarge.length > 0);
  const landPoints = (e: (typeof evidence)[number]) => scoreNeed(e).components.find((c) => c.input === 'land')!.points;
  assert.deepEqual(new Set([...untitledLarge, ...titledLarge].map(landPoints)), new Set([0]));
});

test('some open-round applicants waited through earlier rounds without an award', (t) => {
  const { db } = seeded(t);
  const waited = db
    .prepare(
      `SELECT COUNT(DISTINCT c.child_id) AS n FROM cases c
       WHERE c.round_id = 'R-2026-T1'
         AND NOT EXISTS (SELECT 1 FROM case_events e WHERE e.case_id = c.id AND e.stage = 'approved')
         AND EXISTS (SELECT 1 FROM cases o WHERE o.round_id = ? AND o.child_id = c.child_id)`,
    )
    .get(OPEN_ROUND) as { n: number };
  assert.ok(waited.n > 0);
});

test('closed rounds award within budget and confirm disbursement', (t) => {
  const { db } = seeded(t);
  const rounds = db.prepare('SELECT id, budget FROM rounds').all() as { id: string; budget: number }[];
  let awardedRounds = 0;
  for (const round of rounds) {
    const awarded = awardedTotal(db, round.id);
    assert.ok(awarded <= round.budget, `${round.id} over budget`);
    if (awarded > 0) awardedRounds++;
  }
  assert.equal(awardedRounds, 2);

  const confirmed = db
    .prepare("SELECT COUNT(*) AS n FROM case_events WHERE stage = 'school_confirmed'")
    .get() as { n: number };
  assert.ok(confirmed.n > 0);
});

test('every state change records an actor and role', (t) => {
  const { db } = seeded(t);
  const blanks = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM case_events WHERE trim(actor_id) = '') AS events,
              (SELECT COUNT(*) FROM round_events WHERE trim(actor_id) = '') AS rounds,
              (SELECT COUNT(*) FROM cases WHERE trim(actor_id) = '') AS cases`,
    )
    .get() as { events: number; rounds: number; cases: number };
  assert.equal(blanks.events, 0);
  assert.equal(blanks.rounds, 0);
  assert.equal(blanks.cases, 0);
  const roles = db.prepare("SELECT DISTINCT actor_role FROM case_events").all() as { actor_role: string }[];
  assert.deepEqual(
    new Set(roles.map((r) => r.actor_role)),
    new Set(['parent', 'chv', 'teacher', 'committee', 'clerk', 'school']),
  );
});

test('seed includes the hidden-cattle correction with the original preserved', (t) => {
  const { db } = seeded(t);
  const original = db
    .prepare('SELECT id FROM cases WHERE round_id = ? AND child_id = ? AND supersedes_case_id IS NULL')
    .get(OPEN_ROUND, CORRECTED_CHILD) as { id: string };
  const [first, corrected] = getCaseHistory(db, original.id);
  assert.equal(first.evidence.cattle, 0);
  assert.equal(corrected.evidence.cattle, 7);
  assert.equal(corrected.supersedesCaseId, first.id);
  assert.equal(first.supersededByCaseId, corrected.id);
  assert.ok(!listCurrentCases(db, OPEN_ROUND).some((c) => c.id === first.id));
});

test('seed uses only the fake phone range', (t) => {
  const { db } = seeded(t);
  const phones = db.prepare('SELECT phone FROM households').all() as { phone: string }[];
  assert.equal(phones.length, 30);
  for (const { phone } of phones) assert.match(phone, FAKE_PHONE_PATTERN);
});
