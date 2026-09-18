import type { DatabaseSync } from 'node:sqlite';

export const STAGES = ['applied', 'verified', 'approved', 'disbursed', 'school_confirmed', 'rejected'] as const;
export type Stage = (typeof STAGES)[number];
export type HouseType = 'permanent' | 'semi_permanent' | 'mud';
export type CapturerRole = 'chv' | 'teacher';
export type ActorRole = 'parent' | 'chv' | 'teacher' | 'clerk' | 'committee' | 'school' | 'system';

/** Who performed an action. Recorded on every case, correction, stage change, and round event. */
export interface Actor {
  id: string;
  role: ActorRole;
}

/** Stages a case may move to from its current stage. A case may be approved only once. */
const NEXT_STAGES: Record<Stage, Stage[]> = {
  applied: ['verified', 'rejected'],
  verified: ['approved', 'rejected'],
  approved: ['disbursed'],
  disbursed: ['school_confirmed'],
  school_confirmed: [],
  rejected: [],
};

/** Stages at which a case may still be corrected; after an award it cannot. */
const CORRECTABLE_STAGES: Stage[] = ['applied', 'verified', 'rejected'];

export interface EvidenceInput {
  feeBalance: number;
  houseType: HouseType;
  cattle: number;
  hasGoatsOrPoultry: boolean;
  landAcres: number;
  hasTitle: boolean;
  photoRef: string;
  lat: number;
  lng: number;
  capturedBy: string;
  capturedByRole: CapturerRole;
  capturedAt: string;
}

export interface CaseEvent {
  id: number;
  stage: Stage;
  amount: number | null;
  note: string | null;
  actorId: string;
  actorRole: ActorRole;
  at: string;
}

export interface CaseRecord {
  id: string;
  roundId: string;
  childId: string;
  supersedesCaseId: string | null;
  /** Set when a later correction replaced this case; such a case is no longer current. */
  supersededByCaseId: string | null;
  correctionReason: string | null;
  actorId: string;
  actorRole: ActorRole;
  createdAt: string;
  currentStage: Stage;
  evidence: EvidenceInput;
  events: CaseEvent[];
}

export class CaseNotFoundError extends Error {
  constructor(caseId: string) {
    super(`case not found: ${caseId}`);
    this.name = 'CaseNotFoundError';
  }
}
export class AlreadySupersededError extends Error {
  constructor(caseId: string) {
    super(`case already superseded: ${caseId}`);
    this.name = 'AlreadySupersededError';
  }
}
export class InvalidStageError extends Error {
  constructor(stage: string) {
    super(`invalid stage: ${stage}`);
    this.name = 'InvalidStageError';
  }
}
export class InvalidTransitionError extends Error {
  constructor(caseId: string, from: Stage, to: Stage) {
    super(`case ${caseId} cannot move from ${from} to ${to}`);
    this.name = 'InvalidTransitionError';
  }
}
export class DuplicateApplicationError extends Error {
  constructor(childId: string, roundId: string) {
    super(`child ${childId} already applied in round ${roundId}`);
    this.name = 'DuplicateApplicationError';
  }
}
export class CaseNotCorrectableError extends Error {
  constructor(caseId: string, stage: Stage) {
    super(`case ${caseId} cannot be corrected at stage ${stage}`);
    this.name = 'CaseNotCorrectableError';
  }
}
export class RoundNotFoundError extends Error {
  constructor(roundId: string) {
    super(`round not found: ${roundId}`);
    this.name = 'RoundNotFoundError';
  }
}
export class RoundNotOpenError extends Error {
  constructor(roundId: string) {
    super(`round is not open: ${roundId}`);
    this.name = 'RoundNotOpenError';
  }
}
export class RoundStateError extends Error {
  constructor(roundId: string, message: string) {
    super(`round ${roundId}: ${message}`);
    this.name = 'RoundStateError';
  }
}
export class BudgetExceededError extends Error {
  constructor(roundId: string, budget: number, attempted: number) {
    super(`round ${roundId} budget ${budget} would be exceeded by awards totalling ${attempted}`);
    this.name = 'BudgetExceededError';
  }
}
export class InvalidAmountError extends Error {
  constructor(amount: number) {
    super(`award amount must be a positive whole number: ${amount}`);
    this.name = 'InvalidAmountError';
  }
}
export class InvalidTimestampError extends Error {
  constructor(at: string, notBefore?: string) {
    super(notBefore ? `timestamp ${at} is earlier than ${notBefore}` : `timestamp is not ISO-8601: ${at}`);
    this.name = 'InvalidTimestampError';
  }
}

