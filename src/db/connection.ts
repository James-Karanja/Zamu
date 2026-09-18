import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PROJECT_ROOT = resolve(import.meta.dirname, '../..');

/** Default database file, resolved from the project root so the working directory does not matter. */
export const DEFAULT_DB_PATH = join(PROJECT_ROOT, 'data/zamu.db');

const schema = readFileSync(join(import.meta.dirname, 'schema.sql'), 'utf8');

/** The configured database path: ZAMU_DB when set and non-empty, else the project default. */
export function databasePath(): string {
  const configured = process.env.ZAMU_DB?.trim();
  if (!configured) return DEFAULT_DB_PATH;
  return configured === ':memory:' || isAbsolute(configured) ? configured : resolve(PROJECT_ROOT, configured);
}

/** Opens the Zamu database and applies the schema. */
export function openDatabase(path: string = databasePath()): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { timeout: 5_000 });
  db.exec('PRAGMA foreign_keys = ON;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  // Without this, the row deletions REPLACE performs would skip the append-only delete triggers.
  db.exec('PRAGMA recursive_triggers = ON;');
  db.exec(schema);
  return db;
}
