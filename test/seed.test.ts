import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../src/db/connection.ts';
import { awardedTotal, getCaseHistory, listCurrentCases } from '../src/store/cases.ts';
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

test('open round covers every scoring-model band', (t) => {
  const { db } = seeded(t);
  const evidence = listCurrentCases(db, OPEN_ROUND).map((c) => c.evidence);

  const feeBand = (b: number) => (b === 0 ? 0 : b < 10_000 ? 1 : b <= 25_000 ? 2 : 3);
  const livestockBand = (e: (typeof evidence)[number]) =>
    e.cattle >= 5 ? 0 : e.cattle >= 1 ? 1 : e.hasGoatsOrPoultry ? 2 : 3;
  const landBand = (e: (typeof evidence)[number]) =>
    e.landAcres > 2 && e.hasTitle ? 0 : e.landAcres >= 0.5 ? 1 : 2;

  assert.deepEqual(new Set(evidence.map((e) => feeBand(e.feeBalance))), new Set([0, 1, 2, 3]));
  assert.deepEqual(new Set(evidence.map((e) => e.houseType)), new Set(['permanent', 'semi_permanent', 'mud']));
  assert.deepEqual(new Set(evidence.map(livestockBand)), new Set([0, 1, 2, 3]));
  assert.deepEqual(new Set(evidence.map(landBand)), new Set([0, 1, 2]));
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
