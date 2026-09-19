import { openReadOnly } from '../db/connection.ts';
import { runServer } from '../server-runtime.ts';
import { createServer } from './server.ts';

runServer({
  envVar: 'PORT',
  defaultPort: 4000,
  open: openReadOnly,
  create: createServer,
  banner: (address, path) => `Zamu public queue on ${address} (database: ${path}, read-only)`,
});
