// Messages are derived from the append-only log, never sent by the code that advanced a case.
// That way a transition cannot happen without its message, and dispatching twice is harmless.
import type { DatabaseSync } from 'node:sqlite';
import { type Language, type MessageKey, t } from '../i18n/strings.ts';
import { rankRound } from '../queue/ranking.ts';
import { roundsWaited } from '../scoring/priority.ts';

/** The USSD code a parent dials, and where the queue is published. Shown in every message. */
export const USSD_CODE = process.env.ZAMU_USSD_CODE ?? '*384*1234#';
// `.example` is reserved (RFC 2606): it implies no government body and cannot belong to anyone.
export const QUEUE_SITE = process.env.ZAMU_SITE ?? 'zamu.example';

/** One SMS: 160 GSM-7 characters. Longer bodies are a bug, not something to truncate. */
export const MAX_SMS = 160;

export interface QueuedMessage {
  id: number;
  eventRef: string;
  phone: string;
  language: Language;
  template: MessageKey;
  body: string;
  caseId: string | null;
  roundId: string | null;
  at: string;
}

export interface SmsSender {
  name: string;
  send(message: QueuedMessage): Promise<{ providerRef?: string }>;
}

export class MessageTooLongError extends Error {
  constructor(template: string, body: string, septets: number) {
    super(`${template} renders ${septets} septets, over the ${MAX_SMS} limit: ${body}`);
    this.name = 'MessageTooLongError';
  }
}

export class UnfilledPlaceholderError extends Error {
  constructor(template: string, placeholder: string, body: string) {
    super(`${template} left ${placeholder} unfilled: ${body}`);
    this.name = 'UnfilledPlaceholderError';
  }
}

export class NonGsmCharacterError extends Error {
  constructor(template: string, characters: string[], body: string) {
    super(`${template} uses characters outside GSM-7 (${characters.join(' ')}): ${body}`);
    this.name = 'NonGsmCharacterError';
  }
}

// The GSM 03.38 basic alphabet, plus the extension set, whose members cost two septets each.
const GSM7_BASIC =
  '@\u00a3$\u00a5\u00e8\u00e9\u00f9\u00ec\u00f2\u00c7\n\u00d8\u00f8\r\u00c5\u00e5\u0394_\u03a6\u0393\u039b\u03a9\u03a0\u03a8\u03a3\u0398\u039e\u00c6\u00e6\u00df\u00c9 !"#\u00a4%&\'()*+,-./0123456789:;<=>?' +
  '\u00a1ABCDEFGHIJKLMNOPQRSTUVWXYZ\u00c4\u00d6\u00d1\u00dc\u00a7\u00bfabcdefghijklmnopqrstuvwxyz\u00e4\u00f6\u00f1\u00fc\u00e0';
const GSM7_EXTENDED = '^{}\\[~]|\u20ac';

/** Septets an SMS body costs: extension characters count double. */
export function septetLength(body: string): number {
  return [...body].reduce((total, char) => total + (GSM7_EXTENDED.includes(char) ? 2 : 1), 0);
}

export function nonGsmCharacters(body: string): string[] {
  return [...new Set([...body].filter((char) => !GSM7_BASIC.includes(char) && !GSM7_EXTENDED.includes(char)))];
}

/** "1 round" / "2 rounds" / "raundi 2", so no parent reads "1 round(s)". */
function roundsPhrase(language: Language, count: number): string {
  return language === 'sw' ? `raundi ${count}` : `${count} round${count === 1 ? '' : 's'}`;
}

const money = (amount: number, currency: string) =>
  `${currency} ${String(Math.round(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;

/**
 * Renders a template and refuses anything that would not arrive as one clean SMS:
 * an unfilled placeholder, a character outside GSM-7 (which would force UCS-2 and a
 * 70-character limit), or a body over 160 septets.
 */
export function renderBody(language: Language, template: MessageKey, values: Record<string, string | number>): string {
  const body = t(language, template, values);
  const unfilled = body.match(/\{\w+\}/);
  if (unfilled) throw new UnfilledPlaceholderError(template, unfilled[0], body);
  const foreign = nonGsmCharacters(body);
  if (foreign.length) throw new NonGsmCharacterError(template, foreign, body);
  const septets = septetLength(body);
  if (septets > MAX_SMS) throw new MessageTooLongError(template, body, septets);
  return body;
}

interface Recipient {
  phone: string;
  language: Language;
}

/**
 * Renders one message, reporting a failure rather than raising it: one unrenderable name
 * must not stop every later parent from being told anything.
 */
function tryRender(
  language: Language,
  template: MessageKey,
  values: Record<string, string | number>,
): string | undefined {
  try {
    return renderBody(language, template, values);
  } catch (err) {
    console.error(`Skipped ${template}: ${err instanceof Error ? err.message : err}`);
    return undefined;
  }
}

function insertMessage(
  db: DatabaseSync,
  message: {
    eventRef: string;
    recipient: Recipient;
    template: MessageKey;
    body: string;
    caseId?: string | null;
    roundId?: string | null;
    at: string;
  },
): boolean {
  // `OR IGNORE` leans on messages_once_per_event, so two overlapping runs cannot collide.
  const result = db.prepare(
    `INSERT OR IGNORE INTO messages (event_ref, phone, language, template, body, case_id, round_id, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    message.eventRef,
    message.recipient.phone,
    message.recipient.language,
    message.template,
    message.body,
    message.caseId ?? null,
    message.roundId ?? null,
    message.at,
  );
  return result.changes > 0;
}

