// Read-only public queue server: it opens the database read-only, writes nothing,
// and exposes no route that changes state.
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { RoundNotFoundError } from '../store/cases.ts';
import { listRounds, roundView } from '../queue/ranking.ts';
import { renderIndex, renderNotFound, renderRound } from './render.ts';

/**
 * Nothing on this page is private, so it may be cached briefly — one fewer round trip
 * on a weak connection. The CSP makes the no-script, no-external-request promise hold
 * in the browser rather than only in a test.
 */
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'public, max-age=30',
};

function send(res: ServerResponse, status: number, type: string, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': type, ...SECURITY_HEADERS, ...extra });
  res.end(body);
}

const HTML = 'text/html; charset=utf-8';
const JSON_TYPE = 'application/json; charset=utf-8';

function notFound(res: ServerResponse, asJson: boolean, message: string): void {
  if (asJson) send(res, 404, JSON_TYPE, JSON.stringify({ error: message }));
  else send(res, 404, HTML, renderNotFound(message));
}

export function handle(db: DatabaseSync, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://localhost');

  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    // A malformed percent-escape is a bad address, not a server fault.
    notFound(res, url.pathname.endsWith('.json'), 'That page does not exist.');
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', { allow: 'GET, HEAD' });
    return;
  }

  if (path === '/') {
    send(res, 200, HTML, renderIndex(listRounds(db)));
    return;
  }

  if (path === '/favicon.ico') {
    res.writeHead(204, SECURITY_HEADERS);
    res.end();
    return;
  }

  const round = /^\/round\/(.+?)(\.json)?$/.exec(path);
  if (round) {
    const [, roundId, asJson] = round;
    try {
      const { summary, entries } = roundView(db, roundId);
      if (asJson) send(res, 200, JSON_TYPE, JSON.stringify({ round: summary, queue: entries }, null, 2));
      else send(res, 200, HTML, renderRound(summary, entries));
    } catch (err) {
      if (err instanceof RoundNotFoundError) notFound(res, Boolean(asJson), 'That round does not exist.');
      else throw err;
    }
    return;
  }

  notFound(res, path.endsWith('.json'), 'That page does not exist.');
}

export function createServer(db: DatabaseSync): Server {
  return createHttpServer((req, res) => {
    try {
      handle(db, req, res);
    } catch {
      // Never leak a stack trace or database detail to a public visitor.
      if (res.headersSent) res.destroy();
      else send(res, 500, HTML, renderNotFound('Something went wrong.'));
    }
  });
}
