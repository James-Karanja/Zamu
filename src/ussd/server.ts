// Africa's Talking calls this endpoint with a form body and expects plain text back.
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { renderReply, respond } from './session.ts';

const PLAIN = 'text/plain; charset=utf-8';
/** A USSD gateway body is a handful of short fields; anything larger is not ours. */
const MAX_BODY = 8 * 1024;

async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_BODY) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY) return undefined;
    chunks.push(buffer);
  }
  // Decode once, so a multi-byte character split across chunks survives.
  return Buffer.concat(chunks).toString('utf8');
}

export function createServer(db: DatabaseSync): Server {
  return createHttpServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname !== '/ussd') {
          res.writeHead(404, { 'content-type': PLAIN });
          res.end('END Not found. USSD callbacks go to POST /ussd.');
          return;
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': PLAIN, allow: 'POST' });
          res.end('END This endpoint accepts USSD callbacks at POST /ussd.');
          return;
        }

        const body = await readBody(req);
        if (body === undefined) {
          res.writeHead(413, { 'content-type': PLAIN });
          res.end('END Request too large.');
          return;
        }

        const form = new URLSearchParams(body);
        const phoneNumber = form.get('phoneNumber') ?? '';
        const text = form.get('text') ?? '';
        const reply = renderReply(respond(db, { phoneNumber, text }));
        res.writeHead(200, { 'content-type': PLAIN, 'cache-control': 'no-store' });
        res.end(reply);
      } catch (err) {
        // A gateway must always get a valid USSD reply, never a stack trace — but the
        // operator still needs to see what broke, so it goes to the log instead.
        console.error('USSD request failed:', err);
        if (res.headersSent || res.destroyed || res.writableEnded) res.destroy();
        else {
          res.writeHead(200, { 'content-type': PLAIN });
          res.end('END Service unavailable. Please try again shortly.');
        }
      }
    })();
  });
}
