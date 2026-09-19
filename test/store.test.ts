import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AlreadySupersededError, BudgetExceededError, CaseNotCorrectableError, CaseNotFoundError, DuplicateApplicationError,
  InvalidAmountError, InvalidStageError, InvalidTimestampError, InvalidTransitionError, RoundNotFoundError,
  RoundNotOpenError, RoundStateError,
  closeRound, correctCase, createCase, createRound, getCase, getCaseHistory, getCurrentStage, listCurrentCases,
  openRound, recordAward, recordStage,
} from '../src/store/cases.ts';
import { CHV, CLERK, COMMITTEE, PARENT, ROUND_CREATED_AT, ROUND_OPENED_AT, evidence, freshDb } from './helpers.ts';

const apply = (db: ReturnType<typeof freshDb>, childId = 'CH-A', ev = evidence()) =>
  createCase(db, { roundId: 'R-T', childId, evidence: ev, actor: PARENT });

test('create case persists case, evidence, actor, and applied event', (t) => {
  const db = freshDb(t);
  const id = createCase(
    db,
    { roundId: 'R-T', childId: 'CH-A', evidence: evidence({ cattle: 3, hasTitle: true }), actor: PARENT },
    '2026-05-04T09:00:00.000Z',
  );
  assert.match(id, /^ZM-\d{4}$/);
  const record = getCase(db, id);
  assert.equal(record.childId, 'CH-A');
  assert.deepEqual(record.evidence, evidence({ cattle: 3, hasTitle: true }));
  assert.equal(record.actorId, PARENT.id);
  assert.equal(record.actorRole, 'parent');
  assert.equal(record.supersededByCaseId, null);
  assert.equal(record.currentStage, 'applied');
  assert.deepEqual(record.events.map((e) => e.stage), ['applied']);
  assert.equal(record.events[0].actorRole, 'parent');
  assert.equal(getCurrentStage(db, id), 'applied');
});

test('create case in a closed round is rejected', (t) => {
  const db = freshDb(t);
  closeRound(db, 'R-T', CLERK);
  assert.throws(() => apply(db), RoundNotOpenError);
});

test('create case in a round that was never opened is rejected', (t) => {
  const db = freshDb(t);
  createRound(db, { id: 'R-NEW', name: 'Unopened', ward: 'Test Ward', currency: 'KES', budget: 10_000 }, CLERK);
  assert.throws(
    () => createCase(db, { roundId: 'R-NEW', childId: 'CH-A', evidence: evidence(), actor: PARENT }),
    RoundNotOpenError,
  );
});

test('create case in an unknown round is rejected', (t) => {
  const db = freshDb(t);
  assert.throws(
    () => createCase(db, { roundId: 'R-NOPE', childId: 'CH-A', evidence: evidence(), actor: PARENT }),
    RoundNotFoundError,
  );
});

test('duplicate application for the same child and round is rejected', (t) => {
  const db = freshDb(t);
  apply(db);
  assert.throws(() => apply(db), DuplicateApplicationError);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM cases').get() as { n: number };
  assert.equal(n, 1);
});

test('a failed evidence insert leaves no case behind', (t) => {
  const db = freshDb(t);
  assert.throws(() => apply(db, 'CH-A', evidence({ cattle: 2.5 })));
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM cases').get() as { n: number }).n, 0);
  const id = apply(db);
  assert.equal(getCase(db, id).childId, 'CH-A');
  assert.equal(listCurrentCases(db, 'R-T').length, 1);
});

test('a failed correction leaves the original correctable', (t) => {
  const db = freshDb(t);
  const original = apply(db);
  assert.throws(() => correctCase(db, original, { evidence: evidence({ lat: 200 }), reason: 'bad', actor: CHV }));
  assert.equal(getCase(db, original).supersededByCaseId, null);
  const corrected = correctCase(db, original, { evidence: evidence({ cattle: 1 }), reason: 'retry', actor: CHV });
  assert.equal(getCase(db, original).supersededByCaseId, corrected);
});

