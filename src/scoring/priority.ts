// Queue priority: need score plus a waiting bonus, so a parent can see when their turn comes.
import type { DatabaseSync } from 'node:sqlite';
import { type CaseRecord, RoundNotFoundError, getCase } from '../store/cases.ts';
import { scoreNeed } from './model.ts';

/** Points added for each earlier round the child applied in without being awarded. */
export const WAITING_BONUS_PER_ROUND = 10;

export interface QueuePriority {
  need: number;
  roundsWaited: number;
  waitingBonus: number;
  priority: number;
}

interface RoundOutcome {
  round_id: string;
  awards: number;
  last_stage: string;
}

/**
 * Counts the closed rounds the child applied in before `roundId` without receiving an award,
 * stopping at their last award. Rounds they did not apply in are skipped, not counted.
 * Two cases do not earn the bonus: a round still open has not decided anything yet, and a
 * rejected application was decided on its merits rather than passed over.
 */
export function roundsWaited(db: DatabaseSync, childId: string, roundId: string): number {
  const target = db.prepare('SELECT created_at FROM rounds WHERE id = ?').get(roundId) as
    | { created_at: string }
    | undefined;
  if (!target) throw new RoundNotFoundError(roundId);

  const rows = db
    .prepare(
      `SELECT c.round_id,
              (SELECT COUNT(*) FROM case_events e WHERE e.case_id = c.id AND e.stage = 'approved') AS awards,
              (SELECT e.stage FROM case_events e WHERE e.case_id = c.id ORDER BY e.id DESC LIMIT 1) AS last_stage
       FROM cases c
       JOIN rounds r ON r.id = c.round_id
       WHERE c.child_id = ?
         AND julianday(r.created_at) < julianday(?)
         AND EXISTS (SELECT 1 FROM round_events re WHERE re.round_id = r.id AND re.type = 'closed')
         AND NOT EXISTS (SELECT 1 FROM cases s WHERE s.supersedes_case_id = c.id)
       ORDER BY julianday(r.created_at) DESC, c.rowid DESC`,
    )
    .all(childId, target.created_at) as unknown as RoundOutcome[];

  let waited = 0;
  for (const row of rows) {
    if (row.awards > 0) break;
    if (row.last_stage === 'rejected') continue;
    waited++;
  }
  return waited;
}

/** Need score plus waiting bonus for a case, each reported separately. */
export function queuePriority(db: DatabaseSync, record: CaseRecord): QueuePriority {
  const round = db.prepare('SELECT currency FROM rounds WHERE id = ?').get(record.roundId) as
    | { currency: string }
    | undefined;
  if (!round) throw new RoundNotFoundError(record.roundId);
  const need = scoreNeed(record.evidence, round.currency).total;
  const waited = roundsWaited(db, record.childId, record.roundId);
  const waitingBonus = waited * WAITING_BONUS_PER_ROUND;
  return { need, roundsWaited: waited, waitingBonus, priority: need + waitingBonus };
}

/** Convenience for callers holding only a case id. */
export function queuePriorityOf(db: DatabaseSync, caseId: string): QueuePriority {
  return queuePriority(db, getCase(db, caseId));
}
