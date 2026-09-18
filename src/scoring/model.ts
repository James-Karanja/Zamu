// The published scoring rules as executable code. See _bmad-output/specs/spec-zamu/scoring-model.md.
// Pure functions: same evidence in, same score out. No clock, no randomness, no officer input.
import type { EvidenceInput } from '../store/cases.ts';

export type ScoreInput = 'fee_balance' | 'house_type' | 'livestock' | 'land';

export interface ScoreComponent {
  input: ScoreInput;
  /** What the parent sees for this input, e.g. `fee balance KES 28,000`. */
  label: string;
  points: number;
  max: number;
}

export interface NeedScore {
  total: number;
  components: ScoreComponent[];
}

export const MAX_POINTS: Record<ScoreInput, number> = {
  fee_balance: 35,
  house_type: 30,
  livestock: 20,
  land: 15,
};

/** Derived, so changing a weight can never leave the published maximum stale. */
export const MAX_SCORE = Object.values(MAX_POINTS).reduce((sum, points) => sum + points, 0);

/** The longest reason Zamu will render, so it always fits one SMS. */
export const MAX_REASON_LENGTH = 160;

/** Grouped thousands without ICU, so the same evidence renders identically everywhere. */
function money(amount: number, currency: string): string {
  const grouped = String(Math.round(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${currency} ${grouped}`;
}

function feeBalance(e: EvidenceInput, currency: string): ScoreComponent {
  const points = e.feeBalance === 0 ? 0 : e.feeBalance < 10_000 ? 12 : e.feeBalance <= 25_000 ? 24 : 35;
  return { input: 'fee_balance', label: `fee balance ${money(e.feeBalance, currency)}`, points, max: MAX_POINTS.fee_balance };
}

function houseType(e: EvidenceInput): ScoreComponent {
  const points = e.houseType === 'permanent' ? 0 : e.houseType === 'semi_permanent' ? 15 : 30;
  const label = { permanent: 'permanent house', semi_permanent: 'semi-permanent house', mud: 'mud house' }[e.houseType];
  return { input: 'house_type', label, points, max: MAX_POINTS.house_type };
}

function livestock(e: EvidenceInput): ScoreComponent {
  if (e.cattle >= 5) return { input: 'livestock', label: `${e.cattle} cattle`, points: 0, max: MAX_POINTS.livestock };
  if (e.cattle >= 1) return { input: 'livestock', label: `${e.cattle} cattle`, points: 8, max: MAX_POINTS.livestock };
  if (e.hasGoatsOrPoultry) return { input: 'livestock', label: 'goats or poultry only', points: 14, max: MAX_POINTS.livestock };
  return { input: 'livestock', label: 'no livestock', points: 20, max: MAX_POINTS.livestock };
}

/**
 * Land over 2 acres scores 0 whether or not a title deed exists: the land is the visible asset,
 * and hiding paperwork must not raise a score. The title flag stays recorded as evidence.
 */
function land(e: EvidenceInput): ScoreComponent {
  const points = e.landAcres > 2 ? 0 : e.landAcres >= 0.5 ? 7 : 15;
  const label = e.landAcres === 0 ? 'no land' : `${e.landAcres} acre${e.landAcres === 1 ? '' : 's'}`;
  return { input: 'land', label, points, max: MAX_POINTS.land };
}

/** Scores a case's evidence out of 100, with the points for every input. */
export function scoreNeed(evidence: EvidenceInput, currency = 'KES'): NeedScore {
  const components = [feeBalance(evidence, currency), houseType(evidence), livestock(evidence), land(evidence)];
  return { total: components.reduce((sum, c) => sum + c.points, 0), components };
}

/**
 * One screen of plain text naming the inputs that earned points, e.g. for an SMS.
 * Inputs worth zero are left out: telling a parent their cleared fee balance counts
 * towards their score reads as blame for something that helped them.
 */
export function reasonText(score: NeedScore): string {
  const top = score.components
    .filter((c) => c.points > 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, 2);
  const reason = top.length ? top.map((c) => c.label).join(' · ') : 'no scored needs recorded';
  const text = `Score ${score.total}/${MAX_SCORE}: ${reason}`;
  return text.length <= MAX_REASON_LENGTH ? text : `${text.slice(0, MAX_REASON_LENGTH - 1)}…`;
}
