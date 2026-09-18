// Stateless USSD session: Africa's Talking sends the whole keypress history in `text`,
// so the current screen is derived from it and nothing is stored between requests.
import type { DatabaseSync } from 'node:sqlite';
import { type Language, t } from '../i18n/strings.ts';
import { type QueueEntry, rankRound } from '../queue/ranking.ts';
import { MAX_SCORE, scoreNeed } from '../scoring/model.ts';
import { type EvidenceInput, createCase, getCase, requestVerification } from '../store/cases.ts';

/** USSD screens are limited by the network; Africa's Talking allows 182 characters. */
export const MAX_SCREEN = 182;

/** Evidence older than this is reused to let a parent apply, but a re-visit is requested. */
export const EVIDENCE_FRESH_DAYS = 180;

export interface UssdRequest {
  phoneNumber: string;
  text: string;
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

const isStale = (capturedAt: string, now = Date.now()) =>
  now - Date.parse(capturedAt) > EVIDENCE_FRESH_DAYS * 24 * 60 * 60 * 1000;

/**
 * Lists every child on one screen. Names are shortened to fit rather than options dropped:
 * a parent must never be offered a number the menu cannot show.
 */
function childMenu(language: Language, children: Child[]): string {
  const header = t(language, 'chooseChild', { list: '' });
  const numbering = children.reduce((n, _, i) => n + `${i + 1}. \n`.length, 0);
  const budget = Math.max(Math.floor((MAX_SCREEN - 4 - header.length - numbering) / Math.max(children.length, 1)), 6);
  const list = children
    .map((child, i) => `${i + 1}. ${child.name.length > budget ? `${child.name.slice(0, budget - 1)}.` : child.name}`)
    .join('\n');
  return t(language, 'chooseChild', { list });
}

function pick<T>(items: T[], choice: string | undefined): T | undefined {
  if (!choice || !/^\d+$/.test(choice)) return undefined;
  return items[Number(choice) - 1];
}

/** Renders the screen for the keypresses so far. Writes only when the parent consents. */
export function respond(db: DatabaseSync, request: UssdRequest): UssdReply {
  const phone = request.phoneNumber.trim();
  const household = householdOf(db, phone);
  if (!household) return end(t('en', 'notRegistered'));

  const language = household.language;
  const round = openRound(db);
  if (!round) return end(t(language, 'noOpenRound'));

  const children = childrenOf(db, household.id);
  const parent = { id: household.id, role: 'parent' as const };
  const steps = request.text ? request.text.split('*') : [];
  const [choice, second, third] = steps;

  const addChild = (childId: string | null, reason: 'new_child' | 'no_evidence', note: string) => {
    requestVerification(db, { phone, childId, reason, note, actor: parent });
  };

  if (!choice) return con(t(language, 'menu', { round: round.name }));

  // 1 = apply, 2 = my place, 3 = my score, 4 = add a child
  if (choice === '1' || choice === '2' || choice === '3') {
    // A household with nothing on file must not be trapped in an empty child menu.
    if (children.length === 0) {
      addChild(null, 'new_child', 'Registered household has no child on file');
      return end(t(language, 'addChild'));
    }
    if (!second) return con(childMenu(language, children));
    const child = pick(children, second);
    if (!child) return con(`${t(language, 'invalid')}\n${childMenu(language, children)}`);

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
      addChild(child.id, 'no_evidence', `Home visit needed before ${child.id} can apply`);
      return end(t(language, 'needsVisit', { child: child.name }));
    }

    if (!third) return con(t(language, 'consent', { child: child.name }));
    if (third === '2') return end(t(language, 'declined'));
    if (third !== '1') return con(`${t(language, 'invalid')}\n${t(language, 'consent', { child: child.name })}`);

    const caseId = createCase(db, { roundId: round.id, childId: child.id, evidence, actor: parent });
    // The application reuses the last capture, so ask for a fresh visit when it has aged out.
    if (isStale(evidence.capturedAt)) {
      requestVerification(db, {
        phone,
        childId: child.id,
        reason: 'stale_evidence',
        note: `Evidence for ${child.id} last captured ${evidence.capturedAt}; re-visit before award`,
        actor: parent,
      });
    }
    const place = rankRound(db, round.id).find((e) => e.caseId === caseId);
    return end(
      t(language, 'applied', {
        caseId,
        child: child.name,
        position: place?.position ?? ranked.length + 1,
        total: ranked.length + 1,
      }),
    );
  }

  if (choice === '4') {
    addChild(null, 'new_child', 'Parent asked to add a child not on file');
    return end(t(language, 'addChild'));
  }

  return con(`${t(language, 'invalid')}\n${t(language, 'menu', { round: round.name })}`);
}

/** The wire format: `CON `/`END ` prefix, trimmed to the network's screen limit. */
export function renderReply(reply: UssdReply): string {
  const body = `${reply.type} ${reply.text}`;
  return body.length <= MAX_SCREEN ? body : `${body.slice(0, MAX_SCREEN - 3)}...`;
}
