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
  /** Told the address the socket really bound to, not the one that was asked for. */
  banner: (address: string, path: string) => string;
  /** Interface to bind; defaults to all interfaces. The staff dashboard passes 127.0.0.1. */
  host?: string;
}

export function runServer({ envVar, defaultPort, open, create, banner, host }: RunOptions): void {
  const configured = process.env[envVar]?.trim();
  // Plain decimal only: `0x1f`, `1e3` and `0` are configuration mistakes, not ports.
  if (configured !== undefined && configured !== '' && !/^\d+$/.test(configured)) {
    console.error(`Invalid ${envVar}: ${configured}`);
    process.exit(1);
  }
  const port = configured ? Number(configured) : defaultPort;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    console.error(`Invalid ${envVar}: ${configured}`);
    process.exit(1);
  }

  const path = databasePath();
  if (!existsSync(path)) {
    console.error(`No database at ${path} — run \`npm run seed\` first.`);
    process.exit(1);
  }

  let db: DatabaseSync;
  try {
    db = open(path);
  } catch (err) {
    console.error(`Cannot open ${path}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  const server = create(db);

  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(err.code === 'EADDRINUSE' ? `Port ${port} is already in use.` : `Cannot listen on ${port}: ${err.message}`);
    process.exit(1);
  });

  const announce = () => {
    const bound = server.address();
    const address =
      bound && typeof bound === 'object'
        ? `http://${bound.family === 'IPv6' ? `[${bound.address}]` : bound.address}:${bound.port}`
        : `http://localhost:${port}`;
    console.log(banner(address, path));
  };
  if (host) server.listen(port, host, announce);
  else server.listen(port, announce);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      // Gateways hold keep-alive sockets; without this, shutdown waits for them to idle out.
      server.closeAllConnections();
      server.close(() => {
        if (db.isOpen) db.close();
        process.exit(0);
      });
      setTimeout(() => process.exit(0), 5_000).unref();
    });
  }
}
