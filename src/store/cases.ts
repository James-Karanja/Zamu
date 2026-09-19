import type { DatabaseSync } from 'node:sqlite';
import { nonGsmCharacters } from '../i18n/gsm.ts';

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

// Who may do what. Nobody who pays also vouches for need; a school confirms only its own pupils.
export type Action =
  | 'create_round' | 'open_round' | 'close_round' | 'dispatch_sms' | 'apply' | 'correct'
  | 'verified' | 'rejected' | 'approved' | 'disbursed' | 'school_confirmed';

/** Frozen: nothing can widen the rules at runtime. */
export const PERMITTED_ROLES: Readonly<Record<Action, readonly ActorRole[]>> = Object.freeze({
  create_round: Object.freeze(['clerk'] as ActorRole[]),
  open_round: Object.freeze(['clerk'] as ActorRole[]),
  close_round: Object.freeze(['clerk'] as ActorRole[]),
  dispatch_sms: Object.freeze(['clerk'] as ActorRole[]),
  apply: Object.freeze(['parent', 'clerk'] as ActorRole[]),
  correct: Object.freeze(['chv', 'teacher'] as ActorRole[]),
  verified: Object.freeze(['chv', 'teacher'] as ActorRole[]),
  rejected: Object.freeze(['committee'] as ActorRole[]),
  approved: Object.freeze(['committee'] as ActorRole[]),
  disbursed: Object.freeze(['clerk'] as ActorRole[]),
  school_confirmed: Object.freeze(['school'] as ActorRole[]),
});

/** Plain-English verbs and role names for refusal messages staff will read. */
const ACTION_PHRASES: Record<Action, string> = {
  create_round: 'create a round',
  open_round: 'open a round',
  close_round: 'close a round',
  dispatch_sms: 'send the SMS queue',
  apply: 'make an application',
  correct: 'correct evidence',
  verified: 'verify a case',
  rejected: 'reject a case',
  approved: 'award a bursary',
  disbursed: 'mark a bursary paid',
  school_confirmed: 'confirm receipt',
};

export const ROLE_NAMES: Record<string, string> = {
  parent: 'parent',
  chv: 'community health volunteer',
  teacher: 'teacher',
  clerk: 'clerk',
  committee: 'bursary committee',
  school: 'school bursar',
  system: 'system',
};

const roleName = (role: string) => ROLE_NAMES[role] ?? role;

export class RoleNotPermittedError extends Error {
  constructor(actor: Actor, attempted: Action, reason: string) {
    super(`${actor.id} (${roleName(actor.role)}) may not ${ACTION_PHRASES[attempted] ?? attempted}: ${reason}`);
    this.name = 'RoleNotPermittedError';
  }
}
export class MissingReasonError extends Error {
  constructor(caseId: string, detail = 'needs a written reason') {
    super(`rejecting ${caseId} ${detail}`);
    this.name = 'MissingReasonError';
  }
}
export class UnknownCapturerError extends Error {
  constructor(capturer: string, role: string) {
    super(`evidence names ${capturer} as a ${roleName(role)}, but no such person is registered`);
    this.name = 'UnknownCapturerError';
  }
}

/** A rejection reason reaches the parent in an SMS, so it must fit and use the SMS alphabet. */
export const MAX_REASON_LENGTH = 50;

const now = () => new Date().toISOString();

/**
 * Records a refused action and raises it. The row is written outside any transaction, so the
 * refusal survives even though the action itself never happens.
 */
