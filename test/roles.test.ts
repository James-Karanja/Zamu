import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MissingReasonError, PERMITTED_ROLES, RoleNotPermittedError, UnknownCapturerError,
  closeRound, correctCase, createCase, createRound, getCurrentStage, listRefusedActions, openRound, recordAward, recordStage,
  type Actor, type ActorRole,
} from '../src/store/cases.ts';
import { addSchool, addStaff } from '../src/store/registry.ts';
import { CHV, CLERK, COMMITTEE, PARENT, evidence, freshDb } from './helpers.ts';

const SCHOOL: Actor = { id: 'SCH-T', role: 'school' };
const TEACHER: Actor = { id: 'TCH-T', role: 'teacher' };
const ALL_ROLES: ActorRole[] = ['parent', 'chv', 'teacher', 'clerk', 'committee', 'school', 'system'];

const apply = (db: ReturnType<typeof freshDb>, childId = 'CH-A') =>
  createCase(db, { roundId: 'R-T', childId, evidence: evidence(), actor: PARENT });

test('the published role map is the one decided for this story', () => {
  assert.deepEqual(PERMITTED_ROLES.open_round, ['clerk']);
  assert.deepEqual(PERMITTED_ROLES.close_round, ['clerk']);
  assert.deepEqual(PERMITTED_ROLES.apply, ['parent', 'clerk']);
  assert.deepEqual(PERMITTED_ROLES.verified, ['chv', 'teacher']);
  assert.deepEqual(PERMITTED_ROLES.correct, ['chv', 'teacher']);
  assert.deepEqual(PERMITTED_ROLES.rejected, ['committee']);
  assert.deepEqual(PERMITTED_ROLES.approved, ['committee']);
  assert.deepEqual(PERMITTED_ROLES.disbursed, ['clerk']);
  assert.deepEqual(PERMITTED_ROLES.school_confirmed, ['school']);
  // Nobody who pays also vouches for need.
  assert.ok(!PERMITTED_ROLES.verified.includes('clerk'));
});

test('every role outside the map is refused at every stage, and each refusal is logged', (t) => {
  const stages = [
    ['verified', (db: ReturnType<typeof freshDb>, id: string, actor: Actor) => recordStage(db, id, 'verified', actor)],
    ['rejected', (db: ReturnType<typeof freshDb>, id: string, actor: Actor) => recordStage(db, id, 'rejected', actor, undefined, 'reason')],
    ['approved', (db: ReturnType<typeof freshDb>, id: string, actor: Actor) => recordAward(db, id, 1_000, actor)],
    ['disbursed', (db: ReturnType<typeof freshDb>, id: string, actor: Actor) => recordStage(db, id, 'disbursed', actor)],
    ['school_confirmed', (db: ReturnType<typeof freshDb>, id: string, actor: Actor) => recordStage(db, id, 'school_confirmed', actor)],
  ] as const;
  for (const [stage, attempt] of stages) {
    for (const role of ALL_ROLES.filter((r) => !PERMITTED_ROLES[stage].includes(r))) {
      const db = freshDb(t);
      const id = apply(db);
      const actor: Actor = { id: `X-${role}`, role };
      assert.throws(() => attempt(db, id, actor), RoleNotPermittedError, `${role} should not ${stage}`);
      assert.equal(getCurrentStage(db, id), 'applied', 'nothing was recorded');
      const [logged] = listRefusedActions(db);
      assert.equal(logged.actorId, actor.id);
      assert.equal(logged.attempted, stage);
      assert.equal(logged.target, id);
    }
  }
});

test('a parent cannot verify their own case', (t) => {
  const db = freshDb(t);
  const id = apply(db);
  assert.throws(() => recordStage(db, id, 'verified', PARENT), /may not verify a case/);
  assert.equal(listRefusedActions(db).length, 1);
});