test('correcting a case creates a linked case and leaves the original unchanged', (t) => {
  const db = freshDb(t);
  const original = apply(db, 'CH-A', evidence({ cattle: 0 }));
  recordStage(db, original, 'verified', CHV);
  const before = getCase(db, original);

  const corrected = correctCase(db, original, { evidence: evidence({ cattle: 7 }), reason: 'cattle hidden at first visit', actor: CHV });

  assert.deepEqual(getCase(db, original).events, before.events);
  assert.equal(getCase(db, original).supersededByCaseId, corrected);
  const record = getCase(db, corrected);
  assert.equal(record.supersedesCaseId, original);
  assert.equal(record.correctionReason, 'cattle hidden at first visit');
  assert.equal(record.evidence.cattle, 7);
  assert.equal(record.actorRole, 'chv');
  assert.match(record.events[0].note ?? '', /^correction of ZM-\d{4}: cattle hidden at first visit$/);
  assert.equal(getCurrentStage(db, corrected), 'applied');

  assert.deepEqual(getCaseHistory(db, corrected).map((c) => c.id), [original, corrected]);
  assert.deepEqual(getCaseHistory(db, original).map((c) => c.id), [original, corrected]);
});

test('a case can be superseded only once, and history reads from any link', (t) => {
  const db = freshDb(t);
  const original = apply(db);
  const second = correctCase(db, original, { evidence: evidence({ cattle: 2 }), reason: 'first fix', actor: CHV });
  assert.throws(
    () => correctCase(db, original, { evidence: evidence({ cattle: 5 }), reason: 'second fix', actor: CHV }),
    AlreadySupersededError,
  );
  const third = correctCase(db, second, { evidence: evidence({ cattle: 5 }), reason: 'fix of the fix', actor: CHV });
  for (const from of [original, second, third]) {
    assert.deepEqual(getCaseHistory(db, from).map((c) => c.id), [original, second, third]);
  }
});

test('an awarded case cannot be corrected', (t) => {
  const db = freshDb(t);
  const id = apply(db);
  recordStage(db, id, 'verified', CHV);
  recordAward(db, id, 15_000, COMMITTEE);
  assert.throws(
    () => correctCase(db, id, { evidence: evidence({ cattle: 9 }), reason: 'too late', actor: CHV }),
    CaseNotCorrectableError,
  );
});

test('a case in a closed round cannot be corrected', (t) => {
  const db = freshDb(t);
  const id = apply(db);
  closeRound(db, 'R-T', CLERK);
  assert.throws(
    () => correctCase(db, id, { evidence: evidence({ cattle: 9 }), reason: 'after close', actor: CHV }),
    RoundNotOpenError,
  );
});

test('blank correction reasons and blank actors are rejected by the database', (t) => {
  const db = freshDb(t);
  const id = apply(db);
  assert.throws(() => correctCase(db, id, { evidence: evidence(), reason: '   ', actor: CHV }));
  assert.equal(getCase(db, id).supersededByCaseId, null);
  assert.throws(
    () =>
      db.exec(
        `INSERT INTO case_events (case_id, stage, amount, note, actor_id, actor_role, at)
         VALUES ('${id}', 'verified', NULL, NULL, '  ', 'chv', '2026-05-04T09:00:00.000Z')`,
      ),
    /CHECK constraint failed|role not permitted/,
  );
});

test('decision stages cannot be recorded once the round is closed', (t) => {
  const db = freshDb(t);
  const id = apply(db);
  closeRound(db, 'R-T', CLERK);
  assert.throws(() => recordStage(db, id, 'verified', CHV), RoundNotOpenError);
  assert.throws(() => recordStage(db, id, 'rejected', COMMITTEE, undefined, 'too late'), RoundNotOpenError);
});

test('advancing stages appends events and current stage is the latest', (t) => {
  const db = freshDb(t);
  const id = apply(db);
  recordStage(db, id, 'verified', CHV);
  recordAward(db, id, 15_000, COMMITTEE);
  recordStage(db, id, 'disbursed', CLERK);
  recordStage(db, id, 'school_confirmed', { id: 'SCH-T', role: 'school' });
  assert.equal(getCurrentStage(db, id), 'school_confirmed');
  const events = getCase(db, id).events;
  assert.deepEqual(events.map((e) => e.stage), ['applied', 'verified', 'approved', 'disbursed', 'school_confirmed']);
  assert.equal(events[2].amount, 15_000);
  assert.deepEqual(events.map((e) => e.actorRole), ['parent', 'chv', 'committee', 'clerk', 'school']);
});

