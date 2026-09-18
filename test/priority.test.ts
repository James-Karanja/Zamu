import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../src/db/connection.ts';
import { WAITING_BONUS_PER_ROUND, queuePriority, queuePriorityOf, roundsWaited } from '../src/scoring/priority.ts';
import { scoreNeed } from '../src/scoring/model.ts';
import {
  RoundNotFoundError,
  closeRound, correctCase, createCase, createRound, getCase, openRound, recordAward, recordStage,
} from '../src/store/cases.ts';
import { addChild, addHousehold, addSchool } from '../src/store/registry.ts';
import { CHV, CLERK, COMMITTEE, PARENT, evidence, tempDir } from './helpers.ts';

const day = (n: number) => `2026-0${n}-01T08:00:00.000Z`;

/** A database with three rounds a month apart; rounds 1 and 2 closed, round 3 open. */
function history(t: Parameters<typeof tempDir>[0]) {
  const db = openDatabase(join(tempDir(t), 'zamu.db'));
  t.after(() => db.close());
  addSchool(db, { id: 'SCH-T', name: 'Test School', county: 'County', ward: 'Ward' });
  addHousehold(db, { id: 'HH-T', guardianName: 'Guardian', phone: '+254700000999', language: 'sw' });
  for (const id of ['CH-A', 'CH-B']) {
    addChild(db, { id, householdId: 'HH-T', schoolId: 'SCH-T', name: id, admissionNo: `ADM-${id}` });
  }
  for (const [i, id] of ['R-1', 'R-2', 'R-3'].entries()) {
    createRound(db, { id, name: id, ward: 'Ward', currency: 'KES', budget: 50_000 }, day(i + 1));
    openRound(db, id, CLERK, day(i + 1));
  }
  return db;
}

const apply = (db: ReturnType<typeof history>, roundId: string, childId: string, n: number, ev = evidence()) =>
  createCase(db, { roundId, childId, evidence: ev, actor: PARENT }, day(n));

test('a first-time applicant has no waiting bonus', (t) => {
  const db = history(t);
  const id = apply(db, 'R-1', 'CH-A', 1);
  const p = queuePriorityOf(db, id);
  assert.equal(p.roundsWaited, 0);
  assert.equal(p.waitingBonus, 0);
  assert.equal(p.priority, p.need);
  assert.equal(p.need, scoreNeed(evidence()).total);
});

test('each earlier unawarded round adds ten points', (t) => {
  const db = history(t);
  apply(db, 'R-1', 'CH-A', 1);
  closeRound(db, 'R-1', CLERK, day(2));
  const second = apply(db, 'R-2', 'CH-A', 2);
  assert.equal(queuePriorityOf(db, second).waitingBonus, WAITING_BONUS_PER_ROUND);

  closeRound(db, 'R-2', CLERK, day(3));
  const third = apply(db, 'R-3', 'CH-A', 3);
  const p = queuePriorityOf(db, third);
  assert.equal(p.roundsWaited, 2);
  assert.equal(p.waitingBonus, 20);
  assert.equal(p.priority, p.need + 20);
});

test('an award resets the bonus, and only later rounds count again', (t) => {
  const db = history(t);
  const first = apply(db, 'R-1', 'CH-A', 1);
  recordStage(db, first, 'verified', CHV, day(1));
  recordAward(db, first, 10_000, COMMITTEE, day(1));
  closeRound(db, 'R-1', CLERK, day(2));

  const second = apply(db, 'R-2', 'CH-A', 2);
  assert.equal(queuePriorityOf(db, second).waitingBonus, 0, 'awarded last round');
  closeRound(db, 'R-2', CLERK, day(3));

  const third = apply(db, 'R-3', 'CH-A', 3);
  const p = queuePriorityOf(db, third);
  assert.equal(p.roundsWaited, 1, 'only the round since the award counts');
  assert.equal(p.waitingBonus, 10);
});

test('rounds the child did not apply in are skipped, not counted', (t) => {
  const db = history(t);
  apply(db, 'R-1', 'CH-A', 1);
  closeRound(db, 'R-1', CLERK, day(2));
  apply(db, 'R-2', 'CH-B', 2);
  closeRound(db, 'R-2', CLERK, day(3));
  const third = apply(db, 'R-3', 'CH-A', 3);
  assert.equal(queuePriorityOf(db, third).roundsWaited, 1);
});

test('a superseded case does not double-count a waiting round', (t) => {
  const db = history(t);
  const original = apply(db, 'R-1', 'CH-A', 1);
  correctCase(db, original, { evidence: evidence({ cattle: 6 }), reason: 'cattle found', actor: CHV }, day(1));
  closeRound(db, 'R-1', CLERK, day(2));
  const second = apply(db, 'R-2', 'CH-A', 2);
  assert.equal(roundsWaited(db, 'CH-A', 'R-2'), 1);
  assert.equal(queuePriorityOf(db, second).waitingBonus, 10);
});

test('an earlier round that is still open earns no bonus yet', (t) => {
  const db = history(t);
  apply(db, 'R-1', 'CH-A', 1);
  const second = apply(db, 'R-2', 'CH-A', 2);
  assert.equal(queuePriorityOf(db, second).waitingBonus, 0, 'R-1 has decided nothing yet');
  closeRound(db, 'R-1', CLERK, day(3));
  assert.equal(queuePriorityOf(db, second).waitingBonus, WAITING_BONUS_PER_ROUND);
});

test('a rejected application earns no waiting bonus', (t) => {
  const db = history(t);
  const first = apply(db, 'R-1', 'CH-A', 1);
  recordStage(db, first, 'rejected', CLERK, day(1), 'evidence did not match the household');
  closeRound(db, 'R-1', CLERK, day(2));
  const second = apply(db, 'R-2', 'CH-A', 2);
  assert.equal(queuePriorityOf(db, second).roundsWaited, 0);
});

test('an unknown round id is an error, not a silent zero', (t) => {
  const db = history(t);
  assert.throws(() => roundsWaited(db, 'CH-A', 'R-NOPE'), RoundNotFoundError);
});

test('the corrected evidence, not the original, decides the score', (t) => {
  const db = history(t);
  const original = apply(db, 'R-1', 'CH-A', 1, evidence({ cattle: 0, hasGoatsOrPoultry: false }));
  const corrected = correctCase(db, original, { evidence: evidence({ cattle: 7 }), reason: 'cattle found', actor: CHV }, day(1));
  assert.equal(queuePriorityOf(db, original).need - queuePriorityOf(db, corrected).need, 20);
  assert.equal(queuePriority(db, getCase(db, corrected)).need, scoreNeed(evidence({ cattle: 7 })).total);
});