test('the full permitted path works, one role per step', (t) => {
  const db = freshDb(t);
  const id = apply(db);
  recordStage(db, id, 'verified', TEACHER);
  recordAward(db, id, 10_000, COMMITTEE);
  recordStage(db, id, 'disbursed', CLERK);
  recordStage(db, id, 'school_confirmed', SCHOOL);
  assert.equal(getCurrentStage(db, id), 'school_confirmed');
  assert.equal(listRefusedActions(db).length, 0);
});

test('a school confirms only for its own pupils', (t) => {
  const db = freshDb(t);
  addSchool(db, { id: 'SCH-OTHER', name: 'Other School', county: 'County', ward: 'Ward' });
  addStaff(db, { id: 'SCH-OTHER', name: 'Other bursar', role: 'school', schoolId: 'SCH-OTHER' });
  const id = apply(db);
  recordStage(db, id, 'verified', CHV);
  recordAward(db, id, 5_000, COMMITTEE);
  recordStage(db, id, 'disbursed', CLERK);
  assert.throws(() => recordStage(db, id, 'school_confirmed', { id: 'SCH-OTHER', role: 'school' }), /registered at SCH-T/);
  assert.equal(getCurrentStage(db, id), 'disbursed');
  assert.equal(listRefusedActions(db)[0].target, id);
  recordStage(db, id, 'school_confirmed', SCHOOL);
  assert.equal(getCurrentStage(db, id), 'school_confirmed');
});

test('a rejection needs a written reason, and keeps it', (t) => {
  const db = freshDb(t);
  const id = apply(db);
  assert.throws(() => recordStage(db, id, 'rejected', COMMITTEE), MissingReasonError);
  assert.throws(() => recordStage(db, id, 'rejected', COMMITTEE, undefined, '   '), MissingReasonError);
  assert.equal(getCurrentStage(db, id), 'applied');
  recordStage(db, id, 'rejected', COMMITTEE, undefined, '  evidence did not match the household  ');
  const stored = db.prepare("SELECT note FROM case_events WHERE case_id = ? AND stage = 'rejected'").get(id) as { note: string };
  assert.equal(stored.note, 'evidence did not match the household');
});

test('only the clerk opens and closes rounds', (t) => {
  const db = freshDb(t);
  createRound(db, { id: 'R-2', name: 'Second', ward: 'Test Ward', currency: 'KES', budget: 1_000 }, CLERK, '2026-05-01T07:00:00.000Z');
  assert.throws(() => openRound(db, 'R-2', COMMITTEE, '2026-05-01T08:00:00.000Z'), RoleNotPermittedError);
  openRound(db, 'R-2', CLERK, '2026-05-01T08:00:00.000Z');
  assert.throws(() => closeRound(db, 'R-2', PARENT), RoleNotPermittedError);
  closeRound(db, 'R-2', CLERK);
  // Newest first, as the dashboard's refusal log promises.
  assert.deepEqual(listRefusedActions(db).map((r) => r.attempted), ['close_round', 'open_round']);
});

test('applications come from a parent or the clerk; corrections from a volunteer or teacher', (t) => {
  const db = freshDb(t);
  assert.throws(() => createCase(db, { roundId: 'R-T', childId: 'CH-A', evidence: evidence(), actor: COMMITTEE }), RoleNotPermittedError);
  const walkIn = createCase(db, { roundId: 'R-T', childId: 'CH-A', evidence: evidence(), actor: CLERK });
  assert.throws(() => correctCase(db, walkIn, { evidence: evidence({ cattle: 3 }), reason: 'x', actor: CLERK }), RoleNotPermittedError);
  correctCase(db, walkIn, { evidence: evidence({ cattle: 3 }), reason: 'recheck', actor: TEACHER });
});