test('stages cannot skip, repeat, or follow a final stage', (t) => {
  const db = freshDb(t);
  const id = apply(db);
  assert.throws(() => recordStage(db, id, 'disbursed', CLERK), InvalidTransitionError);
  assert.throws(() => recordAward(db, id, 15_000, COMMITTEE), InvalidTransitionError);
  recordStage(db, id, 'verified', CHV);
  recordAward(db, id, 15_000, COMMITTEE);
  assert.throws(() => recordAward(db, id, 15_000, COMMITTEE), InvalidTransitionError);
  recordStage(db, id, 'disbursed', CLERK);
  recordStage(db, id, 'school_confirmed', { id: 'SCH-T', role: 'school' });
  assert.throws(() => recordStage(db, id, 'rejected', COMMITTEE, undefined, 'after the fact'), InvalidTransitionError);
  assert.deepEqual(getCase(db, id).events.map((e) => e.stage), ['applied', 'verified', 'approved', 'disbursed', 'school_confirmed']);
});

test('unknown stage is rejected', (t) => {
  const db = freshDb(t);
  const id = apply(db);
  assert.throws(() => recordStage(db, id, 'paid_in_cash', CLERK), InvalidStageError);
  assert.throws(() => recordStage(db, id, 'approved', COMMITTEE), InvalidStageError, 'approved must go through recordAward');
  assert.equal(getCurrentStage(db, id), 'applied');
});

test('awards must be whole positive amounts within the round budget', (t) => {
  const db = freshDb(t);
  const a = apply(db, 'CH-A');
  recordStage(db, a, 'verified', CHV);
  assert.throws(() => recordAward(db, a, 150.5, COMMITTEE), InvalidAmountError);
  assert.throws(() => recordAward(db, a, 0, COMMITTEE), InvalidAmountError);
  recordAward(db, a, 100_000, COMMITTEE);

  const b = apply(db, 'CH-B');
  recordStage(db, b, 'verified', CHV);
  assert.throws(() => recordAward(db, b, 1, COMMITTEE), BudgetExceededError);
  assert.equal(getCurrentStage(db, b), 'verified');
});

test('events cannot be backdated and timestamps must be ISO-8601', (t) => {
  const db = freshDb(t);
  const id = createCase(db, { roundId: 'R-T', childId: 'CH-A', evidence: evidence(), actor: PARENT }, '2026-05-04T09:00:00.000Z');
  assert.throws(() => recordStage(db, id, 'verified', CHV, '2026-05-04T08:00:00.000Z'), InvalidTimestampError);
  assert.throws(() => recordStage(db, id, 'verified', CHV, 'yesterday'), InvalidTimestampError);
  recordStage(db, id, 'verified', CHV, '2026-05-04T10:00:00.000Z');
  assert.equal(getCurrentStage(db, id), 'verified');
});

test('evidence capture timestamps and non-ISO formats are rejected', (t) => {
  const db = freshDb(t);
  assert.throws(() => apply(db, 'CH-A', evidence({ capturedAt: 'yesterday' })), InvalidTimestampError);
  assert.throws(() => apply(db, 'CH-A', evidence({ capturedAt: '12/25/2026' })), InvalidTimestampError);
  assert.throws(
    () => createCase(db, { roundId: 'R-T', childId: 'CH-A', evidence: evidence(), actor: PARENT }, 'May 4 2026'),
    InvalidTimestampError,
  );
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM cases').get() as { n: number }).n, 0);
});

test('an application cannot predate the round opening', (t) => {
  const db = freshDb(t);
  assert.throws(
    () => createCase(db, { roundId: 'R-T', childId: 'CH-A', evidence: evidence(), actor: PARENT }, '2026-04-30T08:00:00.000Z'),
    InvalidTimestampError,
  );
});

