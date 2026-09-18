import { existsSync } from 'node:fs';
import { databasePath, openDatabase } from '../db/connection.ts';
import { dispatch, listMessages } from './dispatch.ts';
import { MissingCredentialsError, chooseSender } from './senders.ts';

const live = process.argv.includes('--live');
const path = databasePath();
if (!existsSync(path)) {
  console.error(`No database at ${path} — run \`npm run seed\` first.`);
  process.exit(1);
}

let sender;
try {
  sender = chooseSender(process.argv);
} catch (err) {
  if (err instanceof MissingCredentialsError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const db = openDatabase(path);
try {
  const before = new Set(listMessages(db).map((message) => message.id));
  const report = await dispatch(db, sender);
  const fresh = listMessages(db).filter((message) => !before.has(message.id));

  console.log(`Sender: ${sender.name}${live ? ' (live)' : ' (recorded only, nothing left this machine)'}`);
  console.log(`Queued ${report.queued} new, sent ${report.sent}, failed ${report.failed}. Outbox holds ${before.size + fresh.length}.`);
  for (const message of (fresh.length ? fresh : listMessages(db)).slice(-8)) {
    console.log(`\n  to ${message.phone} [${message.language}] ${message.template}`);
    console.log(`  ${message.body}`);
  }
} catch (err) {
  console.error(`Dispatch failed: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  db.close();
}
