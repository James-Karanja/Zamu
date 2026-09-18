// Shared bootstrap for the two entry points, so a fix to shutdown or error handling lands in both.
import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { databasePath } from './db/connection.ts';

export interface RunOptions {
  /** Environment variable holding the port, e.g. `PORT`. */
  envVar: string;
  defaultPort: number;
  open: (path: string) => DatabaseSync;
  create: (db: DatabaseSync) => Server;
  banner: (port: number, path: string) => string;
}

export function runServer({ envVar, defaultPort, open, create, banner }: RunOptions): void {
  const configured = process.env[envVar]?.trim();
  const port = configured ? Number(configured) : defaultPort;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    console.error(`Invalid ${envVar}: ${configured}`);
    process.exit(1);
  }

  const path = databasePath();
  if (!existsSync(path)) {
    console.error(`No database at ${path} — run \`npm run seed\` first.`);
    process.exit(1);
  }

  const db = open(path);
  const server = create(db);

  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(err.code === 'EADDRINUSE' ? `Port ${port} is already in use.` : `Cannot listen on ${port}: ${err.message}`);
    process.exit(1);
  });

  server.listen(port, () => console.log(banner(port, path)));

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      server.close(() => {
        if (db.isOpen) db.close();
        process.exit(0);
      });
    });
  }
}
