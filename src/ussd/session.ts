// Stateless USSD session: Africa's Talking sends the whole keypress history in `text`,
// so the current screen is derived from it and nothing is stored between requests.
import type { DatabaseSync } from 'node:sqlite';
import { type Language, t } from '../i18n/strings.ts';
import { type QueueEntry, rankRound } from '../queue/ranking.ts';
import { MAX_SCORE, scoreNeed } from '../scoring/model.ts';
import {
  type EvidenceInput, DuplicateApplicationError, RoundNotOpenError, createCase, getCase, requestVerification,
} from '../store/cases.ts';

/** USSD screens are limited by the network; Africa's Talking allows 182 characters. */
export const MAX_SCREEN = 182;

/** Evidence older than this is reused to let a parent apply, but a re-visit is requested. */
export const EVIDENCE_FRESH_DAYS = 180;

export interface UssdRequest {
  phoneNumber: string;
  text: string;
  /** Injectable clock, so evidence-freshness behaviour is testable rather than wall-clock dependent. */
  now?: number;
}

export interface UssdReply {
  type: 'CON' | 'END';
  text: string;
}

const con = (text: string): UssdReply => ({ type: 'CON', text });
const end = (text: string): UssdReply => ({ type: 'END', text });

interface Household {
  id: string;
  language: Language;
}

interface Child {
  id: string;
  name: string;
}

function householdOf(db: DatabaseSync, phone: string): Household | undefined {
  return db.prepare('SELECT id, language FROM households WHERE phone = ?').get(phone) as unknown as Household | undefined;
}

function childrenOf(db: DatabaseSync, householdId: string): Child[] {
  return db.prepare('SELECT id, name FROM children WHERE household_id = ? ORDER BY id').all(householdId) as unknown as Child[];
}

function openRound(db: DatabaseSync): { id: string; name: string } | undefined {
  return db
    .prepare(
      `SELECT r.id, r.name FROM rounds r
       WHERE (SELECT e.type FROM round_events e WHERE e.round_id = r.id ORDER BY e.id DESC LIMIT 1) = 'opened'
       ORDER BY julianday(r.created_at) DESC LIMIT 1`,
    )
    .get() as unknown as { id: string; name: string } | undefined;
}

/** The last evidence captured for this child, which an application in a later round reuses. */
function evidenceOnFile(db: DatabaseSync, childId: string): EvidenceInput | undefined {
  const row = db
    .prepare(
      `SELECT e.* FROM evidence e JOIN cases c ON c.id = e.case_id
       WHERE c.child_id = ? ORDER BY e.id DESC LIMIT 1`,
    )
    .get(childId) as unknown as Record<string, any> | undefined;
  if (!row) return undefined;
  return {
    feeBalance: row.fee_balance,
    houseType: row.house_type,
    cattle: row.cattle,
    hasGoatsOrPoultry: row.has_goats_or_poultry === 1,
    landAcres: row.land_acres,
    hasTitle: row.has_title === 1,
    photoRef: row.photo_ref,
    lat: row.lat,
    lng: row.lng,
    capturedBy: row.captured_by,
    capturedByRole: row.captured_by_role,
    capturedAt: row.captured_at,
  };
}

