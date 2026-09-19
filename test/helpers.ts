import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/connection.ts';
import { createRound, openRound, type Actor, type EvidenceInput } from '../src/store/cases.ts';
import { addChild, addHousehold, addSchool, addStaff } from '../src/store/registry.ts';

export const ROUND_CREATED_AT = '2026-05-01T07:00:00.000Z';
export const ROUND_OPENED_AT = '2026-05-01T08:00:00.000Z';

export const CLERK: Actor = { id: 'CLERK-T', role: 'clerk' };
export const PARENT: Actor = { id: 'HH-T', role: 'parent' };
export const CHV: Actor = { id: 'CHV-T', role: 'chv' };
export const COMMITTEE: Actor = { id: 'BC-T', role: 'committee' };

/** Registers every staff actor the tests use; the store resolves roles from here. Needs SCH-T to exist. */
export function registerStaff(db: DatabaseSync): void {
  addStaff(db, { id: 'CLERK-T', name: 'Test Clerk', role: 'clerk' });
  addStaff(db, { id: 'CHV-T', name: 'Test Volunteer', role: 'chv' });
  addStaff(db, { id: 'CHV-01', name: 'Evidence Volunteer', role: 'chv' });
  addStaff(db, { id: 'TCH-T', name: 'Test Teacher', role: 'teacher' });
  addStaff(db, { id: 'BC-T', name: 'Test Committee', role: 'committee' });
  addStaff(db, { id: 'SCH-T', name: 'Test School bursar', role: 'school', schoolId: 'SCH-T' });
}

/** A temp directory removed after the test. */
export function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'zamu-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

/** A fresh temp-file database with one school, household, two children, and an open round. */
export function freshDb(t: { after: (fn: () => void) => void }): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'zamu-test-'));
  const db = openDatabase(join(dir, 'zamu.db'));
  // Registered before the directory removal so the file is closed first.
  t.after(() => db.close());
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  addSchool(db, { id: 'SCH-T', name: 'Test School', county: 'Test County', ward: 'Test Ward' });
  registerStaff(db);
  addHousehold(db, { id: 'HH-T', guardianName: 'Test Guardian', phone: '+254700000999', language: 'sw' });
  addChild(db, { id: 'CH-A', householdId: 'HH-T', schoolId: 'SCH-T', name: 'Child A', admissionNo: 'ADM-A' });
  addChild(db, { id: 'CH-B', householdId: 'HH-T', schoolId: 'SCH-T', name: 'Child B', admissionNo: 'ADM-B' });
  createRound(db, { id: 'R-T', name: 'Test Round', ward: 'Test Ward', currency: 'KES', budget: 100_000 }, CLERK, ROUND_CREATED_AT);
  openRound(db, 'R-T', CLERK, ROUND_OPENED_AT);
  return db;
}

export function evidence(overrides: Partial<EvidenceInput> = {}): EvidenceInput {
  return {
    feeBalance: 18_000,
    houseType: 'mud',
    cattle: 0,
    hasGoatsOrPoultry: false,
    landAcres: 0.3,
    hasTitle: false,
    photoRef: 'evidence/test.jpg',
    lat: -0.35,
    lng: 36.9,
    capturedBy: 'CHV-01',
    capturedByRole: 'chv',
    capturedAt: '2026-05-04T08:00:00.000Z',
    ...overrides,
  };
}