const now = () => new Date().toISOString();

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

function checkTimestamp(at: string, notBefore?: string | null): string {
  if (!ISO_8601.test(at) || Number.isNaN(Date.parse(at))) throw new InvalidTimestampError(at);
  if (notBefore && Date.parse(at) < Date.parse(notBefore)) throw new InvalidTimestampError(at, notBefore);
  return at;
}

function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

function isUniqueViolation(err: unknown, column: string): boolean {
  return err instanceof Error && err.message.includes('UNIQUE constraint failed') && err.message.includes(column);
}

// Rounds

interface RoundRow {
  id: string;
  name: string;
  ward: string;
  currency: string;
  budget: number;
  created_at: string;
}

function getRoundRow(db: DatabaseSync, roundId: string): RoundRow | undefined {
  return db.prepare('SELECT * FROM rounds WHERE id = ?').get(roundId) as RoundRow | undefined;
}

function requireRound(db: DatabaseSync, roundId: string): RoundRow {
  const round = getRoundRow(db, roundId);
  if (!round) throw new RoundNotFoundError(roundId);
  return round;
}

function lastRoundEvent(db: DatabaseSync, roundId: string): { type: string; at: string } | undefined {
  return db.prepare('SELECT type, at FROM round_events WHERE round_id = ? ORDER BY id DESC LIMIT 1').get(roundId) as
    | { type: string; at: string }
    | undefined;
}

export function createRound(
  db: DatabaseSync,
  round: { id: string; name: string; ward: string; currency: string; budget: number },
  at: string = now(),
): void {
  checkTimestamp(at);
  db.prepare('INSERT INTO rounds (id, name, ward, currency, budget, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    round.id, round.name, round.ward, round.currency, round.budget, at,
  );
}

export function openRound(db: DatabaseSync, roundId: string, actor: Actor, at: string = now()): void {
  const round = requireRound(db, roundId);
  const last = lastRoundEvent(db, roundId);
  if (last?.type === 'opened') throw new RoundStateError(roundId, 'already open');
  if (last?.type === 'closed') throw new RoundStateError(roundId, 'closed rounds cannot reopen');
  checkTimestamp(at, round.created_at);
  db.prepare("INSERT INTO round_events (round_id, type, actor_id, actor_role, at) VALUES (?, 'opened', ?, ?, ?)").run(
    roundId, actor.id, actor.role, at,
  );
}

export function closeRound(db: DatabaseSync, roundId: string, actor: Actor, at: string = now()): void {
  requireRound(db, roundId);
  const last = lastRoundEvent(db, roundId);
  if (last?.type !== 'opened') throw new RoundStateError(roundId, 'only an open round can be closed');
  checkTimestamp(at, last.at);
  db.prepare("INSERT INTO round_events (round_id, type, actor_id, actor_role, at) VALUES (?, 'closed', ?, ?, ?)").run(
    roundId, actor.id, actor.role, at,
  );
}

export function isRoundOpen(db: DatabaseSync, roundId: string): boolean {
  return lastRoundEvent(db, roundId)?.type === 'opened';
}

/** Total of the round's approved awards. */
export function awardedTotal(db: DatabaseSync, roundId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(e.amount), 0) AS total FROM case_events e
       JOIN cases c ON c.id = e.case_id
       WHERE c.round_id = ? AND e.stage = 'approved'`,
    )
    .get(roundId) as { total: number };
  return row.total;
}

// Cases

function nextCaseId(db: DatabaseSync): string {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM cases').get() as { n: number };
  return `ZM-${String(n + 1).padStart(4, '0')}`;
}

function insertEvidence(db: DatabaseSync, caseId: string, e: EvidenceInput): void {
  checkTimestamp(e.capturedAt);
  db.prepare(
    `INSERT INTO evidence (case_id, fee_balance, house_type, cattle, has_goats_or_poultry, land_acres, has_title,
       photo_ref, lat, lng, captured_by, captured_by_role, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    caseId, e.feeBalance, e.houseType, e.cattle, e.hasGoatsOrPoultry ? 1 : 0, e.landAcres, e.hasTitle ? 1 : 0,
    e.photoRef, e.lat, e.lng, e.capturedBy, e.capturedByRole, e.capturedAt,
  );
}