test('a correction cannot predate the case it corrects', (t) => {
  const db = freshDb(t);
  const id = createCase(db, { roundId: 'R-T', childId: 'CH-A', evidence: evidence(), actor: PARENT }, '2026-05-04T09:00:00.000Z');
  assert.throws(
    () => correctCase(db, id, { evidence: evidence({ cattle: 1 }), reason: 'backdated', actor: CHV }, '2026-05-03T09:00:00.000Z'),
    InvalidTimestampError,
  );
});

test('round events cannot be backdated', (t) => {
  const db = freshDb(t);
  assert.throws(() => closeRound(db, 'R-T', CLERK, '2026-04-30T08:00:00.000Z'), InvalidTimestampError);
  createRound(db, { id: 'R-3', name: 'Third', ward: 'Test Ward', currency: 'KES', budget: 1_000 }, CLERK, ROUND_CREATED_AT);
  assert.throws(() => openRound(db, 'R-3', CLERK, '2026-04-01T08:00:00.000Z'), InvalidTimestampError);
  assert.ok(ROUND_OPENED_AT > ROUND_CREATED_AT);
});

test('rounds open once, close once, and never reopen', (t) => {
  const db = freshDb(t);
  assert.throws(() => openRound(db, 'R-T', CLERK), RoundStateError);
  closeRound(db, 'R-T', CLERK);
  assert.throws(() => closeRound(db, 'R-T', CLERK), RoundStateError);
  assert.throws(() => openRound(db, 'R-T', CLERK), RoundStateError);
  createRound(db, { id: 'R-NEW', name: 'Unopened', ward: 'Test Ward', currency: 'KES', budget: 1_000 }, CLERK);
  assert.throws(() => closeRound(db, 'R-NEW', CLERK), RoundStateError);
  assert.throws(() => openRound(db, 'R-NOPE', CLERK), RoundNotFoundError);
});

test('unknown case ids raise CaseNotFoundError from every entry point', (t) => {
  const db = freshDb(t);
  assert.throws(() => correctCase(db, 'ZM-9999', { evidence: evidence(), reason: 'x', actor: CHV }), CaseNotFoundError);
  assert.throws(() => recordStage(db, 'ZM-9999', 'verified', CHV), CaseNotFoundError);
  assert.throws(() => recordAward(db, 'ZM-9999', 1_000, COMMITTEE), CaseNotFoundError);
  assert.throws(() => getCurrentStage(db, 'ZM-9999'), CaseNotFoundError);
  assert.throws(() => getCase(db, 'ZM-9999'), CaseNotFoundError);
  assert.throws(() => getCaseHistory(db, 'ZM-9999'), CaseNotFoundError);
});

test('stages cannot be recorded on a superseded case', (t) => {
  const db = freshDb(t);
  const original = apply(db);
  correctCase(db, original, { evidence: evidence({ cattle: 1 }), reason: 'fix', actor: CHV });
  assert.throws(() => recordStage(db, original, 'verified', CHV), AlreadySupersededError);
  assert.throws(() => recordAward(db, original, 10_000, COMMITTEE), AlreadySupersededError);
});

test('listCurrentCases excludes superseded cases, keeps insertion order, and filters by round', (t) => {
  const db = freshDb(t);
  const a = apply(db, 'CH-A');
  const b = apply(db, 'CH-B');
  const a2 = correctCase(db, a, { evidence: evidence({ cattle: 4 }), reason: 'fix', actor: CHV });
  assert.deepEqual(listCurrentCases(db, 'R-T').map((c) => c.id), [b, a2]);

  createRound(db, { id: 'R-2', name: 'Second', ward: 'Test Ward', currency: 'KES', budget: 50_000 }, CLERK, '2026-06-01T07:00:00.000Z');
  openRound(db, 'R-2', CLERK, '2026-06-01T08:00:00.000Z');
  const other = createCase(
    db,
    { roundId: 'R-2', childId: 'CH-A', evidence: evidence(), actor: PARENT },
    '2026-06-01T09:00:00.000Z',
  );
  assert.deepEqual(listCurrentCases(db, 'R-2').map((c) => c.id), [other]);
  assert.deepEqual(listCurrentCases(db, 'R-T').map((c) => c.id), [b, a2]);
});