/** Evidence of unknown age counts as stale: a visit is cheaper than a wrong award. */
export function isStale(capturedAt: string, now: number = Date.now()): boolean {
  const captured = Date.parse(capturedAt);
  return Number.isNaN(captured) || now - captured > EVIDENCE_FRESH_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * A gateway may post the caller's number with an unencoded `+`, which form decoding turns
 * into a space. Restore it rather than failing to recognise the household.
 */
export function normalisePhone(raw: string): string {
  const trimmed = raw.trim();
  return /^\d{9,15}$/.test(trimmed) ? `+${trimmed}` : trimmed;
}

const MIN_NAME = 6;

/**
 * One page of the child list. Names are shortened to fit, and when even shortened names will
 * not fit, the page ends with a "More" option — a parent must never be offered a number the
 * menu cannot show.
 */
function childPage(
  language: Language,
  children: Child[],
  page: number,
  prefix = '',
): { shown: Child[]; offset: number; screen: string; hasMore: boolean } {
  const header = prefix + t(language, 'chooseChild', { list: '' });
  const more = t(language, 'morePrompt');
  const budget = MAX_SCREEN - 4 - header.length;

  let offset = 0;
  for (let p = 0; p < page; p++) {
    const fit = countThatFit(children, offset, budget, more);
    if (offset + fit >= children.length) break;
    offset += fit;
  }
  const fit = countThatFit(children, offset, budget, more);
  const shown = children.slice(offset, offset + fit);
  const hasMore = offset + fit < children.length;

  const numbering = shown.reduce((n, _, i) => n + `${offset + i + 1}. \n`.length, 0);
  const nameBudget = Math.max(
    Math.floor((budget - numbering - (hasMore ? more.length + 1 : 0)) / Math.max(shown.length, 1)),
    MIN_NAME,
  );
  const lines = shown.map(
    (child, i) =>
      `${offset + i + 1}. ${child.name.length > nameBudget ? `${child.name.slice(0, nameBudget - 1)}.` : child.name}`,
  );
  if (hasMore) lines.push(more);
  return { shown, offset, screen: prefix + t(language, 'chooseChild', { list: lines.join('\n') }), hasMore };
}

/** How many entries fit from `offset`, at the minimum readable name width. */
function countThatFit(children: Child[], offset: number, budget: number, more: string): number {
  let used = 0;
  let count = 0;
  for (let i = offset; i < children.length; i++) {
    const line = `${i + 1}. ${children[i].name.slice(0, MIN_NAME)}\n`.length;
    const needsMore = i + 1 < children.length ? more.length + 1 : 0;
    if (used + line + needsMore > budget) break;
    used += line;
    count++;
  }
  return Math.max(count, 1);
}

function pick<T>(items: T[], choice: string | undefined): T | undefined {
  if (!choice || !/^\d+$/.test(choice)) return undefined;
  return items[Number(choice) - 1];
}

/**
 * Renders the screen for the keypresses so far. An application is written only after the parent
 * consents; a home-visit request is written when a parent asks to apply for a child with no
 * evidence on file, or asks to add a child.
 */
export function respond(db: DatabaseSync, request: UssdRequest): UssdReply {
  const phone = normalisePhone(request.phoneNumber);
  const now = request.now ?? Date.now();
  const household = householdOf(db, phone);
  if (!household) return end(t('en', 'notRegistered'));

  const language = household.language;
  const round = openRound(db);
  if (!round) return end(t(language, 'noOpenRound'));

  const children = childrenOf(db, household.id);
  const parent = { id: household.id, role: 'parent' as const };
  const steps = request.text ? request.text.split('*') : [];
  const [choice, ...rest] = steps;

  if (!choice) return con(t(language, 'menu', { round: round.name }));

  // 1 = apply, 2 = my place, 3 = my score, 4 = add a child
  if (choice === '1' || choice === '2' || choice === '3') {
    if (children.length === 0) {
      // Only applying implies a new child; checking a place or score must not queue a visit.
      if (choice !== '1') return end(t(language, 'noCase', { child: '' }).trim());
      requestVerification(db, {
        phone,
        roundId: round.id,
        reason: 'new_child',
        note: 'Registered household has no child on file',
        actor: parent,
      });
      return end(t(language, 'addChild'));
    }

    // `0` pages the child list; the first other key is the selection.
    let page = 0;
    let selection: string | undefined;
    const afterSelection: string[] = [];
    for (const step of rest) {
      if (selection === undefined) {
        if (step === '0') page++;
        else selection = step;
      } else afterSelection.push(step);
    }

    const { shown, offset, screen } = childPage(language, children, page);
    if (selection === undefined) return con(screen);

    const child = pick(children, selection);
    const onThisPage = child !== undefined && children.indexOf(child) >= offset && children.indexOf(child) < offset + shown.length;
    if (!child || !onThisPage) {
      return con(childPage(language, children, page, `${t(language, 'invalid')}\n`).screen);
    }

    // One ranking pass answers "has this child applied", "where are they" and "what did they score".
    const ranked = rankRound(db, round.id);
    const entry: QueueEntry | undefined = ranked.find((e) => e.childId === child.id);

    if (choice === '2' || choice === '3') {
      if (!entry) return end(t(language, 'noCase', { child: child.name }));
      if (choice === '2') {
        return end(
          t(language, 'place', {
            child: child.name,
            position: entry.position,
            total: ranked.length,
            need: entry.need,
            bonus: entry.waitingBonus,
            priority: entry.priority,
          }),
        );
      }
      // Score the evidence this case was ranked on, not whatever is newest on file.
      const score = scoreNeed(getCase(db, entry.caseId).evidence);
      const points = (input: string) => score.components.find((c) => c.input === input)?.points ?? 0;
      return end(
        t(language, 'score', {
          child: child.name,
          total: score.total,
          max: MAX_SCORE,
          fee: points('fee_balance'),
          house: points('house_type'),
          livestock: points('livestock'),
          land: points('land'),
        }),
      );
    }

    if (entry) {
      return end(
        t(language, 'alreadyApplied', {
          child: child.name,
          caseId: entry.caseId,
          position: entry.position,
          total: ranked.length,
        }),
      );
    }

    const evidence = evidenceOnFile(db, child.id);
    if (!evidence) {
      requestVerification(db, {
        phone,
        childId: child.id,
        roundId: round.id,
        reason: 'no_evidence',
        note: `Home visit needed before ${child.id} can apply`,
        actor: parent,
      });
      return end(t(language, 'needsVisit', { child: child.name }));
    }

    const consent = afterSelection[0];
    if (!consent) return con(t(language, 'consent', { child: child.name }));
    if (consent === '2') return end(t(language, 'declined'));
    if (consent !== '1') return con(`${t(language, 'invalid')}\n${t(language, 'consent', { child: child.name })}`);

    let caseId: string;
    try {
      caseId = createCase(db, { roundId: round.id, childId: child.id, evidence, actor: parent });
    } catch (err) {
      // A parent who just consented deserves a real answer, not "service unavailable".
      if (err instanceof DuplicateApplicationError) {
        const already = rankRound(db, round.id).find((e) => e.childId === child.id);
        return end(
          already
            ? t(language, 'alreadyApplied', {
                child: child.name,
                caseId: already.caseId,
                position: already.position,
                total: ranked.length,
              })
            : t(language, 'tryAgain'),
        );
      }
      if (err instanceof RoundNotOpenError) return end(t(language, 'noOpenRound'));
      throw err;
    }

    // The application reuses the last capture, so ask for a fresh visit when it has aged out.
    if (isStale(evidence.capturedAt, now)) {
      requestVerification(db, {
        phone,
        childId: child.id,
        roundId: round.id,
        reason: 'stale_evidence',
        note: `Evidence for ${child.id} last captured ${evidence.capturedAt}; re-visit before award`,
        actor: parent,
      });
    }

    // Re-rank after the write: another application may have landed while this session ran.
    const after = rankRound(db, round.id);
    const place = after.find((e) => e.caseId === caseId);
    return end(
      t(language, 'applied', {
        caseId,
        child: child.name,
        position: place?.position ?? after.length,
        total: after.length,
      }),
    );
  }

  if (choice === '4') {
    requestVerification(db, {
      phone,
      roundId: round.id,
      reason: 'new_child',
      note: 'Parent asked to add a child not on file',
      actor: parent,
    });
    return end(t(language, 'addChild'));
  }

  return con(`${t(language, 'invalid')}\n${t(language, 'menu', { round: round.name })}`);
}

/** The wire format: `CON `/`END ` prefix, trimmed to the network's screen limit. */
export function renderReply(reply: UssdReply): string {
  const body = `${reply.type} ${reply.text}`;
  return body.length <= MAX_SCREEN ? body : `${body.slice(0, MAX_SCREEN - 3)}...`;
}
