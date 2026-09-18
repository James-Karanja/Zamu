import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_POINTS, MAX_REASON_LENGTH, MAX_SCORE, reasonText, scoreNeed } from '../src/scoring/model.ts';
import { evidence } from './helpers.ts';

const points = (e: Parameters<typeof scoreNeed>[0], input: string) =>
  scoreNeed(e).components.find((c) => c.input === input)!.points;

test('the neediest evidence scores the maximum', () => {
  const score = scoreNeed(evidence({ feeBalance: 32_000, houseType: 'mud', cattle: 0, hasGoatsOrPoultry: false, landAcres: 0.3 }));
  assert.equal(score.total, MAX_SCORE);
  assert.deepEqual(score.components.map((c) => c.points), [35, 30, 20, 15]);
});

test('the least needy evidence scores zero and says so plainly', () => {
  const e = evidence({ feeBalance: 0, houseType: 'permanent', cattle: 7, hasGoatsOrPoultry: true, landAcres: 3, hasTitle: true });
  const score = scoreNeed(e);
  assert.equal(score.total, 0);
  assert.equal(reasonText(score), 'Score 0/100: no scored needs recorded');
});

test('the reason names only inputs that earned points', () => {
  const oneFactor = scoreNeed(evidence({ feeBalance: 0, houseType: 'permanent', cattle: 7, landAcres: 0.3 }));
  assert.equal(reasonText(oneFactor), 'Score 15/100: 0.3 acres');
  const twoFactors = scoreNeed(evidence({ feeBalance: 0, houseType: 'mud', cattle: 7, landAcres: 3 }));
  assert.equal(reasonText(twoFactors), 'Score 30/100: mud house');
});

test('the maximum points sum to the published maximum score', () => {
  assert.equal(Object.values(MAX_POINTS).reduce((sum, points) => sum + points, 0), MAX_SCORE);
  assert.equal(MAX_SCORE, 100);
});

test('a very large fee balance still fits one SMS', () => {
  const text = reasonText(scoreNeed(evidence({ feeBalance: 987_654_321 })));
  assert.ok(text.length <= MAX_REASON_LENGTH);
  assert.match(text, /KES 987,654,321/);
});

test('money formatting does not depend on the platform locale', () => {
  assert.match(reasonText(scoreNeed(evidence({ feeBalance: 1_234_567 }))), /KES 1,234,567/);
  assert.match(reasonText(scoreNeed(evidence({ feeBalance: 999, houseType: 'permanent', cattle: 7, landAcres: 3 }))), /KES 999/);
});

test('the breakdown always sums to the total and respects each maximum', () => {
  for (const e of [evidence(), evidence({ feeBalance: 0, cattle: 9, landAcres: 5 }), evidence({ houseType: 'semi_permanent', landAcres: 1 })]) {
    const score = scoreNeed(e);
    assert.equal(score.components.reduce((sum, c) => sum + c.points, 0), score.total);
    for (const c of score.components) assert.ok(c.points <= c.max && c.max === MAX_POINTS[c.input]);
  }
});

test('fee balance bands', () => {
  assert.equal(points(evidence({ feeBalance: 0 }), 'fee_balance'), 0);
  assert.equal(points(evidence({ feeBalance: 1 }), 'fee_balance'), 12);
  assert.equal(points(evidence({ feeBalance: 9_999 }), 'fee_balance'), 12);
  assert.equal(points(evidence({ feeBalance: 10_000 }), 'fee_balance'), 24);
  assert.equal(points(evidence({ feeBalance: 25_000 }), 'fee_balance'), 24);
  assert.equal(points(evidence({ feeBalance: 25_001 }), 'fee_balance'), 35);
});

test('house type bands', () => {
  assert.equal(points(evidence({ houseType: 'permanent' }), 'house_type'), 0);
  assert.equal(points(evidence({ houseType: 'semi_permanent' }), 'house_type'), 15);
  assert.equal(points(evidence({ houseType: 'mud' }), 'house_type'), 30);
});

test('livestock bands', () => {
  assert.equal(points(evidence({ cattle: 5 }), 'livestock'), 0);
  assert.equal(points(evidence({ cattle: 4 }), 'livestock'), 8);
  assert.equal(points(evidence({ cattle: 1 }), 'livestock'), 8);
  assert.equal(points(evidence({ cattle: 0, hasGoatsOrPoultry: true }), 'livestock'), 14);
  assert.equal(points(evidence({ cattle: 0, hasGoatsOrPoultry: false }), 'livestock'), 20);
});

test('land bands, and a title deed never changes the score', () => {
  assert.equal(points(evidence({ landAcres: 2.1 }), 'land'), 0);
  assert.equal(points(evidence({ landAcres: 2 }), 'land'), 7);
  assert.equal(points(evidence({ landAcres: 0.5 }), 'land'), 7);
  assert.equal(points(evidence({ landAcres: 0.49 }), 'land'), 15);
  assert.equal(points(evidence({ landAcres: 0 }), 'land'), 15);
  for (const acres of [0, 0.5, 2, 3]) {
    assert.equal(points(evidence({ landAcres: acres, hasTitle: true }), 'land'), points(evidence({ landAcres: acres, hasTitle: false }), 'land'));
  }
});

test('the reason names the two largest contributors and fits one SMS', () => {
  const score = scoreNeed(evidence({ feeBalance: 28_000, houseType: 'mud', cattle: 3, landAcres: 1 }));
  assert.equal(score.total, 35 + 30 + 8 + 7);
  assert.equal(reasonText(score), 'Score 80/100: fee balance KES 28,000 · mud house');
  assert.ok(reasonText(score).length <= 160);
});

test('scoring is deterministic', () => {
  const e = evidence({ feeBalance: 18_000, houseType: 'semi_permanent', cattle: 2, landAcres: 1.5 });
  assert.deepEqual(scoreNeed(e), scoreNeed(e));
});
