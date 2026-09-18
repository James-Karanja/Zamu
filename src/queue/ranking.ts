// One ranking rule for the round queue: everything that publishes an order uses this.
import type { DatabaseSync } from 'node:sqlite';
import { queuePriority } from '../scoring/priority.ts';
import {
  type CaseRecord, type Stage, RoundNotFoundError, awardedTotal, getCaseHistory, listCurrentCases,
} from '../store/cases.ts';

export class ChildNotFoundError extends Error {
  constructor(childId: string) {
    super(`child not found: ${childId}`);
    this.name = 'ChildNotFoundError';
  }
}

/** A round that was created but never opened is neither open nor decided. */
export type RoundStatus = 'not_opened' | 'open' | 'closed';

export interface QueueEntry {
  position: number;
  caseId: string;
  childId: string;
  /** Full name — for the parent's own view and admin screens, never for the public page. */
  name: string;
  maskedName: string;
  school: string;
  need: number;
  waitingBonus: number;
  roundsWaited: number;
  priority: number;
  stage: Stage;
  awardAmount: number | null;
  /** First application in this case's correction chain; the tie-break. */
  appliedAt: string;
}

/** Only the fields SPEC Constraints allow on the public queue. */
export interface PublicQueueEntry {
  position: number;
  caseId: string;
  maskedName: string;
  school: string;
  need: number;
  waitingBonus: number;
  priority: number;
  stage: Stage;
  awardAmount: number | null;
}

export interface RoundSummary {
  id: string;
  name: string;
  ward: string;
  currency: string;
  budget: number;
  awarded: number;
  recipients: number;
  applicants: number;
  status: RoundStatus;
}

/** Stars are fixed-width, so the mask never discloses how long a surname is. */
const MASK = '****';

/**
 * `Baraka Kariuki` becomes `B. K****`: a neighbour recognises the household,
 * a stranger cannot compile a list of poor families. Hyphenated names split too,
 * so `Wanjiru-Mwangi` keeps its second part.
 */
export function maskName(name: string): string {
  const parts = name.trim().split(/[\s-]+/).filter(Boolean);
  const initial = parts[0]?.charAt(0).toUpperCase() ?? '';
  if (!initial) return '';
  const surname = parts.length > 1 ? parts[parts.length - 1] : '';
  return surname ? `${initial}. ${surname.charAt(0).toUpperCase()}${MASK}` : `${initial}.`;
}

interface ChildRow {
  name: string;
  school: string;
}

function childOf(db: DatabaseSync, childId: string): ChildRow {
  const row = db
    .prepare('SELECT c.name AS name, s.name AS school FROM children c JOIN schools s ON s.id = c.school_id WHERE c.id = ?')
    .get(childId) as unknown as ChildRow | undefined;
  if (!row) throw new ChildNotFoundError(childId);
  return row;
}

function awardOf(record: CaseRecord): number | null {
  const approved = record.events.find((e) => e.stage === 'approved');
  return approved?.amount ?? null;
}

/**
 * Orders a round's current cases by priority; ties go to the household that applied first
 * (the first case in a correction chain, so fixing evidence never costs a place), then to
 * the lower case id.
 */
export function rankRound(db: DatabaseSync, roundId: string): QueueEntry[] {
  const round = db.prepare('SELECT id FROM rounds WHERE id = ?').get(roundId);
  if (!round) throw new RoundNotFoundError(roundId);
  return rankCases(db, listCurrentCases(db, roundId));
}

function rankCases(db: DatabaseSync, cases: CaseRecord[]): QueueEntry[] {
  return cases
    .map((record) => {
      const { need, waitingBonus, roundsWaited, priority } = queuePriority(db, record);
      const child = childOf(db, record.childId);
      return {
        caseId: record.id,
        childId: record.childId,
        name: child.name,
        maskedName: maskName(child.name),
        school: child.school,
        need,
        waitingBonus,
        roundsWaited,
        priority,
        stage: record.currentStage,
        awardAmount: awardOf(record),
        appliedAt: getCaseHistory(db, record.id)[0].createdAt,
      };
    })
    .sort((a, b) => b.priority - a.priority || a.appliedAt.localeCompare(b.appliedAt) || a.caseId.localeCompare(b.caseId))
    .map((entry, index) => ({ position: index + 1, ...entry }));
}

/** Strips an entry down to what may be published. */
export function publicEntry(entry: QueueEntry): PublicQueueEntry {
  return {
    position: entry.position,
    caseId: entry.caseId,
    maskedName: entry.maskedName,
    school: entry.school,
    need: entry.need,
    waitingBonus: entry.waitingBonus,
    priority: entry.priority,
    stage: entry.stage,
    awardAmount: entry.awardAmount,
  };
}

export function publicQueue(db: DatabaseSync, roundId: string): PublicQueueEntry[] {
  return rankRound(db, roundId).map(publicEntry);
}

function statusOf(db: DatabaseSync, roundId: string): RoundStatus {
  const last = db.prepare('SELECT type FROM round_events WHERE round_id = ? ORDER BY id DESC LIMIT 1').get(roundId) as
    | { type: string }
    | undefined;
  if (!last) return 'not_opened';
  return last.type === 'opened' ? 'open' : 'closed';
}

function summaryOf(db: DatabaseSync, roundId: string, cases: CaseRecord[]): RoundSummary {
  const row = db.prepare('SELECT id, name, ward, currency, budget FROM rounds WHERE id = ?').get(roundId) as unknown as
    | { id: string; name: string; ward: string; currency: string; budget: number }
    | undefined;
  if (!row) throw new RoundNotFoundError(roundId);
  return {
    ...row,
    awarded: awardedTotal(db, roundId),
    recipients: cases.filter((c) => c.events.some((e) => e.stage === 'approved')).length,
    applicants: cases.length,
    status: statusOf(db, roundId),
  };
}

export function roundSummary(db: DatabaseSync, roundId: string): RoundSummary {
  return summaryOf(db, roundId, listCurrentCases(db, roundId));
}

/** Summary and ranked queue from a single pass over the round's cases. */
export function roundView(db: DatabaseSync, roundId: string): { summary: RoundSummary; entries: PublicQueueEntry[] } {
  const round = db.prepare('SELECT id FROM rounds WHERE id = ?').get(roundId);
  if (!round) throw new RoundNotFoundError(roundId);
  const cases = listCurrentCases(db, roundId);
  return { summary: summaryOf(db, roundId, cases), entries: rankCases(db, cases).map(publicEntry) };
}

/** Rounds newest first, for the index page. */
export function listRounds(db: DatabaseSync): RoundSummary[] {
  const rows = db
    .prepare('SELECT id FROM rounds ORDER BY julianday(created_at) DESC, id DESC')
    .all() as unknown as { id: string }[];
  return rows.map((r) => roundSummary(db, r.id));
}
