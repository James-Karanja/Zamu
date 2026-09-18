import { openReadOnly } from '../db/connection.ts';
import { runServer } from '../server-runtime.ts';
import { createServer } from './server.ts';

runServer({
  envVar: 'PORT',
  defaultPort: 4000,
  open: openReadOnly,
  create: createServer,
  banner: (port, path) => `Zamu public queue on http://localhost:${port} (database: ${path}, read-only)`,
});
