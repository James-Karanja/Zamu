import type { DatabaseSync } from 'node:sqlite';

export class DuplicatePhoneError extends Error {
  constructor(phone: string) {
    super(`another household already uses ${phone}`);
    this.name = 'DuplicatePhoneError';
  }
}

export function addSchool(db: DatabaseSync, s: { id: string; name: string; county: string; ward: string }): void {
  db.prepare('INSERT INTO schools (id, name, county, ward) VALUES (?, ?, ?, ?)').run(s.id, s.name, s.county, s.ward);
}

export function addHousehold(
  db: DatabaseSync,
  h: { id: string; guardianName: string; phone: string; language: 'sw' | 'en' },
): void {
  try {
    db.prepare('INSERT INTO households (id, guardian_name, phone, language) VALUES (?, ?, ?, ?)').run(
      h.id, h.guardianName, h.phone, h.language,
    );
  } catch (err) {
    const unique = err instanceof Error && err.message.includes('UNIQUE constraint failed');
    if (unique && /households[._]phone/.test((err as Error).message)) throw new DuplicatePhoneError(h.phone);
    throw err;
  }
}

export function addChild(
  db: DatabaseSync,
  c: { id: string; householdId: string; schoolId: string; name: string; admissionNo: string },
): void {
  db.prepare('INSERT INTO children (id, household_id, school_id, name, admission_no) VALUES (?, ?, ?, ?, ?)').run(
    c.id, c.householdId, c.schoolId, c.name, c.admissionNo,
  );
}

export type StaffRole = 'chv' | 'teacher' | 'clerk' | 'committee' | 'school';

export interface StaffMember {
  id: string;
  name: string;
  role: StaffRole;
  schoolId: string | null;
}

export function addStaff(db: DatabaseSync, s: { id: string; name: string; role: StaffRole; schoolId?: string | null }): void {
  db.prepare('INSERT INTO staff (id, name, role, school_id) VALUES (?, ?, ?, ?)').run(s.id, s.name, s.role, s.schoolId ?? null);
}

/** A staff member by id — the only place an acting role comes from. */
export function getStaff(db: DatabaseSync, id: string): StaffMember | undefined {
  const row = db.prepare('SELECT * FROM staff WHERE id = ?').get(id) as Record<string, any> | undefined;
  return row ? { id: row.id, name: row.name, role: row.role, schoolId: row.school_id ?? null } : undefined;
}

export function listStaff(db: DatabaseSync): StaffMember[] {
  return (db.prepare('SELECT * FROM staff ORDER BY role, id').all() as unknown as Record<string, any>[]).map((row) => ({
    id: row.id, name: row.name, role: row.role, schoolId: row.school_id ?? null,
  }));
}
