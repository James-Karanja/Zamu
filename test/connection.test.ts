import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_DB_PATH, databasePath, openDatabase } from '../src/db/connection.ts';
import { DuplicatePhoneError, addHousehold } from '../src/store/registry.ts';
import { tempDir } from './helpers.ts';

function withEnv(t: { after: (fn: () => void) => void }, value: string | undefined): void {
  const previous = process.env.ZAMU_DB;
  t.after(() => {
    if (previous === undefined) delete process.env.ZAMU_DB;
    else process.env.ZAMU_DB = previous;
  });
  if (value === undefined) delete process.env.ZAMU_DB;
  else process.env.ZAMU_DB = value;
}

test('unset or blank ZAMU_DB falls back to the project default', (t) => {
  withEnv(t, undefined);
  assert.equal(databasePath(), DEFAULT_DB_PATH);
  process.env.ZAMU_DB = '   ';
  assert.equal(databasePath(), DEFAULT_DB_PATH);
});

test('default path is absolute, so the working directory does not matter', () => {
  assert.ok(DEFAULT_DB_PATH.startsWith('/'));
  assert.ok(DEFAULT_DB_PATH.endsWith('data/zamu.db'));
});

test('a relative ZAMU_DB resolves against the project root, not the cwd', (t) => {
  withEnv(t, 'tmp/custom.db');
  assert.equal(databasePath(), join(DEFAULT_DB_PATH, '../../tmp/custom.db'));
});

test('an absolute ZAMU_DB and :memory: are used as given', (t) => {
  withEnv(t, '/tmp/zamu-abs.db');
  assert.equal(databasePath(), '/tmp/zamu-abs.db');
  process.env.ZAMU_DB = ':memory:';
  assert.equal(databasePath(), ':memory:');
});

test('opening creates missing parent directories', (t) => {
  const path = join(tempDir(t), 'nested/deeper/zamu.db');
  const db = openDatabase(path);
  t.after(() => db.close());
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM cases').get() as { n: number }).n, 0);
});

test('one household per phone number, even on a database made before the rule', (t) => {
  const path = join(tempDir(t), 'legacy.db');
  // The shape households had before uniqueness was introduced.
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE households (
    id TEXT PRIMARY KEY, guardian_name TEXT NOT NULL, phone TEXT NOT NULL,
    language TEXT NOT NULL CHECK (language IN ('sw', 'en')));`);
  legacy.prepare("INSERT INTO households VALUES ('HH-1', 'First', '+254700000001', 'en')").run();
  legacy.close();

  const db = openDatabase(path);
  t.after(() => db.close());
  assert.throws(
    () => addHousehold(db, { id: 'HH-2', guardianName: 'Second', phone: '+254700000001', language: 'en' }),
    DuplicatePhoneError,
    'a table constraint would not reach this database; the unique index does',
  );
});

test('an in-memory database applies the schema', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM rounds').get() as { n: number }).n, 0);
});
