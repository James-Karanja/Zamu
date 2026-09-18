import { openDatabase } from '../db/connection.ts';
import { runServer } from '../server-runtime.ts';
import { createServer } from './server.ts';

runServer({
  envVar: 'USSD_PORT',
  defaultPort: 4001,
  open: openDatabase,
  create: createServer,
  banner: (port, path) =>
    `Zamu USSD on http://localhost:${port}/ussd (database: ${path})\n` +
    "Point the Africa's Talking sandbox at this URL through a tunnel, or drive it with curl.",
});
