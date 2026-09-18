import { existsSync } from 'node:fs';
import { databasePath, openReadOnly } from '../db/connection.ts';
import { createServer } from './server.ts';

const configured = process.env.PORT?.trim();
const port = configured ? Number(configured) : 4000;
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  console.error(`Invalid PORT: ${configured}`);
  process.exit(1);
}

const path = databasePath();
if (!existsSync(path)) {
  console.error(`No database at ${path} — run \`npm run seed\` first.`);
  process.exit(1);
}

const db = openReadOnly(path);
const server = createServer(db);

server.on('error', (err: NodeJS.ErrnoException) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${port} is already in use.` : `Cannot listen on ${port}: ${err.message}`);
  process.exit(1);
});

server.listen(port, () => {
  console.log(`Zamu public queue on http://localhost:${port} (database: ${path}, read-only)`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
