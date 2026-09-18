import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../src/db/connection.ts';
import { listRounds, maskName, publicEntry, publicQueue, rankRound, roundSummary } from '../src/queue/ranking.ts';
import { RoundNotFoundError, correctCase, createCase, listCurrentCases } from '../src/store/cases.ts';
import { CHV, PARENT, evidence, freshDb, tempDir } from './helpers.ts';
import { CHILD_COUNT, seedDatabase } from '../src/seed/data.ts';

const OPEN_ROUND = 'R-2026-T2';

function seeded(t: Parameters<typeof tempDir>[0]) {
  const path = join(tempDir(t), 'zamu.db');
  seedDatabase(path);
  const db = openDatabase(path);
  t.after(() => db.close());
  return db;
}

test('masked names identify a household without listing it', () => {
  assert.equal(maskName('Baraka Kariuki'), 'B. K****');
  assert.equal(maskName('imani odhiambo'), 'I. O****');
  assert.equal(maskName('Juma'), 'J.');
  assert.equal(maskName('Neema Wanjiru Mwangi'), 'N. M****');
  assert.equal(maskName('Wanjiru-Mwangi'), 'W. M****');
  assert.equal(maskName(''), '');
  // Fixed-width stars: the mask must not disclose how long a surname is.
  assert.equal(maskName('A Bo'), maskName('A Bartholomew'));
});

test('a round ranks every current case by priority, positions from 1', (t) => {
  const db = seeded(t);
  const entries = rankRound(db, OPEN_ROUND);
  assert.equal(entries.length, CHILD_COUNT);
  assert.deepEqual(entries.map((e) => e.position), Array.from({ length: CHILD_COUNT }, (_, i) => i + 1));
  for (let i = 1; i < entries.length; i++) assert.ok(entries[i - 1].priority >= entries[i].priority);
  assert.equal(entries[0].priority, entries[0].need + entries[0].waitingBonus);
});

test('ties go to the household that applied first, then the lower case id', (t) => {
  const db = freshDb(t);
  const first = createCase(db, { roundId: 'R-T', childId: 'CH-A', evidence: evidence(), actor: PARENT }, '2026-05-04T09:00:00.000Z');
  const second = createCase(db, { roundId: 'R-T', childId: 'CH-B', evidence: evidence(), actor: PARENT }, '2026-05-04T10:00:00.000Z');
  assert.deepEqual(rankRound(db, 'R-T').map((e) => e.caseId), [first, second]);

  // Correcting the first case must not cost it the tie, even though its row is newer.
  const corrected = correctCase(db, first, { evidence: evidence(), reason: 'recheck', actor: CHV }, '2026-05-04T11:00:00.000Z');
  assert.deepEqual(rankRound(db, 'R-T').map((e) => e.caseId), [corrected, second]);
});

test('a superseded case never appears in the queue', (t) => {
  const db = freshDb(t);
  const original = createCase(db, { roundId: 'R-T', childId: 'CH-A', evidence: evidence(), actor: PARENT });
  const corrected = correctCase(db, original, { evidence: evidence({ cattle: 7 }), reason: 'cattle found', actor: CHV });
  const ids = rankRound(db, 'R-T').map((e) => e.caseId);
  assert.deepEqual(ids, [corrected]);
  assert.ok(!ids.includes(original));
});

test('public entries carry no household detail', (t) => {
  const db = seeded(t);
  const entry = rankRound(db, OPEN_ROUND)[0];
  const published = publicEntry(entry);
  assert.deepEqual(Object.keys(published).sort(), [
    'awardAmount', 'caseId', 'maskedName', 'need', 'position', 'priority', 'school', 'stage', 'waitingBonus',
  ]);
  assert.ok(!('name' in published) && !('childId' in published) && !('appliedAt' in published));
  assert.ok(entry.name.length > 0 && !JSON.stringify(published).includes(entry.name));
});

test('the awarded entries of a closed round match its recorded total', (t) => {
  const db = seeded(t);
  for (const roundId of ['R-2025-T3', 'R-2026-T1']) {
    const summary = roundSummary(db, roundId);
    const entries = publicQueue(db, roundId);
    const awarded = entries.filter((e) => e.awardAmount !== null);
    assert.equal(awarded.length, summary.recipients);
    assert.equal(awarded.reduce((sum, e) => sum + (e.awardAmount ?? 0), 0), summary.awarded);
    assert.equal(summary.status, 'closed');
    assert.equal(summary.applicants, entries.length);
  }
});

test('the seed and the page rank a round identically', (t) => {
  const db = seeded(t);
  const closed = 'R-2025-T3';
  const awardedInOrder = rankRound(db, closed).filter((e) => e.awardAmount !== null).map((e) => e.position);
  assert.deepEqual(awardedInOrder, Array.from({ length: awardedInOrder.length }, (_, i) => i + 1));
});

test('rounds are listed newest first and an unknown round is an error', (t) => {
  const db = seeded(t);
  assert.deepEqual(listRounds(db).map((r) => r.id), ['R-2026-T2', 'R-2026-T1', 'R-2025-T3']);
  assert.throws(() => rankRound(db, 'R-NOPE'), RoundNotFoundError);
  assert.throws(() => roundSummary(db, 'R-NOPE'), RoundNotFoundError);
});

test('an empty round ranks to an empty queue', (t) => {
  const db = freshDb(t);
  assert.equal(listCurrentCases(db, 'R-T').length, 0);
  assert.deepEqual(rankRound(db, 'R-T'), []);
  assert.equal(roundSummary(db, 'R-T').applicants, 0);
});