interface RoundRow {
  id: string;
  name: string;
  currency: string;
  budget: number;
}

/** Households with at least one child on file, which are the ones a round concerns. */
function householdsWithChildren(db: DatabaseSync): (Recipient & { id: string })[] {
  return db
    .prepare(
      `SELECT DISTINCT h.id AS id, h.phone AS phone, h.language AS language
       FROM households h JOIN children c ON c.household_id = h.id ORDER BY h.id`,
    )
    .all() as unknown as (Recipient & { id: string })[];
}

/**
 * The longest wait among a household's children, by exactly the rule the queue uses for its
 * waiting bonus. One rule, so a "your turn" SMS can never contradict the queue a parent then sees.
 */
function roundsWaitedByHousehold(db: DatabaseSync, householdId: string, roundId: string): number {
  const children = db.prepare('SELECT id FROM children WHERE household_id = ?').all(householdId) as unknown as { id: string }[];
  return children.reduce((longest, child) => Math.max(longest, roundsWaited(db, child.id, roundId)), 0);
}

function queueRoundOpenings(db: DatabaseSync): number {
  // Only rounds that are still open: a present-tense invitation to a closed round is a lie,
  // and a household registered after the close would otherwise be invited to apply into nothing.
  const events = db
    .prepare(
      `SELECT e.id AS id, e.round_id AS round_id, e.at AS at FROM round_events e
       WHERE e.type = 'opened'
         AND NOT EXISTS (SELECT 1 FROM round_events c WHERE c.round_id = e.round_id AND c.type = 'closed')
       ORDER BY e.id`,
    )
    .all() as unknown as { id: number; round_id: string; at: string }[];
  let queued = 0;
  const households = householdsWithChildren(db);

  for (const event of events) {
    const round = db.prepare('SELECT id, name, currency, budget FROM rounds WHERE id = ?').get(event.round_id) as
      | RoundRow
      | undefined;
    if (!round) continue;
    const eventRef = `round_event:${event.id}`;

    for (const household of households) {
      const waited = roundsWaitedByHousehold(db, household.id, round.id);
      const template: MessageKey = waited > 0 ? 'smsYourTurn' : 'smsWindowOpen';
      const body = tryRender(household.language, template, {
        round: round.name,
        amount: money(round.budget, round.currency),
        rounds: roundsPhrase(household.language, waited),
        code: USSD_CODE,
        site: QUEUE_SITE,
      });
      if (body && insertMessage(db, { eventRef, recipient: household, template, body, roundId: round.id, at: event.at })) {
        queued++;
      }
    }
  }
  return queued;
}

const STAGE_TEMPLATES: Record<string, MessageKey | undefined> = {
  applied: undefined, // the USSD session already told them; a second message adds nothing
  verified: 'smsVerified',
  approved: 'smsAwarded',
  disbursed: 'smsDisbursed',
  school_confirmed: 'smsSchoolConfirmed',
  rejected: 'smsRejected',
};

interface StageEventRow {
  id: number;
  case_id: string;
  stage: string;
  amount: number | null;
  award_amount: number | null;
  at: string;
  round_id: string;
  round_name: string;
  currency: string;
  child_name: string;
  school: string;
  phone: string;
  language: Language;
}

