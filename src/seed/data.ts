// Deterministic synthetic demo data. Every name, phone number, school, and place is invented.
import { rmSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../db/connection.ts';
import {
  awardedTotal, closeRound, correctCase, createCase, createRound, openRound, recordAward, recordStage,
  type Actor, type EvidenceInput, type HouseType,
} from '../store/cases.ts';
import { addChild, addHousehold, addSchool } from '../store/registry.ts';
import { rankRound } from '../queue/ranking.ts';

export const WARD = 'Mwangaza Ward';
const COUNTY = 'Kilima County';
export const HOUSEHOLD_COUNT = 30;
export const CHILD_COUNT = 40;
/** Fake phone range reserved for demo data: +254700000001 – +254700000999. */
export const FAKE_PHONE_PATTERN = /^\+254700000\d{3}$/;

const GUARDIAN_FIRST = ['Wanjiru', 'Achieng', 'Mutua', 'Njeri', 'Otieno', 'Chebet', 'Kamau', 'Akinyi', 'Wafula', 'Nyambura'];
const SURNAMES = ['Kariuki', 'Odhiambo', 'Mwangi', 'Kiprono', 'Mutiso', 'Wekesa', 'Njoroge', 'Omondi', 'Barasa', 'Kilonzo'];
const CHILD_FIRST = ['Baraka', 'Imani', 'Neema', 'Juma', 'Zawadi', 'Tumaini', 'Amani', 'Faraja', 'Pendo', 'Jabali', 'Makena', 'Kioko', 'Wairimu', 'Kipchoge'];

const SCHOOLS = [
  { id: 'SCH-1', name: 'Mwangaza Secondary School' },
  { id: 'SCH-2', name: 'Kilima Girls High School' },
  { id: 'SCH-3', name: 'Tumaini Mixed Day Secondary School' },
];

const HOUSE_TYPES: HouseType[] = ['permanent', 'semi_permanent', 'mud'];
// Livestock bands from scoring-model.md: 5+ cattle, 1–4 cattle, goats/poultry only, none.
const LIVESTOCK = [
  { cattle: 7, hasGoatsOrPoultry: true },
  { cattle: 3, hasGoatsOrPoultry: true },
  { cattle: 0, hasGoatsOrPoultry: true },
  { cattle: 0, hasGoatsOrPoultry: false },
];
// Land bands: >2 acres (title or not), 0.5–2 acres, <0.5 acre or none.
// The untitled 3-acre entry exists so the demo shows that hiding a title deed does not raise a score.
const LAND = [
  { landAcres: 2.5, hasTitle: true },
  { landAcres: 1.2, hasTitle: true },
  { landAcres: 0.3, hasTitle: false },
  { landAcres: 3.0, hasTitle: false },
];
// Fee balance bands: 0, <10,000, 10,000–25,000, >25,000.
const FEE_BALANCES = [0, 6_500, 18_000, 32_000];

const ROUNDS = [
  { id: 'R-2025-T3', name: '2025 Term 3', budget: 150_000, opened: '2025-09-01', closed: '2025-10-15', applicants: 30 },
  { id: 'R-2026-T1', name: '2026 Term 1', budget: 150_000, opened: '2026-01-05', closed: '2026-02-20', applicants: 36 },
  { id: 'R-2026-T2', name: '2026 Term 2', budget: 180_000, opened: '2026-05-04', closed: null, applicants: CHILD_COUNT },
];

/**
 * Two children who applied in earlier rounds are left out of the open round, so a live demo
 * can apply for them over USSD and watch the queue change.
 */
export const OPEN_ROUND_SKIPPED = [34, 35];

/** Children 0–29 belong to households 0–29; children 30–39 are second children of households 0–9. */
export const householdOf = (child: number) => (child < HOUSEHOLD_COUNT ? child : child - HOUSEHOLD_COUNT);
const houseTypeOf = (h: number) => HOUSE_TYPES[h % 3];

/**
 * Demo of the "hide the cows" attack: household HH-005's first capture in the open round
 * recorded no livestock; a CHV re-visit found 7 cattle, so a correction supersedes the original.
 */
export const CORRECTED_CHILD_INDEX = 4;
export const CORRECTED_CHILD = `CH-${String(CORRECTED_CHILD_INDEX + 1).padStart(3, '0')}`;

const CLERK: Actor = { id: 'CLERK-01', role: 'clerk' };
const COMMITTEE: Actor = { id: 'BC-01', role: 'committee' };
const parentOf = (child: number): Actor => ({ id: hhId(householdOf(child)), role: 'parent' });
const capturerOf = (child: number): Actor => {
  const e = evidenceFor(child, 0, '2026-01-01');
  return { id: e.capturedBy, role: e.capturedByRole };
};

const hhId = (h: number) => `HH-${String(h + 1).padStart(3, '0')}`;
const childId = (c: number) => `CH-${String(c + 1).padStart(3, '0')}`;
const at = (date: string, minute: number) =>
  `${date}T${String(8 + Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00.000Z`;

function evidenceFor(child: number, round: number, date: string): EvidenceInput {
  const h = householdOf(child);
  const capturerIsChv = h % 2 === 0;
  return {
    feeBalance: FEE_BALANCES[(child + round) % 4] + (FEE_BALANCES[(child + round) % 4] === 0 ? 0 : child * 50),
    houseType: houseTypeOf(h),
    ...LIVESTOCK[h % 4],
    ...LAND[Math.floor(h / 2) % LAND.length],
    photoRef: `evidence/${hhId(h)}-${ROUNDS[round].id}.jpg`,
    lat: -0.35 - h * 0.002,
    lng: 36.9 + h * 0.003,
    capturedBy: capturerIsChv ? `CHV-0${(h % 3) + 1}` : `TCH-0${(h % 3) + 1}`,
    capturedByRole: capturerIsChv ? 'chv' : 'teacher',
    capturedAt: at(date, child),
  };
}

function seedRegistry(db: DatabaseSync): void {
  for (const s of SCHOOLS) addSchool(db, { ...s, county: COUNTY, ward: WARD });
  for (let h = 0; h < HOUSEHOLD_COUNT; h++) {
    addHousehold(db, {
      id: hhId(h),
      guardianName: `${GUARDIAN_FIRST[h % 10]} ${SURNAMES[(h * 3) % 10]}`,
      phone: `+254700000${String(h + 1).padStart(3, '0')}`,
      language: h % 3 === 0 ? 'en' : 'sw',
    });
  }
  for (let c = 0; c < CHILD_COUNT; c++) {
    const h = householdOf(c);
    addChild(db, {
      id: childId(c),
      householdId: hhId(h),
      schoolId: SCHOOLS[c % 3].id,
      name: `${CHILD_FIRST[c % CHILD_FIRST.length]} ${SURNAMES[(h * 3) % 10]}`,
      admissionNo: `ADM-${2021 + (c % 4)}-${String(100 + c)}`,
    });
  }
}

// Award size per closed round; recipients are the highest-priority applicants the budget covers.
const AWARD_AMOUNTS = [15_000, 12_500];

function seedRounds(db: DatabaseSync): void {
  let closedRoundsSoFar = 0;
  ROUNDS.forEach((round) => {
    createRound(db, { id: round.id, name: round.name, ward: WARD, currency: 'KES', budget: round.budget }, at(round.opened, 0));
    openRound(db, round.id, CLERK, at(round.opened, 0));

    for (let c = 0; c < round.applicants; c++) {
      if (round.closed === null && OPEN_ROUND_SKIPPED.includes(c)) continue;
      let evidence = evidenceFor(c, ROUNDS.indexOf(round), round.opened);
      if (round.closed === null && childId(c) === CORRECTED_CHILD) evidence = { ...evidence, cattle: 0, hasGoatsOrPoultry: false };
      const caseId = createCase(db, { roundId: round.id, childId: childId(c), evidence, actor: parentOf(c) }, at(round.opened, c + 1));
      if (round.closed === null) {
        if (c < 25) recordStage(db, caseId, 'verified', capturerOf(c), at(round.opened, c + 90));
        continue;
      }
      recordStage(db, caseId, 'verified', capturerOf(c), at(round.opened, c + 90));
    }
    if (round.closed !== null) {
      const amount = AWARD_AMOUNTS[closedRoundsSoFar++];
      if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error(`no award amount for closed round ${round.id}`);
      if (amount > round.budget) throw new Error(`round ${round.id}: budget ${round.budget} cannot cover one award of ${amount}`);
      const awards = awardByPriority(db, round.id, amount, round.budget, round.closed);
      closeRound(db, round.id, CLERK, at(round.closed, Math.max(240, awards + 121)));
    }
  });
}

/**
 * Awards the highest-priority applicants the budget can cover, ties going to the earlier
 * application — measured from the first case in a correction chain, so correcting evidence
 * never costs a household its place. This is the rule the public queue publishes, so demo
 * history matches what parents are shown. Returns the number of awards made.
 */
function awardByPriority(db: DatabaseSync, roundId: string, amount: number, budget: number, closed: string): number {
  let spent = awardedTotal(db, roundId);
  let awards = 0;
  for (const entry of rankRound(db, roundId)) {
    if (spent + amount > budget) break;
    if (entry.stage !== 'verified') continue;
    recordAward(db, entry.caseId, amount, COMMITTEE, at(closed, awards));
    recordStage(db, entry.caseId, 'disbursed', CLERK, at(closed, awards + 60));
    recordStage(db, entry.caseId, 'school_confirmed', schoolOfCase(db, entry.childId), at(closed, awards + 120));
    spent += amount;
    awards++;
  }
  return awards;
}

/** The school a child is actually registered at, rather than one re-derived from the id. */
function schoolOfCase(db: DatabaseSync, childId: string): Actor {
  const row = db.prepare('SELECT school_id FROM children WHERE id = ?').get(childId) as { school_id: string };
  return { id: row.school_id, role: 'school' };
}

function seedCorrection(db: DatabaseSync): void {
  const openRoundId = ROUNDS[2].id;
  const original = db
    .prepare('SELECT id FROM cases WHERE round_id = ? AND child_id = ?')
    .get(openRoundId, CORRECTED_CHILD) as { id: string };
  const truth = evidenceFor(CORRECTED_CHILD_INDEX, 2, '2026-05-20');
  const reviser: Actor = { id: 'CHV-02', role: 'chv' };
  correctCase(
    db,
    original.id,
    {
      evidence: {
        ...truth,
        capturedBy: reviser.id,
        capturedByRole: 'chv',
        photoRef: `evidence/${hhId(householdOf(CORRECTED_CHILD_INDEX))}-revisit.jpg`,
      },
      reason: "CHV re-visit found 7 cattle moved to a neighbour's homestead during the first visit",
      actor: reviser,
    },
    at('2026-05-20', 30),
  );
}

export interface SeedCounts {
  [table: string]: number;
}

/** Deletes the database file at `path` and rebuilds it with the demo dataset. */
export function seedDatabase(path: string): SeedCounts {
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(path + suffix, { force: true });
  const db = openDatabase(path);
  try {
    seedRegistry(db);
    seedRounds(db);
    seedCorrection(db);
    const counts: SeedCounts = {};
    for (const table of ['schools', 'households', 'children', 'rounds', 'round_events', 'cases', 'evidence', 'case_events']) {
      counts[table] = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    }
    return counts;
  } finally {
    db.close();
  }
}