test('the refusal survives even though the action rolled back', (t) => {
  const db = freshDb(t);
  const id = apply(db);
  assert.throws(() => recordAward(db, id, 1_000, CLERK));
  const events = db.prepare('SELECT COUNT(*) AS n FROM case_events WHERE case_id = ?').get(id) as { n: number };
  assert.equal(events.n, 1, 'only the application');
  assert.equal(listRefusedActions(db).length, 1);
  assert.throws(() => db.exec('DELETE FROM refused_actions'), /immutable record/);
  assert.throws(() => db.exec("UPDATE refused_actions SET reason = 'x'"), /immutable record/);
});

test('an unknown case is a not-found error, not a logged refusal', (t) => {
  const db = freshDb(t);
  assert.throws(() => recordStage(db, 'ZM-9999', 'verified', PARENT), /case not found/);
  assert.equal(listRefusedActions(db).length, 0);
});

test('a caller cannot promote itself: the role comes from the registry, not the claim', (t) => {
  const db = freshDb(t);
  const id = apply(db);
  // The clerk who pays claims to be a volunteer.
  assert.throws(() => recordStage(db, id, 'verified', { id: 'CLERK-T', role: 'chv' }), /registered as a clerk, not a community health volunteer/);
  // Someone nobody registered claims to be the committee.
  assert.throws(() => recordAward(db, id, 1_000, { id: 'NOBODY', role: 'committee' }), /not a registered bursary committee/);
  // A parent id that is not a household.
  assert.throws(() => createCase(db, { roundId: 'R-T', childId: 'CH-B', evidence: evidence(), actor: { id: 'HH-NONE', role: 'parent' } }), RoleNotPermittedError);
  assert.equal(getCurrentStage(db, id), 'applied');
  assert.deepEqual(listRefusedActions(db).map((r) => r.actorId), ['HH-NONE', 'NOBODY', 'CLERK-T']);
});

test('evidence must name a registered volunteer or teacher', (t) => {
  const db = freshDb(t);
  assert.throws(
    () => createCase(db, { roundId: 'R-T', childId: 'CH-A', evidence: evidence({ capturedBy: 'CHV-GHOST' }), actor: PARENT }),
    UnknownCapturerError,
  );
  assert.throws(
    () => createCase(db, { roundId: 'R-T', childId: 'CH-A', evidence: evidence({ capturedBy: 'CLERK-T', capturedByRole: 'chv' }), actor: PARENT }),
    UnknownCapturerError,
  );
});

test('the permission map cannot be widened at runtime', () => {
  assert.throws(() => (PERMITTED_ROLES.verified as ActorRole[]).push('clerk'));
  assert.ok(!PERMITTED_ROLES.verified.includes('clerk'));
});

test('the database itself refuses a stage recorded under the wrong role, on any connection', async (t) => {
  const db = freshDb(t);
  const id = apply(db);
  recordStage(db, id, 'verified', CHV);
  // Straight SQL, skipping the store: the schema's guards are the backstop.
  const insert = (stage: string, actorId: string, role: string, amount: number | null = null) =>
    db.prepare('INSERT INTO case_events (case_id, stage, amount, note, actor_id, actor_role, at) VALUES (?, ?, ?, NULL, ?, ?, ?)')
      .run(id, stage, amount, actorId, role, '2026-05-05T08:00:00.000Z');
  assert.throws(() => insert('approved', 'CLERK-T', 'clerk', 1_000), /role not permitted/);
  assert.throws(() => insert('approved', 'NOBODY', 'committee', 1_000), /role not permitted/);
  assert.throws(() => insert('approved', 'BC-T', 'committee', 999_999), /over budget/);
  assert.throws(() => insert('school_confirmed', 'SCH-OTHER', 'school'), /role not permitted/);
  assert.throws(
    () => db.prepare("INSERT INTO round_events (round_id, type, actor_id, actor_role, at) VALUES ('R-T', 'closed', 'BC-T', 'committee', '2026-05-05T08:00:00.000Z')").run(),
    /role not permitted/,
  );
  assert.equal(getCurrentStage(db, id), 'verified');
});
