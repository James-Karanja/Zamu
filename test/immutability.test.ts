import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeRound, createCase, recordStage, requestVerification } from '../src/store/cases.ts';
import { CHV, CLERK, PARENT, evidence, freshDb } from './helpers.ts';

const APPEND_ONLY = {
  cases: {
    update: "UPDATE cases SET child_id = 'CH-B'",
    replace: `INSERT OR REPLACE INTO cases (id, round_id, child_id, actor_id, actor_role, created_at)
              VALUES ('ZM-0001', 'R-T', 'CH-B', 'X', 'clerk', '2026-05-04T08:00:00.000Z')`,
  },
  evidence: {
    update: 'UPDATE evidence SET cattle = 0',
    replace: `INSERT OR REPLACE INTO evidence (case_id, fee_balance, house_type, cattle, has_goats_or_poultry,
                land_acres, has_title, photo_ref, lat, lng, captured_by, captured_by_role, captured_at)
              VALUES ('ZM-0001', 0, 'permanent', 0, 0, 3.0, 1, 'x.jpg', -0.3, 36.9, 'X', 'chv', '2026-05-04T08:00:00.000Z')`,
  },
  case_events: {
    update: "UPDATE case_events SET stage = 'rejected'",
    replace: `INSERT OR REPLACE INTO case_events (id, case_id, stage, amount, note, actor_id, actor_role, at)
              VALUES (1, 'ZM-0001', 'rejected', NULL, NULL, 'X', 'clerk', '2026-05-04T08:00:00.000Z')`,
  },
  round_events: {
    update: "UPDATE round_events SET type = 'closed'",
    replace: `INSERT OR REPLACE INTO round_events (id, round_id, type, actor_id, actor_role, at)
              VALUES (1, 'R-T', 'closed', 'X', 'clerk', '2026-05-04T08:00:00.000Z')`,
  },
  verification_requests: {
    update: "UPDATE verification_requests SET note = 'edited'",
    replace: `INSERT OR REPLACE INTO verification_requests (id, phone, child_id, round_id, reason, note, actor_id, actor_role, at)
              VALUES (1, '+254700000999', NULL, NULL, 'new_child', 'rewritten', 'X', 'parent', '2026-05-04T08:00:00.000Z')`,
  },
  rounds: {
    update: 'UPDATE rounds SET budget = 999999',
    replace: `INSERT OR REPLACE INTO rounds (id, name, ward, currency, budget, created_at)
              VALUES ('R-T', 'Rewritten', 'Test Ward', 'KES', 999999, '2026-05-04T08:00:00.000Z')`,
  },
};

function seedOneCase(db: ReturnType<typeof freshDb>): string {
  const caseId = createCase(db, { roundId: 'R-T', childId: 'CH-A', evidence: evidence({ cattle: 7 }), actor: PARENT });
  recordStage(db, caseId, 'verified', CHV);
  // Every append-only table needs a row, or a DELETE would pass on an empty table.
  requestVerification(db, { phone: '+254700000999', reason: 'new_child', note: 'home visit please', actor: PARENT });
  return caseId;
}

for (const [table, sql] of Object.entries(APPEND_ONLY)) {
  test(`${table}: direct UPDATE is rejected by the database`, (t) => {
    const db = freshDb(t);
    seedOneCase(db);
    closeRound(db, 'R-T', CLERK);
    assert.throws(() => db.exec(sql.update), /immutable record/);
  });

  test(`${table}: direct DELETE is rejected by the database`, (t) => {
    const db = freshDb(t);
    seedOneCase(db);
    assert.throws(() => db.exec(`DELETE FROM ${table}`), /immutable record/);
  });

  test(`${table}: INSERT OR REPLACE over an existing row is rejected`, (t) => {
    const db = freshDb(t);
    seedOneCase(db);
    assert.throws(() => db.exec(sql.replace), /immutable record/);
  });
}

test('rejected edits leave the original values intact', (t) => {
  const db = freshDb(t);
  const caseId = seedOneCase(db);
  assert.throws(() => db.exec('UPDATE evidence SET cattle = 0'), /immutable record/);
  assert.throws(() => db.exec(APPEND_ONLY.evidence.replace), /immutable record/);
  const row = db.prepare('SELECT cattle FROM evidence WHERE case_id = ?').get(caseId) as { cattle: number };
  assert.equal(row.cattle, 7);
  const budget = db.prepare("SELECT budget FROM rounds WHERE id = 'R-T'").get() as { budget: number };
  assert.equal(budget.budget, 100_000);
});
