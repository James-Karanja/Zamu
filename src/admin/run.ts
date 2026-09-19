import { openDatabase } from '../db/connection.ts';
import { runServer } from '../server-runtime.ts';
import { createServer } from './server.ts';

// Localhost only: the dashboard writes, shows full names, and has no login. It refuses any other address.
const LOOPBACK = ['127.0.0.1', '::1', 'localhost'];
const host = process.env.ADMIN_HOST?.trim() || '127.0.0.1';
if (!LOOPBACK.includes(host)) {
  console.error(`Refusing to serve the staff dashboard on ${host}: it has no login, so it only runs on this machine.`);
  process.exit(1);
}

runServer({
  envVar: 'ADMIN_PORT',
  defaultPort: 4002,
  host,
  open: openDatabase,
  create: (db) => createServer(db),
  banner: (address, path) => `Zamu staff dashboard on ${address} (database: ${path})`,
});