function insertEvent(
  db: DatabaseSync,
  caseId: string,
  stage: Stage,
  actor: Actor,
  at: string,
  note: string | null,
  amount: number | null,
): void {
  db.prepare(
    'INSERT INTO case_events (case_id, stage, amount, note, actor_id, actor_role, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(caseId, stage, amount, note, actor.id, actor.role, at);
}

/** Creates an application for a child in an open round, with its evidence, and records the `applied` stage. */
export function createCase(
  db: DatabaseSync,
  input: { roundId: string; childId: string; evidence: EvidenceInput; actor: Actor },
  at: string = now(),
): string {
  checkTimestamp(at);
  return transaction(db, () => {
    requireRound(db, input.roundId);
    const opened = lastRoundEvent(db, input.roundId);
    if (opened?.type !== 'opened') throw new RoundNotOpenError(input.roundId);
    checkTimestamp(at, opened.at);
    const id = nextCaseId(db);
    try {
      db.prepare(
        'INSERT INTO cases (id, round_id, child_id, actor_id, actor_role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(id, input.roundId, input.childId, input.actor.id, input.actor.role, at);
    } catch (err) {
      if (isUniqueViolation(err, 'cases.child_id')) throw new DuplicateApplicationError(input.childId, input.roundId);
      throw err;
    }
    insertEvidence(db, id, input.evidence);
    insertEvent(db, id, 'applied', input.actor, at, null, null);
    return id;
  });
}

/**
 * Corrects a case by creating a new case that supersedes it. The original is never changed.
 * Only allowed while the round is open and the case has not been awarded; the correction
 * starts again at `applied`, so it must be re-verified.
 */
export function correctCase(
  db: DatabaseSync,
  originalCaseId: string,
  input: { evidence: EvidenceInput; reason: string; actor: Actor },
  at: string = now(),
): string {
  checkTimestamp(at);
  return transaction(db, () => {
    const original = getCaseRow(db, originalCaseId);
    if (!original) throw new CaseNotFoundError(originalCaseId);
    if (!isRoundOpen(db, original.round_id)) throw new RoundNotOpenError(original.round_id);
    const previous = lastEvent(db, originalCaseId);
    if (!CORRECTABLE_STAGES.includes(previous.stage)) throw new CaseNotCorrectableError(originalCaseId, previous.stage);
    checkTimestamp(at, previous.at);
    const id = nextCaseId(db);
    try {
      db.prepare(
        `INSERT INTO cases (id, round_id, child_id, supersedes_case_id, correction_reason, actor_id, actor_role, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, original.round_id, original.child_id, originalCaseId, input.reason, input.actor.id, input.actor.role, at);
    } catch (err) {
      if (isUniqueViolation(err, 'cases.supersedes_case_id')) throw new AlreadySupersededError(originalCaseId);
      throw err;
    }
    insertEvidence(db, id, input.evidence);
    insertEvent(db, id, 'applied', input.actor, at, `correction of ${originalCaseId}: ${input.reason}`, null);
    return id;
  });
}

function supersededBy(db: DatabaseSync, caseId: string): string | null {
  const row = db.prepare('SELECT id FROM cases WHERE supersedes_case_id = ?').get(caseId) as { id: string } | undefined;
  return row?.id ?? null;
}

function lastEvent(db: DatabaseSync, caseId: string): { stage: Stage; at: string } {
  return db.prepare('SELECT stage, at FROM case_events WHERE case_id = ? ORDER BY id DESC LIMIT 1').get(caseId) as {
    stage: Stage;
    at: string;
  };
}

function currentStage(db: DatabaseSync, caseId: string): Stage {
  return lastEvent(db, caseId).stage;
}

/** Stages that decide an application; they may only be recorded while the round is open. */
const DECISION_STAGES: Stage[] = ['verified', 'approved', 'rejected'];

/** Checks the case exists, is still current, and that `stage` is a legal next stage. */
function prepareTransition(db: DatabaseSync, caseId: string, stage: Stage, at: string): CaseRow {
  const row = getCaseRow(db, caseId);
  if (!row) throw new CaseNotFoundError(caseId);
  if (supersededBy(db, caseId)) throw new AlreadySupersededError(caseId);
  if (DECISION_STAGES.includes(stage) && !isRoundOpen(db, row.round_id)) throw new RoundNotOpenError(row.round_id);
  const previous = lastEvent(db, caseId);
  if (!NEXT_STAGES[previous.stage].includes(stage)) throw new InvalidTransitionError(caseId, previous.stage, stage);
  checkTimestamp(at, previous.at);
  return row;
}

/** Records a stage change as a new event. Use `recordAward` for `approved`, which needs an amount. */
export function recordStage(
  db: DatabaseSync,
  caseId: string,
  stage: string,
  actor: Actor,
  at: string = now(),
  note?: string,
): void {
  if (!(STAGES as readonly string[]).includes(stage) || stage === 'approved') throw new InvalidStageError(stage);
  transaction(db, () => {
    prepareTransition(db, caseId, stage as Stage, at);
    insertEvent(db, caseId, stage as Stage, actor, at, note ?? null, null);
  });
}

/** Records the `approved` stage with the awarded amount, within the round's budget. */
export function recordAward(db: DatabaseSync, caseId: string, amount: number, actor: Actor, at: string = now()): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new InvalidAmountError(amount);
  transaction(db, () => {
    const row = prepareTransition(db, caseId, 'approved', at);
    const round = requireRound(db, row.round_id);
    const total = awardedTotal(db, row.round_id) + amount;
    if (total > round.budget) throw new BudgetExceededError(row.round_id, round.budget, total);
    insertEvent(db, caseId, 'approved', actor, at, null, amount);
  });
}

export function getCurrentStage(db: DatabaseSync, caseId: string): Stage {
  if (!getCaseRow(db, caseId)) throw new CaseNotFoundError(caseId);
  return currentStage(db, caseId);
}

interface CaseRow {
  id: string;
  round_id: string;
  child_id: string;
  supersedes_case_id: string | null;
  correction_reason: string | null;
  actor_id: string;
  actor_role: ActorRole;
  created_at: string;
}

function getCaseRow(db: DatabaseSync, caseId: string): CaseRow | undefined {
  return db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId) as CaseRow | undefined;
}

function toRecord(db: DatabaseSync, row: CaseRow): CaseRecord {
  const e = db.prepare('SELECT * FROM evidence WHERE case_id = ?').get(row.id) as Record<string, any>;
  const events = db
    .prepare('SELECT id, stage, amount, note, actor_id, actor_role, at FROM case_events WHERE case_id = ? ORDER BY id')
    .all(row.id) as unknown as Record<string, any>[];
  return {
    id: row.id,
    roundId: row.round_id,
    childId: row.child_id,
    supersedesCaseId: row.supersedes_case_id,
    supersededByCaseId: supersededBy(db, row.id),
    correctionReason: row.correction_reason,
    actorId: row.actor_id,
    actorRole: row.actor_role,
    createdAt: row.created_at,
    currentStage: events[events.length - 1].stage as Stage,
    evidence: {
      feeBalance: e.fee_balance,
      houseType: e.house_type,
      cattle: e.cattle,
      hasGoatsOrPoultry: e.has_goats_or_poultry === 1,
      landAcres: e.land_acres,
      hasTitle: e.has_title === 1,
      photoRef: e.photo_ref,
      lat: e.lat,
      lng: e.lng,
      capturedBy: e.captured_by,
      capturedByRole: e.captured_by_role,
      capturedAt: e.captured_at,
    },
    events: events.map((ev) => ({
      id: ev.id,
      stage: ev.stage,
      amount: ev.amount,
      note: ev.note,
      actorId: ev.actor_id,
      actorRole: ev.actor_role,
      at: ev.at,
    })),
  };
}

export function getCase(db: DatabaseSync, caseId: string): CaseRecord {
  const row = getCaseRow(db, caseId);
  if (!row) throw new CaseNotFoundError(caseId);
  return toRecord(db, row);
}

/** Returns the full correction chain containing this case, oldest first. */
export function getCaseHistory(db: DatabaseSync, caseId: string): CaseRecord[] {
  let row = getCaseRow(db, caseId);
  if (!row) throw new CaseNotFoundError(caseId);
  while (row.supersedes_case_id) row = getCaseRow(db, row.supersedes_case_id)!;
  const chain: CaseRecord[] = [];
  let current: CaseRow | undefined = row;
  while (current) {
    chain.push(toRecord(db, current));
    current = db.prepare('SELECT * FROM cases WHERE supersedes_case_id = ?').get(current.id) as CaseRow | undefined;
  }
  return chain;
}

/** Cases in a round that have not been superseded, in insertion order. */
export function listCurrentCases(db: DatabaseSync, roundId: string): CaseRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM cases c WHERE c.round_id = ?
         AND NOT EXISTS (SELECT 1 FROM cases s WHERE s.supersedes_case_id = c.id)
       ORDER BY c.rowid`,
    )
    .all(roundId) as unknown as CaseRow[];
  return rows.map((r) => toRecord(db, r));
}