function refuse(db: DatabaseSync, actor: Actor, target: string, attempted: Action, reason: string): never {
  db.prepare(
    'INSERT INTO refused_actions (actor_id, actor_role, target, attempted, reason, at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(actor.id?.trim() || '(none)', actor.role?.trim() || '(none)', target?.trim() || '(none)', attempted, reason, now());
  throw new RoleNotPermittedError(actor, attempted, reason);
}

interface ResolvedActor {
  id: string;
  role: ActorRole;
  schoolId: string | null;
}

/**
 * Who the actor really is. The role is taken from the registry — staff for staff, households for
 * parents — never from what the caller claims, so a caller cannot promote itself.
 */
function resolveActor(db: DatabaseSync, actor: Actor): ResolvedActor | undefined {
  if (actor.role === 'parent') {
    const household = db.prepare('SELECT id FROM households WHERE id = ?').get(actor.id);
    return household ? { id: actor.id, role: 'parent', schoolId: null } : undefined;
  }
  const staff = db.prepare('SELECT id, role, school_id FROM staff WHERE id = ?').get(actor.id) as
    | { id: string; role: ActorRole; school_id: string | null }
    | undefined;
  return staff ? { id: staff.id, role: staff.role, schoolId: staff.school_id } : undefined;
}

/** Refuses and logs unless the registered person holds a role the map permits for this action. */
function requireRole(db: DatabaseSync, actor: Actor, target: string, attempted: Action): ResolvedActor {
  const resolved = resolveActor(db, actor);
  if (!resolved) refuse(db, actor, target, attempted, `${actor.id || 'this id'} is not a registered ${roleName(actor.role)}`);
  if (resolved.role !== actor.role) {
    refuse(db, actor, target, attempted, `${actor.id} is registered as a ${roleName(resolved.role)}, not a ${roleName(actor.role)}`);
  }
  const allowed = PERMITTED_ROLES[attempted];
  if (!allowed.includes(resolved.role)) {
    refuse(db, actor, target, attempted, `only a ${allowed.map(roleName).join(' or ')} may do this`);
  }
  return resolved;
}

/**
 * Logs an attempt by someone the registry does not know at all (the dashboard's forged or stale
 * staff id). Forged identities are the most suspicious attempts, so they belong on the record too.
 */
export function recordUnregisteredAttempt(db: DatabaseSync, claimedId: string, target: string, attempted: string): void {
  db.prepare(
    'INSERT INTO refused_actions (actor_id, actor_role, target, attempted, reason, at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(claimedId.trim().slice(0, 64) || '(none)', '(unregistered)', target.trim() || '(none)', attempted, 'not on the staff list', now());
}

/** For callers outside the store (the dashboard's SMS button): the same check, the same log. */
export function checkPermitted(db: DatabaseSync, actor: Actor, target: string, attempted: Action): void {
  requireRole(db, actor, target, attempted);
}

/** A school may confirm receipt only for a child registered at that school. */
function requireOwnSchool(db: DatabaseSync, actor: Actor, school: ResolvedActor, caseId: string): void {
  const row = db
    .prepare('SELECT ch.school_id AS school FROM cases c JOIN children ch ON ch.id = c.child_id WHERE c.id = ?')
    .get(caseId) as { school: string } | undefined;
  if (row && row.school !== school.schoolId) {
    refuse(db, actor, caseId, 'school_confirmed', `the child is registered at ${row.school}, not ${school.schoolId}`);
  }
}

/** Evidence must name a registered volunteer or teacher, so nobody can attribute a visit that never happened. */
function requireCapturer(db: DatabaseSync, evidence: EvidenceInput): void {
  const capturer = db.prepare('SELECT role FROM staff WHERE id = ?').get(evidence.capturedBy) as { role: string } | undefined;
  if (!capturer || capturer.role !== evidence.capturedByRole) {
    throw new UnknownCapturerError(evidence.capturedBy, evidence.capturedByRole);
  }
}

export interface RefusedAction {
  id: number;
  actorId: string;
  actorRole: string;
  target: string;
  attempted: string;
  reason: string;
  at: string;
}

/** Refused actions, newest first. */
export function listRefusedActions(db: DatabaseSync): RefusedAction[] {
  return (db.prepare('SELECT * FROM refused_actions ORDER BY id DESC').all() as unknown as Record<string, any>[]).map(
    (r) => ({ id: r.id, actorId: r.actor_id, actorRole: r.actor_role, target: r.target, attempted: r.attempted, reason: r.reason, at: r.at }),
  );
}

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

/** Guard messages raised by the BEFORE INSERT triggers, keyed by the unique column they protect. */
const GUARD_MESSAGES: Record<string, string> = {
  'cases.child_id': 'duplicate application',
  'cases.supersedes_case_id': 'already superseded',
};

function isUniqueViolation(err: unknown, column: string): boolean {
  if (!(err instanceof Error)) return false;
  const guard = GUARD_MESSAGES[column];
  return (err.message.includes('UNIQUE constraint failed') && err.message.includes(column)) ||
    (guard !== undefined && err.message.includes(guard));
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
  actor: Actor,
  at: string = now(),
): void {
  requireRole(db, actor, round.id, 'create_round');
  checkTimestamp(at);
  db.prepare(
    'INSERT INTO rounds (id, name, ward, currency, budget, actor_id, actor_role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(round.id, round.name, round.ward, round.currency, round.budget, actor.id, actor.role, at);
}

export function openRound(db: DatabaseSync, roundId: string, actor: Actor, at: string = now()): void {
  const round = requireRound(db, roundId);
  requireRole(db, actor, roundId, 'open_round');
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
  requireRole(db, actor, roundId, 'close_round');
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

// Verification requests — a child not yet on file cannot have an application, so the ask is recorded instead.

export type VerificationReason = 'stale_evidence' | 'no_evidence' | 'new_child';

export interface VerificationRequest {
  id: number;
  phone: string;
  childId: string | null;
  roundId: string | null;
  reason: VerificationReason;
  note: string;
  actorId: string;
  actorRole: ActorRole;
  at: string;
}

/**
 * Records that a household needs a visit. A request naming a child is not repeated for the
 * same reason and round — the table is append-only, so a parent pressing the same key twice
 * must not create two visits to chase. A request naming no child (a parent adding a child we
 * have never seen) is always recorded, because the second child is a different ask.
 * Returns whether a new request was recorded.
 */
export function requestVerification(
  db: DatabaseSync,
  input: {
    phone: string;
    childId?: string | null;
    roundId?: string | null;
    reason: VerificationReason;
    note: string;
    actor: Actor;
  },
  at: string = now(),
): boolean {
  checkTimestamp(at);
  const childId = input.childId ?? null;
  const roundId = input.roundId ?? null;
  // One ask per household, reason and round: a repeated keypress must not send two volunteers,
  // while a new round is a fresh ask.
  if (childId || roundId) {
    const existing = db
      .prepare('SELECT id FROM verification_requests WHERE phone = ? AND reason = ? AND child_id IS ? AND round_id IS ?')
      .get(input.phone, input.reason, childId, roundId);
    if (existing) return false;
  }
  db.prepare(
    `INSERT INTO verification_requests (phone, child_id, round_id, reason, note, actor_id, actor_role, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(input.phone, childId, roundId, input.reason, input.note, input.actor.id, input.actor.role, at);
  return true;
}

export function listVerificationRequests(db: DatabaseSync, phone?: string): VerificationRequest[] {
  const rows = (
    phone
      ? db.prepare('SELECT * FROM verification_requests WHERE phone = ? ORDER BY id').all(phone)
      : db.prepare('SELECT * FROM verification_requests ORDER BY id').all()
  ) as unknown as Record<string, any>[];
  return rows.map((r) => ({
    id: r.id,
    phone: r.phone,
    childId: r.child_id ?? null,
    roundId: r.round_id ?? null,
    reason: r.reason,
    note: r.note,
    actorId: r.actor_id,
    actorRole: r.actor_role,
    at: r.at,
  }));
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
  requireRound(db, input.roundId);
  // Role first: a wrong-role attempt is logged even if something else about it is also wrong.
  requireRole(db, input.actor, input.roundId, 'apply');
  checkTimestamp(at);
  requireCapturer(db, input.evidence);
  return transaction(db, () => {
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
  if (getCaseRow(db, originalCaseId)) requireRole(db, input.actor, originalCaseId, 'correct');
  checkTimestamp(at);
  requireCapturer(db, input.evidence);
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
  // `applied` is only ever written by createCase/correctCase; `approved` needs an amount (recordAward).
  if (!(STAGES as readonly string[]).includes(stage) || stage === 'approved' || stage === 'applied') {
    throw new InvalidStageError(stage);
  }
  const action = stage as Exclude<Stage, 'applied' | 'approved'>;
  // Role rules run before the transaction, so a refusal is logged even though nothing else is written.
  if (getCaseRow(db, caseId)) {
    const resolved = requireRole(db, actor, caseId, action);
    if (action === 'school_confirmed') requireOwnSchool(db, actor, resolved, caseId);
  }
  const reason = note?.trim() || null;
  transaction(db, () => {
    prepareTransition(db, caseId, action, at);
    // Checked after the lifecycle rules, so an impossible rejection reports why it is impossible.
    if (action === 'rejected') {
      if (!reason) throw new MissingReasonError(caseId);
      if (reason.length > MAX_REASON_LENGTH) {
        throw new MissingReasonError(caseId, `needs a reason of at most ${MAX_REASON_LENGTH} characters, to fit the parent's SMS`);
      }
      const foreign = nonGsmCharacters(reason);
      if (foreign.length) throw new MissingReasonError(caseId, `needs a reason in plain characters an SMS can carry (not ${foreign.join(' ')})`);
    }
    insertEvent(db, caseId, action, actor, at, reason, null);
  });
}

/** Records the `approved` stage with the awarded amount, within the round's budget. */
export function recordAward(db: DatabaseSync, caseId: string, amount: number, actor: Actor, at: string = now()): void {
  if (getCaseRow(db, caseId)) requireRole(db, actor, caseId, 'approved');
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
