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

test('a plain connection, as the sqlite3 CLI would open it, cannot rewrite history either', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const { seedDatabase } = await import('../src/seed/data.ts');

  const dir = mkdtempSync(join(tmpdir(), 'zamu-plain-'));
  const path = join(dir, 'zamu.db');
  seedDatabase(path);
  // No openDatabase: none of Zamu's pragmas, exactly what a clerk with the file would get.
  const plain = new DatabaseSync(path);
  t.after(() => {
    plain.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  assert.equal((plain.prepare('PRAGMA recursive_triggers').get() as { recursive_triggers: number }).recursive_triggers, 0);

  const target = plain.prepare('SELECT case_id, cattle FROM evidence ORDER BY id LIMIT 1').get() as { case_id: string; cattle: number };
  const attacks: [string, () => void][] = [
    ['UPDATE evidence', () => plain.prepare('UPDATE evidence SET cattle = 0 WHERE case_id = ?').run(target.case_id)],
    ['DELETE evidence', () => plain.prepare('DELETE FROM evidence WHERE case_id = ?').run(target.case_id)],
    ['REPLACE evidence', () => plain.prepare(
      `INSERT OR REPLACE INTO evidence (case_id, fee_balance, house_type, cattle, has_goats_or_poultry, land_acres, has_title,
         photo_ref, lat, lng, captured_by, captured_by_role, captured_at)
       VALUES (?, 0, 'permanent', 0, 0, 3.0, 1, 'x.jpg', -0.3, 36.9, 'X', 'chv', '2026-05-04T08:00:00.000Z')`,
    ).run(target.case_id)],
    ['REPLACE case', () => plain.prepare(
      `INSERT OR REPLACE INTO cases (id, round_id, child_id, actor_id, actor_role, created_at)
       SELECT id, round_id, 'CH-002', 'X', 'clerk', created_at FROM cases WHERE id = ?`,
    ).run(target.case_id)],
    ['REPLACE case_event', () => plain.exec(
      "INSERT OR REPLACE INTO case_events (id, case_id, stage, amount, note, actor_id, actor_role, at) SELECT id, case_id, 'rejected', NULL, NULL, 'X', 'clerk', at FROM case_events ORDER BY id LIMIT 1",
    )],
    ['REPLACE round', () => plain.exec(
      "INSERT OR REPLACE INTO rounds (id, name, ward, currency, budget, created_at) SELECT id, name, ward, currency, 999999, created_at FROM rounds LIMIT 1",
    )],
    ['REPLACE round_event', () => plain.exec(
      "INSERT OR REPLACE INTO round_events (id, round_id, type, actor_id, actor_role, at) SELECT id, round_id, 'closed', 'X', 'clerk', at FROM round_events ORDER BY id LIMIT 1",
    )],
  ];
  const caseBefore = plain.prepare('SELECT child_id FROM cases WHERE id = ?').get(target.case_id) as { child_id: string };
  for (const [name, attack] of attacks) {
    // Whichever guard fires first, the write must be refused.
    assert.throws(attack, /immutable record|duplicate application|already superseded/, `${name} was allowed on a plain connection`);
  }
  const after = plain.prepare('SELECT cattle FROM evidence WHERE case_id = ?').get(target.case_id) as { cattle: number };
  assert.equal(after.cattle, target.cattle, 'the evidence is unchanged after every attempt');
  const caseAfter = plain.prepare('SELECT child_id FROM cases WHERE id = ?').get(target.case_id) as { child_id: string };
  assert.equal(caseAfter.child_id, caseBefore.child_id, 'the case still belongs to the same child');
});