function queueStageChanges(db: DatabaseSync): number {
  const events = db
    .prepare(
      `SELECT e.id AS id, e.case_id AS case_id, e.stage AS stage, e.amount AS amount, e.at AS at,
              (SELECT a.amount FROM case_events a WHERE a.case_id = e.case_id AND a.stage = 'approved'
               ORDER BY a.id DESC LIMIT 1) AS award_amount,
              c.round_id AS round_id, r.name AS round_name, r.currency AS currency,
              ch.name AS child_name, s.name AS school, h.phone AS phone, h.language AS language
       FROM case_events e
       JOIN cases c ON c.id = e.case_id
       JOIN rounds r ON r.id = c.round_id
       JOIN children ch ON ch.id = c.child_id
       JOIN schools s ON s.id = ch.school_id
       JOIN households h ON h.id = ch.household_id
       WHERE e.stage <> 'applied'
       ORDER BY e.id`,
    )
    .all() as unknown as StageEventRow[];

  let queued = 0;
  const positions = new Map<string, number>();
  const ranked = new Set<string>();

  for (const event of events) {
    const template = STAGE_TEMPLATES[event.stage];
    if (!template) continue;
    const eventRef = `case_event:${event.id}`;
    const recipient: Recipient = { phone: event.phone, language: event.language };

    if (!ranked.has(event.round_id)) {
      for (const entry of rankRound(db, event.round_id)) positions.set(`${event.round_id}:${entry.caseId}`, entry.position);
      ranked.add(event.round_id);
    }

    // A superseded case has no place in the queue; its history is not news for the parent,
    // who is told about the correction that replaced it instead.
    const position = positions.get(`${event.round_id}:${event.case_id}`);
    if (position === undefined) continue;

    const body = tryRender(event.language, template, {
      child: event.child_name,
      round: event.round_name,
      caseId: event.case_id,
      position,
      // "Paid" and "confirmed" events carry no amount of their own; they are about the award.
      amount: money(event.amount ?? event.award_amount ?? 0, event.currency),
      school: event.school,
      code: USSD_CODE,
    });
    if (
      body &&
      insertMessage(db, { eventRef, recipient, template, body, caseId: event.case_id, roundId: event.round_id, at: event.at })
    ) {
      queued++;
    }
  }
  return queued;
}

/** Attempts beyond this are pointless: a number that never accepts is not retried forever. */
export const MAX_ATTEMPTS = 5;

/** Writes a message for every event that does not have one yet. Safe to run repeatedly. */
export function queuePending(db: DatabaseSync): number {
  return queueRoundOpenings(db) + queueStageChanges(db);
}

function rowToMessage(row: Record<string, any>): QueuedMessage {
  return {
    id: row.id,
    eventRef: row.event_ref,
    phone: row.phone,
    language: row.language,
    template: row.template,
    body: row.body,
    caseId: row.case_id ?? null,
    roundId: row.round_id ?? null,
    at: row.at,
  };
}

/** Messages with no successful attempt yet, oldest first. */
export function pendingMessages(db: DatabaseSync): QueuedMessage[] {
  const rows = db
    .prepare(
      `SELECT * FROM messages m
       WHERE NOT EXISTS (SELECT 1 FROM message_attempts a WHERE a.message_id = m.id AND a.outcome = 'sent')
         AND (SELECT COUNT(*) FROM message_attempts a WHERE a.message_id = m.id) < ${MAX_ATTEMPTS}
       ORDER BY m.id`,
    )
    .all() as unknown as Record<string, any>[];
  return rows.map(rowToMessage);
}

export function listMessages(db: DatabaseSync, phone?: string): QueuedMessage[] {
  const rows = (
    phone
      ? db.prepare('SELECT * FROM messages WHERE phone = ? ORDER BY id').all(phone)
      : db.prepare('SELECT * FROM messages ORDER BY id').all()
  ) as unknown as Record<string, any>[];
  return rows.map(rowToMessage);
}

export interface SendReport {
  queued: number;
  sent: number;
  failed: number;
}

/** Attempts every pending message once. A failure is recorded, not raised: the next run retries. */
export async function sendQueued(db: DatabaseSync, sender: SmsSender): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (const message of pendingMessages(db)) {
    const at = new Date().toISOString();
    try {
      const { providerRef } = await sender.send(message);
      db.prepare(
        "INSERT INTO message_attempts (message_id, outcome, provider_ref, error, at) VALUES (?, 'sent', ?, NULL, ?)",
      ).run(message.id, providerRef ?? null, at);
      sent++;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      db.prepare(
        "INSERT INTO message_attempts (message_id, outcome, provider_ref, error, at) VALUES (?, 'failed', NULL, ?, ?)",
      ).run(message.id, reason.slice(0, 500), at);
      failed++;
    }
  }
  return { sent, failed };
}

export async function dispatch(db: DatabaseSync, sender: SmsSender): Promise<SendReport> {
  const queued = queuePending(db);
  const { sent, failed } = await sendQueued(db, sender);
  return { queued, sent, failed };
}
