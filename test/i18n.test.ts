import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TABLES, t, type Language, type MessageKey } from '../src/i18n/strings.ts';

const LANGUAGES = Object.keys(TABLES) as Language[];
const placeholders = (template: string) => new Set(template.match(/\{\w+\}/g) ?? []);

test('every language carries the same keys', () => {
  const keys = LANGUAGES.map((language) => Object.keys(TABLES[language]).sort());
  for (const set of keys) assert.deepEqual(set, keys[0]);
});

test('matching messages use the same placeholders, so no parent ever sees a raw {token}', () => {
  for (const key of Object.keys(TABLES.en) as MessageKey[]) {
    const expected = placeholders(TABLES.en[key]);
    for (const language of LANGUAGES) {
      assert.deepEqual(placeholders(TABLES[language][key]), expected, `${language}.${key}`);
    }
  }
});

test('messages stay within GSM-7, so a basic handset renders them', () => {
  for (const language of LANGUAGES) {
    for (const [key, template] of Object.entries(TABLES[language])) {
      const offending = [...template].filter((c) => c.charCodeAt(0) > 127);
      assert.deepEqual(offending, [], `${language}.${key} has non-GSM characters: ${offending.join('')}`);
    }
  }
});

test('interpolation fills known values and leaves unknown tokens visible', () => {
  assert.match(t('en', 'place', { child: 'Ada', position: 3, total: 40, need: 70, bonus: 10, priority: 80 }), /Ada: place 3 of 40/);
  assert.match(t('sw', 'menu', { round: '2026 Term 2' }), /Zamu: 2026 Term 2/);
  assert.match(t('en', 'place', {}), /\{child\}/);
});
